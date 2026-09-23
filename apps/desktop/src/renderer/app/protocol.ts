import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  emptyProtocol,
  isProtocolFrozen,
  nextCriterionCode,
  nextProtocolId,
  readProtocol,
  type Criterion,
  type CriterionKind,
  type Deviation,
  type ExtractionField,
  type Hypothesis,
  type Preregistration,
  type ProtocolBody,
  type RichDocument,
  type SubQuestion,
} from "@kiwi/contracts";
import { readBridge, type RendererCommandResult } from "./bridge.js";

/**
 * Reading and writing the one protocol a project has.
 *
 * The page is six lists and two blocks of prose, all of them held in a single object, so every
 * edit on it is the same write: send the parts that changed against the version being shown.
 * That is why this is one hook rather than one per section -- six hooks over one object would be
 * six ways to lose somebody else's edit, and the sections would disagree about which version
 * they were looking at.
 *
 * A project that has never opened the page has no protocol object at all. The page still shows a
 * protocol -- an empty one -- because a blank screen is not an answer to "what is this project
 * asking". Nothing is written until somebody saves, and then `ensure` makes the object first.
 */

export interface ProtocolView {
  id: string;
  version: number;
  content_hash: string;
  title: string;
  created_at: string;
  updated_at: string;
  protocol: ProtocolBody;
}

/**
 * A protocol out of a command result, read defensively.
 *
 * `readProtocol` already drops what it cannot make sense of rather than inventing it, so a file
 * a newer build wrote arrives with the parts this one understands and no others.
 */
export function readProtocolView(data: Record<string, unknown> | undefined): ProtocolView | null {
  const row = data?.["protocol"];
  if (typeof row !== "object" || row === null || Array.isArray(row)) return null;
  const entry = row as Record<string, unknown>;
  const id = entry["id"];
  if (typeof id !== "string") return null;
  const version = entry["version"];
  const hash = entry["content_hash"];
  const title = entry["title"];
  const created = entry["created_at"];
  const updated = entry["updated_at"];
  return {
    id,
    version: typeof version === "number" ? version : 1,
    content_hash: typeof hash === "string" ? hash : "",
    title: typeof title === "string" ? title : "",
    created_at: typeof created === "string" ? created : "",
    updated_at: typeof updated === "string" ? updated : "",
    protocol: readProtocol(entry["protocol"]),
  };
}

/*
 * Adding and removing entries.
 *
 * Each of these mints the next unused number rather than the next index, because a claim names
 * `H2` and a screening decision names `E3`. Deleting the entry above one must not renumber it,
 * or every decision that mentioned it quietly starts saying something else.
 */

export function addSubQuestion(list: readonly SubQuestion[], text = ""): SubQuestion[] {
  const id = nextProtocolId(
    "Q",
    list.map((entry) => entry.id),
  );
  return [...list, { id, text }];
}

export function addHypothesis(list: readonly Hypothesis[], statement = ""): Hypothesis[] {
  const id = nextProtocolId(
    "H",
    list.map((entry) => entry.id),
  );
  return [...list, { id, statement, direction: "none", status: "open" }];
}

export function addCriterion(
  list: readonly Criterion[],
  kind: CriterionKind,
  text = "",
): Criterion[] {
  const id = nextProtocolId(
    "C",
    list.map((entry) => entry.id),
  );
  // The code is numbered within its kind, so `E3` says exclusion without anybody opening this.
  return [...list, { id, kind, code: nextCriterionCode(kind, list), text }];
}

export function addExtractionField(list: readonly ExtractionField[], name = ""): ExtractionField[] {
  const id = nextProtocolId(
    "F",
    list.map((entry) => entry.id),
  );
  return [...list, { id, name, type: "text", required: false, allowed: [], unit: null }];
}

export function changeEntry<T extends { id: string }>(
  list: readonly T[],
  id: string,
  changes: Partial<T>,
): T[] {
  return list.map((entry) => (entry.id === id ? { ...entry, ...changes } : entry));
}

export function removeEntry<T extends { id: string }>(list: readonly T[], id: string): T[] {
  return list.filter((entry) => entry.id !== id);
}

/** An absent part is left as it was. There is no way to unset one: they all have an empty value. */
export interface ProtocolChanges {
  question?: string;
  sub_questions?: SubQuestion[];
  hypotheses?: Hypothesis[];
  criteria?: Criterion[];
  extraction_schema?: ExtractionField[];
  method?: string;
  preregistration?: Preregistration;
  document?: RichDocument;
}

export interface ProtocolPage {
  /** What the project wrote down. An empty protocol until the page has been saved once. */
  protocol: ProtocolBody;
  /** The stored object, or null for a project that has never opened this page. */
  object: ProtocolView | null;
  frozen: boolean;
  /** True until the first answer only. A reload does not blank the page it is refreshing. */
  loading: boolean;
  busy: boolean;
  /** What the last write was refused for, in the words the command used. */
  error: string | null;
  /**
   * The command to run instead, when the refusal named one.
   *
   * An edit to a frozen protocol comes back pointing at `kiwi.protocol.log-deviation`. Carrying
   * it here is what lets the page offer the deviation rather than only saying no.
   */
  instead: string | null;
  reload(): Promise<void>;
  dismissError(): void;
  save(changes: ProtocolChanges): Promise<boolean>;
  freeze(): Promise<boolean>;
  logDeviation(entry: Omit<Deviation, "id">): Promise<boolean>;
}

async function invoke(
  workspaceId: string,
  command: string,
  args: Record<string, unknown>,
): Promise<RendererCommandResult> {
  const bridge = readBridge();
  if (bridge === null) throw new Error("The desktop bridge is unavailable.");
  const requestId = crypto.randomUUID();
  return bridge.invokeCommand({
    protocol_version: "1.0.0",
    request_id: requestId,
    idempotency_key: requestId,
    workspace_id: workspaceId,
    command,
    args,
  });
}

function failureMessage(cause: unknown): string {
  if (cause instanceof Error && cause.message !== "") return cause.message;
  return "That did not go through. Nothing was changed.";
}

export function useProtocol(scope: {
  workspaceId: string;
  projectId: string | null;
}): ProtocolPage {
  const { workspaceId, projectId } = scope;

  const [object, setObject] = useState<ProtocolView | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [instead, setInstead] = useState<string | null>(null);

  /**
   * Which read the page is waiting for.
   *
   * A project switched while the last read is still out would otherwise be answered by the old
   * one landing second and putting the previous project's protocol back on the screen.
   */
  const asked = useRef(0);

  /** The object as the last answer left it, for a write that starts before a render lands. */
  const held = useRef<ProtocolView | null>(null);

  const remember = useCallback((next: ProtocolView | null): void => {
    held.current = next;
    setObject(next);
  }, []);

  const reload = useCallback(async (): Promise<void> => {
    if (projectId === null) {
      setLoading(false);
      return;
    }
    const ticket = (asked.current += 1);
    try {
      const result = await invoke(workspaceId, "kiwi.protocol.read", { project_id: projectId });
      if (ticket !== asked.current) return;
      if (result.error !== undefined) setError(result.error.message);
      else {
        // A null here is a project that has never opened the page, not a failure to read one.
        remember(readProtocolView(result.data));
        setError(null);
        setInstead(null);
      }
    } catch (cause) {
      if (ticket === asked.current) setError(failureMessage(cause));
    } finally {
      if (ticket === asked.current) setLoading(false);
    }
  }, [workspaceId, projectId, remember]);

  useEffect(() => {
    // Another project's protocol is not this one's, and leaving it up while the real one is
    // asked for would show one project's question under another project's name.
    held.current = null;
    setObject(null);
    setError(null);
    setInstead(null);
    setLoading(true);
    void reload();
  }, [reload]);

  /**
   * Runs a write and keeps what it answered with.
   *
   * Every protocol write hands back the whole protocol as it now stands, so the page takes that
   * rather than reading again. One round trip, and no window in which the screen is showing a
   * version that is already behind the one it just wrote.
   */
  const run = useCallback(
    async (command: string, args: Record<string, unknown>): Promise<boolean> => {
      setBusy(true);
      setError(null);
      setInstead(null);
      try {
        const result = await invoke(workspaceId, command, args);
        if (result.error !== undefined) {
          setError(result.error.message);
          const pointer = result.error.details["instead"];
          if (typeof pointer === "string") setInstead(pointer);
          return false;
        }
        const written = readProtocolView(result.data);
        if (written !== null) remember(written);
        return true;
      } catch (cause) {
        setError(failureMessage(cause));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [workspaceId, remember],
  );

  /**
   * The protocol object, made if this is the first save.
   *
   * `ensure` is idempotent, so a second caller racing the first gets the same object rather than
   * a second protocol. It is only called on a write: opening the page must leave nothing behind.
   */
  const ensure = useCallback(async (): Promise<ProtocolView | null> => {
    if (held.current !== null) return held.current;
    if (projectId === null) return null;
    const made = await run("kiwi.protocol.ensure", { project_id: projectId });
    return made ? held.current : null;
  }, [projectId, run]);

  const save = useCallback(
    async (changes: ProtocolChanges): Promise<boolean> => {
      if (projectId === null) return false;
      const base = await ensure();
      if (base === null) return false;
      return run("kiwi.protocol.update", {
        project_id: projectId,
        expected_version: base.version,
        expected_hash: base.content_hash,
        ...changes,
      });
    },
    [ensure, projectId, run],
  );

  const freeze = useCallback(async (): Promise<boolean> => {
    if (projectId === null) return false;
    const base = await ensure();
    if (base === null) return false;
    return run("kiwi.protocol.freeze", { project_id: projectId });
  }, [ensure, projectId, run]);

  // A deviation carries no expected version: it is appended to a list, so two people logging one
  // at the same time have written down two things that happened, not a conflict.
  const logDeviation = useCallback(
    async (entry: Omit<Deviation, "id">): Promise<boolean> => {
      if (projectId === null) return false;
      return run("kiwi.protocol.log-deviation", {
        project_id: projectId,
        on: entry.on,
        what: entry.what,
        why: entry.why,
        approved_by: entry.approved_by,
      });
    },
    [projectId, run],
  );

  const dismissError = useCallback((): void => {
    setError(null);
    setInstead(null);
  }, []);

  // Held steady between renders, so a section that only redraws when the protocol changes does
  // not redraw on every keystroke somewhere else on the page.
  const blank = useMemo(() => emptyProtocol(), []);
  const protocol = object?.protocol ?? blank;

  return {
    protocol,
    object,
    frozen: isProtocolFrozen(protocol),
    loading,
    busy,
    error,
    instead,
    reload,
    dismissError,
    save,
    freeze,
    logDeviation,
  };
}
