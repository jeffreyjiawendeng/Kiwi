/**
 * What a project set out to find, and how it said it would look.
 *
 * The primary question, its sub-questions, the hypotheses, the inclusion and exclusion criteria,
 * the extraction schema, and the protocol prose are one object rather than six, because freezing
 * is the point of the page. A freeze that covers five of them and misses the extraction schema is
 * not a freeze, and a freeze spread across six objects is a transaction that can half-succeed.
 * One object, one version, one frozen flag, one deviation log appended to it.
 *
 * The file is called `research-protocol` rather than `protocol` because the wire protocol already
 * owns that name. Nothing here is about envelopes.
 *
 * The ids inside the lists are stable and never reused. A Claim references `H1` and a screening
 * decision records `E3`, and neither carries a version, so deleting `H2` must not turn `H3` into
 * the thing `H2` used to mean. Every new entry takes the next unused number, not the next index.
 */

import { documentText, emptyDocument, readDocument, type RichDocument } from "./document.js";

export const HYPOTHESIS_DIRECTIONS = ["increase", "decrease", "difference", "none"] as const;
export type HypothesisDirection = (typeof HYPOTHESIS_DIRECTIONS)[number];

/** What the hypothesis predicts, said the way somebody would say it out loud. */
export const HYPOTHESIS_DIRECTION_LABELS: Record<HypothesisDirection, string> = {
  increase: "Increases",
  decrease: "Decreases",
  difference: "Differs",
  none: "No effect",
};

export const HYPOTHESIS_STATUSES = ["open", "supported", "contradicted", "abandoned"] as const;
export type HypothesisStatus = (typeof HYPOTHESIS_STATUSES)[number];

export const HYPOTHESIS_STATUS_LABELS: Record<HypothesisStatus, string> = {
  open: "Open",
  supported: "Supported",
  contradicted: "Contradicted",
  abandoned: "Abandoned",
};

export const CRITERION_KINDS = ["inclusion", "exclusion"] as const;
export type CriterionKind = (typeof CRITERION_KINDS)[number];

export const CRITERION_KIND_LABELS: Record<CriterionKind, string> = {
  inclusion: "Include",
  exclusion: "Exclude",
};

export const EXTRACTION_FIELD_TYPES = ["text", "number", "boolean", "date", "choice"] as const;
export type ExtractionFieldType = (typeof EXTRACTION_FIELD_TYPES)[number];

export const EXTRACTION_FIELD_TYPE_LABELS: Record<ExtractionFieldType, string> = {
  text: "Text",
  number: "Number",
  boolean: "Yes or no",
  date: "Date",
  choice: "One of a list",
};

export interface SubQuestion {
  /** `Q1`, `Q2`. Stable: a task or a claim may name it. */
  id: string;
  text: string;
}

export interface Hypothesis {
  /** `H1`. Stable: a claim names it, and the claim does not carry a version. */
  id: string;
  statement: string;
  direction: HypothesisDirection;
  status: HypothesisStatus;
}

export interface Criterion {
  id: string;
  kind: CriterionKind;
  /**
   * `E3`, `I2`. What a screening decision records when it says why a paper was let in or kept
   * out, so it is numbered within its kind and never reused across the project's life.
   */
  code: string;
  text: string;
}

export interface ExtractionField {
  id: string;
  /** The column heading on the extraction table. Two of them cannot say the same thing. */
  name: string;
  type: ExtractionFieldType;
  required: boolean;
  /** What may be chosen, for a `choice` field. Empty for every other type. */
  allowed: string[];
  /** `mg/dL`, `weeks`. Only a number has one. */
  unit: string | null;
}

export interface Preregistration {
  /** `OSF`, `PROSPERO`, `ClinicalTrials.gov`. Free text: registries are not a closed list. */
  registry: string | null;
  id: string | null;
  url: string | null;
  /** The day it was registered. */
  on: string | null;
}

export interface Deviation {
  id: string;
  /** When the project departed from what it had frozen. */
  on: string;
  what: string;
  why: string;
  approved_by: string;
}

export interface ProtocolBody {
  question: string;
  sub_questions: SubQuestion[];
  hypotheses: Hypothesis[];
  criteria: Criterion[];
  extraction_schema: ExtractionField[];
  method: string;
  preregistration: Preregistration;
  /** The protocol prose. Covered by the freeze like everything else here. */
  document: RichDocument;
  frozen_at: string | null;
  /** The object version the freeze covers, so History can open exactly what was committed to. */
  frozen_version: number | null;
  deviations: Deviation[];
}

export const PROTOCOL_LIMITS = {
  question: 2_000,
  method: 50_000,
  sub_questions: 100,
  hypotheses: 100,
  criteria: 200,
  extraction_schema: 200,
  allowed: 100,
  deviations: 1_000,
} as const;

export function isHypothesisDirection(value: unknown): value is HypothesisDirection {
  return typeof value === "string" && (HYPOTHESIS_DIRECTIONS as readonly string[]).includes(value);
}

export function isHypothesisStatus(value: unknown): value is HypothesisStatus {
  return typeof value === "string" && (HYPOTHESIS_STATUSES as readonly string[]).includes(value);
}

export function isCriterionKind(value: unknown): value is CriterionKind {
  return typeof value === "string" && (CRITERION_KINDS as readonly string[]).includes(value);
}

export function isExtractionFieldType(value: unknown): value is ExtractionFieldType {
  return typeof value === "string" && (EXTRACTION_FIELD_TYPES as readonly string[]).includes(value);
}

export function emptyProtocol(): ProtocolBody {
  return {
    question: "",
    sub_questions: [],
    hypotheses: [],
    criteria: [],
    extraction_schema: [],
    method: "",
    preregistration: { registry: null, id: null, url: null, on: null },
    document: emptyDocument(),
    frozen_at: null,
    frozen_version: null,
    deviations: [],
  };
}

/**
 * The next id in a series, which is the next unused number rather than the next index.
 *
 * A list of `H1, H3` gets `H4`, not `H3` again and not `H2`. Reusing a number would silently
 * re-point every claim that named the deleted hypothesis at a different one, and nothing in the
 * claim would look wrong. Ids that were never in the series are ignored when finding the highest,
 * which is what lets an older file with a hand-written id still be added to.
 */
export function nextProtocolId(prefix: string, existing: readonly string[]): string {
  let highest = 0;
  for (const id of existing) {
    if (!id.startsWith(prefix)) continue;
    const tail = id.slice(prefix.length);
    if (!/^\d+$/u.test(tail)) continue;
    highest = Math.max(highest, Number(tail));
  }
  return `${prefix}${highest + 1}`;
}

/**
 * The code a screening decision will record for a new criterion.
 *
 * Numbered within its kind, because `E3` says exclusion on its face and a reader should not have
 * to open the protocol to learn that `C7` was an inclusion rule.
 */
export function nextCriterionCode(kind: CriterionKind, criteria: readonly Criterion[]): string {
  const prefix = kind === "inclusion" ? "I" : "E";
  return nextProtocolId(
    prefix,
    criteria.filter((entry) => entry.kind === kind).map((entry) => entry.code),
  );
}

export function isProtocolFrozen(protocol: ProtocolBody): boolean {
  return protocol.frozen_at !== null;
}

/**
 * Committed to, as of a version.
 *
 * Freezing twice is not an error and does not move the date. A second freeze is a double click or
 * a retry after a slow save, and moving `frozen_at` would quietly restate when the project stopped
 * being able to change its mind -- which is the one date the whole page exists to record.
 *
 * There is no unfreeze. The way a frozen protocol changes is a deviation.
 */
export function freezeProtocol(protocol: ProtocolBody, at: string, version: number): ProtocolBody {
  if (isProtocolFrozen(protocol)) return protocol;
  return { ...protocol, frozen_at: at, frozen_version: version };
}

/**
 * A departure from what was frozen, written down.
 *
 * Appended, never edited: the log is the record of what actually happened, and a record that can
 * be rewritten is not one. The id follows the same never-reused rule as everything else here.
 */
export function logDeviation(
  protocol: ProtocolBody,
  deviation: Omit<Deviation, "id">,
): ProtocolBody {
  const id = nextProtocolId(
    "D",
    protocol.deviations.map((entry) => entry.id),
  );
  // The computed id last, so a caller handing back a deviation it read from somewhere -- a retry,
  // a copy of an earlier one -- appends a new entry rather than a second D1.
  return { ...protocol, deviations: [...protocol.deviations, { ...deviation, id }] };
}

export interface ProtocolProblem {
  field: keyof ProtocolBody;
  message: string;
}

export function validateProtocol(protocol: ProtocolBody): ProtocolProblem[] {
  const problems: ProtocolProblem[] = [];
  const add = (field: ProtocolProblem["field"], message: string) =>
    problems.push({ field, message });

  if (protocol.question.length > PROTOCOL_LIMITS.question) {
    add("question", "That question is too long to store.");
  }
  if (protocol.method.length > PROTOCOL_LIMITS.method) {
    add("method", "That method is too long to store.");
  }

  const most = (many: number, what: string) => `A protocol cannot hold more than ${many} ${what}.`;

  if (protocol.sub_questions.length > PROTOCOL_LIMITS.sub_questions) {
    add("sub_questions", most(PROTOCOL_LIMITS.sub_questions, "sub-questions"));
  }
  checkIds(
    protocol.sub_questions,
    (problem) => add("sub_questions", problem),
    "Two sub-questions cannot share an id.",
  );
  for (const entry of protocol.sub_questions) {
    if (entry.text.trim() === "") add("sub_questions", "A sub-question needs to ask something.");
  }

  if (protocol.hypotheses.length > PROTOCOL_LIMITS.hypotheses) {
    add("hypotheses", most(PROTOCOL_LIMITS.hypotheses, "hypotheses"));
  }
  checkIds(
    protocol.hypotheses,
    (problem) => add("hypotheses", problem),
    "Two hypotheses cannot share an id.",
  );
  for (const entry of protocol.hypotheses) {
    if (entry.statement.trim() === "") add("hypotheses", "A hypothesis has to predict something.");
    if (!isHypothesisDirection(entry.direction)) {
      add("hypotheses", "Say which way the hypothesis goes.");
    }
    if (!isHypothesisStatus(entry.status))
      add("hypotheses", "That is not a state for a hypothesis.");
  }

  if (protocol.criteria.length > PROTOCOL_LIMITS.criteria) {
    add("criteria", most(PROTOCOL_LIMITS.criteria, "criteria"));
  }
  checkIds(
    protocol.criteria,
    (problem) => add("criteria", problem),
    "Two criteria cannot share an id.",
  );
  const codes = new Set<string>();
  for (const entry of protocol.criteria) {
    if (!isCriterionKind(entry.kind))
      add("criteria", "A criterion either lets papers in or keeps them out.");
    if (entry.text.trim() === "") add("criteria", "A criterion has to say what it tests.");
    // The code is what a screening decision stores. Two rules answering to `E3` would make every
    // decision that names it ambiguous, and there is no version on a decision to break the tie.
    if (codes.has(entry.code)) {
      add("criteria", `Two criteria are both called ${entry.code}.`);
      break;
    }
    codes.add(entry.code);
  }

  if (protocol.extraction_schema.length > PROTOCOL_LIMITS.extraction_schema) {
    add("extraction_schema", most(PROTOCOL_LIMITS.extraction_schema, "fields to extract"));
  }
  checkIds(
    protocol.extraction_schema,
    (problem) => add("extraction_schema", problem),
    "Two fields cannot share an id.",
  );
  const names = new Set<string>();
  for (const field of protocol.extraction_schema) {
    const name = field.name.trim();
    if (name === "") add("extraction_schema", "A field needs a name.");
    // The name is the column heading. Two of them are two columns nobody can tell apart.
    else if (names.has(name.toLowerCase())) {
      add("extraction_schema", `Two fields are both called ${name}.`);
      break;
    } else names.add(name.toLowerCase());

    if (!isExtractionFieldType(field.type))
      add("extraction_schema", "That is not a kind of field.");
    if (field.type === "choice" && field.allowed.length === 0) {
      add("extraction_schema", "A field to choose from needs something to choose.");
    }
    if (field.type !== "choice" && field.allowed.length > 0) {
      add("extraction_schema", "Only a field to choose from has a list of choices.");
    }
    if (field.allowed.length > PROTOCOL_LIMITS.allowed) {
      add(
        "extraction_schema",
        `A field cannot offer more than ${PROTOCOL_LIMITS.allowed} choices.`,
      );
    }
    if (field.unit !== null && field.type !== "number") {
      add("extraction_schema", "Only a number has a unit.");
    }
  }

  if (protocol.frozen_at !== null && protocol.frozen_version === null) {
    add("frozen_version", "A freeze records which version it covers.");
  }
  if (protocol.deviations.length > 0 && !isProtocolFrozen(protocol)) {
    // A deviation is a departure from something. Before the freeze there is nothing to depart
    // from -- an unfrozen protocol simply gets edited.
    add("deviations", "A deviation is a departure from a protocol that was frozen.");
  }
  if (protocol.deviations.length > PROTOCOL_LIMITS.deviations) {
    add("deviations", "That is more deviations than can be stored.");
  }
  checkIds(
    protocol.deviations,
    (problem) => add("deviations", problem),
    "Two deviations cannot share an id.",
  );

  return problems;
}

/** Ids have to be there, and have to be distinct. Reported once rather than once per entry. */
function checkIds(
  entries: ReadonlyArray<{ id: string }>,
  add: (message: string) => void,
  clash: string,
): void {
  const seen = new Set<string>();
  for (const entry of entries) {
    if (typeof entry.id !== "string" || entry.id.trim() === "") {
      add("Every entry carries an id, so what points at it keeps pointing.");
      return;
    }
    if (seen.has(entry.id)) {
      add(clash);
      return;
    }
    seen.add(entry.id);
  }
}

export function isProtocol(value: unknown): value is ProtocolBody {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Partial<ProtocolBody>;
  return typeof candidate.question === "string" && Array.isArray(candidate.hypotheses);
}

function readText(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function readNullableText(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function readList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

/**
 * A stored protocol, read defensively.
 *
 * A file written by a later build, or merged by another machine, may hold a hypothesis with a
 * direction this build has never heard of. That is not a reason to fail to open the page. An
 * entry that cannot be read at all is dropped; one that is merely unfamiliar in a single field
 * falls back to the empty protocol's answer, which the interface can always show.
 *
 * Ids are the exception: an entry without one is dropped rather than given a new id, because
 * inventing an id here would mint a second `H2` on the next machine to open the file.
 */
export function readProtocol(value: unknown): ProtocolBody {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return emptyProtocol();
  const stored = value as Partial<ProtocolBody>;

  const withId = <T>(entry: unknown, read: (row: Record<string, unknown>) => T): T | null => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return null;
    const row = entry as Record<string, unknown>;
    const id = row["id"];
    if (typeof id !== "string" || id.trim() === "") return null;
    return read(row);
  };

  const subQuestions = readList(stored.sub_questions)
    .map((entry) =>
      withId(entry, (row) => ({ id: row["id"] as string, text: readText(row["text"]) })),
    )
    .filter((entry): entry is SubQuestion => entry !== null);

  const hypotheses = readList(stored.hypotheses)
    .map((entry) =>
      withId(entry, (row) => ({
        id: row["id"] as string,
        statement: readText(row["statement"]),
        direction: isHypothesisDirection(row["direction"]) ? row["direction"] : "none",
        status: isHypothesisStatus(row["status"]) ? row["status"] : "open",
      })),
    )
    .filter((entry): entry is Hypothesis => entry !== null);

  const criteria = readList(stored.criteria)
    .map((entry) =>
      withId(entry, (row) => ({
        id: row["id"] as string,
        kind: isCriterionKind(row["kind"]) ? row["kind"] : "inclusion",
        code: readText(row["code"]),
        text: readText(row["text"]),
      })),
    )
    .filter((entry): entry is Criterion => entry !== null);

  const extraction = readList(stored.extraction_schema)
    .map((entry) =>
      withId(entry, (row) => {
        const type = isExtractionFieldType(row["type"]) ? row["type"] : "text";
        return {
          id: row["id"] as string,
          name: readText(row["name"]),
          type,
          required: row["required"] === true,
          allowed: readList(row["allowed"]).filter((one): one is string => typeof one === "string"),
          unit: type === "number" ? readNullableText(row["unit"]) : null,
        };
      }),
    )
    .filter((entry): entry is ExtractionField => entry !== null);

  const deviations = readList(stored.deviations)
    .map((entry) =>
      withId(entry, (row) => ({
        id: row["id"] as string,
        on: readText(row["on"]),
        what: readText(row["what"]),
        why: readText(row["why"]),
        approved_by: readText(row["approved_by"]),
      })),
    )
    .filter((entry): entry is Deviation => entry !== null);

  const registration = readRecord((value as Record<string, unknown>)["preregistration"]);

  const frozenAt = readNullableText(stored.frozen_at);
  return {
    question: readText(stored.question),
    sub_questions: subQuestions,
    hypotheses,
    criteria,
    extraction_schema: extraction,
    method: readText(stored.method),
    preregistration: {
      registry: readNullableText(registration["registry"]),
      id: readNullableText(registration["id"]),
      url: readNullableText(registration["url"]),
      on: readNullableText(registration["on"]),
    },
    document: readDocument(stored.document),
    frozen_at: frozenAt,
    // A version without a date is not a freeze, and a date without a version cannot be opened in
    // History. Neither half is kept without the other.
    frozen_version:
      frozenAt !== null && typeof stored.frozen_version === "number" ? stored.frozen_version : null,
    deviations: frozenAt === null ? [] : deviations,
  };
}

/**
 * The protocol's searchable text.
 *
 * Everything somebody wrote, so that searching for a phrase from the question, a hypothesis, an
 * exclusion rule, or the prose all find the project it belongs to. The ids and the codes are left
 * out: `E3` is an identifier, and matching it as a word would answer a search for a chemical.
 */
export function protocolContent(protocol: ProtocolBody): string {
  return [
    protocol.question,
    ...protocol.sub_questions.map((entry) => entry.text),
    ...protocol.hypotheses.map((entry) => entry.statement),
    ...protocol.criteria.map((entry) => entry.text),
    ...protocol.extraction_schema.map((field) => field.name),
    protocol.method,
    documentText(protocol.document),
    ...protocol.deviations.map((entry) => `${entry.what} ${entry.why}`),
  ]
    .filter((part) => part.trim() !== "")
    .join("\n");
}
