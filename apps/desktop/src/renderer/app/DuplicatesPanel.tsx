import { useCallback, useEffect, useState } from "react";
import { type Reference } from "@kiwi/contracts";
import { readBridge, type RendererCommandResult } from "./bridge.js";

/**
 * The Papers that look like the same work, shown side by side.
 *
 * This screen ends at showing and at Trash. Kiwi does not merge records, and the reason is worth
 * saying on the page rather than only here: a merge has to decide what happens to two sets of
 * annotations, two sets of files, and every claim that quotes one of them, and a merge that
 * quietly picks for you loses work that nobody knew was at stake. Until there is a merge worth
 * trusting, the honest offer is both records, the differences marked, and one button that moves
 * the copy you do not want somewhere it can be brought back from.
 */

interface DuplicateRecord {
  id: string;
  title: string;
  version: number;
  content_hash: string;
  updated_at: string;
  reference: Reference;
  files: number;
  annotations: number;
}

interface DuplicateGroup {
  reason: "doi" | "title";
  key: string;
  records: DuplicateRecord[];
}

/** What Trash would take with the record, read before anything is moved. */
interface PendingTrash {
  record: DuplicateRecord;
  impact: { relation_count: number; related_object_count: number };
  guards: unknown[];
}

/**
 * The fields worth comparing, in the order a reference is read in.
 *
 * Everything a bibliography would print, and nothing else. The abstract is left out on purpose:
 * two abstracts differ in the middle of a paragraph, and a table cell is the wrong place to find
 * that out.
 */
const FIELDS: Array<{ label: string; read: (record: DuplicateRecord) => string }> = [
  { label: "Kind", read: (record) => record.reference.kind },
  { label: "Authors", read: (record) => record.reference.authors.join("; ") },
  {
    label: "Year",
    read: (record) => (record.reference.year === null ? "" : String(record.reference.year)),
  },
  { label: "Published in", read: (record) => record.reference.container ?? "" },
  { label: "Publisher", read: (record) => record.reference.publisher ?? "" },
  { label: "Volume", read: (record) => record.reference.volume ?? "" },
  { label: "Issue", read: (record) => record.reference.issue ?? "" },
  { label: "Pages", read: (record) => record.reference.pages ?? "" },
  { label: "DOI", read: (record) => record.reference.doi ?? "" },
  { label: "Link", read: (record) => record.reference.url ?? "" },
];

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

/**
 * What is hanging off the record, which is what choosing between two of them is really about.
 *
 * Counts and not a list. The question at this moment is which of these two has the work in it,
 * and two numbers answer that without turning a comparison into a file browser.
 */
function attachedLabel(record: DuplicateRecord): string {
  const files = `${String(record.files)} ${record.files === 1 ? "file" : "files"}`;
  const annotations = `${String(record.annotations)} ${
    record.annotations === 1 ? "annotation" : "annotations"
  }`;
  const updated = new Date(record.updated_at);
  const when = Number.isNaN(updated.valueOf()) ? record.updated_at : updated.toLocaleDateString();
  return `${files}, ${annotations} · Updated ${when}`;
}

function groupHeading(group: DuplicateGroup): string {
  return group.reason === "doi"
    ? `${String(group.records.length)} records with the DOI ${group.key}`
    : `${String(group.records.length)} records with the same title`;
}

export function DuplicatesPanel({
  workspaceId,
  writable = true,
  onClose,
  onOpenObject,
  onChanged,
}: {
  workspaceId: string;
  writable?: boolean;
  onClose?: () => void;
  onOpenObject?: (objectId: string) => void;
  /** A record moved to Trash is one fewer row in the Library behind this screen. */
  onChanged?: () => void;
}): React.JSX.Element {
  const [groups, setGroups] = useState<DuplicateGroup[] | null>(null);
  const [pending, setPending] = useState<PendingTrash | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setError(null);
    try {
      const result = await invoke(workspaceId, "kiwi.object.duplicate-candidates", {});
      if (result.error !== undefined) throw new Error(result.error.message);
      setGroups(((result.data ?? {})["groups"] as DuplicateGroup[] | undefined) ?? []);
    } catch (cause) {
      setGroups([]);
      setError(cause instanceof Error ? cause.message : "Kiwi could not read the Library.");
    }
  }, [workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Reads what Trash would take before offering to take it.
   *
   * The same two steps the rest of Kiwi uses, and for the same reason: a record with eleven
   * relations hanging off it is a different decision from a record with none, and the moment to
   * learn which one this is is before the button, not after.
   */
  async function reviewTrash(record: DuplicateRecord): Promise<void> {
    setBusyId(record.id);
    setError(null);
    setMessage(null);
    try {
      const result = await invoke(workspaceId, "kiwi.object.validate-trash", {
        object_id: record.id,
        expected_version: record.version,
        expected_hash: record.content_hash,
      });
      if (result.error !== undefined) throw new Error(result.error.message);
      const preview = (result.data ?? {})["preview"] as
        | {
            impact?: { relation_count: number; related_object_count: number };
            relation_guards?: unknown[];
          }
        | undefined;
      if (preview?.impact === undefined || !Array.isArray(preview.relation_guards))
        throw new Error("Kiwi did not return Trash impact.");
      setPending({ record, impact: preview.impact, guards: preview.relation_guards });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Kiwi could not preview this deletion.");
    } finally {
      setBusyId(null);
    }
  }

  async function confirmTrash(): Promise<void> {
    if (pending === null) return;
    setBusyId(pending.record.id);
    setError(null);
    try {
      const result = await invoke(workspaceId, "kiwi.object.trash", {
        object_id: pending.record.id,
        expected_version: pending.record.version,
        expected_hash: pending.record.content_hash,
        expected_relations: pending.guards,
      });
      if (result.error !== undefined) throw new Error(result.error.message);
      setMessage(
        `Moved ${pending.record.title} to workspace Trash. It can be restored, with its relations.`,
      );
      setPending(null);
      onChanged?.();
      // The group this record was in is either gone or down to one record, and either way it is
      // not the list that was on the screen a moment ago.
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Kiwi could not move this to Trash.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="duplicates" aria-labelledby="duplicates-title">
      <header className="duplicates__header">
        <div>
          <span>Library</span>
          <h3 id="duplicates-title">Possible duplicates</h3>
        </div>
        <div className="duplicates__actions">
          <button className="button" type="button" onClick={() => void load()}>
            Check again
          </button>
          {onClose === undefined ? null : (
            <button className="button" type="button" onClick={onClose}>
              Back to the Library
            </button>
          )}
        </div>
      </header>

      <p className="duplicates__note">
        Kiwi does not merge records, and nothing here will. Moving one to Trash leaves the other
        exactly as it stands, and takes that record&apos;s files, annotations and claims with it;
        Trash can give them back. Anything worth keeping from the copy you are throwing away has to
        be copied across by hand first.
      </p>

      {error !== null ? (
        <p className="auth__error" role="alert">
          {error}
        </p>
      ) : null}
      {message !== null ? (
        <p className="duplicates__message" role="status">
          {message}
        </p>
      ) : null}

      {groups === null ? (
        <p className="duplicates__quiet">Reading the Library</p>
      ) : groups.length === 0 ? (
        <p className="duplicates__quiet">
          Nothing here looks like the same work twice. Kiwi groups Papers that share a DOI, and
          Papers whose titles are the same once case and punctuation are set aside.
        </p>
      ) : (
        groups.map((group) => (
          <section
            className="duplicates__group"
            key={`${group.reason}:${group.key}`}
            aria-label={groupHeading(group)}
          >
            <h4>{groupHeading(group)}</h4>
            <div className="duplicates__table-wrap">
              <table className="duplicates__table">
                <thead>
                  <tr>
                    <th scope="col">Field</th>
                    {group.records.map((record) => (
                      <th scope="col" key={record.id}>
                        {/*
                          The title heads the column rather than sitting in a row of its own. It is
                          what tells the two columns apart while the fields underneath are read,
                          and two records grouped by their DOI often differ here first.
                        */}
                        {record.title}
                        <span className="duplicates__attached">{attachedLabel(record)}</span>
                        <div className="duplicates__actions">
                          {onOpenObject === undefined ? null : (
                            <button
                              className="button"
                              type="button"
                              onClick={() => onOpenObject(record.id)}
                            >
                              Open
                            </button>
                          )}
                          {writable ? (
                            <button
                              className="button"
                              type="button"
                              disabled={busyId !== null}
                              aria-label={`Move ${record.title} to Trash`}
                              onClick={() => void reviewTrash(record)}
                            >
                              Move to Trash
                            </button>
                          ) : null}
                        </div>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {FIELDS.filter((field) =>
                    // A row that is empty in every record is not a difference, and a table of
                    // blank rows is where the differences that matter get lost.
                    group.records.some((record) => field.read(record).trim() !== ""),
                  ).map((field) => {
                    const values = group.records.map((record) => field.read(record).trim());
                    const differs = new Set(values).size > 1;
                    return (
                      <tr
                        key={field.label}
                        className={differs ? "duplicates__row--differs" : undefined}
                      >
                        <th scope="row">
                          {field.label}
                          {differs ? (
                            <span className="duplicates__mark">
                              {" "}
                              <span aria-hidden="true">&#9679;</span>
                              <span className="sr-only">differs</span>
                            </span>
                          ) : null}
                        </th>
                        {values.map((value, index) => (
                          <td key={group.records[index]?.id ?? index}>
                            {value === "" ? (
                              <span className="duplicates__quiet">Not recorded</span>
                            ) : (
                              value
                            )}
                          </td>
                        ))}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {pending !== null && group.records.some((record) => record.id === pending.record.id) ? (
              <div className="duplicates__confirm" role="status">
                <p>
                  Move {pending.record.title} to Trash? {pending.impact.relation_count}{" "}
                  {pending.impact.relation_count === 1 ? "relation" : "relations"} and{" "}
                  {pending.impact.related_object_count}{" "}
                  {pending.impact.related_object_count === 1 ? "related object" : "related objects"}{" "}
                  go with it. Nothing is merged into the record that stays.
                </p>
                <div className="settings-inline">
                  <button
                    className="button button--danger"
                    type="button"
                    disabled={busyId !== null}
                    onClick={() => void confirmTrash()}
                  >
                    Move to Trash
                  </button>
                  <button
                    className="button"
                    type="button"
                    disabled={busyId !== null}
                    onClick={() => setPending(null)}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : null}
          </section>
        ))
      )}
    </section>
  );
}
