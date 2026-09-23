import { useEffect, useRef, useState } from "react";
import { readBridge, type RendererCommandResult } from "./bridge.js";

interface TrashEntry {
  manifest: {
    object_id: string;
    title: string;
    object_type: string;
    trashed_at: string;
    trashed_by: string;
    deletion_event_id: string;
  };
  object: {
    id: string;
    title: string;
    type: string;
    version: number;
    content_hash: string;
  };
  impact: {
    relation_count: number;
    related_object_count: number;
    relation_types: string[];
  };
}

interface TrashCleanupPolicy {
  enabled: boolean;
  minimum_age_days: number;
}

interface TrashCleanupPolicyPreview {
  policy: TrashCleanupPolicy;
  eligible_count: number;
  eligible_entries: Array<{ object_id: string; title: string; trashed_at: string }>;
  preview_token: string;
}

interface TrashPurgePreview {
  scope: "all" | "age";
  entry_count: number;
  relation_count: number;
  related_object_count: number;
  asset_count: number;
  object_checkpoint_count: number;
  relation_checkpoint_count: number;
  checkpoint_count: number;
  entries: Array<{
    object_id: string;
    title: string;
    object_type: string;
    trashed_at: string;
    relation_count: number;
  }>;
  preview_token: string;
  limitations: string[];
}

const DEFAULT_POLICY: TrashCleanupPolicy = { enabled: false, minimum_age_days: 30 };

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

function trashedTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
}

function confirmationPhrase(count: number): string {
  return `DELETE ${count} ${count === 1 ? "ITEM" : "ITEMS"}`;
}

function resultData<T>(result: RendererCommandResult, key: string): T {
  if (result.error !== undefined) throw new Error(result.error.message);
  return (result.data ?? {})[key] as T;
}

export function TrashWorkbench({
  workspaceId,
  writable,
}: {
  workspaceId: string;
  writable: boolean;
}): React.JSX.Element {
  const [entries, setEntries] = useState<TrashEntry[]>([]);
  const [policy, setPolicy] = useState<TrashCleanupPolicy>(DEFAULT_POLICY);
  const [policyDraft, setPolicyDraft] = useState<TrashCleanupPolicy>(DEFAULT_POLICY);
  const [policyPreview, setPolicyPreview] = useState<TrashCleanupPolicyPreview | null>(null);
  const [purgePreview, setPurgePreview] = useState<TrashPurgePreview | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const confirmationRef = useRef<HTMLInputElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    let current = true;
    setLoading(true);
    setError(null);
    void Promise.all([
      invoke(workspaceId, "kiwi.object.trash-list", {}),
      invoke(workspaceId, "kiwi.object.trash-policy", {}),
    ])
      .then(([listResult, policyResult]) => {
        const nextEntries = resultData<TrashEntry[]>(listResult, "entries") ?? [];
        const nextPolicy =
          resultData<TrashCleanupPolicy | undefined>(policyResult, "policy") ?? DEFAULT_POLICY;
        if (!current) return;
        setEntries(nextEntries);
        setPolicy(nextPolicy);
        setPolicyDraft(nextPolicy);
        setPolicyPreview(null);
      })
      .catch((cause: unknown) => {
        if (current)
          setError(cause instanceof Error ? cause.message : "Kiwi could not read workspace Trash.");
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [revision, workspaceId]);

  useEffect(() => {
    if (purgePreview !== null) confirmationRef.current?.focus();
  }, [purgePreview]);

  function clearNotices(): void {
    setError(null);
    setMessage(null);
  }

  async function restore(entry: TrashEntry): Promise<void> {
    setBusyId(entry.object.id);
    clearNotices();
    try {
      const result = await invoke(workspaceId, "kiwi.object.restore-from-trash", {
        object_id: entry.object.id,
      });
      if (result.error !== undefined) throw new Error(result.error.message);
      const relationCount = Number((result.data ?? {})["restored_relation_count"] ?? 0);
      setMessage(
        `Restored ${entry.object.title} with ${relationCount} ${relationCount === 1 ? "relation" : "relations"}.`,
      );
      setRevision((value) => value + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Kiwi could not restore this object.");
    } finally {
      setBusyId(null);
    }
  }

  async function reviewPolicy(): Promise<void> {
    setBusyId("policy-review");
    clearNotices();
    try {
      const result = await invoke(workspaceId, "kiwi.object.validate-trash-policy", {
        enabled: policyDraft.enabled,
        minimum_age_days: policyDraft.minimum_age_days,
      });
      setPolicyPreview(resultData<TrashCleanupPolicyPreview>(result, "preview"));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Kiwi could not review this policy.");
    } finally {
      setBusyId(null);
    }
  }

  async function applyPolicy(): Promise<void> {
    if (policyPreview === null) return;
    setBusyId("policy-apply");
    clearNotices();
    try {
      const result = await invoke(workspaceId, "kiwi.object.set-trash-policy", {
        ...policyPreview.policy,
        preview_token: policyPreview.preview_token,
      });
      if (result.error !== undefined) throw new Error(result.error.message);
      setMessage(
        policyPreview.policy.enabled
          ? `Age cleanup is enabled for items at least ${policyPreview.policy.minimum_age_days} days old. Cleanup still runs only when you request it.`
          : "Age cleanup is off. Trash will not be purged by age.",
      );
      setRevision((value) => value + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Kiwi could not save this policy.");
    } finally {
      setBusyId(null);
    }
  }

  async function reviewPurge(scope: "all" | "age", trigger: HTMLElement): Promise<void> {
    setBusyId(`purge-review-${scope}`);
    clearNotices();
    try {
      const result = await invoke(workspaceId, "kiwi.object.validate-trash-purge", { scope });
      const preview = resultData<TrashPurgePreview>(result, "preview");
      if (preview.entry_count === 0) {
        setMessage(
          scope === "age"
            ? "No Trash items currently meet the age policy."
            : "Trash is already empty.",
        );
        return;
      }
      returnFocusRef.current = trigger;
      setConfirmation("");
      setPurgePreview(preview);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Kiwi could not review permanent deletion.",
      );
    } finally {
      setBusyId(null);
    }
  }

  function closePurge(): void {
    setPurgePreview(null);
    setConfirmation("");
    window.setTimeout(() => returnFocusRef.current?.focus(), 0);
  }

  async function purge(): Promise<void> {
    if (purgePreview === null) return;
    setBusyId("purge");
    clearNotices();
    try {
      const result = await invoke(workspaceId, "kiwi.object.purge-trash", {
        scope: purgePreview.scope,
        preview_token: purgePreview.preview_token,
      });
      const receipt = resultData<{ purged_count: number }>(result, "receipt");
      setMessage(
        `Permanently deleted ${receipt.purged_count} ${receipt.purged_count === 1 ? "item" : "items"} from Trash. No Undo is available.`,
      );
      setPurgePreview(null);
      setConfirmation("");
      setRevision((value) => value + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Kiwi could not empty Trash.");
    } finally {
      setBusyId(null);
    }
  }

  function handleDialogKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    if (event.key === "Escape" && busyId !== "purge") {
      event.preventDefault();
      closePurge();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [
      ...(dialogRef.current?.querySelectorAll<HTMLElement>("button, input") ?? []),
    ].filter((element) => !element.hasAttribute("disabled"));
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  }

  const policyChanged =
    policy.enabled !== policyDraft.enabled ||
    policy.minimum_age_days !== policyDraft.minimum_age_days;
  const expectedConfirmation =
    purgePreview === null ? "" : confirmationPhrase(purgePreview.entry_count);

  return (
    <section className="trash-workbench" aria-labelledby="trash-title">
      <header className="page-head">
        <h2 id="trash-title">Trash</h2>
        {entries.length > 0 ? <p className="page-head__count">{entries.length}</p> : null}
        <div className="page-head__spacer" />
        <div className="trash-workbench__toolbar">
          <button
            type="button"
            disabled={loading}
            onClick={() => setRevision((value) => value + 1)}
          >
            Refresh
          </button>
          <button
            className="button button--danger"
            type="button"
            disabled={!writable || loading || entries.length === 0 || busyId !== null}
            title={!writable ? "This workspace is read only" : undefined}
            onClick={(event) => void reviewPurge("all", event.currentTarget)}
          >
            {busyId === "purge-review-all" ? "Reviewing..." : "Empty Trash..."}
          </button>
        </div>
      </header>
      <p className="page-lead">Restore items here, or review them before permanent deletion.</p>

      <section className="trash-workbench__policy" aria-labelledby="trash-policy-title">
        <div>
          <h3 id="trash-policy-title">Age cleanup</h3>
          <p>Off by default. Even when enabled, cleanup runs only when you request it.</p>
        </div>
        <label className="trash-workbench__policy-toggle">
          <input
            type="checkbox"
            checked={policyDraft.enabled}
            disabled={!writable || busyId !== null}
            onChange={(event) => {
              const enabled = event.currentTarget.checked;
              setPolicyDraft((value) => ({ ...value, enabled }));
              setPolicyPreview(null);
            }}
          />
          Enable age cleanup
        </label>
        <label className="trash-workbench__age">
          Keep items for at least
          <span>
            <input
              aria-label="Minimum cleanup age in days"
              type="number"
              min="1"
              max="3650"
              value={policyDraft.minimum_age_days}
              disabled={!writable || busyId !== null}
              onChange={(event) => {
                const minimumAgeDays = Number(event.currentTarget.value);
                setPolicyDraft((value) => ({
                  ...value,
                  minimum_age_days: minimumAgeDays,
                }));
                setPolicyPreview(null);
              }}
            />
            days
          </span>
        </label>
        <div className="trash-workbench__policy-actions">
          <button
            type="button"
            disabled={!writable || !policyChanged || busyId !== null}
            onClick={() => void reviewPolicy()}
          >
            {busyId === "policy-review" ? "Reviewing..." : "Review policy"}
          </button>
          {policy.enabled ? (
            <button
              type="button"
              disabled={!writable || entries.length === 0 || busyId !== null || policyChanged}
              onClick={(event) => void reviewPurge("age", event.currentTarget)}
            >
              {busyId === "purge-review-age" ? "Reviewing..." : "Run age cleanup..."}
            </button>
          ) : null}
        </div>
        {policyPreview === null ? null : (
          <div className="trash-workbench__policy-review" role="status">
            <strong>Policy review</strong>
            <p>
              {policyPreview.policy.enabled
                ? `${policyPreview.eligible_count} current ${policyPreview.eligible_count === 1 ? "item meets" : "items meet"} this age. Saving the policy will not delete them.`
                : "Age cleanup will be disabled. No items will be deleted."}
            </p>
            {policyPreview.eligible_entries.length > 0 ? (
              <ul>
                {policyPreview.eligible_entries.map((entry) => (
                  <li key={entry.object_id}>
                    {entry.title} - moved {trashedTime(entry.trashed_at)}
                  </li>
                ))}
              </ul>
            ) : null}
            <button
              className="button button--primary"
              type="button"
              disabled={!writable || busyId !== null}
              onClick={() => void applyPolicy()}
            >
              {busyId === "policy-apply" ? "Saving..." : "Apply reviewed policy"}
            </button>
          </div>
        )}
      </section>

      {loading ? <p role="status">Reading workspace Trash...</p> : null}
      {!loading && entries.length === 0 && error === null ? (
        <div className="trash-workbench__empty">
          <h3>Trash is empty</h3>
          <p>Objects moved to Trash will appear here with their recovery impact.</p>
        </div>
      ) : null}
      {entries.length > 0 ? (
        <ul className="trash-workbench__list">
          {entries.map((entry) => (
            <li key={entry.object.id}>
              <div>
                <strong>{entry.object.title}</strong>
                <span>
                  {entry.object.type.replaceAll("_", " ")} / Moved{" "}
                  {trashedTime(entry.manifest.trashed_at)}
                </span>
                <small>
                  {entry.impact.relation_count}{" "}
                  {entry.impact.relation_count === 1 ? "relation" : "relations"}
                  {entry.impact.relation_types.length === 0
                    ? ""
                    : `: ${entry.impact.relation_types.join(", ")}`}
                </small>
              </div>
              <button
                className="button button--primary"
                type="button"
                disabled={!writable || busyId !== null}
                title={!writable ? "This workspace is read only" : undefined}
                onClick={() => void restore(entry)}
              >
                {busyId === entry.object.id ? "Restoring..." : "Restore"}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {message === null ? null : (
        <p role="status" className="trash-workbench__message">
          {message}
        </p>
      )}
      {error === null ? null : (
        <p role="alert" className="trash-workbench__error">
          {error}
        </p>
      )}

      {purgePreview === null ? null : (
        <div className="trash-workbench__dialog-backdrop">
          <div
            ref={dialogRef}
            className="trash-workbench__dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="purge-title"
            aria-describedby="purge-description"
            onKeyDown={handleDialogKeyDown}
          >
            <span>Permanent deletion</span>
            <h3 id="purge-title">
              {purgePreview.scope === "all" ? "Empty Trash?" : "Run age cleanup?"}
            </h3>
            <p id="purge-description">
              This permanently removes {purgePreview.entry_count}{" "}
              {purgePreview.entry_count === 1 ? "item" : "items"} from recoverable Trash. You cannot
              restore them, and no Undo is available.
            </p>
            <dl className="trash-workbench__impact">
              <div>
                <dt>Trash items</dt>
                <dd>{purgePreview.entry_count}</dd>
              </div>
              <div>
                <dt>Relation tombstones removed</dt>
                <dd>{purgePreview.relation_count}</dd>
              </div>
              <div>
                <dt>Related objects affected</dt>
                <dd>{purgePreview.related_object_count}</dd>
              </div>
              <div>
                <dt>Asset records</dt>
                <dd>{purgePreview.asset_count}</dd>
              </div>
            </dl>
            <div className="trash-workbench__targets">
              <strong>Exact targets</strong>
              <ul>
                {purgePreview.entries.map((entry) => (
                  <li key={entry.object_id}>
                    <span>{entry.title}</span>
                    <small>
                      {entry.object_type.replaceAll("_", " ")} / moved{" "}
                      {trashedTime(entry.trashed_at)}
                    </small>
                  </li>
                ))}
              </ul>
            </div>
            <div className="trash-workbench__retention">
              <strong>What remains</strong>
              <p>
                {purgePreview.checkpoint_count} version{" "}
                {purgePreview.checkpoint_count === 1 ? "checkpoint remains" : "checkpoints remain"},{" "}
                including {purgePreview.object_checkpoint_count} object and{" "}
                {purgePreview.relation_checkpoint_count} relation checkpoints, along with canonical
                event evidence and a minimal permanent tombstone.
              </p>
              <ul>
                {purgePreview.limitations.map((limitation) => (
                  <li key={limitation}>{limitation}</li>
                ))}
              </ul>
            </div>
            <label className="trash-workbench__confirmation">
              Type <strong>{expectedConfirmation}</strong> to continue
              <input
                ref={confirmationRef}
                value={confirmation}
                disabled={busyId === "purge"}
                autoComplete="off"
                spellCheck="false"
                onChange={(event) => setConfirmation(event.currentTarget.value)}
              />
            </label>
            <div className="trash-workbench__dialog-actions">
              <button type="button" disabled={busyId === "purge"} onClick={closePurge}>
                Cancel
              </button>
              <button
                className="button button--danger"
                type="button"
                disabled={!writable || busyId === "purge" || confirmation !== expectedConfirmation}
                onClick={() => void purge()}
              >
                {busyId === "purge" ? "Permanently deleting..." : "Permanently delete"}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
