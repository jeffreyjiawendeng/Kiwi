import { useEffect, useRef, useState } from "react";
import type { Reference } from "@kiwi/contracts";
import { readBridge, type RendererManagedAssetSelection } from "./bridge.js";
import { planImportBatches, type ReviewedRow } from "./import-batches.js";
import {
  collectImport,
  describeDuplicate,
  describeFolderRead,
  describeImport,
  describeMissing,
  readImportPreview,
  readImportReceipt,
  type ImportPart,
  type ImportSummary,
  type PreviewRow,
} from "./import-review.js";
import { attachPickedFiles, describeAttachments, type PickedFile } from "./file-attach.js";
import { checkAgainstLibrary, type CheckEntry } from "./library-check.js";
import { loadPdfDocument, type PdfLoader } from "./pdf-document.js";
import { readPdfSelections } from "./pdf-candidates.js";
import { ReferenceFields } from "./ReferenceFields.js";

/**
 * Reviewing a reference library before any of it is created.
 *
 * The window between picking a file and having four hundred Papers. An import that runs first and
 * reports afterwards leaves somebody reading a decision that has already been made; this stops one
 * step short of that, shows every row it would create, and creates only what is still ticked.
 *
 * The two things a person can get wrong here are opposite and both expensive. Importing a copy of
 * something already held leaves two records of one paper, drifting apart from then on. Unticking a
 * distinct paper wrongly called a copy loses it silently -- nothing is created, nothing says so.
 * So a row arrives ticked unless the preview held it back, what it resembles is stated in a
 * sentence rather than as a badge, and every row can be corrected before it goes anywhere.
 *
 * There are three ways in and one path afterwards. A reference file picked through the dialog and
 * a file dropped on the window both become the same kind of selection -- a name, a size, and an
 * identifier good for one command -- before anything reads them. A folder of PDFs becomes one such
 * selection per file, each opened and read here in the renderer rather than by the workspace. All
 * three end at the same table, which cannot tell which happened and does not have to.
 *
 * What the folder does owe is an account of itself. Thirty files that yield twenty rows have to
 * say where the other ten went while the table is still on screen, so the counts the picker came
 * back with and the files that would not open are stated above the rows rather than left to be
 * noticed later.
 *
 * The parts nobody can see on a screen live elsewhere. `import-review.ts` owns the wording and the
 * arithmetic, `import-batches.ts` owns cutting the import into requests that fit under the 256 KB
 * ceiling. What is left here is a file picker, a list, and a progress line.
 */

/** The line under a title: who wrote it, when, and where it appeared. */
function describeRow(reference: Reference): string {
  const authors =
    reference.authors.length > 2
      ? `${reference.authors[0] ?? ""} and others`
      : reference.authors.join(" and ");
  return [authors, reference.year === null ? "" : String(reference.year), reference.container ?? ""]
    .filter((part) => part !== "")
    .join(" · ");
}

/** What a part of a split import turned out to be, said the way a person would say it. */
function failureOf(result: { status: string; error?: { message: string } }): string | null {
  if (result.status === "canceled") return "The import was canceled.";
  if (result.error !== undefined) return result.error.message;
  return null;
}

export function ReferenceImport({
  workspaceId,
  writable,
  dropped = null,
  loadPdf = loadPdfDocument,
  onClose,
  onImported,
}: {
  workspaceId: string;
  writable: boolean;
  /** A file dropped on the window, read on arrival so the drop is not asked for a second time. */
  dropped?: File | null;
  /** How a picked PDF is opened. Supplied by tests, which have no canvas to draw one on. */
  loadPdf?: PdfLoader;
  onClose(): void;
  /** What was created, so the shell can show it rather than leaving somebody to go and look. */
  onImported(objectIds: string[]): void;
}): React.JSX.Element {
  const [fileName, setFileName] = useState<string | null>(null);
  const [found, setFound] = useState(0);
  const [rows, setRows] = useState<PreviewRow[] | null>(null);
  /** What the source held and the rows do not account for. Empty for a reference file. */
  const [notes, setNotes] = useState<string[]>([]);
  /**
   * The files behind the rows, by the name each row travels under. Empty for a reference file.
   *
   * A folder import is the only one where a row stands for a file this side is still holding, and
   * holding it is the whole point: once the Paper exists the file has to go on it. Keyed by the
   * row's key, which for these rows is the picker's identifier for the file, so the pairing is the
   * same one that was true when the row was read.
   */
  const [files, setFiles] = useState<ReadonlyMap<string, PickedFile>>(new Map());
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState<
    "selecting" | "previewing" | "browsing" | "reading" | "checking" | "importing" | "filing" | null
  >(null);
  const [progress, setProgress] = useState<{
    done: number;
    total: number;
    /** Which of the slow things is happening, since they are all counted the same way. */
    of: "files" | "papers" | "attachments";
  } | null>(null);
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [created, setCreated] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const arrived = useRef(false);
  const browse = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const doneButton = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLElement>(null);

  useEffect(() => {
    (writable ? browse.current : closeButton.current)?.focus();
  }, [writable]);

  useEffect(() => {
    if (summary !== null) doneButton.current?.focus();
  }, [summary]);

  // A file dropped on the window opens this dialog already holding it, so it is read once on
  // arrival rather than asked for again. The guard is what makes it once: a re-render while the
  // preview is in flight must not start a second one against the same spent identifier.
  useEffect(() => {
    if (dropped === null || arrived.current) return;
    arrived.current = true;
    void take(dropped);
  }, [dropped]);

  useEffect(() => {
    function keydown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        // Nothing to escape to while rows are being created: the command cannot be cancelled, and
        // closing the window would leave somebody guessing how much of their library went in.
        if (busy !== null) return;
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [
        ...(dialog.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? []),
      ];
      const first = focusable[0];
      const last = focusable.at(-1);
      if (first === undefined || last === undefined) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  });

  /**
   * Reads a file that is already a selection, and shows what it holds.
   *
   * Where the file is stays on the other side of the bridge throughout: what crosses is a name, a
   * size, and an identifier good for one command and ten minutes.
   */
  async function read(chosen: RendererManagedAssetSelection): Promise<void> {
    const bridge = readBridge();
    if (bridge === null) return;
    setBusy("previewing");
    const id = crypto.randomUUID();
    let result;
    try {
      result = await bridge.invokeCommand({
        protocol_version: "1.0.0",
        request_id: id,
        idempotency_key: id,
        workspace_id: workspaceId,
        command: "kiwi.bibliography.import-preview",
        args: { selection_id: chosen.id },
      });
    } catch {
      setBusy(null);
      setError("Kiwi could not read that file. Choose it again.");
      return;
    }
    setBusy(null);
    if (result.error !== undefined) {
      setError(`${result.error.message} Choose a file again to retry.`);
      return;
    }
    const preview = readImportPreview(result.data);
    // Refusing the whole preview rather than showing part of it. A row whose duplicate verdict
    // went missing on the way in arrives ticked and looking ordinary, and gets created over a
    // warning nobody was ever shown.
    if (preview === null) {
      setError("Kiwi read that file but could not show what is in it. Choose it again.");
      return;
    }
    setFileName(chosen.name);
    setFound(preview.found);
    setRows(preview.rows);
    // A reference file is one file, and every entry in it is a row. There is nothing left over
    // to account for, which is the difference between this way in and a folder.
    setNotes([]);
    // It states what papers are and holds none of them, so there is nothing to attach afterwards.
    // Cleared rather than left, because a folder read before this one is not what these rows are.
    setFiles(new Map());
    setEditing(null);
    setSummary(null);
  }

  /**
   * Picks a file and reads it, in one motion.
   *
   * The identifier the picker hands back is good for one command and ten minutes, so there is
   * nothing to be gained by holding it and a confirmation step to be lost.
   */
  async function choose(): Promise<void> {
    const bridge = readBridge();
    if (bridge === null || !writable || busy !== null) return;
    setBusy("selecting");
    setError(null);
    let chosen;
    try {
      chosen = await bridge.chooseReferenceFile();
    } catch {
      setBusy(null);
      setError("Kiwi could not open the file picker. Try again.");
      return;
    }
    if (chosen === null) {
      setBusy(null);
      return;
    }
    await read(chosen);
  }

  /**
   * Reads a file that arrived by being dropped rather than picked.
   *
   * A drop hands the renderer a File, which knows its own name and nothing about where it sits on
   * disk. Registering it in the main process turns it into the same kind of selection the picker
   * issues, so from the next line down the two ways in are indistinguishable -- and the renderer
   * has still never held a path.
   */
  async function take(file: File): Promise<void> {
    const bridge = readBridge();
    if (bridge === null || !writable || busy !== null) return;
    setBusy("selecting");
    setError(null);
    setDragging(false);
    let chosen;
    try {
      chosen = await bridge.registerDroppedManagedAsset(file);
    } catch {
      chosen = null;
    }
    if (chosen === null) {
      setBusy(null);
      setError("Kiwi could not use that dropped file. Choose it with the button instead.");
      return;
    }
    await read(chosen);
  }

  /**
   * Picks a folder of PDFs and reads every one of them into a row.
   *
   * The reading happens here rather than in the workspace, because opening a PDF is what the
   * renderer already does and shipping thirty files across the bridge to have them opened on the
   * other side would be the same work done twice. What crosses is what always crosses: one
   * identifier per file, good for one command and ten minutes.
   *
   * It is slow in a way the other way in is not -- thirty files opened one at a time is thirty
   * waits -- so it counts out loud. A folder that yields nothing is reported as an empty folder
   * rather than opened as an empty table, since a table with no rows in it says nothing about
   * why.
   *
   * Reading them is not the whole of it. The rows come out of the files knowing what each paper
   * is and nothing about whether the library already holds it, so they go back across the bridge
   * once more to be told -- by the same command that tells a reference file, so that the two ways
   * in cannot disagree about what a second copy is.
   */
  async function browseFolder(): Promise<void> {
    const bridge = readBridge();
    if (bridge === null || !writable || busy !== null) return;
    setBusy("browsing");
    setError(null);
    let chosen;
    try {
      chosen = await bridge.chooseAssetFolder();
    } catch {
      setBusy(null);
      setError("Kiwi could not open the folder picker. Try again.");
      return;
    }
    if (chosen === null) {
      setBusy(null);
      return;
    }
    const folder = chosen;
    if (folder.files.length === 0) {
      setBusy(null);
      setError(`There are no PDFs in ${folder.name}. Choose another folder.`);
      return;
    }

    setBusy("reading");
    setProgress({ done: 0, total: folder.files.length, of: "files" });
    const read = await readPdfSelections(loadPdf, folder.files, {
      onProgress: (done) => setProgress({ done, total: folder.files.length, of: "files" }),
    });
    setBusy(null);
    setProgress(null);

    const account = describeFolderRead({
      skipped: folder.skipped,
      truncated: folder.truncated,
      unreadable: read.unreadable,
    });
    if (read.rows.length === 0) {
      setError(`Kiwi could not open anything in ${folder.name}. ${account.join(" ")}`.trimEnd());
      return;
    }

    setBusy("checking");
    const checked = await checkAgainstLibrary(askLibrary, read.rows);
    setBusy(null);

    setFileName(folder.name);
    setFound(checked.rows.length);
    setRows(checked.rows);
    setNotes(checked.note === null ? account : [...account, checked.note]);
    // Every file the folder gave, whether or not it became a row. A row is looked up by its own
    // key, so a file that would not open is simply never asked for.
    setFiles(new Map(folder.files.map((file) => [file.id, file])));
    setEditing(null);
    setSummary(null);
  }

  /**
   * Asks the workspace what it already holds, for rows that were read on this side.
   *
   * The same command a picked reference file goes through, sent rows instead of a file. What
   * comes back matters only for its verdicts, so a failure here is answered with null and turns
   * into one sentence above the table rather than losing the folder.
   */
  async function askLibrary(entries: CheckEntry[]): Promise<Record<string, unknown> | null> {
    const bridge = readBridge();
    if (bridge === null) return null;
    const id = crypto.randomUUID();
    try {
      const result = await bridge.invokeCommand({
        protocol_version: "1.0.0",
        request_id: id,
        idempotency_key: id,
        workspace_id: workspaceId,
        command: "kiwi.bibliography.import-preview",
        args: { entries },
      });
      return result.error === undefined ? (result.data ?? null) : null;
    } catch {
      return null;
    }
  }

  function setSelected(key: string, selected: boolean): void {
    setRows(
      (current) => current?.map((row) => (row.key === key ? { ...row, selected } : row)) ?? current,
    );
  }

  function setReference(key: string, reference: Reference): void {
    setRows(
      (current) =>
        current?.map((row) => (row.key === key ? { ...row, reference } : row)) ?? current,
    );
  }

  function setAll(selected: boolean): void {
    setRows((current) => current?.map((row) => ({ ...row, selected })) ?? current);
  }

  /**
   * Creates the ticked rows, in as many requests as the ceiling requires and one answer.
   *
   * A part that fails stops the rest. Twenty further requests to a workspace that has just stopped
   * answering are twenty further ways to be half-imported; the rows that never went are reported
   * as rows, so the person can pick up where it stopped rather than work out what a failed request
   * was carrying.
   *
   * Creating the records is not the end of it for a folder. Those rows each stand for a PDF still
   * sitting where it was picked, and a Paper without the paper is half of what was asked for, so
   * the files follow their records in once the records exist. Second rather than first because
   * only now is there anything to attach them to, and because a file copied in for a row that
   * turned out to be a duplicate would be a copy of something already held.
   */
  async function commit(): Promise<void> {
    const bridge = readBridge();
    if (bridge === null || rows === null || !writable || busy !== null) return;
    const ticked: ReviewedRow[] = rows
      .filter((row) => row.selected)
      .map((row) => ({
        key: row.key,
        title: row.title,
        reference: row.reference,
        file_hash: row.file_hash,
      }));
    if (ticked.length === 0) return;

    const plan = planImportBatches(ticked);
    if (plan.status === "row_too_large") {
      setError(
        `"${plan.title}" is too large to send. Untick it and import the rest, or shorten its abstract first.`,
      );
      return;
    }

    setBusy("importing");
    setError(null);
    setProgress({ done: 0, total: plan.batches.length, of: "papers" });
    const parts: ImportPart[] = [];
    let stopped: string | null = null;
    for (const [index, batch] of plan.batches.entries()) {
      if (stopped !== null) {
        parts.push({
          first: batch.first,
          last: batch.last,
          outcome: { status: "failed", message: stopped },
        });
        continue;
      }
      const id = crypto.randomUUID();
      let result;
      try {
        result = await bridge.invokeCommand({
          protocol_version: "1.0.0",
          request_id: id,
          idempotency_key: id,
          workspace_id: workspaceId,
          command: "kiwi.bibliography.import",
          args: { entries: batch.entries },
        });
      } catch {
        stopped = "Kiwi lost contact with the workspace.";
        parts.push({
          first: batch.first,
          last: batch.last,
          outcome: { status: "failed", message: stopped },
        });
        continue;
      }
      const receipt = readImportReceipt(result.data);
      const failure =
        failureOf(result) ??
        (receipt === null ? "Kiwi could not read what the workspace answered." : null);
      if (failure !== null || receipt === null) {
        stopped = failure ?? "Kiwi could not read what the workspace answered.";
        parts.push({
          first: batch.first,
          last: batch.last,
          outcome: { status: "failed", message: stopped },
        });
        continue;
      }
      parts.push({
        first: batch.first,
        last: batch.last,
        outcome: { status: "committed", receipt },
      });
      setProgress({ done: index + 1, total: plan.batches.length, of: "papers" });
    }

    const outcome = collectImport(parts);
    setCreated(outcome.created.map((row) => row.id));
    const summarized = describeImport(outcome);

    const waiting = outcome.created.filter((row) => files.has(row.key)).length;
    if (waiting === 0) {
      setBusy(null);
      setProgress(null);
      setSummary(summarized);
      return;
    }
    setBusy("filing");
    setProgress({ done: 0, total: waiting, of: "attachments" });
    const filed = await attachPickedFiles(copyIn, attachToPaper, outcome.created, files, {
      onProgress: (done) => setProgress({ done, total: waiting, of: "attachments" }),
    });
    setBusy(null);
    setProgress(null);
    const filing = describeAttachments(filed);
    setSummary(
      filing === null ? summarized : { ...summarized, notes: [...summarized.notes, filing] },
    );
  }

  /**
   * Copies one picked file into the workspace, answering with the asset it became.
   *
   * The identifier goes over and the path does not, which is the same arrangement every other way
   * of handing this side a file already uses. It is spent by this call: a file is copied in once,
   * and looking at it beforehand did not count.
   */
  async function copyIn(selectionId: string): Promise<string | null> {
    const bridge = readBridge();
    if (bridge === null) throw new Error("no bridge");
    const id = crypto.randomUUID();
    const result = await bridge.invokeCommand({
      protocol_version: "1.0.0",
      request_id: id,
      idempotency_key: id,
      workspace_id: workspaceId,
      command: "kiwi.asset.import-managed",
      args: { selection_id: selectionId },
    });
    if (result.error !== undefined) return null;
    const asset = result.data?.["asset_id"];
    return typeof asset === "string" && asset !== "" ? asset : null;
  }

  /** Puts a copied file on the Paper its row created. */
  async function attachToPaper(paperId: string, assetId: string): Promise<boolean> {
    const bridge = readBridge();
    if (bridge === null) throw new Error("no bridge");
    const id = crypto.randomUUID();
    const result = await bridge.invokeCommand({
      protocol_version: "1.0.0",
      request_id: id,
      idempotency_key: id,
      workspace_id: workspaceId,
      command: "kiwi.object.attach-file",
      args: { object_id: paperId, asset_id: assetId },
    });
    return result.error === undefined;
  }

  const unavailable = !writable;
  const ticked = rows?.filter((row) => row.selected).length ?? 0;
  return (
    <div className="reference-import__backdrop">
      <section
        ref={dialog}
        className="reference-import"
        role="dialog"
        aria-modal="true"
        aria-labelledby="reference-import-title"
        aria-describedby="reference-import-description"
      >
        <header>
          <div>
            <span>Reference library</span>
            <h2 id="reference-import-title">Import references</h2>
          </div>
          <button
            ref={closeButton}
            type="button"
            aria-label="Close Import references"
            disabled={busy !== null}
            onClick={onClose}
          >
            ×
          </button>
        </header>
        <p id="reference-import-description">
          Kiwi reads a BibTeX or RIS file, or a folder of PDFs, and shows every entry it would add.
          Nothing is created until you say so.
        </p>

        {summary !== null ? (
          <section className="reference-import__receipt" aria-labelledby="reference-import-receipt">
            <h3 id="reference-import-receipt">{summary.headline}</h3>
            {summary.notes.length === 0 ? null : (
              <ul>
                {summary.notes.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            )}
          </section>
        ) : rows === null ? (
          <div
            className={`reference-import__empty${dragging ? " reference-import__empty--active" : ""}`}
            aria-label="Reference library drop target"
            onDragEnter={(event) => {
              event.preventDefault();
              if (!unavailable) setDragging(true);
            }}
            onDragOver={(event) => event.preventDefault()}
            onDragLeave={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null))
                setDragging(false);
            }}
            onDrop={(event) => {
              event.preventDefault();
              const file = event.dataTransfer.files[0];
              if (event.dataTransfer.files.length !== 1 || file === undefined) {
                setDragging(false);
                setError("Drop one file at a time.");
                return;
              }
              void take(file);
            }}
          >
            <p>
              A .bib or .ris file exported from Zotero, Mendeley, EndNote, or a journal page. Also a
              folder of PDFs, which Kiwi opens one at a time and reads for what each one is.
            </p>
            {unavailable ? null : (
              <strong>{dragging ? "Drop the file here" : "Drop one here, or"}</strong>
            )}
            <div className="reference-import__ways">
              <button
                ref={browse}
                type="button"
                className="button button--primary"
                disabled={unavailable || busy !== null}
                onClick={choose}
              >
                {busy === "selecting"
                  ? "Opening…"
                  : busy === "previewing"
                    ? "Reading…"
                    : "Choose a file…"}
              </button>
              <button
                type="button"
                className="button button--secondary"
                disabled={unavailable || busy !== null}
                onClick={browseFolder}
              >
                {busy === "browsing"
                  ? "Opening…"
                  : busy === "reading"
                    ? "Reading…"
                    : busy === "checking"
                      ? "Checking the library…"
                      : "Choose a folder…"}
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="reference-import__toolbar">
              <p>
                <strong>{fileName}</strong>
                <span>
                  {found === 1 ? "1 reference" : `${found.toLocaleString()} references`} ·{" "}
                  {ticked.toLocaleString()} ticked
                </span>
              </p>
              <div>
                <button type="button" disabled={busy !== null} onClick={() => setAll(true)}>
                  Tick all
                </button>
                <button type="button" disabled={busy !== null} onClick={() => setAll(false)}>
                  Untick all
                </button>
              </div>
            </div>
            {notes.length === 0 ? null : (
              <ul className="reference-import__notes" aria-label="What this folder held">
                {notes.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            )}
            <ul className="reference-import__rows" aria-label="References to import">
              {rows.map((row) => {
                const missing = describeMissing(row.missing);
                const open = editing === row.key;
                const prefix = `import-row-${String(row.row)}`;
                return (
                  <li key={row.key} className={row.selected ? undefined : "is-unticked"}>
                    <input
                      id={`${prefix}-selected`}
                      type="checkbox"
                      checked={row.selected}
                      disabled={busy !== null}
                      onChange={(event) => setSelected(row.key, event.target.checked)}
                    />
                    <div>
                      <label htmlFor={`${prefix}-selected`}>{row.title}</label>
                      <span className="reference-import__meta">{describeRow(row.reference)}</span>
                      {row.duplicate === null ? null : (
                        <p className="reference-import__verdict">
                          {describeDuplicate(row.duplicate)}
                        </p>
                      )}
                      {row.note === null ? null : (
                        <p className="reference-import__gap">{row.note}</p>
                      )}
                      {missing === null ? null : <p className="reference-import__gap">{missing}</p>}
                      {row.problems.map((problem) => (
                        <p
                          key={`${problem.field}-${problem.message}`}
                          className="reference-import__gap"
                        >
                          {problem.message}
                        </p>
                      ))}
                      <button
                        type="button"
                        className="reference-import__correct"
                        aria-expanded={open}
                        disabled={busy !== null}
                        onClick={() => setEditing(open ? null : row.key)}
                      >
                        {open ? "Done correcting" : "Correct"}
                      </button>
                      {open ? (
                        <div className="reference-import__fields">
                          <ReferenceFields
                            reference={row.reference}
                            onChange={(next) => setReference(row.key, next)}
                            workspaceId={workspaceId}
                            // No object exists yet, so nothing in the library is this row. A DOI
                            // already held is therefore a real answer rather than the row meeting
                            // itself, which is exactly the answer worth having here.
                            objectId={row.key}
                            disabled={busy !== null}
                            idPrefix={prefix}
                          />
                        </div>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          </>
        )}

        {progress === null ? null : (
          <div className="reference-import__progress" role="status" aria-live="polite">
            <progress
              aria-label={
                progress.of === "files"
                  ? "Reading progress"
                  : progress.of === "attachments"
                    ? "Attaching progress"
                    : "Import progress"
              }
              value={progress.done}
              max={progress.total}
            />
            <span>
              {progress.of === "files"
                ? `Reading… file ${String(Math.min(progress.done + 1, progress.total))} of ${String(progress.total)}`
                : progress.of === "attachments"
                  ? `Attaching files… file ${String(Math.min(progress.done + 1, progress.total))} of ${String(progress.total)}`
                  : progress.total === 1
                    ? "Creating papers…"
                    : `Creating papers… part ${String(progress.done + 1)} of ${String(progress.total)}`}
            </span>
          </div>
        )}

        {unavailable ? (
          <p className="reference-import__notice">
            This workspace is read only. Open a writable copy to import references.
          </p>
        ) : null}
        {error === null ? null : (
          <p className="reference-import__error" role="alert">
            {error}
          </p>
        )}

        <footer>
          {summary === null ? (
            <>
              <button
                type="button"
                className="button button--secondary"
                disabled={busy !== null}
                onClick={onClose}
              >
                Cancel
              </button>
              {rows === null ? null : (
                <button
                  type="button"
                  className="button button--primary"
                  disabled={unavailable || busy !== null || ticked === 0}
                  onClick={commit}
                >
                  {ticked === 1 ? "Add 1 paper" : `Add ${ticked.toLocaleString()} papers`}
                </button>
              )}
            </>
          ) : (
            <button
              ref={doneButton}
              type="button"
              className="button button--primary"
              onClick={() => onImported(created)}
            >
              {created.length === 0 ? "Close" : "Open the library"}
            </button>
          )}
        </footer>
      </section>
    </div>
  );
}
