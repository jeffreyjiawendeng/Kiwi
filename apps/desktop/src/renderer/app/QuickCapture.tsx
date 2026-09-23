import { useEffect, useRef, useState } from "react";
import { readBridge, type RendererCommandResult } from "./bridge.js";

export interface QuickCaptureObjectContext {
  id: string;
  title: string;
  type: string;
  version: number;
  content_hash: string;
}

export interface QuickCaptureSelection {
  text: string;
  prefix: string | null;
  suffix: string | null;
}

export interface QuickCaptureLaunch {
  surface: string;
  projectId: string | null;
  object: QuickCaptureObjectContext | null;
  selection: QuickCaptureSelection | null;
}

async function invoke(
  workspaceId: string,
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
    command: "kiwi.object.quick-capture",
    args,
  });
}

function defaultTitle(launch: QuickCaptureLaunch): string {
  const selected = launch.selection?.text.trim().replace(/\s+/gu, " ");
  if (selected !== undefined && selected !== "")
    return selected.length > 80 ? `${selected.slice(0, 79)}...` : selected;
  if (launch.object !== null) return `Capture from ${launch.object.title}`.slice(0, 200);
  return "Quick capture";
}

export function readQuickCaptureSelection(): QuickCaptureSelection | null {
  const active = document.activeElement;
  if (active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement) {
    const start = active.selectionStart;
    const end = active.selectionEnd;
    if (start !== null && end !== null && end > start) {
      const text = active.value.slice(start, end);
      if (text.trim() !== "")
        return {
          text,
          prefix: active.value.slice(Math.max(0, start - 500), start) || null,
          suffix: active.value.slice(end, end + 500) || null,
        };
    }
  }
  const selection = window.getSelection();
  const text = selection?.toString() ?? "";
  return text.trim() === "" ? null : { text, prefix: null, suffix: null };
}

export function QuickCapture({
  workspaceId,
  writable,
  launch,
  onClose,
  onCaptured,
}: {
  workspaceId: string;
  writable: boolean;
  launch: QuickCaptureLaunch;
  onClose: () => void;
  onCaptured: (objectId: string) => void;
}): React.JSX.Element {
  const [title, setTitle] = useState(() => defaultTitle(launch));
  const [content, setContent] = useState(() => launch.selection?.text ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const editor = contentRef.current;
    editor?.focus();
    if (editor !== null && launch.selection !== null)
      editor.setSelectionRange(editor.value.length, editor.value.length);
  }, [launch.selection]);

  async function capture(): Promise<void> {
    if (!writable || title.trim() === "" || busy) return;
    setBusy(true);
    setError(null);
    try {
      const reference =
        launch.object === null
          ? null
          : {
              object_id: launch.object.id,
              version: launch.object.version,
              content_hash: launch.object.content_hash,
            };
      const result = await invoke(workspaceId, {
        title,
        content,
        context: {
          surface: launch.surface,
          project_id: launch.projectId,
          object: reference,
          source:
            launch.object?.type === "source" ? { ...reference, representation_id: null } : null,
          selection: launch.selection,
        },
      });
      if (result.error !== undefined) throw new Error(result.error.message);
      const object = (result.data ?? {})["object"] as { id?: unknown } | undefined;
      if (typeof object?.id !== "string")
        throw new Error("Kiwi returned an invalid capture receipt.");
      onCaptured(object.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Kiwi could not add this capture.");
    } finally {
      setBusy(false);
    }
  }

  function keyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    if (event.key === "Escape" && !busy) {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === "Enter" && event.ctrlKey && !busy) {
      event.preventDefault();
      void capture();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [
      ...(dialogRef.current?.querySelectorAll<HTMLElement>("input, textarea, button") ?? []),
    ].filter((element) => !element.hasAttribute("disabled"));
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

  return (
    <div className="quick-capture__backdrop">
      <div
        ref={dialogRef}
        className="quick-capture"
        role="dialog"
        aria-modal="true"
        aria-labelledby="quick-capture-title"
        aria-describedby="quick-capture-description"
        onKeyDown={keyDown}
      >
        <header>
          <div>
            <span>Inbox</span>
            <h2 id="quick-capture-title">Quick Capture</h2>
          </div>
          <kbd>Ctrl+Shift+I</kbd>
        </header>
        <p id="quick-capture-description">
          Save this thought now and classify, connect, or promote it later.
        </p>
        <label>
          Title
          <input
            value={title}
            maxLength={200}
            disabled={!writable || busy}
            onChange={(event) => setTitle(event.currentTarget.value)}
          />
        </label>
        <label>
          Note
          <textarea
            ref={contentRef}
            value={content}
            maxLength={1_000_000}
            disabled={!writable || busy}
            placeholder="Capture a thought, question, or passage..."
            onChange={(event) => setContent(event.currentTarget.value)}
          />
        </label>
        <section className="quick-capture__context" aria-labelledby="capture-context-title">
          <strong id="capture-context-title">Context saved with this item</strong>
          <dl>
            <div>
              <dt>Surface</dt>
              <dd>{launch.surface.replaceAll("-", " ")}</dd>
            </div>
            <div>
              <dt>Active item</dt>
              <dd>
                {launch.object === null
                  ? "No active item"
                  : `${launch.object.title} (version ${launch.object.version})`}
              </dd>
            </div>
            <div>
              <dt>Project</dt>
              <dd>{launch.projectId ?? "Workspace context"}</dd>
            </div>
          </dl>
          {launch.selection === null ? null : <blockquote>{launch.selection.text}</blockquote>}
        </section>
        {writable ? null : (
          <p className="quick-capture__error" role="status">
            This workspace is read only. The text remains here until you cancel.
          </p>
        )}
        {error === null ? null : (
          <p className="quick-capture__error" role="alert">
            {error} Your capture is still here.
          </p>
        )}
        <footer>
          <span>Ctrl+Enter to add to Inbox</span>
          <div>
            <button type="button" disabled={busy} onClick={onClose}>
              Cancel
            </button>
            <button
              className="button button--primary"
              type="button"
              disabled={!writable || busy || title.trim() === ""}
              onClick={() => void capture()}
            >
              {busy ? "Adding..." : "Add to Inbox"}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
