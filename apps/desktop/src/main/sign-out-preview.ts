import type { AccountSignOutPreview } from "./ipc.js";

export interface PendingSynchronizationSource {
  count(accountId: string): Promise<number>;
}

export async function summarizePendingSynchronization(
  accountId: string,
  sources: {
    registrations: PendingSynchronizationSource | null;
    structured: PendingSynchronizationSource | null;
    documents: PendingSynchronizationSource | null;
  },
): Promise<AccountSignOutPreview> {
  const [registrations, structured, documents] = await Promise.all([
    sources.registrations?.count(accountId) ?? 0,
    sources.structured?.count(accountId) ?? 0,
    sources.documents?.count(accountId) ?? 0,
  ]);
  return {
    pending_workspace_registrations: registrations,
    pending_structured_changes: structured,
    pending_document_operations: documents,
    total: registrations + structured + documents,
  };
}
