import { useEffect, useRef, useState } from "react";
import { tagLabel, userTagId } from "@kiwi/contracts";
import { readBridge, type RendererCommandResult } from "./bridge.js";
import type { CanonicalObjectView } from "./CanonicalObjectEditor.js";

export type ObjectOrganizationAction =
  "rename" | "move" | "collect" | "project" | "tag" | "duplicate" | "reveal" | "trash";

export interface ObjectOrganizationRequest {
  object: CanonicalObjectView;
  action: ObjectOrganizationAction | null;
  revision: number;
}

interface OrganizationSnapshot {
  tags: string[];
  collections: Array<{ id: string; title: string; relation_id: string }>;
}

interface UndoDescriptor {
  command: string;
  args: Record<string, unknown>;
}

/** A project as this menu needs it: something to name in a list and something to file into. */
interface ProjectChoice {
  id: string;
  title: string;
}

interface TrashImpact {
  relation_count: number;
  incoming_count: number;
  outgoing_count: number;
  related_object_count: number;
  relation_types: string[];
  collection_membership_count: number;
}

interface TrashRelationGuard {
  relation_id: string;
  version: number;
  content_hash: string;
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

/**
 * The projects to choose between, and the one this object is filed in now.
 *
 * Both are needed together: a list on its own cannot show which entry is already the answer, and
 * a menu that opens on nothing in particular invites somebody to move an object that was never
 * anywhere else.
 */
async function readProjectChoices(
  workspaceId: string,
  objectId: string,
): Promise<{ projects: ProjectChoice[]; currentId: string }> {
  const [listed, current] = await Promise.all([
    invoke(workspaceId, "kiwi.project.list", {}),
    invoke(workspaceId, "kiwi.project.membership", { object_id: objectId }),
  ]);
  if (listed.error !== undefined) throw new Error(listed.error.message);
  if (current.error !== undefined) throw new Error(current.error.message);
  const projects = (listed.data ?? {})["projects"] as ProjectChoice[] | undefined;
  if (projects === undefined) throw new Error("Kiwi did not return the projects.");
  const holder = (current.data ?? {})["project"] as { id: string } | null | undefined;
  return { projects, currentId: holder?.id ?? "" };
}

const ACTION_LABEL: Record<ObjectOrganizationAction, string> = {
  rename: "Rename",
  move: "Move to collection",
  collect: "Add to collection",
  project: "Move to project",
  tag: "Add tag",
  duplicate: "Duplicate",
  reveal: "Reveal in File Explorer",
  trash: "Move to Trash",
};

export function ObjectOrganizationMenu({
  workspaceId,
  writable,
  request,
  onClose,
  onObjectChanged,
  onObjectTrashed,
  onCollectionChanged,
}: {
  workspaceId: string;
  writable: boolean;
  request: ObjectOrganizationRequest | null;
  onClose(): void;
  onObjectChanged(object: CanonicalObjectView): void;
  onObjectTrashed(objectId: string): void;
  onCollectionChanged(): void;
}): React.JSX.Element | null {
  const [action, setAction] = useState<ObjectOrganizationAction | null>(null);
  const [currentObject, setCurrentObject] = useState<CanonicalObjectView | null>(null);
  const [organization, setOrganization] = useState<OrganizationSnapshot>({
    tags: [],
    collections: [],
  });
  const [value, setValue] = useState("");
  const [sourceCollectionId, setSourceCollectionId] = useState("");
  const [projects, setProjects] = useState<ProjectChoice[]>([]);
  const [projectId, setProjectId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [undo, setUndo] = useState<UndoDescriptor | null>(null);
  const [trashImpact, setTrashImpact] = useState<TrashImpact | null>(null);
  const [trashRelationGuards, setTrashRelationGuards] = useState<TrashRelationGuard[]>([]);
  const [hasRecoveryDraft, setHasRecoveryDraft] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (request === null) return;
    setAction(request.action);
    setCurrentObject(request.object);
    setValue(
      request.action === "rename"
        ? request.object.title
        : request.action === "duplicate"
          ? `Copy of ${request.object.title}`
          : "",
    );
    setError(null);
    setMessage(null);
    setUndo(null);
    setTrashImpact(null);
    setTrashRelationGuards([]);
    setHasRecoveryDraft(false);
    setBusy(true);
    const organizationRequest = invoke(workspaceId, "kiwi.object.organization", {
      object_id: request.object.id,
    });
    const draftRequest = invoke(workspaceId, "kiwi.draft.read", { object_id: request.object.id });
    const trashRequest =
      request.action === "trash"
        ? invoke(workspaceId, "kiwi.object.validate-trash", {
            object_id: request.object.id,
            expected_version: request.object.version,
            expected_hash: request.object.content_hash,
          })
        : Promise.resolve(null);
    // Asked for only when the menu opens straight into the move, which is how the command palette
    // arrives. A rename is the common visit here, and a rename is worth no reading about projects.
    const projectRequest =
      request.action === "project"
        ? readProjectChoices(workspaceId, request.object.id)
        : Promise.resolve(null);
    void Promise.all([organizationRequest, draftRequest, trashRequest, projectRequest])
      .then(([organizationResult, draftResult, trashResult, projectResult]) => {
        if (organizationResult.error !== undefined)
          throw new Error(organizationResult.error.message);
        if (draftResult.error !== undefined) throw new Error(draftResult.error.message);
        if (trashResult?.error !== undefined) throw new Error(trashResult.error.message);
        const snapshot = (organizationResult.data ?? {})["organization"] as
          OrganizationSnapshot | undefined;
        if (snapshot === undefined) throw new Error("Kiwi did not return object organization.");
        setOrganization(snapshot);
        setSourceCollectionId(snapshot.collections[0]?.id ?? "");
        const draft = (draftResult.data ?? {})["draft"];
        setHasRecoveryDraft(draft !== null && draft !== undefined);
        if (trashResult !== null) {
          const preview = (trashResult.data ?? {})["preview"] as
            { impact?: TrashImpact; relation_guards?: TrashRelationGuard[] } | undefined;
          if (preview?.impact === undefined || !Array.isArray(preview.relation_guards))
            throw new Error("Kiwi did not return Trash impact.");
          setTrashImpact(preview.impact);
          setTrashRelationGuards(preview.relation_guards);
        }
        if (projectResult !== null) {
          setProjects(projectResult.projects);
          setProjectId(projectResult.currentId);
        }
      })
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : "Kiwi could not load organization."),
      )
      .finally(() => {
        setBusy(false);
        window.setTimeout(() => heading.current?.focus(), 0);
      });
  }, [request, workspaceId]);

  if (request === null) return null;
  const object = currentObject ?? request.object;
  const mutationDisabled = !writable || busy;

  async function chooseAction(candidate: ObjectOrganizationAction): Promise<void> {
    setAction(candidate);
    setError(null);
    setMessage(null);
    setUndo(null);
    if (candidate === "project") {
      setBusy(true);
      try {
        const choices = await readProjectChoices(workspaceId, object.id);
        setProjects(choices.projects);
        setProjectId(choices.currentId);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Kiwi could not read the projects.");
      } finally {
        setBusy(false);
      }
      return;
    }
    if (candidate !== "trash") {
      setValue(
        candidate === "rename"
          ? object.title
          : candidate === "duplicate"
            ? `Copy of ${object.title}`
            : "",
      );
      return;
    }
    setBusy(true);
    setTrashImpact(null);
    setTrashRelationGuards([]);
    try {
      const result = await invoke(workspaceId, "kiwi.object.validate-trash", {
        object_id: object.id,
        expected_version: object.version,
        expected_hash: object.content_hash,
      });
      if (result.error !== undefined) throw new Error(result.error.message);
      const preview = (result.data ?? {})["preview"] as
        { impact?: TrashImpact; relation_guards?: TrashRelationGuard[] } | undefined;
      if (preview?.impact === undefined || !Array.isArray(preview.relation_guards))
        throw new Error("Kiwi did not return Trash impact.");
      setTrashImpact(preview.impact);
      setTrashRelationGuards(preview.relation_guards);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Kiwi could not preview this deletion.");
    } finally {
      setBusy(false);
    }
  }

  async function run(command: string, args: Record<string, unknown>): Promise<void> {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const result = await invoke(workspaceId, command, args);
      if (result.error !== undefined) throw new Error(result.error.message);
      const data = result.data ?? {};
      const changedObject = data["object"] as CanonicalObjectView | undefined;
      if (changedObject !== undefined && command !== "kiwi.object.duplicate") {
        setCurrentObject(changedObject);
        onObjectChanged(changedObject);
      }
      const receipt = data["receipt"] as
        { collections?: Array<{ id: string; title: string }>; changed?: boolean } | undefined;
      if (receipt?.collections !== undefined) {
        setOrganization((current) => ({
          ...current,
          collections: receipt.collections!.map((collection) => ({
            ...collection,
            relation_id: "",
          })),
        }));
      }
      if (command === "kiwi.object.duplicate") onCollectionChanged();
      if (command === "kiwi.object.trash") {
        onObjectTrashed(object.id);
        onCollectionChanged();
      }
      if (command === "kiwi.object.restore-from-trash") onCollectionChanged();
      if (
        command.includes("collection") ||
        command === "kiwi.object.collect" ||
        command === "kiwi.object.move"
      )
        onCollectionChanged();
      setUndo((data["undo"] as UndoDescriptor | null | undefined) ?? null);
      setMessage(
        command === "kiwi.object.reveal"
          ? "Revealed the canonical file in File Explorer."
          : command === "kiwi.object.trash"
            ? "Moved to workspace Trash. Its identity and relations can be restored."
            : command === "kiwi.object.restore-from-trash"
              ? "Restored the object and its relations."
              : result.status === "no_change"
                ? `${ACTION_LABEL[action ?? "reveal"]} made no change.`
                : `${ACTION_LABEL[action ?? "rename"]} completed.`,
      );
    } catch (cause) {
      setUndo(null);
      setError(cause instanceof Error ? cause.message : "Kiwi could not complete this action.");
    } finally {
      setBusy(false);
    }
  }

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (action === null || action === "reveal") return;
    const guard = {
      object_id: object.id,
      expected_version: object.version,
      expected_hash: object.content_hash,
    };
    if (action === "trash") {
      await run("kiwi.object.trash", { ...guard, expected_relations: trashRelationGuards });
      return;
    }
    if (action === "rename" || action === "duplicate") {
      await run(`kiwi.object.${action}`, { ...guard, title: value });
      return;
    }
    if (action === "project") {
      // No version guard, and none to give: which project an object belongs to is a relation
      // beside the object rather than a field inside it, so filing it somewhere else does not
      // rewrite the copy a stale version number would be arguing about.
      await run("kiwi.project.assign", {
        object_id: object.id,
        project_id: projectId === "" ? null : projectId,
      });
      return;
    }
    if (action === "tag") {
      const tagId = userTagId(value);
      if (tagId === "") {
        setError("Enter a tag name.");
        return;
      }
      await run("kiwi.object.tag", { ...guard, tag_id: tagId, action: "add" });
      return;
    }
    const membership = {
      ...guard,
      expected_collection_ids: organization.collections.map((collection) => collection.id),
      destination_title: value,
    };
    await run(`kiwi.object.${action}`, {
      ...membership,
      ...(action === "move" ? { source_collection_id: sourceCollectionId } : {}),
    });
  }

  return (
    <section
      className="object-actions"
      role="dialog"
      aria-modal="false"
      aria-labelledby="object-actions-title"
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
      }}
    >
      <header>
        <div>
          <span>Object actions</span>
          <h4 id="object-actions-title" ref={heading} tabIndex={-1}>
            {object.title}
          </h4>
        </div>
        <button type="button" aria-label="Close object actions" onClick={onClose}>
          ×
        </button>
      </header>

      {action === null ? (
        <>
          <dl className="object-actions__summary">
            <dt>Collections</dt>
            <dd>
              {organization.collections.length === 0
                ? "None"
                : organization.collections.map((collection) => collection.title).join(", ")}
            </dd>
            <dt>Tags</dt>
            <dd>
              {organization.tags.length === 0 ? "None" : organization.tags.map(tagLabel).join(", ")}
            </dd>
          </dl>
          <div className="object-actions__menu" role="menu" aria-label="Organize object">
            {(Object.keys(ACTION_LABEL) as ObjectOrganizationAction[]).map((candidate) => (
              <button
                key={candidate}
                type="button"
                role="menuitem"
                disabled={candidate !== "reveal" && !writable}
                title={
                  !writable && candidate !== "reveal" ? "This workspace is read only" : undefined
                }
                onClick={() => {
                  if (candidate === "reveal")
                    void run("kiwi.object.reveal", { object_id: object.id });
                  else void chooseAction(candidate);
                }}
                className={candidate === "trash" ? "object-actions__danger" : undefined}
              >
                {ACTION_LABEL[candidate]}
              </button>
            ))}
          </div>
        </>
      ) : action === "reveal" ? null : action === "trash" ? (
        <form onSubmit={(event) => void submit(event)}>
          <p>
            Move <strong>{object.title}</strong> to workspace Trash. It will disappear from active
            views, but Kiwi will retain its identity and recovery evidence.
          </p>
          {trashImpact === null ? null : (
            <dl className="object-actions__summary">
              <dt>Relations affected</dt>
              <dd>{trashImpact.relation_count}</dd>
              <dt>Related objects</dt>
              <dd>{trashImpact.related_object_count}</dd>
              <dt>Direction</dt>
              <dd>
                {trashImpact.incoming_count} incoming, {trashImpact.outgoing_count} outgoing
              </dd>
              <dt>Relation types</dt>
              <dd>
                {trashImpact.relation_types.length === 0
                  ? "None"
                  : trashImpact.relation_types.join(", ")}
              </dd>
            </dl>
          )}
          <small>
            Restore returns this identity and these relations when their tombstones remain
            unchanged. Collection definitions are removed without deleting their members.
          </small>
          {hasRecoveryDraft ? (
            <p className="object-actions__error" role="alert">
              Save or discard the local recovery draft before moving this object to Trash.
            </p>
          ) : null}
          <div>
            <button
              className="button button--danger"
              type="submit"
              disabled={mutationDisabled || trashImpact === null || hasRecoveryDraft}
            >
              {busy ? "Working..." : "Move to Trash"}
            </button>
            <button type="button" disabled={busy} onClick={() => setAction(null)}>
              Cancel
            </button>
          </div>
        </form>
      ) : action === "project" ? (
        <form onSubmit={(event) => void submit(event)}>
          <label>
            <span>Project</span>
            <select
              value={projectId}
              disabled={mutationDisabled}
              onChange={(event) => setProjectId(event.target.value)}
            >
              {/*
                Belonging to nothing is a real answer and not an empty one. An object filed in the
                wrong project has to be able to leave it without being pushed into another.
              */}
              <option value="">No project</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.title}
                </option>
              ))}
            </select>
          </label>
          <small>
            An object belongs to one project at a time, so moving it here takes it out of the
            project it was in. Its collections and tags are left alone.
          </small>
          <div>
            <button className="button button--primary" type="submit" disabled={mutationDisabled}>
              {busy ? "Working…" : "Move to project"}
            </button>
            <button type="button" disabled={busy} onClick={() => setAction(null)}>
              Back
            </button>
          </div>
        </form>
      ) : (
        <form onSubmit={(event) => void submit(event)}>
          {action === "move" ? (
            <label>
              <span>Current collection</span>
              <select
                value={sourceCollectionId}
                required
                disabled={organization.collections.length === 0}
                onChange={(event) => setSourceCollectionId(event.target.value)}
              >
                {organization.collections.map((collection) => (
                  <option key={collection.id} value={collection.id}>
                    {collection.title}
                  </option>
                ))}
              </select>
              {organization.collections.length === 0 ? (
                <small>Add this object to a collection before moving a membership.</small>
              ) : null}
            </label>
          ) : null}
          <label>
            <span>
              {action === "rename"
                ? "New title"
                : action === "duplicate"
                  ? "Duplicate title"
                  : action === "tag"
                    ? "Tag name"
                    : "Destination collection"}
            </span>
            <input
              value={value}
              maxLength={200}
              required
              onChange={(event) => setValue(event.target.value)}
            />
          </label>
          <div>
            <button
              className="button button--primary"
              type="submit"
              disabled={mutationDisabled || (action === "move" && sourceCollectionId === "")}
            >
              {busy ? "Working…" : ACTION_LABEL[action]}
            </button>
            <button type="button" disabled={busy} onClick={() => setAction(null)}>
              Back
            </button>
          </div>
        </form>
      )}

      {message === null ? null : (
        <div className="object-actions__receipt" role="status">
          <span>{message}</span>
          {undo === null ? null : (
            <button type="button" disabled={busy} onClick={() => void run(undo.command, undo.args)}>
              Undo
            </button>
          )}
        </div>
      )}
      {error === null ? null : (
        <p className="object-actions__error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
