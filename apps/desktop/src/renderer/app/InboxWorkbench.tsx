import { useCallback, useEffect, useMemo, useState } from "react";
import { objectEventLabel } from "@kiwi/contracts";
import { readBridge, type RendererCommandResult } from "./bridge.js";
import { readConflict } from "./conflict-review.js";
import { ConflictReview } from "./ConflictReview.js";

export interface InboxObjectView {
  id: string;
  type: string;
  title: string;
  content: string;
  version: number;
  content_hash: string;
  updated_at: string;
  updated_by: string;
  provenance?: unknown[];
}

interface QuickCaptureProvenanceView {
  type: "quick_capture";
  captured_at: string;
  capture_command: "kiwi.object.quick-capture";
  surface: string;
  project_id: string | null;
  object: {
    object_id: string;
    object_type: string;
    object_title: string;
    version: number;
    content_hash: string;
  } | null;
  source: {
    object_id: string;
    object_type: string;
    object_title: string;
    version: number;
    content_hash: string;
    representation_id: string | null;
  } | null;
  selection: { text: string; prefix: string | null; suffix: string | null } | null;
}

/** A project as the Inbox needs it: a name to read and something to file a note into. */
interface ProjectChoice {
  id: string;
  title: string;
}

interface HistoryView {
  version: number;
  title: string;
  content_hash: string;
  updated_at: string;
  updated_by: string;
}

interface RelationView {
  direction: "incoming" | "outgoing";
  relation: {
    id: string;
    type: string;
    subject: { object_id: string };
    object: { object_id: string };
  };
}

interface ActivityView {
  id: string;
  event_type: string;
  occurred_at: string;
  actor: string;
  version: number | null;
}

interface ConflictView {
  id: string;
  object_id: string;
  status: "unresolved" | "resolved";
  base_snapshot?: InboxObjectView;
  mine: InboxObjectView | null;
  theirs: InboxObjectView;
}

type Inspector = "closed" | "connections" | "history" | "conflict";

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

function resultError(result: RendererCommandResult): string | null {
  if (result.error?.code === "KIWI_CONFLICT_VERSION") {
    return "This note changed elsewhere. Your draft is still here; reload the saved version before saving your own.";
  }
  return result.error?.message ?? null;
}

function quickCaptureProvenance(object: InboxObjectView | null): QuickCaptureProvenanceView | null {
  const value = object?.provenance?.find(
    (item) =>
      item !== null &&
      typeof item === "object" &&
      !Array.isArray(item) &&
      (item as Record<string, unknown>)["type"] === "quick_capture",
  );
  return (value as QuickCaptureProvenanceView | undefined) ?? null;
}

export function InboxWorkbench({
  workspaceId,
  writable,
  initialObjectId,
}: {
  workspaceId: string;
  writable: boolean;
  initialObjectId?: string | null;
}): React.JSX.Element {
  const [objects, setObjects] = useState<InboxObjectView[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [current, setCurrent] = useState<InboxObjectView | null>(null);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [history, setHistory] = useState<HistoryView[]>([]);
  const [activity, setActivity] = useState<ActivityView[]>([]);
  const [relations, setRelations] = useState<RelationView[]>([]);
  const [conflicts, setConflicts] = useState<ConflictView[]>([]);
  const [projects, setProjects] = useState<ProjectChoice[]>([]);
  const [projectId, setProjectId] = useState("");
  const [inspector, setInspector] = useState<Inspector>("closed");
  const [relationType, setRelationType] = useState("supports");
  const [relationTarget, setRelationTarget] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const applyObject = useCallback((object: InboxObjectView): void => {
    setCurrent(object);
    setSelectedId(object.id);
    setTitle(object.title);
    setContent(object.content);
  }, []);

  const loadObjects = useCallback(async (): Promise<InboxObjectView[]> => {
    const result = await invoke(workspaceId, "kiwi.projection.list", {});
    const message = resultError(result);
    if (message !== null) throw new Error(message);
    const next = (((result.data ?? {})["objects"] as InboxObjectView[] | undefined) ?? []).filter(
      (object) => object.type === "inbox_item",
    );
    setObjects(next);
    return next;
  }, [workspaceId]);

  const loadObject = useCallback(
    async (objectId: string): Promise<void> => {
      setLoading(true);
      setError(null);
      try {
        const [objectResult, historyResult, relationResult, conflictResult, projectResult] =
          await Promise.all([
            invoke(workspaceId, "kiwi.object.read", { object_id: objectId }),
            invoke(workspaceId, "kiwi.object.history", { object_id: objectId }),
            invoke(workspaceId, "kiwi.projection.relations", { object_id: objectId }),
            invoke(workspaceId, "kiwi.conflict.list", { object_id: objectId }),
            invoke(workspaceId, "kiwi.project.membership", { object_id: objectId }),
          ]);
        const failed = [objectResult, historyResult, relationResult, conflictResult]
          .map(resultError)
          .find((message) => message !== null);
        if (failed !== undefined && failed !== null) throw new Error(failed);
        applyObject((objectResult.data ?? {})["object"] as InboxObjectView);
        setHistory(((historyResult.data ?? {})["history"] as HistoryView[] | undefined) ?? []);
        setActivity(((historyResult.data ?? {})["activity"] as ActivityView[] | undefined) ?? []);
        setRelations(
          ((relationResult.data ?? {})["relations"] as RelationView[] | undefined) ?? [],
        );
        setConflicts(
          ((conflictResult.data ?? {})["conflicts"] as ConflictView[] | undefined) ?? [],
        );
        // Read beside the note rather than out of it: which project something belongs to is a
        // relation, so a note promoted into a Paper keeps the answer it had in the Inbox.
        const holder = (projectResult.data ?? {})["project"] as { id: string } | null | undefined;
        setProjectId(holder?.id ?? "");
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Kiwi could not open this note.");
      } finally {
        setLoading(false);
      }
    },
    [applyObject, workspaceId],
  );

  useEffect(() => {
    let active = true;
    setLoading(true);
    void loadObjects()
      .then((next) => {
        if (!active) return;
        const initial = next.find((item) => item.id === initialObjectId) ?? next[0];
        if (initial !== undefined) void loadObject(initial.id);
        else setLoading(false);
      })
      .catch((cause: unknown) => {
        if (!active) return;
        setError(cause instanceof Error ? cause.message : "Kiwi could not load the Inbox.");
        setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [initialObjectId, loadObject, loadObjects]);

  useEffect(() => {
    let active = true;
    void invoke(workspaceId, "kiwi.project.list", {})
      .then((result) => {
        if (!active) return;
        setProjects(((result.data ?? {})["projects"] as ProjectChoice[] | undefined) ?? []);
      })
      .catch(() => {
        // The note still opens without the list. What it cannot then do is offer a project.
        if (active) setProjects([]);
      });
    return () => {
      active = false;
    };
  }, [workspaceId]);

  const dirty =
    current === null
      ? title.trim() !== "" || content !== ""
      : title !== current.title || content !== current.content;

  useEffect(() => {
    if (current === null || busy || loading) return;
    let active = true;
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const result = await invoke(workspaceId, "kiwi.object.read", {
            object_id: current.id,
          });
          if (!active || result.error !== undefined) return;
          const external = (result.data ?? {})["object"] as InboxObjectView;
          if (external.content_hash === current.content_hash) return;
          if (!dirty) {
            applyObject(external);
            setSaved("Refreshed after an external file edit");
            await loadObjects();
            return;
          }
          const conflictResult = await invoke(workspaceId, "kiwi.conflict.record-external", {
            object_id: current.id,
            base_version: current.version,
            base_hash: current.content_hash,
            mine_title: title,
            mine_content: content,
          });
          if (!active || conflictResult.error !== undefined) return;
          const conflict = (conflictResult.data ?? {})["conflict"] as ConflictView;
          setCurrent(external);
          setConflicts((items) => [...items.filter((item) => item.id !== conflict.id), conflict]);
          setSaved("External edit found · both versions preserved");
        } catch {
          // Reconciliation polling stays quiet; normal commands surface actionable errors.
        }
      })();
    }, 1_500);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [applyObject, busy, content, current, dirty, loadObjects, loading, title, workspaceId]);
  const otherObjects = useMemo(
    () => objects.filter((object) => object.id !== selectedId),
    [objects, selectedId],
  );
  const captureContext = quickCaptureProvenance(current);
  // Diffing is real work and a note can be long, so it is done when the conflicts change rather
  // than on every keystroke in the editor above it.
  const unresolved = useMemo(
    () =>
      conflicts
        .filter((item) => item.status === "unresolved")
        .map((item) => ({ id: item.id, reading: readConflict(item, new Date()) })),
    [conflicts],
  );

  useEffect(() => {
    if (current === null) return;
    window.dispatchEvent(
      new CustomEvent("kiwi:object-context", {
        detail: {
          id: current.id,
          title: current.title,
          type: current.type,
          version: current.version,
          content_hash: current.content_hash,
        },
      }),
    );
  }, [current]);

  function startNew(): void {
    setSelectedId(null);
    setCurrent(null);
    setTitle("");
    setContent("");
    setHistory([]);
    setActivity([]);
    setRelations([]);
    setConflicts([]);
    setInspector("closed");
    setError(null);
    setSaved(null);
  }

  async function save(): Promise<void> {
    if (!writable || title.trim() === "" || !dirty) return;
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      const command = current === null ? "kiwi.object.create-inbox" : "kiwi.object.save";
      const args =
        current === null
          ? { title, content }
          : {
              object_id: current.id,
              expected_version: current.version,
              expected_hash: current.content_hash,
              title,
              content,
            };
      const result = await invoke(workspaceId, command, args);
      const message = resultError(result);
      if (message !== null) {
        setError(message);
        return;
      }
      const object = (result.data ?? {})["object"] as InboxObjectView;
      applyObject(object);
      const sync = (result.data ?? {})["sync"] as { status?: string } | undefined;
      const syncMessage =
        sync?.status === "pending"
          ? " · Saved locally; sync pending"
          : sync?.status === "conflict"
            ? " · Conflict needs review"
            : "";
      setSaved(
        `${current === null ? "Added to Inbox" : `Saved version ${object.version}`}${syncMessage}`,
      );
      await loadObjects();
      await loadObject(object.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Kiwi could not save this note.");
    } finally {
      setBusy(false);
    }
  }

  async function restore(version: number): Promise<void> {
    if (current === null || !writable) return;
    setBusy(true);
    setError(null);
    try {
      const result = await invoke(workspaceId, "kiwi.object.restore-version", {
        object_id: current.id,
        restore_version: version,
        expected_version: current.version,
        expected_hash: current.content_hash,
        reason: `Restore version ${version}`,
      });
      const message = resultError(result);
      if (message !== null) {
        setError(message);
        return;
      }
      const object = (result.data ?? {})["object"] as InboxObjectView;
      applyObject(object);
      setSaved(`Restored version ${version} as version ${object.version}`);
      await loadObjects();
      await loadObject(object.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Kiwi could not restore this version.");
    } finally {
      setBusy(false);
    }
  }

  /**
   * Files the open note in a project, or takes it out of the one it is in.
   *
   * No version guard, and none to give: the project an object belongs to is a relation beside the
   * object rather than a field inside it, so filing a note somewhere else does not touch the draft
   * being typed above. Promoting the note later keeps its identity, and so keeps this.
   */
  async function fileInProject(next: string): Promise<void> {
    if (current === null || !writable) return;
    const previous = projectId;
    setProjectId(next);
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      const result = await invoke(workspaceId, "kiwi.project.assign", {
        object_id: current.id,
        project_id: next === "" ? null : next,
      });
      const message = resultError(result);
      if (message !== null) {
        setProjectId(previous);
        setError(message);
        return;
      }
      const chosen = projects.find((project) => project.id === next);
      setSaved(chosen === undefined ? "Taken out of its project" : `Filed in ${chosen.title}`);
    } catch (cause) {
      setProjectId(previous);
      setError(cause instanceof Error ? cause.message : "Kiwi could not file this note.");
    } finally {
      setBusy(false);
    }
  }

  async function addRelation(): Promise<void> {
    if (current === null || relationTarget === "" || relationType.trim() === "" || !writable)
      return;
    setBusy(true);
    setError(null);
    try {
      const result = await invoke(workspaceId, "kiwi.relation.create", {
        type: relationType,
        subject_id: current.id,
        object_id: relationTarget,
      });
      const message = resultError(result);
      if (message !== null) {
        setError(message);
        return;
      }
      setRelationTarget("");
      const refreshed = await invoke(workspaceId, "kiwi.relation.for-object", {
        object_id: current.id,
      });
      setRelations(((refreshed.data ?? {})["relations"] as RelationView[] | undefined) ?? []);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Kiwi could not add the connection.");
    } finally {
      setBusy(false);
    }
  }

  async function resolveConflict(
    conflictId: string,
    resolution: "mine" | "theirs",
    keepOther: boolean,
  ) {
    if (current === null || !writable) return;
    setBusy(true);
    setError(null);
    try {
      const result = await invoke(workspaceId, "kiwi.conflict.resolve", {
        conflict_id: conflictId,
        resolution,
        expected_version: current.version,
        expected_hash: current.content_hash,
        ...(keepOther ? { keep_other: true } : {}),
      });
      const message = resultError(result);
      if (message !== null) {
        setError(message);
        return;
      }
      const object = (result.data ?? {})["object"] as InboxObjectView;
      // The copy is somewhere else in the library by the time this is read, so it is named:
      // "resolved" on its own would leave somebody wondering whether the other side survived.
      const kept = (result.data ?? {})["kept"] as { title: string } | null | undefined;
      applyObject(object);
      setSaved(
        kept === null || kept === undefined
          ? `Resolved as version ${object.version}`
          : `Resolved as version ${object.version}. The other version is now a note called ${kept.title}.`,
      );
      setInspector("closed");
      await loadObjects();
      await loadObject(object.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Kiwi could not resolve the conflict.");
    } finally {
      setBusy(false);
    }
  }

  function objectTitle(id: string): string {
    return objects.find((object) => object.id === id)?.title ?? "Unknown note";
  }

  function projectTitle(id: string): string {
    return projects.find((project) => project.id === id)?.title ?? "A project that is gone";
  }

  return (
    <div className="inbox-workbench" aria-busy={busy || loading}>
      <aside className="inbox-list" aria-label="Inbox">
        <div className="inbox-list__heading">
          <span>Inbox</span>
          <button type="button" disabled={!writable || busy} onClick={startNew}>
            New
          </button>
        </div>
        {objects.length === 0 ? (
          <p>Capture the first idea, source, or question for this workspace.</p>
        ) : (
          <ul>
            {objects.map((object) => (
              <li key={object.id}>
                <button
                  aria-label={object.title}
                  type="button"
                  aria-current={selectedId === object.id ? "page" : undefined}
                  onClick={() => void loadObject(object.id)}
                >
                  <span>{object.title}</span>
                  <small>v{object.version}</small>
                </button>
              </li>
            ))}
          </ul>
        )}
      </aside>

      <article className="object-editor" aria-label="Inbox note editor">
        <header className="object-editor__header">
          <div>
            <span>{current === null ? "New Inbox note" : `Inbox note · v${current.version}`}</span>
            {dirty ? <small>Unsaved changes</small> : null}
          </div>
          <button
            className="button button--primary"
            type="button"
            disabled={!writable || busy || title.trim() === "" || !dirty}
            onClick={() => void save()}
          >
            {busy ? "Saving" : current === null ? "Add to Inbox" : "Save"}
          </button>
        </header>

        {captureContext === null ? null : (
          <section className="object-editor__capture-context" aria-label="Quick Capture context">
            <div>
              <strong>Captured with context</strong>
              <span>
                {new Date(captureContext.captured_at).toLocaleString()} from{" "}
                {captureContext.surface.replaceAll("-", " ")}
              </span>
            </div>
            <dl>
              <div>
                <dt>Active item</dt>
                <dd>
                  {captureContext.object === null
                    ? "Workspace only"
                    : `${captureContext.object.object_title} (version ${captureContext.object.version})`}
                </dd>
              </div>
              {captureContext.project_id === null ? null : (
                <div>
                  <dt>Captured in</dt>
                  {/* The project that was open at the time, by name. The identifier is what was
                      recorded, and an identifier tells the person who captured it nothing. */}
                  <dd>{projectTitle(captureContext.project_id)}</dd>
                </div>
              )}
              {captureContext.source === null ? null : (
                <div>
                  <dt>Source</dt>
                  <dd>
                    {captureContext.source.object_title} (version {captureContext.source.version})
                  </dd>
                </div>
              )}
            </dl>
            {captureContext.selection === null ? null : (
              <blockquote>{captureContext.selection.text}</blockquote>
            )}
          </section>
        )}

        <label className="object-editor__title">
          <span>Title</span>
          <input
            value={title}
            maxLength={200}
            disabled={!writable || loading}
            placeholder="What are you working on?"
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        <label className="object-editor__content">
          <span>Note</span>
          <textarea
            value={content}
            disabled={!writable || loading}
            placeholder="Write a thought, paste a source, or leave yourself a question…"
            onChange={(event) => setContent(event.target.value)}
          />
        </label>

        {current === null ? null : (
          <label className="object-editor__project">
            <span>Project</span>
            <select
              value={projectId}
              disabled={!writable || busy || loading}
              onChange={(event) => void fileInProject(event.target.value)}
            >
              <option value="">No project</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.title}
                </option>
              ))}
              {/* The project it is in, when that project is no longer one you can choose. Without
                  it the chooser would read "No project" for a note that is in one. */}
              {projectId !== "" && !projects.some((project) => project.id === projectId) ? (
                <option value={projectId}>{projectTitle(projectId)}</option>
              ) : null}
            </select>
          </label>
        )}

        {error !== null ? (
          <div className="object-editor__error" role="alert">
            <span>{error}</span>
            {current !== null && error.startsWith("This note changed") ? (
              <button type="button" onClick={() => void loadObject(current.id)}>
                Reload saved version
              </button>
            ) : null}
          </div>
        ) : null}
        {saved !== null ? (
          <p className="object-editor__saved" role="status">
            {saved}
          </p>
        ) : null}

        {conflicts.some((item) => item.status === "unresolved") ? (
          <div className="object-editor__conflict" role="alert">
            <span>This note has two saved versions. Both are preserved.</span>
            <button type="button" onClick={() => setInspector("conflict")}>
              Review versions
            </button>
          </div>
        ) : null}

        {current !== null ? (
          <footer className="object-editor__footer">
            <button
              type="button"
              aria-expanded={inspector === "connections"}
              onClick={() => setInspector(inspector === "connections" ? "closed" : "connections")}
            >
              Connections {relations.length > 0 ? `(${relations.length})` : ""}
            </button>
            <button
              type="button"
              aria-expanded={inspector === "history"}
              onClick={() => setInspector(inspector === "history" ? "closed" : "history")}
            >
              History ({history.length})
            </button>
          </footer>
        ) : null}

        {current !== null && inspector === "connections" ? (
          <section className="object-inspector" aria-label="Connections">
            {relations.length === 0 ? <p>No connections yet.</p> : null}
            <ul>
              {relations.map(({ relation, direction }) => {
                const relatedId =
                  direction === "outgoing" ? relation.object.object_id : relation.subject.object_id;
                return (
                  <li key={`${relation.id}-${direction}`}>
                    <span>
                      {direction === "outgoing" ? relation.type : `is ${relation.type} by`}
                    </span>
                    <button type="button" onClick={() => void loadObject(relatedId)}>
                      {objectTitle(relatedId)}
                    </button>
                  </li>
                );
              })}
            </ul>
            {otherObjects.length > 0 ? (
              <div className="object-inspector__add">
                <input
                  aria-label="Connection type"
                  value={relationType}
                  onChange={(event) => setRelationType(event.target.value)}
                />
                <select
                  aria-label="Connected note"
                  value={relationTarget}
                  onChange={(event) => setRelationTarget(event.target.value)}
                >
                  <option value="">Choose a note</option>
                  {otherObjects.map((object) => (
                    <option key={object.id} value={object.id}>
                      {object.title}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  disabled={
                    !writable || busy || relationTarget === "" || relationType.trim() === ""
                  }
                  onClick={() => void addRelation()}
                >
                  Connect
                </button>
              </div>
            ) : null}
          </section>
        ) : null}

        {current !== null && inspector === "history" ? (
          <section className="object-inspector" aria-label="Version history">
            <ol className="object-history">
              {[...history].reverse().map((entry) => (
                <li key={entry.version}>
                  <div>
                    <strong>Version {entry.version}</strong>
                    <span>{new Date(entry.updated_at).toLocaleString()}</span>
                  </div>
                  {entry.version === current.version ? (
                    <span>Current</span>
                  ) : (
                    <button
                      type="button"
                      disabled={!writable || busy}
                      onClick={() => void restore(entry.version)}
                    >
                      Restore
                    </button>
                  )}
                </li>
              ))}
            </ol>
            {activity.length > 0 ? (
              <>
                <h3>Activity</h3>
                <ol className="object-history">
                  {[...activity].reverse().map((entry) => (
                    <li key={entry.id}>
                      <div>
                        <strong>{objectEventLabel(entry.event_type)}</strong>
                        <span>{new Date(entry.occurred_at).toLocaleString()}</span>
                      </div>
                      {entry.version === null ? null : <span>v{entry.version}</span>}
                    </li>
                  ))}
                </ol>
              </>
            ) : null}
          </section>
        ) : null}

        {current !== null && inspector === "conflict" ? (
          <section className="object-inspector" aria-label="Conflict comparison">
            {unresolved.map((conflict) => (
              <ConflictReview
                key={conflict.id}
                reading={conflict.reading}
                disabled={busy || !writable}
                onKeep={(side, keepOther) => void resolveConflict(conflict.id, side, keepOther)}
              />
            ))}
          </section>
        ) : null}
      </article>
    </div>
  );
}
