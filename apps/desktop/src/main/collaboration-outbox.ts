import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface PendingRegistration {
  account_id: string;
  workspace_id: string;
  title: string;
}

export type WorkspaceRegistration = Omit<PendingRegistration, "account_id">;

export interface CollaborationOutbox {
  queueRegistration(value: PendingRegistration): Promise<void>;
  flush(
    accountId: string,
    send: (value: WorkspaceRegistration) => Promise<boolean>,
  ): Promise<number>;
  count(accountId: string): Promise<number>;
  /** The same count for one workspace, for a status line that is about one workspace. */
  countFor(accountId: string, workspaceId: string): Promise<number>;
}

const LEGACY_ACCOUNT_ID = "legacy-unassigned";

export function createCollaborationOutbox(filePath: string): CollaborationOutbox {
  const nextPath = `${filePath}.next`;
  async function load(): Promise<PendingRegistration[]> {
    try {
      const parsed: unknown = JSON.parse(await readFile(filePath, "utf8"));
      return Array.isArray(parsed)
        ? parsed
            .filter(
              (item): item is PendingRegistration =>
                item !== null &&
                typeof item === "object" &&
                typeof (item as Record<string, unknown>)["workspace_id"] === "string" &&
                typeof (item as Record<string, unknown>)["title"] === "string",
            )
            .map((item) => ({
              ...item,
              account_id:
                typeof (item as unknown as Record<string, unknown>)["account_id"] === "string"
                  ? item.account_id
                  : LEGACY_ACCOUNT_ID,
            }))
        : [];
    } catch {
      return [];
    }
  }
  async function save(values: PendingRegistration[]): Promise<void> {
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(nextPath, `${JSON.stringify(values, null, 2)}\n`, "utf8");
    await rename(nextPath, filePath);
  }
  return {
    async queueRegistration(value) {
      const current = await load();
      const next = [
        value,
        ...current.filter(
          (item) =>
            item.account_id !== value.account_id || item.workspace_id !== value.workspace_id,
        ),
      ];
      await save(next);
    },
    async flush(accountId, send) {
      const current = await load();
      const remaining: PendingRegistration[] = [];
      let sent = 0;
      for (const value of current) {
        if (value.account_id !== accountId) remaining.push(value);
        else if (await send({ workspace_id: value.workspace_id, title: value.title })) sent += 1;
        else remaining.push(value);
      }
      await save(remaining);
      return sent;
    },
    async count(accountId) {
      return (await load()).filter((item) => item.account_id === accountId).length;
    },
    async countFor(accountId, workspaceId) {
      return (await load()).filter(
        (item) => item.account_id === accountId && item.workspace_id === workspaceId,
      ).length;
    },
  };
}
