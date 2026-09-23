import { sha256Text } from "./canonical-json.js";

export interface CoeditInsertOperation {
  document_id: string;
  operation_id: string;
  actor_id: string;
  lamport: number;
  kind: "insert";
  after_id: string | null;
  text: string;
  document_title?: string;
}

export interface CoeditDeleteOperation {
  document_id: string;
  operation_id: string;
  actor_id: string;
  lamport: number;
  kind: "delete";
  target_ids: string[];
}

export type CoeditOperation = CoeditInsertOperation | CoeditDeleteOperation;

export interface CoeditDocument {
  document_id: string;
  operations: CoeditOperation[];
}

export interface CoeditCheckpoint {
  document_id: string;
  content: string;
  content_hash: string;
  operation_count: number;
  actor_clock: Record<string, number>;
  operations: CoeditOperation[];
}

export interface CoeditPresence {
  document_id: string;
  actor_id: string;
  sequence: number;
  cursor: number;
  updated_at: string;
  expires_at: string;
}

function operationKey(operation: CoeditOperation): string {
  return `${operation.lamport.toString().padStart(16, "0")}:${operation.actor_id}:${operation.operation_id}`;
}

function normalizedOperation(operation: CoeditOperation): CoeditOperation {
  if (!Number.isSafeInteger(operation.lamport) || operation.lamport < 1)
    throw new Error("A coediting operation has an invalid logical clock.");
  if (operation.kind === "insert") {
    if (operation.text === "" || operation.text.length > 10_000)
      throw new Error("A coediting insertion is empty or too large.");
    return { ...operation, text: operation.text.normalize("NFC").replaceAll("\r\n", "\n") };
  }
  return { ...operation, target_ids: [...new Set(operation.target_ids)].sort() };
}

/** Merges duplicate and reordered delivery without depending on arrival order. */
export function mergeCoeditOperations(
  documentId: string,
  ...replicas: readonly CoeditOperation[][]
): CoeditDocument {
  const merged = new Map<string, CoeditOperation>();
  for (const operation of replicas.flat()) {
    if (operation.document_id !== documentId)
      throw new Error("A coediting operation belongs to another document.");
    const normalized = normalizedOperation(operation);
    const prior = merged.get(normalized.operation_id);
    if (prior !== undefined && JSON.stringify(prior) !== JSON.stringify(normalized)) {
      throw new Error("A coediting operation identifier was reused with different content.");
    }
    merged.set(normalized.operation_id, normalized);
  }
  return {
    document_id: documentId,
    operations: [...merged.values()].sort((left, right) =>
      operationKey(left).localeCompare(operationKey(right)),
    ),
  };
}

interface CharacterNode {
  id: string;
  parent: string | null;
  value: string;
  order: string;
}

/** Deterministically materializes Markdown from the convergent operation set. */
export function materializedCoeditCharacters(
  document: CoeditDocument,
): Array<{ id: string; value: string }> {
  const nodes = new Map<string, CharacterNode>();
  const deleted = new Set<string>();
  for (const operation of document.operations) {
    if (operation.kind === "delete") {
      for (const target of operation.target_ids) deleted.add(target);
      continue;
    }
    let parent = operation.after_id;
    for (const [index, value] of [...operation.text].entries()) {
      const id = `${operation.operation_id}:${String(index).padStart(6, "0")}`;
      nodes.set(id, { id, parent, value, order: `${operationKey(operation)}:${id}` });
      parent = id;
    }
  }
  const children = new Map<string | null, CharacterNode[]>();
  for (const node of nodes.values()) {
    const parent = node.parent === null || nodes.has(node.parent) ? node.parent : null;
    children.set(parent, [...(children.get(parent) ?? []), node]);
  }
  for (const values of children.values()) values.sort((a, b) => a.order.localeCompare(b.order));
  const visited = new Set<string>();
  const output: Array<{ id: string; value: string }> = [];
  function visit(parent: string | null): void {
    for (const node of children.get(parent) ?? []) {
      if (visited.has(node.id)) continue;
      visited.add(node.id);
      if (!deleted.has(node.id)) output.push({ id: node.id, value: node.value });
      visit(node.id);
    }
  }
  visit(null);
  return output;
}

export function materializeCoeditMarkdown(document: CoeditDocument): string {
  return materializedCoeditCharacters(document)
    .map((item) => item.value)
    .join("");
}

export function checkpointCoeditDocument(document: CoeditDocument): CoeditCheckpoint {
  const canonical = mergeCoeditOperations(document.document_id, document.operations);
  const content = materializeCoeditMarkdown(canonical);
  const actorClock: Record<string, number> = {};
  for (const operation of canonical.operations) {
    actorClock[operation.actor_id] = Math.max(
      actorClock[operation.actor_id] ?? 0,
      operation.lamport,
    );
  }
  return {
    document_id: document.document_id,
    content,
    content_hash: sha256Text(content),
    operation_count: canonical.operations.length,
    actor_clock: Object.fromEntries(
      Object.entries(actorClock).sort(([a], [b]) => a.localeCompare(b)),
    ),
    operations: canonical.operations,
  };
}

/** Presence is ephemeral: the newest unexpired update per actor wins. */
export function currentCoeditPresence(
  documentId: string,
  now: string,
  updates: readonly CoeditPresence[],
): CoeditPresence[] {
  const current = new Map<string, CoeditPresence>();
  for (const update of updates) {
    if (update.document_id !== documentId || update.expires_at <= now) continue;
    const prior = current.get(update.actor_id);
    if (prior === undefined || update.sequence > prior.sequence)
      current.set(update.actor_id, update);
  }
  return [...current.values()].sort((a, b) => a.actor_id.localeCompare(b.actor_id));
}
