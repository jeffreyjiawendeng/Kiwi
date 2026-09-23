import { useCallback, useEffect, useRef, useState } from "react";
import { readBridge, type RendererCommandResult } from "./bridge.js";

export interface LiveNoteView {
  document_id: string;
  title: string;
  content: string;
  content_hash: string;
  operation_count: number;
  updated_at: string;
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

function errorMessage(result: RendererCommandResult): string | null {
  if (result.error?.code === "KIWI_CONFLICT_VERSION")
    return "This note changed on another device. Kiwi kept your draft; reload the shared text and try again.";
  return result.error?.message ?? null;
}

export function LiveNotesWorkbench({
  workspaceId,
  writable,
}: {
  workspaceId: string;
  writable: boolean;
}): React.JSX.Element {
  const [notes, setNotes] = useState<LiveNoteView[]>([]);
  const [current, setCurrent] = useState<LiveNoteView | null>(null);
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState("All changes are local and synchronized");
  const [presence, setPresence] = useState<Array<{ actor_id: string; cursor: number }>>([]);
  const [error, setError] = useState<string | null>(null);
  const draft = useRef(content);
  draft.current = content;

  const loadList = useCallback(async (): Promise<LiveNoteView[]> => {
    const result = await invoke(workspaceId, "kiwi.note.list", {});
    const message = errorMessage(result);
    if (message !== null) throw new Error(message);
    const next = ((result.data ?? {})["notes"] as LiveNoteView[] | undefined) ?? [];
    setNotes(next);
    return next;
  }, [workspaceId]);

  const open = useCallback(
    async (documentId: string, resetStatus = true): Promise<void> => {
      setError(null);
      const result = await invoke(workspaceId, "kiwi.note.read", { document_id: documentId });
      const message = errorMessage(result);
      if (message !== null) throw new Error(message);
      const note = (result.data ?? {})["note"] as LiveNoteView;
      setCurrent(note);
      setCreating(false);
      setTitle(note.title);
      setContent(note.content);
      if (resetStatus) setStatus("All changes are local and synchronized");
    },
    [workspaceId],
  );

  useEffect(() => {
    void loadList()
      .then((next) => (next[0] === undefined ? undefined : open(next[0].document_id)))
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : "Kiwi could not load live notes."),
      );
  }, [loadList, open]);

  useEffect(() => {
    if (!writable || creating || current === null || content === current.content || saving) return;
    setStatus("Waiting to share changes…");
    const expected = current.content_hash;
    const submitted = content;
    const timer = window.setTimeout(() => {
      setSaving(true);
      setStatus("Sharing changes…");
      setError(null);
      void invoke(workspaceId, "kiwi.note.replace-text", {
        document_id: current.document_id,
        expected_hash: expected,
        content: submitted,
      })
        .then(async (result) => {
          const message = errorMessage(result);
          if (message !== null) throw new Error(message);
          const changed = (result.data ?? {})["note"] as LiveNoteView;
          const sync = (result.data ?? {})["sync"] as
            | {
                status?: string;
                pending?: number;
                collaborators?: number;
                presence?: Array<{ actor_id: string; cursor: number }>;
              }
            | undefined;
          setCurrent(changed);
          setNotes((items) =>
            items.map((item) => (item.document_id === changed.document_id ? changed : item)),
          );
          setStatus(
            sync?.status === "pending"
              ? "Saved locally · synchronization queued"
              : `${sync?.collaborators ?? 1} collaborator${sync?.collaborators === 1 ? "" : "s"} present · synchronized`,
          );
          setPresence(sync?.presence ?? []);
          if (draft.current === submitted) await open(changed.document_id, false);
        })
        .catch((cause: unknown) => {
          setError(cause instanceof Error ? cause.message : "Kiwi could not share this change.");
          setStatus("Draft preserved on this device");
        })
        .finally(() => setSaving(false));
    }, 450);
    return () => window.clearTimeout(timer);
  }, [content, creating, current, open, saving, workspaceId, writable]);

  async function create(): Promise<void> {
    if (title.trim() === "") return;
    setSaving(true);
    setError(null);
    try {
      const result = await invoke(workspaceId, "kiwi.note.create", { title, content });
      const message = errorMessage(result);
      if (message !== null) throw new Error(message);
      const note = (result.data ?? {})["note"] as LiveNoteView;
      await loadList();
      setCurrent(note);
      setCreating(false);
      setTitle(note.title);
      setContent(note.content);
      const sync = (result.data ?? {})["sync"] as { status?: string } | undefined;
      setStatus(
        sync?.status === "pending"
          ? "Saved locally · synchronization queued"
          : "Created and synchronized",
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Kiwi could not create this note.");
    } finally {
      setSaving(false);
    }
  }

  function startNew(): void {
    setCreating(true);
    setCurrent(null);
    setTitle("");
    setContent("");
    setError(null);
    setStatus("New live note");
  }

  return (
    <div className="inbox-workbench live-notes" aria-busy={saving}>
      <aside className="inbox-list" aria-label="Live notes">
        <div className="inbox-list__heading">
          <span>Live notes</span>
          <button type="button" disabled={!writable || saving} onClick={startNew}>
            New
          </button>
        </div>
        {notes.length === 0 ? (
          <p>Start a note that collaborators can edit with you, online or offline.</p>
        ) : (
          <ul>
            {notes.map((note) => (
              <li key={note.document_id}>
                <button
                  type="button"
                  aria-current={current?.document_id === note.document_id ? "page" : undefined}
                  onClick={() => void open(note.document_id)}
                >
                  <span>{note.title}</span>
                  <small>{note.operation_count} changes</small>
                </button>
              </li>
            ))}
          </ul>
        )}
      </aside>
      <article className="object-editor" aria-label="Live note editor">
        <header className="object-editor__header">
          <div>
            <span>{creating ? "New live note" : "Collaborative note"}</span>
            <small role="status">{saving ? "Sharing changes…" : status}</small>
            {presence.length > 1 ? (
              <small className="live-notes__presence" aria-label="Collaborator cursors">
                Cursors at {presence.map((item) => item.cursor).join(", ")}
              </small>
            ) : null}
          </div>
          {creating ? (
            <button
              className="button button--primary"
              type="button"
              disabled={!writable || saving || title.trim() === ""}
              onClick={() => void create()}
            >
              Create note
            </button>
          ) : null}
        </header>
        <label className="object-editor__title">
          <span>Title</span>
          <input
            value={title}
            maxLength={200}
            readOnly={!creating}
            disabled={!writable}
            placeholder="Shared note title"
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        <label className="object-editor__content">
          <span>Note</span>
          <textarea
            value={content}
            disabled={!writable || (!creating && current === null)}
            placeholder="Write together…"
            onChange={(event) => setContent(event.target.value)}
          />
        </label>
        {error !== null ? (
          <div className="object-editor__error" role="alert">
            <span>{error}</span>
            {current === null ? null : (
              <button type="button" onClick={() => void open(current.document_id)}>
                Reload shared text
              </button>
            )}
          </div>
        ) : null}
      </article>
    </div>
  );
}
