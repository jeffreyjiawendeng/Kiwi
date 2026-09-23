import { useCallback, useEffect, useId, useState } from "react";
import {
  PAPER_SUMMARY_LIMIT,
  primaryFileId,
  readPaperReadState,
  readPaperSummary,
  readReference,
  referenceSummary,
  tagLabel,
  type Reference,
} from "@kiwi/contracts";
import { LinksPanel } from "./LinksPanel.js";
import { ReferenceFields } from "./ReferenceFields.js";
import { readBridge } from "./bridge.js";
import { DropMenu } from "./DropMenu.js";

export interface PaperRecord {
  id: string;
  type: string;
  title: string;
  version: number;
  content_hash: string;
  reference?: unknown;
  summary?: unknown;
  read?: unknown;
  primary_asset_id?: unknown;
}

export interface AttachedFile {
  id: string;
  title: string;
  original_filename?: string;
  byte_size?: number;
  media_type?: { determined?: string };
}

interface PaperPanelProps {
  workspaceId: string;
  paper: PaperRecord;
  writable?: boolean;
  onOpenFile(assetId: string, title: string, objectId: string): void;
  onChanged?(paper: PaperRecord): void;
  /** Where a link out of this paper sends you. Absent, the links read as names. */
  onOpenObject?: (objectId: string, type: string) => void;
}

function fileSize(bytes: number | undefined): string {
  if (bytes === undefined) return "";
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function run(
  workspaceId: string,
  command: string,
  args: Record<string, unknown>,
): Promise<{ data: Record<string, unknown>; error?: string }> {
  const bridge = readBridge();
  if (bridge === null) return { data: {}, error: "Kiwi is not available." };
  const requestId = crypto.randomUUID();
  const result = await bridge.invokeCommand({
    protocol_version: "1.0.0",
    request_id: requestId,
    idempotency_key: requestId,
    workspace_id: workspaceId,
    command,
    args,
  });
  if (result.error !== undefined) return { data: {}, error: result.error.message };
  return { data: result.data ?? {} };
}

export function PaperPanel({
  workspaceId,
  paper,
  writable = true,
  onOpenFile,
  onChanged,
  onOpenObject,
}: PaperPanelProps): React.JSX.Element {
  const summaryFieldId = useId();
  const [stored, setStored] = useState<unknown>(paper.reference);
  const [reference, setReference] = useState<Reference>(() => readReference(paper.reference));
  const [summary, setSummary] = useState(() => readPaperSummary(paper.summary));
  const [read, setRead] = useState(() => readPaperReadState(paper.read));
  /** The file this Paper names, which is not always the one it opens to, see `primaryFileId`. */
  const [named, setNamed] = useState<unknown>(paper.primary_asset_id);
  /**
   * The version the next write is made against.
   *
   * The row this panel opened from is a moment old the instant anything is saved, and marking a
   * paper read is the one edit here somebody does twice in a row. Carrying the version forward
   * from whatever last answered means the second click is not a conflict.
   */
  const [revision, setRevision] = useState({
    version: paper.version,
    hash: paper.content_hash,
  });
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState(false);
  const [editingSummary, setEditingSummary] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [files, setFiles] = useState<AttachedFile[] | null>(null);
  const [missing, setMissing] = useState<readonly string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /**
   * The tags on this paper, which are relations beside the object rather than fields on it.
   *
   * Shown because a tag is how a screening decision is recorded -- "included", "needs review" --
   * and reading one off a chip is the difference between knowing where a paper stands and opening
   * a menu to find out.
   */
  const [tags, setTags] = useState<string[]>([]);

  useEffect(() => {
    setReference(readReference(paper.reference));
    setStored(paper.reference);
    setSummary(readPaperSummary(paper.summary));
    setRead(readPaperReadState(paper.read));
    setNamed(paper.primary_asset_id);
    setRevision({ version: paper.version, hash: paper.content_hash });
    setEditing(false);
    setEditingSummary(false);
  }, [
    paper.id,
    paper.reference,
    paper.summary,
    paper.read,
    paper.primary_asset_id,
    paper.version,
    paper.content_hash,
  ]);

  /** Takes the version off whatever the workspace last returned, when it returned one. */
  const adopt = useCallback((record: Record<string, unknown> | undefined): void => {
    if (record === undefined) return;
    const version = Number(record["version"]);
    const hash = record["content_hash"];
    if (Number.isInteger(version) && typeof hash === "string") setRevision({ version, hash });
  }, []);

  /**
   * The written fields come from the canonical object, not from the row that opened this panel.
   *
   * The Library draws its rows from the index, and the index holds no reference record: a form
   * seeded from that row would open empty over a Paper that has one, and saving it would write
   * the empty one back. Until this read lands, the reference cannot be edited.
   */
  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    void (async () => {
      const { data } = await run(workspaceId, "kiwi.object.read", { object_id: paper.id });
      if (cancelled) return;
      const record = data["object"] as Record<string, unknown> | undefined;
      if (record !== undefined) {
        setStored(record["reference"]);
        setReference(readReference(record["reference"]));
        setSummary(readPaperSummary(record["summary"]));
        setRead(readPaperReadState(record["read"]));
        setNamed(record["primary_asset_id"]);
        adopt(record);
      }
      setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [adopt, paper.id, paper.version, workspaceId]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { data } = await run(workspaceId, "kiwi.object.organization", { object_id: paper.id });
      if (cancelled) return;
      const organization = data["organization"] as { tags?: unknown } | undefined;
      const listed = organization?.tags;
      setTags(
        Array.isArray(listed)
          ? listed.filter((value): value is string => typeof value === "string")
          : [],
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [paper.id, paper.version, workspaceId]);

  const loadFiles = useCallback(async () => {
    const { data, error: failure } = await run(workspaceId, "kiwi.object.files", {
      object_id: paper.id,
    });
    if (failure !== undefined) {
      setFiles([]);
      setMissing([]);
      return;
    }
    setFiles((data["files"] as AttachedFile[] | undefined) ?? []);
    setMissing((data["missing"] as string[] | undefined) ?? []);
  }, [paper.id, workspaceId]);

  useEffect(() => {
    void loadFiles();
  }, [loadFiles]);

  async function saveReference(): Promise<void> {
    setBusy(true);
    setError(null);
    setNotice(null);
    const { data, error: failure } = await run(workspaceId, "kiwi.object.set-reference", {
      object_id: paper.id,
      expected_version: revision.version,
      expected_hash: revision.hash,
      reference,
    });
    setBusy(false);
    if (failure !== undefined) {
      setError(failure);
      return;
    }
    setEditing(false);
    setNotice("Reference saved.");
    setStored(reference);
    const updated = data["object"] as PaperRecord | undefined;
    adopt(updated as Record<string, unknown> | undefined);
    if (updated !== undefined) onChanged?.(updated);
  }

  async function saveSummary(): Promise<void> {
    setBusy(true);
    setError(null);
    setNotice(null);
    const { data, error: failure } = await run(workspaceId, "kiwi.object.set-summary", {
      object_id: paper.id,
      expected_version: revision.version,
      expected_hash: revision.hash,
      summary: draft,
    });
    setBusy(false);
    if (failure !== undefined) {
      setError(failure);
      return;
    }
    // The stored line is what the command folded onto one line, not what was typed into the box.
    setSummary(typeof data["summary"] === "string" ? data["summary"] : draft.trim());
    setEditingSummary(false);
    setNotice("Summary saved.");
    const updated = data["object"] as PaperRecord | undefined;
    adopt(updated as Record<string, unknown> | undefined);
    if (updated !== undefined) onChanged?.(updated);
  }

  async function mark(next: boolean): Promise<void> {
    setBusy(true);
    setError(null);
    setNotice(null);
    const { data, error: failure } = await run(workspaceId, "kiwi.object.set-read", {
      object_id: paper.id,
      expected_version: revision.version,
      expected_hash: revision.hash,
      // The state to end in rather than a flip, so the button and the command agree even if
      // somebody else marked this paper between the panel opening and the click.
      read: next,
    });
    setBusy(false);
    if (failure !== undefined) {
      setError(failure);
      return;
    }
    setRead(next);
    setNotice(next ? "Marked read." : "Marked unread.");
    const updated = data["object"] as PaperRecord | undefined;
    adopt(updated as Record<string, unknown> | undefined);
    if (updated !== undefined) onChanged?.(updated);
  }

  async function choosePrimary(assetId: string): Promise<void> {
    setBusy(true);
    setError(null);
    setNotice(null);
    const { data, error: failure } = await run(workspaceId, "kiwi.object.set-primary-file", {
      object_id: paper.id,
      expected_version: revision.version,
      expected_hash: revision.hash,
      asset_id: assetId,
    });
    setBusy(false);
    if (failure !== undefined) {
      setError(failure);
      return;
    }
    setNamed(assetId);
    setNotice("This is the file the Reader will open.");
    const updated = data["object"] as PaperRecord | undefined;
    adopt(updated as Record<string, unknown> | undefined);
    if (updated !== undefined) onChanged?.(updated);
  }

  async function attachFile(): Promise<void> {
    const bridge = readBridge();
    if (bridge === null) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      // The file dialog lives in the main process, so a cancelled dialog returns nothing at
      // all and must not read as a failure.
      const chosen = await bridge.chooseManagedAsset();
      if (chosen === null || chosen === undefined) return;
      const imported = await run(workspaceId, "kiwi.asset.import-managed", {
        selection_id: chosen.id,
      });
      if (imported.error !== undefined) {
        setError(imported.error);
        return;
      }
      const asset = imported.data["asset"] as { id: string } | undefined;
      if (asset === undefined) {
        setError("Kiwi did not return the imported file.");
        return;
      }
      const attached = await run(workspaceId, "kiwi.object.attach-file", {
        object_id: paper.id,
        asset_id: asset.id,
      });
      if (attached.error !== undefined) {
        setError(attached.error);
        return;
      }
      setNotice("File attached.");
      await loadFiles();
    } catch {
      setError("Kiwi could not attach that file.");
    } finally {
      setBusy(false);
    }
  }

  /**
   * Hands the file to whatever application the system uses for it.
   *
   * The escape hatch. Kiwi reads PDFs and nothing else, and a PDF it reads badly is still a file
   * somebody needs today, so there has to be a way to see a file that does not depend on Kiwi
   * being able to draw it. Offered on a read-only workspace too: opening a file is a read.
   */
  async function openOutside(assetId: string): Promise<void> {
    setBusy(true);
    setError(null);
    setNotice(null);
    const { error: failure } = await run(workspaceId, "kiwi.asset.open-managed", {
      asset_id: assetId,
    });
    setBusy(false);
    if (failure !== undefined) {
      setError(failure);
      return;
    }
    // What the system does next is the system's business. Kiwi knows only that it took the file.
    setNotice("Handed to the application the system uses for this file.");
  }

  async function detach(assetId: string): Promise<void> {
    setBusy(true);
    setError(null);
    const { error: failure } = await run(workspaceId, "kiwi.object.detach-file", {
      object_id: paper.id,
      asset_id: assetId,
    });
    setBusy(false);
    if (failure !== undefined) {
      setError(failure);
      return;
    }
    // Detaching says this paper is not that file. The import itself is left alone.
    setNotice("File detached. The imported file is still in this workspace.");
    await loadFiles();
  }

  // "Vaswani et al. (2017)", built from the reference. Not the summary, which is written.
  const citation = referenceSummary(reference);

  /**
   * The file the Reader opens, worked out the same way here as anywhere else.
   *
   * A Paper with one file has a primary file without anybody choosing one, so the list says which
   * it is rather than offering a choice between one thing.
   */
  const primary = primaryFileId(
    (files ?? []).map((file) => file.id),
    named,
  );

  /**
   * The files the workspace listed but could not find, checked as the list was drawn.
   *
   * A file can be missing and still be the one this Paper opens to. Those are two different
   * things and the row says both, rather than quietly handing the default to another file and
   * leaving nobody to notice that one is gone.
   */
  const gone = new Set(missing);

  /** The file the primary button reads, and what its label says about it. */
  const primaryFile = files?.find((file) => file.id === primary) ?? null;
  const missingPrimary = primaryFile !== null && gone.has(primaryFile.id);

  function readFile(file: AttachedFile): void {
    onOpenFile(file.id, file.original_filename ?? paper.title, paper.id);
  }

  return (
    <section className="paper-panel" aria-label={`Details for ${paper.title}`}>
      <div className="paper-panel__identity">
        {/* Read or unread, and which version, on one line. Unread is where every paper starts,
            so it is said quietly; Read is the mark somebody put there. */}
        <span className="paper-panel__mark" data-read={read || undefined}>
          {read ? "Read" : "Unread"} · v{revision.version}
        </span>
        <h3>{paper.title}</h3>
        {citation === "" ? (
          <p className="paper-panel__empty">No reference details yet.</p>
        ) : (
          <p>{citation}</p>
        )}
      </div>

      <div className="paper-panel__open">
        {files === null ? (
          <button className="paper-panel__read" type="button" disabled>
            Reading the files
          </button>
        ) : primaryFile === null ? (
          <button className="paper-panel__read" type="button" disabled>
            No file attached
          </button>
        ) : files.length === 1 ? (
          <button
            className="paper-panel__read"
            type="button"
            data-missing={missingPrimary || undefined}
            disabled={missingPrimary}
            onClick={() => readFile(primaryFile)}
          >
            {missingPrimary ? "File is missing" : `Read PDF · ${fileSize(primaryFile.byte_size)}`}
          </button>
        ) : (
          // Several files, so the button is the way into all of them rather than a bet on one.
          <DropMenu
            label="Read PDF"
            className="paper-panel__read-menu"
            triggerClassName="paper-panel__read"
            trigger={
              <>
                Read PDF <span aria-hidden="true">&#8964;</span>
              </>
            }
          >
            {(close) =>
              // The primary first, because that is the one the Reader would have opened.
              [primaryFile, ...files.filter((file) => file.id !== primaryFile.id)].map((file) => (
                <button
                  key={file.id}
                  type="button"
                  role="menuitem"
                  disabled={gone.has(file.id)}
                  onClick={() => {
                    close();
                    readFile(file);
                  }}
                >
                  {file.original_filename ?? file.title}
                  {gone.has(file.id) ? " · file is missing" : ` · ${fileSize(file.byte_size)}`}
                </button>
              ))
            }
          </DropMenu>
        )}

        {/* Everything else a file can have done to it. Opening one is the common case and has the
            button; the rest are occasional and would be four buttons in a 300px panel. */}
        <DropMenu
          label="File actions"
          className="paper-panel__files-menu"
          align="end"
          trigger={<span aria-hidden="true">&#8943;</span>}
        >
          {(close) => (
            <>
              {writable ? (
                <button
                  type="button"
                  role="menuitem"
                  disabled={busy}
                  onClick={() => {
                    close();
                    void attachFile();
                  }}
                >
                  Attach a PDF
                </button>
              ) : null}
              {(files ?? []).map((file) => (
                <div key={file.id} className="paper-panel__file">
                  {/*
                    Said on the file rather than left to be inferred from which actions it is
                    missing. On a Paper with one file this is the whole of the feature.
                  */}
                  <span>
                    {file.original_filename ?? file.title}
                    {file.id === primary ? " · opens by default" : ""}
                  </span>
                  {gone.has(file.id) ? (
                    <span className="paper-panel__gone">File is missing</span>
                  ) : (
                    <button
                      type="button"
                      role="menuitem"
                      disabled={busy}
                      onClick={() => {
                        close();
                        void openOutside(file.id);
                      }}
                    >
                      Open outside Kiwi
                    </button>
                  )}
                  {/* Choosing a file nothing can open is a choice that can only disappoint. */}
                  {writable && file.id !== primary && !gone.has(file.id) ? (
                    <button
                      type="button"
                      role="menuitem"
                      disabled={busy}
                      onClick={() => {
                        close();
                        void choosePrimary(file.id);
                      }}
                    >
                      Open this one by default
                    </button>
                  ) : null}
                  {writable ? (
                    <button
                      type="button"
                      role="menuitem"
                      disabled={busy}
                      onClick={() => {
                        close();
                        void detach(file.id);
                      }}
                    >
                      Detach
                    </button>
                  ) : null}
                </div>
              ))}
            </>
          )}
        </DropMenu>
      </div>

      {files !== null && files.length === 0 && writable ? (
        <button
          className="paper-panel__attach"
          type="button"
          disabled={busy}
          onClick={() => void attachFile()}
        >
          Attach a PDF
        </button>
      ) : null}

      {/*
        The reader's own line about the work, above the record it was written against. It is
        what somebody coming back in six months reads instead of opening the PDF, so it is shown
        without asking rather than folded into the reference form.
      */}
      <section className="paper-panel__summary" aria-label="Summary in your own words">
        {editingSummary ? (
          <form
            className="settings-form"
            onSubmit={(event) => {
              event.preventDefault();
              void saveSummary();
            }}
          >
            <div className="settings-field">
              <label htmlFor={summaryFieldId}>Summary</label>
              <textarea
                id={summaryFieldId}
                rows={3}
                value={draft}
                maxLength={PAPER_SUMMARY_LIMIT}
                disabled={busy}
                placeholder="What this paper says, in your own words."
                onChange={(event) => setDraft(event.target.value)}
              />
              <p className="paper-panel__count">
                {PAPER_SUMMARY_LIMIT - draft.length} characters left
              </p>
            </div>
            <div className="settings-inline">
              <button className="button button--primary" type="submit" disabled={busy}>
                {busy ? "Saving" : "Save summary"}
              </button>
              <button
                className="button"
                type="button"
                disabled={busy}
                onClick={() => setEditingSummary(false)}
              >
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <>
            <div className="paper-panel__label">
              <span>Summary</span>
              {writable ? (
                <button
                  type="button"
                  disabled={busy || !loaded}
                  onClick={() => {
                    setDraft(summary);
                    setEditingSummary(true);
                  }}
                >
                  {summary === "" ? "Write a summary" : "Edit summary"}
                </button>
              ) : null}
            </div>
            {summary === "" ? (
              <p className="paper-panel__empty">No summary yet.</p>
            ) : (
              <p>{summary}</p>
            )}
          </>
        )}
      </section>

      {editing ? (
        <form
          className="settings-form"
          onSubmit={(event) => {
            event.preventDefault();
            void saveReference();
          }}
        >
          <ReferenceFields
            reference={reference}
            onChange={setReference}
            workspaceId={workspaceId}
            objectId={paper.id}
            disabled={busy}
          />

          <div className="settings-inline">
            <button className="button button--primary" type="submit" disabled={busy}>
              {busy ? "Saving" : "Save reference"}
            </button>
            <button
              className="button"
              type="button"
              disabled={busy}
              onClick={() => {
                setReference(readReference(stored));
                setEditing(false);
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      ) : null}

      {/*
        What has already been made of this paper. It sits under the reading matter because reading
        comes before what was written about the reading, and because a paper nobody has used yet
        shows one quiet line here rather than an empty region above the thing people came for.
      */}
      {/* No heading of its own: the links panel already heads each direction, and "Draws on this"
          above "Draws on" was the same words twice. */}
      <section className="paper-panel__links" aria-label="What draws on this">
        <LinksPanel
          workspaceId={workspaceId}
          objectId={paper.id}
          {...(onOpenObject === undefined ? {} : { onOpen: onOpenObject })}
        />
      </section>

      {tags.length === 0 ? null : (
        <section className="paper-panel__tags" aria-label="Tags">
          <div className="paper-panel__label">
            <span>Tags</span>
          </div>
          <div className="paper-panel__chips">
            {tags.map((tag) => (
              <span key={tag}>{tagLabel(tag)}</span>
            ))}
          </div>
        </section>
      )}

      {writable ? (
        <div className="paper-panel__actions">
          <button
            type="button"
            disabled={busy || !loaded}
            onClick={() => setEditing((value) => !value)}
          >
            {editing ? "Close" : "Edit reference"}
          </button>
          <button type="button" disabled={busy || !loaded} onClick={() => void mark(!read)}>
            {read ? "Mark unread" : "Mark read"}
          </button>
        </div>
      ) : null}

      {error !== null ? (
        <p className="auth__error" role="alert">
          {error}
        </p>
      ) : null}
      {notice !== null ? <p role="status">{notice}</p> : null}
    </section>
  );
}
