import {
  EMPTY_ANNOTATION,
  manuscriptSections,
  readAnnotation,
  type Annotation,
  type AnnotationColor,
  type AnnotationKind,
  type AnnotationRect,
  type EvidenceStance,
  type ManuscriptSection,
} from "@kiwi/contracts";
import { readBridge } from "./bridge.js";
import { base64Of } from "./pdf-capture.js";

export interface StoredAnnotationView {
  id: string;
  version: number;
  content_hash: string;
  title: string;
  updated_at: string;
  /** The mark's own tags, which are ordinary object tags on the annotation object. */
  tags: string[];
  /**
   * The id the mark was written under, and empty when the workspace did not say.
   *
   * An id and not a name: what somebody is called is the account service's answer, and a name
   * copied into the mark would still read as the old one after they changed it.
   */
  author: string;
  annotation: Annotation;
}

async function invoke(
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

export async function listAnnotations(
  workspaceId: string,
  objectId: string,
  assetId: string,
): Promise<StoredAnnotationView[]> {
  const { data } = await invoke(workspaceId, "kiwi.annotation.list", {
    object_id: objectId,
    asset_id: assetId,
  });
  const raw =
    (data["annotations"] as Array<StoredAnnotationView & { created_by?: unknown }> | undefined) ??
    [];
  return raw
    .map((entry) => {
      const annotation = readAnnotation(entry.annotation);
      if (annotation === null) return null;
      const tags = Array.isArray(entry.tags)
        ? entry.tags.filter((tag): tag is string => typeof tag === "string")
        : [];
      // A mark whose maker was not recorded is nobody's to hide. It is shown, always, rather
      // than filed under a person who cannot be named.
      const author = typeof entry.created_by === "string" ? entry.created_by : "";
      return { ...entry, tags, author, annotation };
    })
    .filter((entry): entry is StoredAnnotationView => entry !== null);
}

/**
 * Adds or takes off one tag on a mark.
 *
 * The same command the Library tags anything with. A mark is an object, so it needs no tagging
 * of its own, and a second way to write a tag would be a second way for two screens to disagree
 * about what a tag is called.
 */
export async function tagAnnotation(
  workspaceId: string,
  stored: StoredAnnotationView,
  tagId: string,
  action: "add" | "remove",
): Promise<{ error?: string }> {
  const { error } = await invoke(workspaceId, "kiwi.object.tag", {
    object_id: stored.id,
    expected_version: stored.version,
    expected_hash: stored.content_hash,
    tag_id: tagId,
    action,
  });
  return error === undefined ? {} : { error };
}

export async function createAnnotation(
  workspaceId: string,
  objectId: string,
  annotation: Annotation,
): Promise<{ error?: string }> {
  const { error } = await invoke(workspaceId, "kiwi.annotation.create", {
    object_id: objectId,
    annotation,
  });
  return error === undefined ? {} : { error };
}

export async function updateAnnotation(
  workspaceId: string,
  stored: StoredAnnotationView,
  annotation: Annotation,
): Promise<{ error?: string }> {
  const { error } = await invoke(workspaceId, "kiwi.annotation.update", {
    annotation_id: stored.id,
    expected_version: stored.version,
    expected_hash: stored.content_hash,
    annotation,
  });
  return error === undefined ? {} : { error };
}

export async function trashAnnotation(
  workspaceId: string,
  stored: StoredAnnotationView,
): Promise<{ error?: string }> {
  const { error } = await invoke(workspaceId, "kiwi.object.trash", {
    object_id: stored.id,
    expected_version: stored.version,
    expected_hash: stored.content_hash,
    expected_relations: [],
  });
  return error === undefined ? {} : { error };
}

/**
 * Turns a browser selection inside one rendered page into page-relative rectangles.
 *
 * The rectangles are fractions of the page rather than pixels, so the same highlight lands
 * correctly at any zoom and on any screen. Client rectangles are used rather than the text
 * run positions because a selection can stop mid-run, and the visible rectangles are what the
 * reader actually dragged over.
 */
export function selectionRects(selection: Selection, pageElement: Element): AnnotationRect[] {
  const page = pageElement.getBoundingClientRect();
  if (page.width <= 0 || page.height <= 0) return [];
  const rects: AnnotationRect[] = [];
  for (let index = 0; index < selection.rangeCount; index += 1) {
    const range = selection.getRangeAt(index);
    for (const rect of Array.from(range.getClientRects())) {
      if (rect.width <= 0 || rect.height <= 0) continue;
      rects.push({
        left: (rect.left - page.left) / page.width,
        top: (rect.top - page.top) / page.height,
        width: rect.width / page.width,
        height: rect.height / page.height,
      });
    }
  }
  return mergeRects(rects);
}

/**
 * A selection over one line often arrives as several adjacent rectangles, one per text run.
 * Merging them keeps a highlight from looking striped.
 */
export function mergeRects(rects: AnnotationRect[]): AnnotationRect[] {
  const sorted = [...rects].sort((left, right) =>
    Math.abs(left.top - right.top) > 0.004 ? left.top - right.top : left.left - right.left,
  );
  const merged: AnnotationRect[] = [];
  for (const rect of sorted) {
    const previous = merged[merged.length - 1];
    const sameLine =
      previous !== undefined &&
      Math.abs(previous.top - rect.top) < 0.004 &&
      rect.left - (previous.left + previous.width) < 0.01;
    if (previous !== undefined && sameLine) {
      const right = Math.max(previous.left + previous.width, rect.left + rect.width);
      previous.width = right - previous.left;
      previous.height = Math.max(previous.height, rect.height);
      continue;
    }
    merged.push({ ...rect });
  }
  return merged;
}

/** Which rendered page an element sits inside, or null when it is outside every page. */
export function pageElementFor(node: Node | null): HTMLElement | null {
  let current: Node | null = node;
  while (current !== null) {
    if (current instanceof HTMLElement && current.dataset["page"] !== undefined) return current;
    current = current.parentNode;
  }
  return null;
}

export function draftAnnotation(input: {
  kind: AnnotationKind;
  assetId: string;
  page: number;
  pageLabel: string;
  rects: AnnotationRect[];
  color: AnnotationColor;
  quoted?: string;
  comment?: string;
  imageAssetId?: string | null;
}): Annotation {
  return {
    ...EMPTY_ANNOTATION,
    kind: input.kind,
    asset_id: input.assetId,
    page: input.page,
    page_label: input.pageLabel,
    rects: input.rects,
    color: input.color,
    quoted: input.quoted ?? "",
    comment: input.comment ?? "",
    image_asset_id: input.imageAssetId ?? null,
  };
}

/**
 * Turns a cropped image into a managed asset.
 *
 * The bytes go to the main process, which writes them to a scratch file and hands back an
 * ordinary file selection. The existing import then runs unchanged, hashing, deduplication
 * and type sniffing all still apply, which they would not if the renderer had a second way in.
 */
export async function importCapturedImage(
  workspaceId: string,
  dataUrl: string,
  name: string,
): Promise<{ assetId?: string; error?: string }> {
  const bridge = readBridge();
  if (bridge === null) return { error: "Kiwi is not available." };
  if (typeof bridge.captureManagedAsset !== "function")
    return { error: "This version of Kiwi cannot capture a region." };
  const bytes = base64Of(dataUrl);
  if (bytes === null) return { error: "Kiwi could not read the captured image." };

  const selection = await bridge.captureManagedAsset({ bytes, name }).catch(() => null);
  if (selection === null) return { error: "Kiwi could not store the captured image." };

  const { data, error } = await invoke(workspaceId, "kiwi.asset.import-managed", {
    selection_id: selection.id,
  });
  if (error !== undefined) return { error };
  const asset = data["asset"] as { id?: string } | undefined;
  return asset?.id === undefined
    ? { error: "The captured image was not imported." }
    : { assetId: asset.id };
}

export interface SendToNoteTarget {
  noteId?: string;
  noteTitle?: string;
}

/** Copies annotations into a note, keeping a link back to each. */
export async function sendAnnotationsToNote(
  workspaceId: string,
  annotationIds: string[],
  target: SendToNoteTarget,
): Promise<{ noteId?: string; error?: string }> {
  const { data, error } = await invoke(workspaceId, "kiwi.annotation.send-to-note", {
    annotation_ids: annotationIds,
    ...(target.noteId === undefined ? {} : { note_id: target.noteId }),
    ...(target.noteTitle === undefined ? {} : { note_title: target.noteTitle }),
  });
  if (error !== undefined) return { error };
  const note = data["note"] as { id?: string } | undefined;
  return note?.id === undefined ? {} : { noteId: note.id };
}

/** A claim already written down, as it reads in a chooser. */
export interface ClaimChoice {
  id: string;
  title: string;
}

/**
 * The claims a passage could be sent to.
 *
 * Filtered to the open project, because a claim answers that project's questions and offering
 * every claim in the workspace would make the list longer and the right answer harder to find.
 */
export async function listClaimChoices(
  workspaceId: string,
  projectId: string | null,
): Promise<ClaimChoice[]> {
  const { data } = await invoke(workspaceId, "kiwi.claim.list", {
    ...(projectId === null ? {} : { project_id: projectId }),
  });
  const claims = (data["claims"] as Array<{ id?: unknown; title?: unknown }> | undefined) ?? [];
  return claims
    .filter(
      (entry): entry is { id: string; title: string } =>
        typeof entry.id === "string" && typeof entry.title === "string",
    )
    .map((entry) => ({ id: entry.id, title: entry.title }));
}

/** A claim already written, or one this send writes down. */
export interface SendToClaimTarget {
  claimId?: string;
  projectId?: string;
  statement?: string;
}

/** What is being sent: marks that exist, a passage that does not yet, or both. */
export interface SendToClaimEvidence {
  objectIds?: string[];
  excerpt?: { objectId: string; annotation: Annotation };
  stance?: EvidenceStance;
}

/**
 * Sends what is being read to a claim.
 *
 * One command rather than three calls, because the claim, the mark, and the relation have to
 * land together. A renderer that made them one at a time could stop after two and leave a claim
 * standing on nothing.
 */
export async function sendEvidenceToClaim(
  workspaceId: string,
  target: SendToClaimTarget,
  evidence: SendToClaimEvidence,
): Promise<{ claimId?: string; created?: boolean; error?: string }> {
  const { data, error } = await invoke(workspaceId, "kiwi.claim.send-evidence", {
    ...(target.claimId === undefined ? {} : { claim_id: target.claimId }),
    ...(target.projectId === undefined ? {} : { project_id: target.projectId }),
    ...(target.statement === undefined ? {} : { statement: target.statement }),
    ...(evidence.objectIds === undefined || evidence.objectIds.length === 0
      ? {}
      : { object_ids: evidence.objectIds }),
    ...(evidence.excerpt === undefined
      ? {}
      : {
          excerpt: {
            object_id: evidence.excerpt.objectId,
            annotation: evidence.excerpt.annotation,
          },
        }),
    ...(evidence.stance === undefined ? {} : { stance: evidence.stance }),
  });
  if (error !== undefined) return { error };
  const claim = data["claim"] as { id?: string } | undefined;
  return {
    ...(claim?.id === undefined ? {} : { claimId: claim.id }),
    created: data["claim_created"] === true,
  };
}

/** A manuscript a passage can be sent to, as it reads in a chooser. */
export interface ManuscriptChoice {
  id: string;
  title: string;
}

/** Every manuscript in the workspace, most recently worked on first. */
export async function listManuscripts(workspaceId: string): Promise<ManuscriptChoice[]> {
  const { data } = await invoke(workspaceId, "kiwi.projection.list", {
    object_types: ["output"],
    text: "",
    sort: { field: "updated_at", direction: "descending" },
    page: { offset: 0, limit: 200 },
  });
  const objects = (data["objects"] as Array<{ id: string; title: string; type: string }>) ?? [];
  return objects
    .filter((object) => object.type === "output")
    .map((object) => ({ id: object.id, title: object.title }));
}

/**
 * The sections of one manuscript, read from the manuscript itself.
 *
 * Read when the chooser opens rather than kept from earlier: somebody may be writing in it, and a
 * list of headings from ten minutes ago offers sections that have since been renamed. The command
 * that does the writing looks them up the same way, so the section on the list is the section the
 * passage lands in.
 */
export async function listManuscriptSections(
  workspaceId: string,
  manuscriptId: string,
): Promise<ManuscriptSection[]> {
  const { data, error } = await invoke(workspaceId, "kiwi.object.read", {
    object_id: manuscriptId,
  });
  if (error !== undefined) return [];
  const object = data["object"] as
    { document_mode?: unknown; document?: unknown; content?: unknown } | undefined;
  if (object === undefined) return [];
  return manuscriptSections(
    object.document_mode === "latex" ? "latex" : "rich",
    object.document,
    typeof object.content === "string" ? object.content : "",
  );
}

/** Where in a manuscript a passage is going. */
export interface SendToManuscriptTarget {
  manuscriptId: string;
  /** The heading to write under, or absent for the end of the manuscript. */
  section?: string;
}

/**
 * Sends what is being read into a manuscript.
 *
 * One command, for the same reason sending to a claim is one: the quotation, the mark it was made
 * from, and the relation tying the draft to the paper have to land together, or the draft quotes
 * something nothing points at.
 */
export async function sendPassageToManuscript(
  workspaceId: string,
  target: SendToManuscriptTarget,
  passages: { objectIds?: string[]; excerpt?: { objectId: string; annotation: Annotation } },
): Promise<{ added?: number; skipped?: number; error?: string }> {
  const { data, error } = await invoke(workspaceId, "kiwi.annotation.send-to-manuscript", {
    manuscript_id: target.manuscriptId,
    ...(target.section === undefined ? {} : { section: target.section }),
    ...(passages.objectIds === undefined || passages.objectIds.length === 0
      ? {}
      : { annotation_ids: passages.objectIds }),
    ...(passages.excerpt === undefined
      ? {}
      : {
          excerpt: {
            object_id: passages.excerpt.objectId,
            annotation: passages.excerpt.annotation,
          },
        }),
  });
  if (error !== undefined) return { error };
  return {
    added: typeof data["added"] === "number" ? data["added"] : 0,
    skipped: typeof data["skipped"] === "number" ? data["skipped"] : 0,
  };
}

/** Every note in the workspace, for choosing where highlights should land. */
export async function listNotes(
  workspaceId: string,
): Promise<Array<{ id: string; title: string }>> {
  const { data } = await invoke(workspaceId, "kiwi.projection.list", {
    object_types: ["note"],
    text: "",
    sort: { field: "updated_at", direction: "descending" },
    page: { offset: 0, limit: 200 },
  });
  const objects = (data["objects"] as Array<{ id: string; title: string; type: string }>) ?? [];
  return objects
    .filter((object) => object.type === "note")
    .map((object) => ({ id: object.id, title: object.title }));
}
