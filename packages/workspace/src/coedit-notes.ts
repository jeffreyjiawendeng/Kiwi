import { readFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { prettyJson, sha256Text } from "./canonical-json.js";
import {
  checkpointCoeditDocument,
  materializeCoeditMarkdown,
  materializedCoeditCharacters,
  mergeCoeditOperations,
  type CoeditInsertOperation,
  type CoeditOperation,
} from "./coedit.js";
import {
  commitCanonical,
  withCanonicalWrite,
  type CanonicalEvent,
} from "./canonical-transaction.js";

export interface CoeditNoteState {
  $schema: "https://kiwi-research.org/schemas/coedit/note-state/1-0-0.json";
  document_id: string;
  title: string;
  markdown_path: string;
  created_at: string;
  updated_at: string;
  created_by: string;
  operations: CoeditOperation[];
}

export interface CoeditNoteView {
  document_id: string;
  title: string;
  content: string;
  content_hash: string;
  operation_count: number;
  updated_at: string;
}

export interface CoeditWriteIds {
  transactionId: string;
  preparedEventId: string;
  domainEventId: string;
  committedEventId: string;
}

export interface ApplyCoeditOperationsInput extends CoeditWriteIds {
  root: string;
  workspaceId: string;
  documentId: string;
  operations: CoeditOperation[];
  actor: string;
  requestId: string;
  now: string;
}

function slug(value: string): string {
  const result = value
    .normalize("NFC")
    .toLocaleLowerCase("en-US")
    .replace(/[<>:"/\\|?*]/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return result === "" ? "untitled" : result;
}

function statePath(documentId: string): string {
  return join(".kiwi", "coedit", `${documentId}.json`);
}

function view(state: CoeditNoteState): CoeditNoteView {
  const document = mergeCoeditOperations(state.document_id, state.operations);
  const content = materializeCoeditMarkdown(document);
  return {
    document_id: state.document_id,
    title: state.title,
    content,
    content_hash: sha256Text(content),
    operation_count: document.operations.length,
    updated_at: state.updated_at,
  };
}

async function readState(root: string, documentId: string): Promise<CoeditNoteState | null> {
  const raw = await readFile(join(root, statePath(documentId)), "utf8").catch(() => null);
  if (raw === null) return null;
  const value = JSON.parse(raw) as Partial<CoeditNoteState>;
  return value.document_id === documentId && Array.isArray(value.operations)
    ? (value as CoeditNoteState)
    : null;
}

function event(
  input: CoeditWriteIds & {
    workspaceId: string;
    documentId: string;
    actor: string;
    requestId: string;
    now: string;
  },
  eventType: string,
  operationIds: string[],
): CanonicalEvent {
  return {
    id: input.domainEventId,
    workspace_id: input.workspaceId,
    transaction_id: input.transactionId,
    schema_version: "1.0.0",
    event_type: eventType,
    occurred_at: input.now,
    recorded_at: input.now,
    actor: input.actor,
    origin: "ui",
    request_id: input.requestId,
    object_ids: [input.documentId],
    operation_ids: operationIds,
  };
}

async function persist(
  input: CoeditWriteIds & {
    root: string;
    workspaceId: string;
    actor: string;
    requestId: string;
    now: string;
  },
  state: CoeditNoteState,
  eventType: string,
  operations: CoeditOperation[],
): Promise<void> {
  const note = view(state);
  await commitCanonical({
    root: input.root,
    workspaceId: input.workspaceId,
    transactionId: input.transactionId,
    now: input.now,
    actor: input.actor,
    origin: "ui",
    requestId: input.requestId,
    preparedEventId: input.preparedEventId,
    committedEventId: input.committedEventId,
    domainEvents: [
      event(
        { ...input, documentId: state.document_id },
        eventType,
        operations.map((item) => item.operation_id),
      ),
    ],
    targets: [
      { relativePath: statePath(state.document_id), after: prettyJson(state) },
      { relativePath: state.markdown_path, after: note.content },
      {
        relativePath: join(
          ".kiwi",
          "coedit-checkpoints",
          state.document_id,
          `${String(note.operation_count).padStart(8, "0")}.json`,
        ),
        after: prettyJson(
          checkpointCoeditDocument({
            document_id: state.document_id,
            operations: state.operations,
          }),
        ),
      },
    ],
  });
}

export async function createCoeditNote(
  input: CoeditWriteIds & {
    root: string;
    workspaceId: string;
    documentId: string;
    title: string;
    content: string;
    actor: string;
    requestId: string;
    now: string;
    newOperationId(): string;
  },
): Promise<{ note: CoeditNoteView; operations: CoeditOperation[] }> {
  return withCanonicalWrite(input.root, async () => {
    const title = input.title.trim().normalize("NFC");
    if (title === "") throw new Error("A live note needs a title.");
    const content = input.content.normalize("NFC").replaceAll("\r\n", "\n");
    const operations: CoeditOperation[] =
      content === ""
        ? []
        : [
            {
              document_id: input.documentId,
              operation_id: input.newOperationId(),
              actor_id: input.actor,
              lamport: 1,
              kind: "insert",
              after_id: null,
              text: content,
              document_title: title,
            },
          ];
    const state: CoeditNoteState = {
      $schema: "https://kiwi-research.org/schemas/coedit/note-state/1-0-0.json",
      document_id: input.documentId,
      title,
      markdown_path: join("objects", "notes", `${slug(title)}--${input.documentId}.md`),
      created_at: input.now,
      updated_at: input.now,
      created_by: input.actor,
      operations,
    };
    await persist(input, state, "coedit.note.created", operations);
    return { note: view(state), operations };
  });
}

export async function listCoeditNotes(root: string): Promise<CoeditNoteView[]> {
  const entries = await readdir(join(root, ".kiwi", "coedit"), { withFileTypes: true }).catch(
    () => [],
  );
  const notes: CoeditNoteView[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const id = basename(entry.name, ".json");
    const state = await readState(root, id);
    if (state !== null) notes.push(view(state));
  }
  return notes.sort((a, b) => a.updated_at.localeCompare(b.updated_at));
}

export async function readCoeditNote(
  root: string,
  documentId: string,
): Promise<CoeditNoteView | null> {
  const state = await readState(root, documentId);
  return state === null ? null : view(state);
}

export class CoeditVersionConflict extends Error {
  constructor(readonly actualHash: string) {
    super("The live note changed since editing began.");
  }
}

export async function replaceCoeditNoteText(
  input: CoeditWriteIds & {
    root: string;
    workspaceId: string;
    documentId: string;
    expectedHash: string;
    content: string;
    actor: string;
    requestId: string;
    now: string;
    newOperationId(): string;
  },
): Promise<{ note: CoeditNoteView; operations: CoeditOperation[] }> {
  return withCanonicalWrite(input.root, async () => {
    const state = await readState(input.root, input.documentId);
    if (state === null) throw new Error("Live note not found.");
    const document = mergeCoeditOperations(state.document_id, state.operations);
    const current = materializedCoeditCharacters(document);
    const currentValues = current.map((item) => item.value);
    const currentText = currentValues.join("");
    const currentHash = sha256Text(currentText);
    if (currentHash !== input.expectedHash) throw new CoeditVersionConflict(currentHash);
    const nextText = input.content.normalize("NFC").replaceAll("\r\n", "\n");
    if (currentText === nextText) return { note: view(state), operations: [] };
    const lamport = Math.max(0, ...state.operations.map((item) => item.lamport));
    const operations: CoeditOperation[] = [];
    const removed = current.map((item) => item.id);
    if (removed.length > 0) {
      operations.push({
        document_id: state.document_id,
        operation_id: input.newOperationId(),
        actor_id: input.actor,
        lamport: lamport + 1,
        kind: "delete",
        target_ids: removed,
      });
    }
    if (nextText !== "") {
      operations.push({
        document_id: state.document_id,
        operation_id: input.newOperationId(),
        actor_id: input.actor,
        lamport: lamport + operations.length + 1,
        kind: "insert",
        after_id: null,
        text: nextText,
        document_title: state.title,
      });
    }
    state.operations = mergeCoeditOperations(
      state.document_id,
      state.operations,
      operations,
    ).operations;
    state.updated_at = input.now;
    await persist(input, state, "coedit.note.changed", operations);
    return { note: view(state), operations };
  });
}

/** Applies reordered or duplicate remote operations without overwriting local work. */
export async function applyCoeditNoteOperations(
  input: ApplyCoeditOperationsInput,
): Promise<{ note: CoeditNoteView; applied: number } | null> {
  return withCanonicalWrite(input.root, async () => {
    let state = await readState(input.root, input.documentId);
    if (state === null) {
      const title = input.operations.find(
        (item): item is CoeditInsertOperation =>
          item.kind === "insert" && item.document_title !== undefined,
      )?.document_title;
      if (title === undefined) return null;
      state = {
        $schema: "https://kiwi-research.org/schemas/coedit/note-state/1-0-0.json",
        document_id: input.documentId,
        title,
        markdown_path: join("objects", "notes", `${slug(title)}--${input.documentId}.md`),
        created_at: input.now,
        updated_at: input.now,
        created_by: input.operations[0]?.actor_id ?? input.actor,
        operations: [],
      };
    }
    const before = new Set(state.operations.map((item) => item.operation_id));
    const merged = mergeCoeditOperations(state.document_id, state.operations, input.operations);
    const applied = merged.operations.filter((item) => !before.has(item.operation_id)).length;
    if (applied === 0) return { note: view(state), applied: 0 };
    state.operations = merged.operations;
    state.updated_at = input.now;
    await persist(input, state, "coedit.note.synchronized", input.operations);
    return { note: view(state), applied };
  });
}
