import { useEffect, useState } from "react";
import { compareObjectVersions, type ObjectVersionComparison } from "@kiwi/contracts";
import { readBridge, type RendererCommandResult } from "./bridge.js";

interface HistoryObjectView {
  id: string;
  type: string;
  title: string;
  content: string;
  version: number;
  content_hash: string;
  updated_at: string;
  updated_by: string;
}

interface HistoryEntryView {
  version: number;
  content_hash: string;
  title: string;
  updated_at: string;
  updated_by: string;
}

interface ActivityEntryView {
  id: string;
  event_type: string;
  occurred_at: string;
  actor: string;
  transaction_id: string;
  version: number | null;
  reason: string | null;
}

interface RestoreImpactView {
  relation_count: number;
  incoming_count: number;
  outgoing_count: number;
  related_object_count: number;
  relation_types: string[];
}

interface RestorePreviewView {
  source: HistoryObjectView;
  current_version: number;
  next_version: number;
  history_count: number;
  impact: RestoreImpactView;
}

export interface RestorationReceiptView {
  object: HistoryObjectView;
  sourceVersion: number;
  historyCount: number;
  transactionId: string;
  eventIds: string[];
  impact: RestoreImpactView;
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

function displayTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
}

function activityForVersion(
  activity: ActivityEntryView[],
  version: number,
): ActivityEntryView | null {
  return [...activity].reverse().find((entry) => entry.version === version) ?? null;
}

export function ObjectHistoryPanel({
  workspaceId,
  object,
  writable,
  restoreBlocked,
  onRestored,
}: {
  workspaceId: string;
  object: HistoryObjectView;
  writable: boolean;
  restoreBlocked: boolean;
  onRestored?: (receipt: RestorationReceiptView) => void;
}): React.JSX.Element {
  const [history, setHistory] = useState<HistoryEntryView[]>([]);
  const [activity, setActivity] = useState<ActivityEntryView[]>([]);
  const [selected, setSelected] = useState<number[]>([]);
  const [comparison, setComparison] = useState<ObjectVersionComparison | null>(null);
  const [restorePreview, setRestorePreview] = useState<RestorePreviewView | null>(null);
  const [restoreReason, setRestoreReason] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    setComparison(null);
    setRestorePreview(null);
    void invoke(workspaceId, "kiwi.object.history", { object_id: object.id })
      .then((result) => {
        if (!active) return;
        if (result.error !== undefined) throw new Error(result.error.message);
        const nextHistory =
          ((result.data ?? {})["history"] as HistoryEntryView[] | undefined) ?? [];
        setHistory(nextHistory);
        setActivity(((result.data ?? {})["activity"] as ActivityEntryView[] | undefined) ?? []);
        setSelected(nextHistory.slice(-2).map((entry) => entry.version));
      })
      .catch((cause: unknown) => {
        if (active)
          setError(cause instanceof Error ? cause.message : "Kiwi could not read this history.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [object.id, object.version, workspaceId]);

  function toggleVersion(version: number, checked: boolean): void {
    setComparison(null);
    setRestorePreview(null);
    setSelected((current) =>
      checked
        ? [...current, version].sort((left, right) => left - right)
        : current.filter((item) => item !== version),
    );
  }

  async function compareSelected(): Promise<void> {
    if (selected.length !== 2) return;
    setBusy(true);
    setError(null);
    setRestorePreview(null);
    try {
      const results = await Promise.all(
        selected.map((version) =>
          invoke(workspaceId, "kiwi.object.read-version", {
            object_id: object.id,
            version,
          }),
        ),
      );
      const failed = results.find((result) => result.error !== undefined);
      if (failed?.error !== undefined) throw new Error(failed.error.message);
      const versions = results.map((result) => (result.data ?? {})["object"] as HistoryObjectView);
      setComparison(compareObjectVersions(versions[0]!, versions[1]!));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Kiwi could not compare these versions.");
    } finally {
      setBusy(false);
    }
  }

  async function reviewRestore(version: number): Promise<void> {
    if (!writable || restoreBlocked || version === object.version) return;
    setBusy(true);
    setError(null);
    try {
      const result = await invoke(workspaceId, "kiwi.object.validate-restore", {
        object_id: object.id,
        restore_version: version,
        expected_version: object.version,
        expected_hash: object.content_hash,
      });
      if (result.error !== undefined) throw new Error(result.error.message);
      const preview = (result.data ?? {})["preview"] as RestorePreviewView | undefined;
      if (preview === undefined) throw new Error("Kiwi did not return a restoration review.");
      setRestorePreview(preview);
      setRestoreReason(`Restore version ${version}`);
    } catch (cause) {
      setError(
        `${cause instanceof Error ? cause.message : "Kiwi could not review this restoration."} No version was changed.`,
      );
    } finally {
      setBusy(false);
    }
  }

  async function restoreVersion(): Promise<void> {
    if (restorePreview === null || restoreReason.trim() === "") return;
    setBusy(true);
    setError(null);
    try {
      const result = await invoke(workspaceId, "kiwi.object.restore-version", {
        object_id: object.id,
        restore_version: restorePreview.source.version,
        expected_version: object.version,
        expected_hash: object.content_hash,
        reason: restoreReason.trim(),
      });
      if (result.error !== undefined) throw new Error(result.error.message);
      const restored = (result.data ?? {})["object"] as HistoryObjectView | undefined;
      const receipt = (result.data ?? {})["restore"] as
        { source_version: number; history_count: number; impact: RestoreImpactView } | undefined;
      if (restored === undefined || receipt === undefined || result.transaction_id === undefined)
        throw new Error("Kiwi did not return a complete restoration receipt.");
      onRestored?.({
        object: restored,
        sourceVersion: receipt.source_version,
        historyCount: receipt.history_count,
        transactionId: result.transaction_id,
        eventIds: result.event_ids ?? [],
        impact: receipt.impact,
      });
    } catch (cause) {
      setError(
        `${cause instanceof Error ? cause.message : "Kiwi could not restore this version."} Historical versions remain unchanged.`,
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      className="object-history-panel"
      aria-label="Version history"
      aria-busy={loading || busy}
    >
      <header>
        <div>
          <strong>Version history</strong>
          <span>Select two immutable versions to compare.</span>
        </div>
        <button
          type="button"
          disabled={selected.length !== 2 || busy}
          onClick={() => void compareSelected()}
        >
          Compare selected
        </button>
      </header>

      {loading ? <p>Reading immutable checkpoints…</p> : null}
      {!loading && history.length === 0 ? <p>No readable versions were found.</p> : null}
      {history.length > 0 ? (
        <ol className="object-history-panel__list">
          {[...history].reverse().map((entry) => {
            const event = activityForVersion(activity, entry.version);
            const checked = selected.includes(entry.version);
            return (
              <li key={entry.version}>
                <label>
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={!checked && selected.length >= 2}
                    aria-label={`Compare version ${entry.version}`}
                    onChange={(change) => toggleVersion(entry.version, change.target.checked)}
                  />
                  <span>
                    <strong>Version {entry.version}</strong>
                    {entry.version === object.version ? (
                      <small>Current</small>
                    ) : (
                      <small>Historical</small>
                    )}
                  </span>
                </label>
                <div>
                  <span>{entry.title}</span>
                  <small>
                    {displayTime(entry.updated_at)} · {event?.actor ?? entry.updated_by}
                  </small>
                  {event?.reason === null || event?.reason === undefined ? null : (
                    <small>{event.reason}</small>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      ) : null}

      {comparison === null ? null : (
        <section className="object-version-compare" aria-label="Version comparison">
          <header>
            <strong>
              Version {comparison.before.version} compared with version {comparison.after.version}
            </strong>
            <span>{comparison.changed ? "Content differs" : "User content is identical"}</span>
          </header>
          <div className="object-version-compare__snapshots">
            {[comparison.before, comparison.after].map((version) => (
              <article key={version.version} aria-label={`Read-only version ${version.version}`}>
                <span>Version {version.version} · read only</span>
                <strong>{version.title}</strong>
                <pre>{version.content}</pre>
                {version.version === object.version ? (
                  <small>Current version</small>
                ) : (
                  <button
                    type="button"
                    disabled={!writable || restoreBlocked || busy}
                    title={
                      !writable
                        ? "This workspace is read only"
                        : restoreBlocked
                          ? "Save or discard the recovery draft before restoring history"
                          : `Review restoring version ${version.version}`
                    }
                    onClick={() => void reviewRestore(version.version)}
                  >
                    Restore version {version.version}
                  </button>
                )}
              </article>
            ))}
          </div>
          <div className="object-version-compare__fields">
            <strong>Title</strong>
            <span>{comparison.fields[0]!.before}</span>
            <span aria-label="changed to">→</span>
            <span>{comparison.fields[0]!.after}</span>
          </div>
          <ol className="object-version-diff" aria-label="Markdown line changes">
            {comparison.markdown.map((line, index) => (
              <li key={`${index}-${line.kind}`} data-kind={line.kind}>
                <span aria-hidden="true">
                  {line.kind === "added" ? "+" : line.kind === "removed" ? "−" : " "}
                </span>
                <code>{line.text === "" ? " " : line.text}</code>
              </li>
            ))}
          </ol>
          {comparison.simplified ? (
            <small>The line view is simplified because these versions are large.</small>
          ) : null}
        </section>
      )}

      {restorePreview === null ? null : (
        <section className="object-restore-review" aria-label="Restoration review">
          <div>
            <strong>Restore version {restorePreview.source.version}</strong>
            <span>
              Kiwi will create version {restorePreview.next_version}. All{" "}
              {restorePreview.history_count} existing versions remain unchanged.
            </span>
          </div>
          {restorePreview.impact.relation_count > 0 ? (
            <p>
              {restorePreview.impact.relation_count} linked{" "}
              {restorePreview.impact.relation_count === 1 ? "relation remains" : "relations remain"}{" "}
              attached to this object identity.
            </p>
          ) : null}
          <label>
            <span>Restoration reason</span>
            <input
              value={restoreReason}
              maxLength={500}
              onChange={(event) => setRestoreReason(event.target.value)}
            />
          </label>
          <div>
            <button
              type="button"
              className="canonical-editor__publish"
              disabled={busy || restoreReason.trim() === ""}
              onClick={() => void restoreVersion()}
            >
              Restore as version {restorePreview.next_version}
            </button>
            <button type="button" disabled={busy} onClick={() => setRestorePreview(null)}>
              Cancel
            </button>
          </div>
        </section>
      )}

      {error === null ? null : (
        <div className="canonical-editor__error" role="alert">
          {error}
        </div>
      )}
    </section>
  );
}
