import { useCallback, useEffect, useState } from "react";
import {
  readReference,
  type CitationSegment,
  type CitationStyle,
  type Reference,
} from "@kiwi/contracts";
import { ReferenceFields } from "./ReferenceFields.js";
import { readBridge, type RendererCommandResult } from "./bridge.js";

/**
 * The Bibliography page.
 *
 * Built from what a manuscript actually cites, never from the whole library: a reference list
 * holding everything the author happens to own is wrong in a way that gets a paper rejected.
 *
 * The two reports beside it are the point of the page. A citation whose Paper has been deleted,
 * and a Paper that was read but never cited, are both mistakes an author cannot see by reading
 * their own draft.
 */

export interface BibliographyEntry {
  id: string;
  key: string;
  number: number;
  title: string;
  text: string;
  segments: CitationSegment[];
  in_text: string;
  /** How many times the manuscript cites this work, not how many entries it has. */
  count: number;
  incomplete: string[];
}

export interface BibliographyData {
  style: CitationStyle;
  numbered: boolean;
  entries: BibliographyEntry[];
  broken: Array<{ object_id: string; reason: string }>;
  uncited: Array<{ id: string; title: string }>;
  bibtex: string;
}

export interface BibliographyPageProps {
  workspaceId: string;
  style: CitationStyle;
  /** The manuscript whose citations this list is built from. */
  manuscriptId: string | null;
  manuscriptTitle?: string;
  onOpenObject?: (objectId: string, type: string) => void;
}

async function invoke(
  workspaceId: string,
  command: string,
  args: Record<string, unknown>,
): Promise<RendererCommandResult | null> {
  const bridge = readBridge();
  if (bridge === null) return null;
  return bridge
    .invokeCommand({
      protocol_version: "1.0.0",
      request_id: crypto.randomUUID(),
      workspace_id: workspaceId,
      command,
      args,
    })
    .catch(() => null);
}

const REASONS: Record<string, string> = {
  deleted: "The Paper has been deleted or moved to Trash.",
  no_reference: "The Paper has no bibliographic record yet.",
};

/** The Paper an entry stands for, as it reads on disk right now. */
interface EntryEdit {
  id: string;
  version: number;
  hash: string;
  reference: Reference;
}

function citedTimes(count: number): string {
  if (count <= 0) return "Not cited in the text";
  if (count === 1) return "Cited once";
  return `Cited ${String(count)} times`;
}

export function BibliographyPage({
  workspaceId,
  style,
  manuscriptId,
  manuscriptTitle = "this manuscript",
  onOpenObject,
}: BibliographyPageProps): React.JSX.Element {
  const [data, setData] = useState<BibliographyData | null>(null);
  // Which thing was copied, not merely that something was, so the confirmation sits beside
  // the button that was pressed.
  const [copied, setCopied] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<EntryEdit | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    if (manuscriptId === null) {
      setData(null);
      return;
    }
    setBusy(true);
    const result = await invoke(workspaceId, "kiwi.bibliography.for-document", {
      object_id: manuscriptId,
      style,
    });
    setBusy(false);
    if (result === null || result.error !== undefined) return;
    setData(result.data as unknown as BibliographyData);
  }, [manuscriptId, style, workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function copy(text: string, token: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(token);
    } catch {
      // A machine that refuses clipboard access still shows the text on the page to copy by
      // hand, so this says nothing rather than claiming a copy that did not happen.
      setCopied(null);
    }
  }

  /**
   * Opens the entry's Paper for correction.
   *
   * The record is read here rather than carried in the list, because saving it quotes a version
   * and a hash. Reading them at the moment the form opens is the difference between a correction
   * that fails cleanly on a stale record and one that overwrites an edit made elsewhere.
   */
  async function startEditing(id: string): Promise<void> {
    setError(null);
    setCopied(null);
    const result = await invoke(workspaceId, "kiwi.object.read", { object_id: id });
    const object = result?.data?.["object"] as Record<string, unknown> | undefined;
    if (result === null || result.error !== undefined || object === undefined) {
      setError("Kiwi could not read that Paper.");
      return;
    }
    setEditing({
      id,
      version: Number(object["version"] ?? 0),
      hash: String(object["content_hash"] ?? ""),
      reference: readReference(object["reference"]),
    });
  }

  async function saveEditing(): Promise<void> {
    if (editing === null) return;
    setBusy(true);
    setError(null);
    const result = await invoke(workspaceId, "kiwi.object.set-reference", {
      object_id: editing.id,
      expected_version: editing.version,
      expected_hash: editing.hash,
      reference: editing.reference,
    });
    setBusy(false);
    if (result === null || result.error !== undefined) {
      setError(result?.error?.message ?? "Kiwi could not save that reference.");
      return;
    }
    setEditing(null);
    // The entry, its in-text form, and the ordering are all built from the record that just
    // changed, so the list is rebuilt rather than patched in place.
    await load();
  }

  if (manuscriptId === null) {
    return (
      <section className="bibliography" aria-labelledby="bibliography-title">
        <h3 id="bibliography-title">Bibliography</h3>
        <p className="bibliography__quiet">
          A reference list belongs to a manuscript. Open one, and what it cites appears here.
        </p>
      </section>
    );
  }

  return (
    <section className="bibliography" aria-labelledby="bibliography-title">
      <header>
        <h3 id="bibliography-title">Bibliography</h3>
        <p className="bibliography__quiet">
          What {manuscriptTitle} cites, in {style.toLocaleUpperCase()}. Change the style in project
          settings.
        </p>
      </header>

      {error !== null ? (
        <p className="auth__error" role="alert">
          {error}
        </p>
      ) : null}

      {data === null ? (
        <p className="bibliography__quiet">
          {busy ? "Building the reference list" : "Nothing yet."}
        </p>
      ) : (
        <>
          <section aria-labelledby="bibliography-entries-title">
            <h4 id="bibliography-entries-title">
              {data.entries.length} cited {data.entries.length === 1 ? "work" : "works"}
            </h4>
            {data.entries.length === 0 ? (
              <p className="bibliography__quiet">
                This manuscript cites nothing yet. Insert a citation while writing and it appears
                here.
              </p>
            ) : (
              <ol className="bibliography__entries">
                {data.entries.map((entry) => (
                  <li key={entry.id}>
                    <button
                      type="button"
                      onClick={() => onOpenObject?.(entry.id, "source")}
                      aria-label={entry.title}
                    >
                      {entry.segments.map((segment, index) =>
                        segment.italic === true ? (
                          <em key={index}>{segment.text}</em>
                        ) : (
                          <span key={index}>{segment.text}</span>
                        ),
                      )}
                    </button>
                    <p className="bibliography__count">
                      {citedTimes(entry.count)} as {entry.in_text}
                    </p>
                    {entry.incomplete.length === 0 ? null : (
                      <p className="bibliography__incomplete">
                        Missing {entry.incomplete.join(", ")}. This style needs{" "}
                        {entry.incomplete.length === 1 ? "it" : "them"} to format the entry
                        correctly.
                      </p>
                    )}
                    <div className="bibliography__actions">
                      <button
                        className="button"
                        type="button"
                        aria-label={`Copy the reference for ${entry.title}`}
                        onClick={() => void copy(entry.text, `entry:${entry.id}`)}
                      >
                        Copy reference
                      </button>
                      <button
                        className="button"
                        type="button"
                        aria-label={`Copy the in-text citation for ${entry.title}`}
                        onClick={() => void copy(entry.in_text, `in-text:${entry.id}`)}
                      >
                        Copy in-text
                      </button>
                      <button
                        className="button"
                        type="button"
                        aria-label={`Fix the details for ${entry.title}`}
                        disabled={busy}
                        onClick={() => {
                          if (editing?.id === entry.id) setEditing(null);
                          else void startEditing(entry.id);
                        }}
                      >
                        {editing?.id === entry.id ? "Close" : "Fix details"}
                      </button>
                      {copied === `entry:${entry.id}` ? <span role="status">Copied</span> : null}
                      {copied === `in-text:${entry.id}` ? <span role="status">Copied</span> : null}
                    </div>
                    {editing?.id === entry.id ? (
                      <form
                        className="settings-form"
                        aria-label={`Details for ${entry.title}`}
                        onSubmit={(event) => {
                          event.preventDefault();
                          void saveEditing();
                        }}
                      >
                        <ReferenceFields
                          reference={editing.reference}
                          workspaceId={workspaceId}
                          objectId={editing.id}
                          idPrefix="bibliography"
                          disabled={busy}
                          onChange={(reference) =>
                            setEditing((current) =>
                              current === null ? null : { ...current, reference },
                            )
                          }
                        />
                        <div className="settings-inline">
                          <button className="button button--primary" type="submit" disabled={busy}>
                            {busy ? "Saving" : "Save reference"}
                          </button>
                          <button
                            className="button"
                            type="button"
                            disabled={busy}
                            onClick={() => setEditing(null)}
                          >
                            Cancel
                          </button>
                        </div>
                      </form>
                    ) : null}
                  </li>
                ))}
              </ol>
            )}
          </section>

          {data.broken.length === 0 ? null : (
            <section aria-labelledby="bibliography-broken-title">
              <h4 id="bibliography-broken-title">Broken citations</h4>
              <p className="bibliography__quiet">
                These are cited in the text but cannot be resolved. Left alone they reach the
                submitted manuscript.
              </p>
              <ul className="bibliography__broken">
                {data.broken.map((entry) => (
                  <li key={entry.object_id}>
                    <code>{entry.object_id}</code>
                    <span>{REASONS[entry.reason] ?? entry.reason}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {data.uncited.length === 0 ? null : (
            <section aria-labelledby="bibliography-uncited-title">
              <h4 id="bibliography-uncited-title">
                In the Library, not cited ({data.uncited.length})
              </h4>
              <ul className="bibliography__uncited">
                {data.uncited.map((entry) => (
                  <li key={entry.id}>
                    <button type="button" onClick={() => onOpenObject?.(entry.id, "source")}>
                      {entry.title}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section aria-labelledby="bibliography-bibtex-title">
            <h4 id="bibliography-bibtex-title">BibTeX</h4>
            <div className="bibliography__actions">
              <button
                className="button"
                type="button"
                onClick={() => void copy(data.bibtex, "bibtex")}
              >
                Copy
              </button>
              {copied === "bibtex" ? <span role="status">Copied</span> : null}
            </div>
            <pre className="bibliography__bibtex">{data.bibtex}</pre>
          </section>
        </>
      )}
    </section>
  );
}
