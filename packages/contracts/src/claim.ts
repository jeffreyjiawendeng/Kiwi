/**
 * Something the project asserts, and what the assertion is standing on.
 *
 * A claim is short on purpose. The statement, where it stands, how sure the project is, and which
 * of the protocol's questions or hypotheses it answers -- and nothing else. Everything that makes
 * a claim believable is evidence, and evidence is a relation pointing at the claim rather than a
 * list inside it.
 *
 * That is not a storage detail. A claim with two hundred pieces of evidence would be a
 * two-hundred-entry array that every read has to parse and every edit has to rewrite, and two
 * people attaching evidence at once would be two writes to one object, one of which loses. As
 * relations they are separate writes that cannot collide, each carrying its own history of who
 * attached it and when, and the relation store already answers "what points at this" in both
 * directions -- which is the evidence panel and the backlinks panel asking the same question.
 *
 * What a claim answers is a field rather than a relation, because `H1` is not an object. It is a
 * line inside the project's protocol, and the protocol is one object whose parts have ids.
 */

import { type Hypothesis, type ProtocolBody, type SubQuestion } from "./research-protocol.js";

export const CLAIM_STATUSES = ["draft", "supported", "contradicted", "abandoned"] as const;
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];

export const CLAIM_STATUS_LABELS: Record<ClaimStatus, string> = {
  draft: "Draft",
  supported: "Supported",
  contradicted: "Contradicted",
  abandoned: "Abandoned",
};

export const CLAIM_CONFIDENCES = ["low", "medium", "high"] as const;
export type ClaimConfidence = (typeof CLAIM_CONFIDENCES)[number];

export const CLAIM_CONFIDENCE_LABELS: Record<ClaimConfidence, string> = {
  low: "Low confidence",
  medium: "Medium confidence",
  high: "High confidence",
};

/**
 * The two ways a piece of evidence bears on a claim.
 *
 * There is no "mentions". Evidence that neither supports nor contradicts is a link, and the Links
 * dock already holds those. Making the third one available here would fill the evidence panel with
 * things that are not evidence, and the unsupported list would stop meaning anything.
 */
export const EVIDENCE_STANCES = ["supports", "contradicts"] as const;
export type EvidenceStance = (typeof EVIDENCE_STANCES)[number];

export const EVIDENCE_STANCE_LABELS: Record<EvidenceStance, string> = {
  supports: "Supports",
  contradicts: "Contradicts",
};

/**
 * What may be evidence.
 *
 * A highlight in a paper, a note somebody wrote, a paper itself, an analysis run, or the dataset a
 * run produced. Not a project, not a task, not another claim: a claim that rests on a claim rests
 * on nothing until the second one has evidence of its own, and the chain hides that.
 */
export const EVIDENCE_OBJECT_TYPES = ["annotation", "note", "source", "run", "dataset"] as const;
export type EvidenceObjectType = (typeof EVIDENCE_OBJECT_TYPES)[number];

export interface ClaimBody {
  statement: string;
  status: ClaimStatus;
  confidence: ClaimConfidence;
  /** `Q2`, `H1`: ids from the project's protocol. Never a version, because the ids never move. */
  answers: string[];
}

export const CLAIM_LIMITS = {
  statement: 4_000,
  answers: 50,
  /** How much of the statement becomes the object's title in a list of things. */
  title: 120,
} as const;

export function isClaimStatus(value: unknown): value is ClaimStatus {
  return typeof value === "string" && (CLAIM_STATUSES as readonly string[]).includes(value);
}

export function isClaimConfidence(value: unknown): value is ClaimConfidence {
  return typeof value === "string" && (CLAIM_CONFIDENCES as readonly string[]).includes(value);
}

export function isEvidenceStance(value: unknown): value is EvidenceStance {
  return typeof value === "string" && (EVIDENCE_STANCES as readonly string[]).includes(value);
}

export function isEvidenceObjectType(value: unknown): value is EvidenceObjectType {
  return typeof value === "string" && (EVIDENCE_OBJECT_TYPES as readonly string[]).includes(value);
}

export function emptyClaim(): ClaimBody {
  return { statement: "", status: "draft", confidence: "low", answers: [] };
}

const ANSWER_ID = /^(Q|H)\d+$/u;

/** `Q2` or `H1`, and nothing else: a claim answers a sub-question or a hypothesis. */
export function isClaimAnswerId(value: unknown): value is string {
  return typeof value === "string" && ANSWER_ID.test(value);
}

export interface ClaimProblem {
  field: keyof ClaimBody;
  message: string;
}

export function validateClaim(claim: ClaimBody): ClaimProblem[] {
  const problems: ClaimProblem[] = [];
  const add = (field: ClaimProblem["field"], message: string) => problems.push({ field, message });

  if (claim.statement.trim() === "") add("statement", "A claim has to assert something.");
  if (claim.statement.length > CLAIM_LIMITS.statement) {
    add("statement", "That claim is too long to store.");
  }
  if (!isClaimStatus(claim.status)) add("status", "Choose where the claim stands.");
  if (!isClaimConfidence(claim.confidence)) add("confidence", "Say how sure the project is.");

  if (claim.answers.length > CLAIM_LIMITS.answers) {
    add("answers", `A claim cannot answer more than ${CLAIM_LIMITS.answers} of them.`);
  }
  const answered = new Set<string>();
  for (const id of claim.answers) {
    if (!isClaimAnswerId(id)) {
      add("answers", "A claim answers a sub-question or a hypothesis, written as Q2 or H1.");
      break;
    }
    if (answered.has(id)) {
      add("answers", "That is already one of the things this claim answers.");
      break;
    }
    answered.add(id);
  }
  return problems;
}

export function isClaim(value: unknown): value is ClaimBody {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Partial<ClaimBody>;
  return typeof candidate.statement === "string" && isClaimStatus(candidate.status);
}

/**
 * A stored claim, read defensively.
 *
 * A status or a confidence this build has never heard of falls back to the empty claim's answer,
 * which every surface can show. The answers are the exception: an id that is not `Q2` or `H1`
 * shaped is dropped rather than kept, because the only thing that can be done with it is to look
 * it up in the protocol, and nothing there will ever match it.
 */
export function readClaim(value: unknown): ClaimBody | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const stored = value as Partial<ClaimBody>;
  if (typeof stored.statement !== "string") return null;
  const answers = (Array.isArray(stored.answers) ? stored.answers : []).filter(isClaimAnswerId);
  return {
    statement: stored.statement,
    status: isClaimStatus(stored.status) ? stored.status : "draft",
    confidence: isClaimConfidence(stored.confidence) ? stored.confidence : "low",
    answers: [...new Set(answers)],
  };
}

/** The claim's searchable text, which is the whole of it: the ids are identifiers, not words. */
export function claimContent(claim: ClaimBody): string {
  return claim.statement;
}

/**
 * What a list of things calls a claim.
 *
 * The statement, cut to a length that fits a row. Cut on a word where there is one to cut on, so
 * the title ends mid-sentence rather than mid-word, and marked with an ellipsis so nobody reads
 * the shortened form as the whole claim.
 */
export function claimTitle(claim: ClaimBody, limit: number = CLAIM_LIMITS.title): string {
  const said = claim.statement.trim().replace(/\s+/gu, " ");
  if (said === "") return "Untitled claim";
  if (said.length <= limit) return said;
  const cut = said.slice(0, limit);
  const space = cut.lastIndexOf(" ");
  return `${(space > limit / 2 ? cut.slice(0, space) : cut).trimEnd()}...`;
}

export interface ClaimAnswer {
  /** `Q2`, `H1`. */
  id: string;
  kind: "sub_question" | "hypothesis";
  /** What the protocol says it is, or an empty string when the protocol no longer has it. */
  text: string;
  /**
   * True when nothing in the protocol carries this id any more.
   *
   * Kept and shown rather than dropped. Somebody deleted the hypothesis this claim was written to
   * answer, and the claim silently answering nothing is the worse of the two ways to say so.
   */
  missing: boolean;
}

/** What the claim's answers point at, in the order the claim lists them. */
export function readClaimAnswers(claim: ClaimBody, protocol: ProtocolBody | null): ClaimAnswer[] {
  const subQuestions = new Map<string, SubQuestion>(
    (protocol?.sub_questions ?? []).map((entry) => [entry.id, entry]),
  );
  const hypotheses = new Map<string, Hypothesis>(
    (protocol?.hypotheses ?? []).map((entry) => [entry.id, entry]),
  );

  return claim.answers.map((id) => {
    const kind = id.startsWith("Q") ? "sub_question" : "hypothesis";
    const found = kind === "sub_question" ? subQuestions.get(id) : hypotheses.get(id);
    if (found === undefined) return { id, kind, text: "", missing: true };
    return {
      id,
      kind,
      text: "text" in found ? found.text : found.statement,
      missing: false,
    };
  });
}

/**
 * Everything in a protocol a claim could be written to answer, in the order the page shows them.
 *
 * The sub-questions before the hypotheses, because that is the order they were asked in, and a
 * chooser that reorders them makes somebody hunt for `Q3`.
 */
export function claimAnswerChoices(
  protocol: ProtocolBody | null,
): Array<{ id: string; kind: ClaimAnswer["kind"]; text: string }> {
  if (protocol === null) return [];
  return [
    ...protocol.sub_questions.map((entry) => ({
      id: entry.id,
      kind: "sub_question" as const,
      text: entry.text,
    })),
    ...protocol.hypotheses.map((entry) => ({
      id: entry.id,
      kind: "hypothesis" as const,
      text: entry.statement,
    })),
  ];
}
