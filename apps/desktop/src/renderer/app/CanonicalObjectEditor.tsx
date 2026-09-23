import { useEffect, useRef, useState } from "react";
import {
  splitAttribution,
  validateObjectPublication,
  type PublicationProblem,
} from "@kiwi/contracts";
import { readBridge, type RendererCommandResult } from "./bridge.js";
import { ObjectHistoryPanel, type RestorationReceiptView } from "./ObjectHistoryPanel.js";

export interface CanonicalObjectView {
  id: string;
  type: string;
  title: string;
  content: string;
  version: number;
  content_hash: string;
  updated_at: string;
  updated_by: string;
}

interface RecoveryDraftView {
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

export interface PublicationImpactView {
  relation_count: number;
  incoming_count: number;
  outgoing_count: number;
  related_object_count: number;
  relation_types: string[];
}

interface PublicationPreviewView {
  valid: boolean;
  problems: PublicationProblem[];
  impact: PublicationImpactView;
}

export interface PublicationReceiptView {
  object: CanonicalObjectView;
  transactionId: string;
  eventIds: string[];
  warnings: string[];
  impact: PublicationImpactView;
  recoveryDraftRetained: boolean;
}

type EditorMode = "read" | "live-preview" | "source";
type SaveState = "pristine" | "autosaving" | "protected" | "error";
type PublishStage = "idle" | "checking" | "review" | "publishing";

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

function savedTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
}

function wordCount(value: string): number {
  const words = value.trim().match(/\S+/gu);
  return words?.length ?? 0;
}

/**
 * A line of stored text, with the marks it points at made into links.
 *
 * A note is plain text and cannot hold a node, so a quotation sent into one carries the mark it
 * came from as a marker in the attribution line. The marker itself is never shown: it is
 * punctuation for a program, and a reader who sees it is reading the plumbing rather than the
 * sentence.
 */
function Line({
  text,
  onOpenAnnotation,
}: {
  text: string;
  onOpenAnnotation: ((annotationId: string) => void) | undefined;
}): React.JSX.Element {
  return (
    <>
      {splitAttribution(text).map((part, index) =>
        part.kind === "text" ? (
          <span key={index}>{part.text}</span>
        ) : onOpenAnnotation === undefined ? null : (
          <button
            key={index}
            type="button"
            className="canonical-editor__quotation"
            title="Open the page this was read on"
            onClick={() => onOpenAnnotation(part.annotation)}
          >
            Open the page
          </button>
        ),
      )}
    </>
  );
}

function SafeMarkdown({
  content,
  onOpenAnnotation,
}: {
  content: string;
  onOpenAnnotation?: (annotationId: string) => void;
}): React.JSX.Element {
  const blocks = content
    .split(/\n{2,}/u)
    .map((block) => block.trim())
    .filter((block) => block !== "");
  if (blocks.length === 0) return <p className="canonical-editor__empty">No content yet.</p>;
  return (
    <div className="canonical-editor__rendered">
      {blocks.map((block, index) => {
        const heading = /^(#{1,6})\s+(.+)$/u.exec(block);
        if (heading !== null) return <h4 key={index}>{heading[2]}</h4>;
        const lines = block.split("\n");
        if (lines.every((line) => /^[-*]\s+/u.test(line)))
          return (
            <ul key={index}>
              {lines.map((line, lineIndex) => (
                <li key={lineIndex}>{line.replace(/^[-*]\s+/u, "")}</li>
              ))}
            </ul>
          );
        // A quotation sent from the Reader arrives as one, and reading it as an ordinary
        // paragraph would put the ">" in front of the words somebody quoted.
        if (lines.every((line) => /^>\s?/u.test(line)))
          return (
            <blockquote key={index}>
              <Line
                text={lines.map((line) => line.replace(/^>\s?/u, "")).join(" ")}
                onOpenAnnotation={onOpenAnnotation}
              />
            </blockquote>
          );
        return (
          <p key={index}>
            <Line text={lines.join(" ")} onOpenAnnotation={onOpenAnnotation} />
          </p>
        );
      })}
    </div>
  );
}

export function CanonicalObjectEditor({
  workspaceId,
  object,
  writable,
  onPublished,
  onRestored,
  onOrganize,
  onOpenAnnotation,
}: {
  workspaceId: string;
  object: CanonicalObjectView;
  writable: boolean;
  onPublished?: (receipt: PublicationReceiptView) => void;
  onRestored?: (receipt: RestorationReceiptView) => void;
  onOrganize?: () => void;
  /** Follows a quotation in this object's text back to the page it was read on. */
  onOpenAnnotation?: (annotationId: string) => void;
}): React.JSX.Element {
  const [mode, setMode] = useState<EditorMode>("read");
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(object.title);
  const [content, setContent] = useState(object.content);
  const [baseVersion, setBaseVersion] = useState(object.version);
  const [baseHash, setBaseHash] = useState(object.content_hash);
  const [recovery, setRecovery] = useState<RecoveryDraftView | null>(null);
  const [checking, setChecking] = useState(true);
  const [saveState, setSaveState] = useState<SaveState>("pristine");
  const [message, setMessage] = useState<string | null>(null);
  const [publishError, setPublishError] = useState<string | null>(null);
  const [inspectRecovery, setInspectRecovery] = useState(false);
  const [viewingRecovery, setViewingRecovery] = useState(false);
  const [checkRevision, setCheckRevision] = useState(0);
  const [publishStage, setPublishStage] = useState<PublishStage>("idle");
  const [publicationPreview, setPublicationPreview] = useState<PublicationPreviewView | null>(null);
  const [versionMessage, setVersionMessage] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);
  const activeObjectId = useRef(object.id);
  const titleField = useRef<HTMLInputElement>(null);
  const contentField = useRef<HTMLTextAreaElement>(null);
  activeObjectId.current = object.id;

  useEffect(() => {
    setMode("read");
    setEditing(false);
    setTitle(object.title);
    setContent(object.content);
    setBaseVersion(object.version);
    setBaseHash(object.content_hash);
    setRecovery(null);
    setChecking(true);
    setSaveState("pristine");
    setMessage(null);
    setPublishError(null);
    setInspectRecovery(false);
    setViewingRecovery(false);
    setPublishStage("idle");
    setPublicationPreview(null);
    setVersionMessage("");
    setHistoryOpen(false);
    let active = true;
    void invoke(workspaceId, "kiwi.draft.read", { object_id: object.id })
      .then((result) => {
        if (!active) return;
        if (result.error !== undefined) throw new Error(result.error.message);
        setRecovery(((result.data ?? {})["draft"] as RecoveryDraftView | null) ?? null);
      })
      .catch((cause: unknown) => {
        if (active) {
          setSaveState("error");
          setMessage(
            `${cause instanceof Error ? cause.message : "Kiwi could not check recovery drafts."} The canonical version remains available.`,
          );
        }
      })
      .finally(() => {
        if (active) setChecking(false);
      });
    return () => {
      active = false;
    };
  }, [
    checkRevision,
    object.content,
    object.content_hash,
    object.id,
    object.title,
    object.version,
    workspaceId,
  ]);

  const dirty = title !== object.title || content !== object.content;
  const problems = editing ? validateObjectPublication({ title, content }) : [];
  const errors = problems.filter((problem) => problem.severity === "error");
  const warnings = problems.filter((problem) => problem.severity === "warning");
  const publishBusy = publishStage === "checking" || publishStage === "publishing";

  async function saveDraft(): Promise<boolean> {
    if (!editing || !dirty) return true;
    const objectId = object.id;
    setSaveState("autosaving");
    setMessage(null);
    try {
      const result = await invoke(workspaceId, "kiwi.draft.save", {
        object_id: objectId,
        base_version: baseVersion,
        base_hash: baseHash,
        title,
        content,
      });
      if (result.error !== undefined) throw new Error(result.error.message);
      if (activeObjectId.current !== objectId) return false;
      const saved = (result.data ?? {})["draft"] as RecoveryDraftView;
      setRecovery(saved);
      setSaveState("protected");
      return true;
    } catch (cause) {
      if (activeObjectId.current !== objectId) return false;
      setSaveState("error");
      setMessage(
        `${cause instanceof Error ? cause.message : "Kiwi could not save this recovery draft."} Your canonical version is unchanged.`,
      );
      return false;
    }
  }

  useEffect(() => {
    if (!editing || !dirty) return;
    setSaveState("autosaving");
    const timer = window.setTimeout(() => void saveDraft(), 600);
    return () => window.clearTimeout(timer);
  }, [baseHash, baseVersion, content, dirty, editing, title]);

  function resetPublicationReview(): void {
    setPublicationPreview(null);
    setPublishStage("idle");
    setPublishError(null);
  }

  function changeTitle(value: string): void {
    setTitle(value);
    resetPublicationReview();
  }

  function changeContent(value: string): void {
    setContent(value);
    resetPublicationReview();
  }

  function beginEdit(): void {
    if (!writable || recovery !== null) return;
    setTitle(object.title);
    setContent(object.content);
    setBaseVersion(object.version);
    setBaseHash(object.content_hash);
    setEditing(true);
    setMode("live-preview");
    setSaveState("pristine");
    setMessage(null);
    setHistoryOpen(false);
    resetPublicationReview();
  }

  function restoreDraft(): void {
    if (recovery === null) return;
    setTitle(recovery.title);
    setContent(recovery.content);
    setBaseVersion(recovery.base_version);
    setBaseHash(recovery.base_hash);
    setEditing(writable);
    setViewingRecovery(!writable);
    setMode(writable ? "live-preview" : "read");
    setSaveState("protected");
    setMessage(
      writable
        ? "Recovery draft restored. It is still separate from the canonical version."
        : "Recovery draft opened read-only. Copy it before discarding if you need to retain it.",
    );
    setInspectRecovery(false);
    resetPublicationReview();
  }

  async function discardDraft(): Promise<void> {
    if (recovery === null) return;
    const result = await invoke(workspaceId, "kiwi.draft.discard", {
      object_id: recovery.object_id,
      base_version: recovery.base_version,
      base_hash: recovery.base_hash,
    });
    if (result.error !== undefined) {
      setMessage(`${result.error.message} The recovery draft was retained.`);
      return;
    }
    setRecovery(null);
    setEditing(false);
    setMode("read");
    setTitle(object.title);
    setContent(object.content);
    setBaseVersion(object.version);
    setBaseHash(object.content_hash);
    setSaveState("pristine");
    setInspectRecovery(false);
    setViewingRecovery(false);
    setMessage("Recovery draft discarded. Canonical content was not changed.");
    resetPublicationReview();
  }

  async function returnToRead(): Promise<void> {
    if (!(await saveDraft())) return;
    setEditing(false);
    setViewingRecovery(false);
    setMode("read");
    setMessage(
      dirty
        ? "Recovery draft closed. Restore it to continue editing."
        : "Edit mode closed without changing the canonical version.",
    );
    resetPublicationReview();
  }

  function focusProblem(problem: PublicationProblem): void {
    setMode("live-preview");
    window.setTimeout(() => {
      (problem.field === "title" ? titleField.current : contentField.current)?.focus();
    }, 0);
  }

  async function commitPublication(preview: PublicationPreviewView): Promise<void> {
    setPublishStage("publishing");
    setPublishError(null);
    const objectId = object.id;
    let result: RendererCommandResult;
    try {
      result = await invoke(workspaceId, "kiwi.object.save", {
        object_id: objectId,
        expected_version: baseVersion,
        expected_hash: baseHash,
        title,
        content,
        ...(versionMessage.trim() === "" ? {} : { reason: versionMessage.trim() }),
      });
    } catch (cause) {
      setPublishStage(preview.impact.relation_count > 0 || warnings.length > 0 ? "review" : "idle");
      setPublishError(
        `${cause instanceof Error ? cause.message : "Kiwi could not save this version."} The recovery draft was retained.`,
      );
      return;
    }
    if (result.error !== undefined) {
      setPublishStage(preview.impact.relation_count > 0 || warnings.length > 0 ? "review" : "idle");
      setPublishError(`${result.error.message} The recovery draft was retained.`);
      return;
    }
    const published = (result.data ?? {})["object"] as CanonicalObjectView | undefined;
    if (published === undefined || result.transaction_id === undefined) {
      setPublishStage("review");
      setPublishError(
        "Kiwi did not return a complete receipt for the saved version. The recovery draft was retained.",
      );
      return;
    }

    let recoveryDraftRetained = false;
    try {
      const discarded = await invoke(workspaceId, "kiwi.draft.discard", {
        object_id: objectId,
        base_version: baseVersion,
        base_hash: baseHash,
      });
      if (discarded.error !== undefined) recoveryDraftRetained = true;
    } catch {
      recoveryDraftRetained = true;
    }

    if (!recoveryDraftRetained) setRecovery(null);
    setEditing(false);
    setViewingRecovery(false);
    setMode("read");
    setSaveState(recoveryDraftRetained ? "protected" : "pristine");
    setPublishStage("idle");
    setPublicationPreview(null);
    setVersionMessage("");
    setMessage(null);
    onPublished?.({
      object: published,
      transactionId: result.transaction_id,
      eventIds: result.event_ids ?? [],
      warnings: result.warnings ?? [],
      impact: preview.impact,
      recoveryDraftRetained,
    });
  }

  async function requestPublication(): Promise<void> {
    if (!editing || !dirty || errors.length > 0 || publishBusy || saveState === "error") return;
    if (!(await saveDraft())) return;
    setPublishStage("checking");
    setPublishError(null);
    let result: RendererCommandResult;
    try {
      result = await invoke(workspaceId, "kiwi.object.validate-save", {
        object_id: object.id,
        expected_version: baseVersion,
        expected_hash: baseHash,
        title,
        content,
      });
    } catch (cause) {
      setPublishStage("idle");
      setPublishError(
        `${cause instanceof Error ? cause.message : "Kiwi could not validate this version."} The recovery draft was retained.`,
      );
      return;
    }
    if (result.error !== undefined) {
      setPublishStage("idle");
      setPublishError(`${result.error.message} The recovery draft was retained.`);
      return;
    }
    const preview = (result.data ?? {})["preview"] as PublicationPreviewView | undefined;
    if (preview === undefined) {
      setPublishStage("idle");
      setPublishError(
        "Kiwi did not return a review of this version. The recovery draft was retained.",
      );
      return;
    }
    setPublicationPreview(preview);
    if (!preview.valid) {
      setPublishStage("idle");
      setPublishError("Correct the listed problems before saving.");
      return;
    }
    const needsReview =
      preview.problems.some((problem) => problem.severity === "warning") ||
      preview.impact.relation_count > 0;
    if (needsReview) setPublishStage("review");
    else await commitPublication(preview);
  }

  const shownTitle = editing || viewingRecovery ? title : object.title;
  const heading = shownTitle.trim() === "" ? "Untitled recovery draft" : shownTitle;
  const shownContent = editing || viewingRecovery ? content : object.content;
  const staleRecovery =
    recovery !== null &&
    (recovery.base_version !== object.version || recovery.base_hash !== object.content_hash);

  return (
    <article
      className="canonical-editor"
      aria-labelledby={`object-editor-${object.id}`}
      onKeyDown={(event) => {
        if (
          editing &&
          event.ctrlKey &&
          !event.shiftKey &&
          event.key.toLocaleLowerCase("en-US") === "s"
        ) {
          event.preventDefault();
          void saveDraft();
        }
      }}
    >
      <header className="canonical-editor__header">
        <div>
          <span>{object.type.replaceAll("_", " ")}</span>
          <h3 id={`object-editor-${object.id}`}>{heading}</h3>
          <small>
            {editing
              ? `Recovery draft based on version ${baseVersion}`
              : `Canonical version ${object.version}`}
            {editing && problems.length > 0
              ? ` · ${errors.length} ${errors.length === 1 ? "error" : "errors"}, ${warnings.length} ${warnings.length === 1 ? "warning" : "warnings"}`
              : ""}
          </small>
        </div>
        <div className="canonical-editor__header-actions">
          {editing && publishStage !== "review" ? (
            <button
              type="button"
              className="canonical-editor__publish"
              disabled={
                !dirty ||
                errors.length > 0 ||
                publishBusy ||
                saveState === "error" ||
                saveState === "autosaving"
              }
              onClick={() => void requestPublication()}
            >
              {publishStage === "checking"
                ? "Checking…"
                : publishStage === "publishing"
                  ? "Saving…"
                  : "Save version"}
            </button>
          ) : null}
          {!editing ? (
            <button type="button" disabled={checking} onClick={onOrganize}>
              Organize
            </button>
          ) : null}
          {!editing ? (
            <button
              type="button"
              aria-expanded={historyOpen}
              disabled={checking}
              onClick={() => setHistoryOpen((open) => !open)}
            >
              {historyOpen ? "Close History" : "History"}
            </button>
          ) : null}
          {editing ? (
            <button type="button" disabled={publishBusy} onClick={() => void returnToRead()}>
              Return to Read
            </button>
          ) : (
            <button
              type="button"
              disabled={!writable || checking || recovery !== null || saveState === "error"}
              title={
                !writable
                  ? "This workspace is read only"
                  : saveState === "error"
                    ? "Recovery draft storage is unavailable"
                    : recovery !== null
                      ? "Restore or discard the existing recovery draft first"
                      : "Edit a protected local recovery draft"
              }
              onClick={beginEdit}
            >
              Edit
            </button>
          )}
        </div>
      </header>

      {historyOpen ? (
        <ObjectHistoryPanel
          workspaceId={workspaceId}
          object={object}
          writable={writable}
          restoreBlocked={recovery !== null}
          onRestored={(receipt) => {
            setHistoryOpen(false);
            onRestored?.(receipt);
          }}
        />
      ) : null}

      <div className="canonical-editor__body" hidden={historyOpen}>
        <div className="canonical-editor__modes" role="tablist" aria-label="Object editor mode">
          {(
            [
              ["read", "Read"],
              ["live-preview", "Live Preview"],
              ["source", "Source"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={mode === value}
              onClick={() => setMode(value)}
            >
              {label}
            </button>
          ))}
        </div>

        {!editing && recovery !== null ? (
          <section className="canonical-editor__recovery" aria-label="Recovery draft available">
            <strong>
              {staleRecovery ? "Recovery draft has an older base" : "Recovery draft available"}
            </strong>
            <span>
              Saved {savedTime(recovery.updated_at)} from version {recovery.base_version}. It has
              not been saved as a version.
            </span>
            <div>
              <button type="button" onClick={restoreDraft}>
                Restore draft
              </button>
              <button type="button" onClick={() => setInspectRecovery((value) => !value)}>
                {inspectRecovery ? "Hide comparison" : "Inspect changes"}
              </button>
              <button type="button" onClick={() => void discardDraft()}>
                Discard draft
              </button>
            </div>
          </section>
        ) : null}

        {inspectRecovery && recovery !== null ? (
          <section className="canonical-editor__compare" aria-label="Recovery draft comparison">
            <article>
              <strong>Canonical version {object.version}</strong>
              <pre>{`${object.title}\n\n${object.content}`}</pre>
            </article>
            <article>
              <strong>Recovery draft</strong>
              <pre>{`${recovery.title}\n\n${recovery.content}`}</pre>
            </article>
          </section>
        ) : null}

        {editing && problems.length > 0 ? (
          <section className="canonical-editor__problems" aria-label="Publication problems">
            <strong>Problems</strong>
            <ul>
              {problems.map((problem) => (
                <li key={problem.code} data-severity={problem.severity}>
                  <button type="button" onClick={() => focusProblem(problem)}>
                    {problem.severity === "error" ? "Error" : "Warning"}: {problem.message}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {editing && (mode === "live-preview" || mode === "source") ? (
          <div
            className={`canonical-editor__fields${mode === "source" ? " canonical-editor__fields--source" : ""}`}
          >
            <label>
              <span>Title</span>
              <input
                ref={titleField}
                value={title}
                maxLength={500}
                aria-invalid={errors.some((problem) => problem.field === "title")}
                onBlur={() => void saveDraft()}
                onChange={(event) => changeTitle(event.target.value)}
              />
            </label>
            <label>
              <span>Content</span>
              <textarea
                ref={contentField}
                value={content}
                aria-invalid={errors.some((problem) => problem.field === "content")}
                onBlur={() => void saveDraft()}
                onChange={(event) => changeContent(event.target.value)}
              />
            </label>
          </div>
        ) : null}

        {mode === "source" && !editing ? (
          <pre className="canonical-editor__source">{shownContent}</pre>
        ) : null}
        {mode !== "source" ? (
          <SafeMarkdown
            content={shownContent}
            {...(onOpenAnnotation === undefined ? {} : { onOpenAnnotation })}
          />
        ) : null}

        {publishStage === "review" && publicationPreview !== null ? (
          <section className="canonical-editor__publication-review" aria-label="Version review">
            <div>
              <strong>Review this version</strong>
              <span>Kiwi will create immutable version {baseVersion + 1}.</span>
            </div>
            {publicationPreview.problems.some((problem) => problem.severity === "warning") ? (
              <ul>
                {publicationPreview.problems
                  .filter((problem) => problem.severity === "warning")
                  .map((problem) => (
                    <li key={problem.code}>{problem.message}</li>
                  ))}
              </ul>
            ) : null}
            {publicationPreview.impact.relation_count > 0 ? (
              <p>
                This object has {publicationPreview.impact.relation_count} linked{" "}
                {publicationPreview.impact.relation_count === 1 ? "relation" : "relations"} across{" "}
                {publicationPreview.impact.related_object_count} related{" "}
                {publicationPreview.impact.related_object_count === 1 ? "object" : "objects"}. Those
                links remain attached to this object identity.
              </p>
            ) : null}
            <label>
              <span>Version message (optional)</span>
              <input
                value={versionMessage}
                maxLength={500}
                onChange={(event) => setVersionMessage(event.target.value)}
              />
            </label>
            <div className="canonical-editor__publication-actions">
              <button
                type="button"
                className="canonical-editor__publish"
                onClick={() => void commitPublication(publicationPreview)}
              >
                Save version
              </button>
              <button
                type="button"
                onClick={() => {
                  setPublishStage("idle");
                  setPublicationPreview(null);
                }}
              >
                Cancel
              </button>
            </div>
          </section>
        ) : null}

        <footer className="canonical-editor__status" aria-live="polite">
          <span>
            {saveState === "autosaving"
              ? "Autosaving recovery draft"
              : saveState === "protected" && recovery !== null
                ? `Recovery draft protected ${savedTime(recovery.updated_at)}`
                : editing
                  ? "Canonical version unchanged"
                  : checking
                    ? "Checking for recovery drafts"
                    : "Read mode"}
          </span>
          <span>{wordCount(shownContent)} words</span>
        </footer>

        {publishError === null ? null : (
          <div className="canonical-editor__error" role="alert">
            <span>{publishError}</span>
          </div>
        )}
        {message === null ? null : (
          <div
            className={
              saveState === "error" ? "canonical-editor__error" : "canonical-editor__message"
            }
            role={saveState === "error" ? "alert" : "status"}
          >
            <span>{message}</span>
            {saveState === "error" ? (
              <button
                type="button"
                onClick={() => {
                  if (editing) void saveDraft();
                  else setCheckRevision((value) => value + 1);
                }}
              >
                {editing ? "Retry recovery save" : "Retry draft storage"}
              </button>
            ) : null}
          </div>
        )}
      </div>
    </article>
  );
}
