import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface RecoveryDraft {
  schema_version: 1;
  actor_id: string;
  workspace_id: string;
  object_id: string;
  base_version: number;
  base_hash: string;
  title: string;
  content: string;
  updated_at: string;
}

interface RecoveryDraftState {
  schema_version: 1;
  drafts: RecoveryDraft[];
}

export interface RecoveryDraftStore {
  read(actorId: string, workspaceId: string, objectId: string): Promise<RecoveryDraft | null>;
  save(draft: RecoveryDraft): Promise<RecoveryDraft>;
  discard(
    actorId: string,
    workspaceId: string,
    objectId: string,
    baseVersion: number,
    baseHash: string,
  ): Promise<boolean>;
}

const empty = (): RecoveryDraftState => ({ schema_version: 1, drafts: [] });

function isDraft(value: unknown): value is RecoveryDraft {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const draft = value as Record<string, unknown>;
  return (
    draft["schema_version"] === 1 &&
    typeof draft["actor_id"] === "string" &&
    draft["actor_id"].length > 0 &&
    typeof draft["workspace_id"] === "string" &&
    draft["workspace_id"].length > 0 &&
    typeof draft["object_id"] === "string" &&
    draft["object_id"].length > 0 &&
    typeof draft["base_version"] === "number" &&
    Number.isInteger(draft["base_version"]) &&
    draft["base_version"] >= 1 &&
    typeof draft["base_hash"] === "string" &&
    /^sha256:[0-9a-f]{64}$/u.test(draft["base_hash"]) &&
    typeof draft["title"] === "string" &&
    draft["title"].length <= 500 &&
    typeof draft["content"] === "string" &&
    draft["content"].length <= 1_000_000 &&
    typeof draft["updated_at"] === "string"
  );
}

function isMissingFile(cause: unknown): boolean {
  return (
    cause !== null &&
    typeof cause === "object" &&
    "code" in cause &&
    (cause as { code?: unknown }).code === "ENOENT"
  );
}

export function createRecoveryDraftStore(filePath: string): RecoveryDraftStore {
  const nextPath = `${filePath}.next`;
  let tail = Promise.resolve();

  async function load(): Promise<RecoveryDraftState> {
    let raw: string;
    try {
      raw = await readFile(filePath, "utf8");
    } catch (cause) {
      if (isMissingFile(cause)) return empty();
      throw cause;
    }
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("Recovery draft storage is invalid.");
    const state = parsed as Record<string, unknown>;
    if (
      state["schema_version"] !== 1 ||
      !Array.isArray(state["drafts"]) ||
      !state["drafts"].every(isDraft)
    )
      throw new Error("Recovery draft storage is invalid.");
    return { schema_version: 1, drafts: state["drafts"] };
  }

  async function persist(state: RecoveryDraftState): Promise<void> {
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(nextPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await rename(nextPath, filePath);
  }

  async function update<T>(work: (state: RecoveryDraftState) => T): Promise<T> {
    const previous = tail;
    let release = (): void => undefined;
    tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      const state = await load();
      const result = work(state);
      await persist(state);
      return result;
    } finally {
      release();
    }
  }

  return {
    async read(actorId, workspaceId, objectId) {
      await tail;
      return (
        (await load()).drafts.find(
          (draft) =>
            draft.actor_id === actorId &&
            draft.workspace_id === workspaceId &&
            draft.object_id === objectId,
        ) ?? null
      );
    },
    save(draft) {
      return update((state) => {
        state.drafts = [
          ...state.drafts.filter(
            (item) =>
              item.actor_id !== draft.actor_id ||
              item.workspace_id !== draft.workspace_id ||
              item.object_id !== draft.object_id,
          ),
          draft,
        ];
        return draft;
      });
    },
    discard(actorId, workspaceId, objectId, baseVersion, baseHash) {
      return update((state) => {
        const before = state.drafts.length;
        state.drafts = state.drafts.filter(
          (draft) =>
            !(
              draft.workspace_id === workspaceId &&
              draft.actor_id === actorId &&
              draft.object_id === objectId &&
              draft.base_version === baseVersion &&
              draft.base_hash === baseHash
            ),
        );
        return state.drafts.length !== before;
      });
    },
  };
}
