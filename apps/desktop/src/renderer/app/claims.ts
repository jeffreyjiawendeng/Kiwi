import { useCallback, useEffect, useRef, useState } from "react";
import {
  isClaimAnswerId,
  isEvidenceStance,
  readClaim,
  type ClaimBody,
  type ClaimConfidence,
  type ClaimStatus,
  type EvidenceStance,
} from "@kiwi/contracts";
import { readBridge, type RendererCommandResult } from "./bridge.js";

/**
 * Reading and writing claims, for every surface that shows them.
 *
 * The Claims page, a project's Dashboard, and the Reader's send-a-selection dialog are one list
 * asked for three ways. They share this so that attaching a piece of evidence means the same
 * thing on each of them, and so that a refusal gets its words in one place.
 *
 * A claim and its evidence arrive together because they are read together: a claim standing on
 * nothing is the one thing the page exists to find, and it cannot be found from the claim alone.
 * The count is not stored on the claim -- it is worked out from the relations pointing at it --
 * so there is nothing here to keep in step with the store.
 */

export interface EvidenceView {
  relation_id: string;
  object_id: string;
  /** `annotation`, `note`, `source`, `run`, `dataset`: what the evidence is. */
  object_type: string;
  title: string;
  stance: EvidenceStance;
  attached_at: string;
}

export interface ClaimView {
  id: string;
  version: number;
  content_hash: string;
  title: string;
  created_at: string;
  updated_at: string;
  claim: ClaimBody;
  evidence: EvidenceView[];
}

function readEvidenceViews(value: unknown): EvidenceView[] {
  if (!Array.isArray(value)) return [];
  const pieces: EvidenceView[] = [];
  for (const row of value) {
    if (typeof row !== "object" || row === null || Array.isArray(row)) continue;
    const entry = row as Record<string, unknown>;
    const relationId = entry["relation_id"];
    const objectId = entry["object_id"];
    const stance = entry["stance"];
    // A stance this build has never heard of is not evidence it can show for or against, and
    // counting it as either would make the claim look decided by something unreadable.
    if (typeof relationId !== "string" || typeof objectId !== "string") continue;
    if (!isEvidenceStance(stance)) continue;
    const type = entry["object_type"];
    const title = entry["title"];
    const attached = entry["attached_at"];
    pieces.push({
      relation_id: relationId,
      object_id: objectId,
      object_type: typeof type === "string" ? type : "",
      title: typeof title === "string" ? title : "",
      stance,
      attached_at: typeof attached === "string" ? attached : "",
    });
  }
  return pieces;
}

/**
 * Claims out of a command result, read defensively.
 *
 * A row this build cannot read as a claim is left out and the rest of the list still arrives,
 * which is the difference between one claim missing and every claim missing.
 */
export function readClaimViews(data: Record<string, unknown> | undefined): ClaimView[] {
  const rows = data?.["claims"];
  if (!Array.isArray(rows)) return [];
  const views: ClaimView[] = [];
  for (const row of rows) {
    if (typeof row !== "object" || row === null || Array.isArray(row)) continue;
    const entry = row as Record<string, unknown>;
    const id = entry["id"];
    const claim = readClaim(entry["claim"]);
    if (claim === null || typeof id !== "string") continue;
    const version = entry["version"];
    const hash = entry["content_hash"];
    const title = entry["title"];
    const created = entry["created_at"];
    const updated = entry["updated_at"];
    views.push({
      id,
      version: typeof version === "number" ? version : 1,
      content_hash: typeof hash === "string" ? hash : "",
      title: typeof title === "string" ? title : "",
      created_at: typeof created === "string" ? created : "",
      updated_at: typeof updated === "string" ? updated : "",
      claim,
      evidence: readEvidenceViews(entry["evidence"]),
    });
  }
  return views;
}

export interface EvidenceTally {
  supports: number;
  contradicts: number;
}

export function evidenceTally(claim: ClaimView): EvidenceTally {
  let supports = 0;
  let contradicts = 0;
  for (const piece of claim.evidence) {
    if (piece.stance === "supports") supports += 1;
    else contradicts += 1;
  }
  return { supports, contradicts };
}

/**
 * A claim nothing supports.
 *
 * Being contradicted does not make a claim supported, so a claim with three papers against it and
 * none for it is on this list. That is the point of it: the list is what the project has asserted
 * and not yet stood up, and something argued against is the most urgent kind of that.
 *
 * The same rule the store filters by, worked out again here so a page holding a list can shade a
 * row without asking for a second list that only differs by one flag.
 */
export function standsOnNothing(claim: ClaimView): boolean {
  return !claim.evidence.some((piece) => piece.stance === "supports");
}

/**
 * Evidence pointing both ways at once.
 *
 * Not an error and not a status: it is a claim somebody has to look at, and the page says so
 * rather than picking one side of it.
 */
export function isDisputed(claim: ClaimView): boolean {
  const tally = evidenceTally(claim);
  return tally.supports > 0 && tally.contradicts > 0;
}

/** How the evidence for one claim reads, without the caller counting it twice. */
export function evidenceOf(claim: ClaimView, stance: EvidenceStance): EvidenceView[] {
  return claim.evidence.filter((piece) => piece.stance === stance);
}

export interface NewClaim {
  statement: string;
  status?: ClaimStatus;
  confidence?: ClaimConfidence;
  /** `Q2`, `H1`: the lines of the protocol this claim was written to answer. */
  answers?: string[];
}

/** An absent field is left as it was. There is nothing here that can be unset. */
export interface ClaimChanges {
  statement?: string;
  status?: ClaimStatus;
  confidence?: ClaimConfidence;
  answers?: string[];
}

/**
 * What the claim answers, changed one id at a time.
 *
 * The command takes the whole list, so a chooser that ticks one box has to resend the others.
 * Working that out here is what stops a tick box from cancelling the rest of the answers.
 */
export function withAnswer(claim: ClaimView, answerId: string, answers: boolean): string[] | null {
  if (!isClaimAnswerId(answerId)) return null;
  const current = claim.claim.answers;
  if (answers === current.includes(answerId)) return null;
  return answers ? [...current, answerId] : current.filter((id) => id !== answerId);
}

export interface ClaimScope {
  workspaceId: string;
  /** The project whose claims these are, or null for everything in the workspace. */
  projectId?: string | null;
  status?: ClaimStatus | null;
  /** Only the claims written to answer one line of the protocol. */
  answers?: string | null;
  /** Only the claims nothing supports. */
  unsupported?: boolean;
}

export interface ClaimList {
  claims: ClaimView[];
  /** True until the first answer only. A reload does not blank the screen it is refreshing. */
  loading: boolean;
  busy: boolean;
  /** What the last write was refused for, in the words the command used. */
  error: string | null;
  reload(): Promise<void>;
  dismissError(): void;
  create(input: NewClaim): Promise<boolean>;
  update(claim: ClaimView, changes: ClaimChanges): Promise<boolean>;
  attach(claimId: string, objectId: string, stance: EvidenceStance): Promise<boolean>;
  detach(claimId: string, objectId: string): Promise<boolean>;
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

function failureMessage(cause: unknown): string {
  if (cause instanceof Error && cause.message !== "") return cause.message;
  return "That did not go through. Nothing was changed.";
}

export function useClaims(scope: ClaimScope): ClaimList {
  const { workspaceId } = scope;
  const projectId = scope.projectId ?? null;
  const status = scope.status ?? null;
  const answers = scope.answers ?? null;
  const unsupported = scope.unsupported === true;

  const [claims, setClaims] = useState<ClaimView[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Which read the screen is waiting for.
   *
   * Two reads can be in the air at once -- a filter changed while the last one is still out, a
   * write's reload racing a manual one -- and the one that started last is the one being asked
   * about. An earlier answer landing afterwards would put back the list it replaced.
   */
  const asked = useRef(0);

  const reload = useCallback(async (): Promise<void> => {
    const ticket = (asked.current += 1);
    try {
      const result = await invoke(workspaceId, "kiwi.claim.list", {
        ...(projectId === null ? {} : { project_id: projectId }),
        ...(status === null ? {} : { status }),
        ...(answers === null ? {} : { answers }),
        ...(unsupported ? { unsupported: true } : {}),
      });
      if (ticket !== asked.current) return;
      if (result.error !== undefined) setError(result.error.message);
      else {
        setClaims(readClaimViews(result.data));
        setError(null);
      }
    } catch (cause) {
      if (ticket === asked.current) setError(failureMessage(cause));
    } finally {
      if (ticket === asked.current) setLoading(false);
    }
  }, [workspaceId, projectId, status, answers, unsupported]);

  useEffect(() => {
    // Another project's claims are not this one's, and a list narrowed by a filter is not the
    // list before it. Either left on the screen would look like an answer to the new question.
    setClaims([]);
    setLoading(true);
    void reload();
  }, [reload]);

  /**
   * Runs a write and reads the list again.
   *
   * Every claim write changes what the list says about the claim -- an attach changes what it
   * stands on, an edit changes where it stands -- so there is nothing to be saved by patching
   * one row in place, and a patched row is a row that can disagree with the store.
   */
  const run = useCallback(
    async (command: string, args: Record<string, unknown>): Promise<boolean> => {
      setBusy(true);
      try {
        const result = await invoke(workspaceId, command, args);
        if (result.error !== undefined) {
          setError(result.error.message);
          return false;
        }
        await reload();
        return true;
      } catch (cause) {
        setError(failureMessage(cause));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [workspaceId, reload],
  );

  const create = useCallback(
    (input: NewClaim): Promise<boolean> => {
      if (projectId === null) {
        // A claim belongs to a project. Written from a list of everything, there is no project
        // to file it in, and a claim filed nowhere is one nobody will find again.
        setError("Open a project to write down what it asserts.");
        return Promise.resolve(false);
      }
      return run("kiwi.claim.create", {
        project_id: projectId,
        statement: input.statement,
        ...(input.status === undefined ? {} : { status: input.status }),
        ...(input.confidence === undefined ? {} : { confidence: input.confidence }),
        ...(input.answers === undefined ? {} : { answers: input.answers }),
      });
    },
    [projectId, run],
  );

  /**
   * Changes what a claim says, against the version being shown.
   *
   * The row carries its own version and hash, so an edit made from a list that has gone stale is
   * refused rather than written over somebody else's. The page takes the whole row for that
   * reason: a claim id on its own cannot say which version was being looked at.
   */
  const update = useCallback(
    (claim: ClaimView, changes: ClaimChanges): Promise<boolean> =>
      run("kiwi.claim.update", {
        claim_id: claim.id,
        expected_version: claim.version,
        expected_hash: claim.content_hash,
        ...(changes.statement === undefined ? {} : { statement: changes.statement }),
        ...(changes.status === undefined ? {} : { status: changes.status }),
        ...(changes.confidence === undefined ? {} : { confidence: changes.confidence }),
        ...(changes.answers === undefined ? {} : { answers: changes.answers }),
      }),
    [run],
  );

  // Evidence carries no version. It is a relation of its own, so two people attaching at once
  // are two writes that cannot collide, and attaching what is already attached changes nothing.
  const attach = useCallback(
    (claimId: string, objectId: string, stance: EvidenceStance): Promise<boolean> =>
      run("kiwi.claim.attach-evidence", {
        claim_id: claimId,
        object_id: objectId,
        stance,
      }),
    [run],
  );

  const detach = useCallback(
    (claimId: string, objectId: string): Promise<boolean> =>
      run("kiwi.claim.detach-evidence", { claim_id: claimId, object_id: objectId }),
    [run],
  );

  const dismissError = useCallback((): void => setError(null), []);

  return {
    claims,
    loading,
    busy,
    error,
    reload,
    dismissError,
    create,
    update,
    attach,
    detach,
  };
}
