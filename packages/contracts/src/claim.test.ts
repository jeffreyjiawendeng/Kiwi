import { describe, expect, it } from "vitest";
import {
  claimAnswerChoices,
  claimContent,
  claimTitle,
  emptyClaim,
  isClaimAnswerId,
  isEvidenceObjectType,
  readClaim,
  readClaimAnswers,
  validateClaim,
  type ClaimBody,
} from "./claim.js";
import { emptyProtocol, type ProtocolBody } from "./research-protocol.js";

function claim(fields: Partial<ClaimBody> = {}): ClaimBody {
  return { ...emptyClaim(), ...fields };
}

function protocol(fields: Partial<ProtocolBody> = {}): ProtocolBody {
  return { ...emptyProtocol(), ...fields };
}

describe("what a claim may say", () => {
  it("refuses a claim that asserts nothing", () => {
    expect(validateClaim(claim({ statement: "   " }))).toEqual([
      { field: "statement", message: "A claim has to assert something." },
    ]);
  });

  it("takes a claim that says something", () => {
    expect(validateClaim(claim({ statement: "Sleep debt slows reaction time." }))).toEqual([]);
  });

  it("refuses a status or a confidence it has no meaning for", () => {
    const fields = validateClaim(
      claim({
        statement: "Something.",
        status: "maybe" as ClaimBody["status"],
        confidence: "certain" as ClaimBody["confidence"],
      }),
    ).map((problem) => problem.field);
    expect(fields).toEqual(["status", "confidence"]);
  });
});

describe("what a claim answers", () => {
  it("takes a sub-question or a hypothesis id and nothing else", () => {
    expect(isClaimAnswerId("Q2")).toBe(true);
    expect(isClaimAnswerId("H1")).toBe(true);
    // A criterion is not a question, and an object id is not either.
    expect(isClaimAnswerId("E3")).toBe(false);
    expect(isClaimAnswerId("H")).toBe(false);
    expect(isClaimAnswerId("obj_01H8")).toBe(false);
  });

  it("refuses an id that is not one of those, and refuses the same one twice", () => {
    expect(validateClaim(claim({ statement: "Something.", answers: ["E3"] }))).toEqual([
      {
        field: "answers",
        message: "A claim answers a sub-question or a hypothesis, written as Q2 or H1.",
      },
    ]);
    expect(validateClaim(claim({ statement: "Something.", answers: ["H1", "H1"] }))).toEqual([
      { field: "answers", message: "That is already one of the things this claim answers." },
    ]);
  });

  it("reads what the ids point at in the protocol", () => {
    const answers = readClaimAnswers(
      claim({ answers: ["Q1", "H2"] }),
      protocol({
        sub_questions: [{ id: "Q1", text: "Does it hold overnight?" }],
        hypotheses: [
          { id: "H2", statement: "It holds", direction: "none", status: "open" },
          { id: "H1", statement: "It rises", direction: "increase", status: "open" },
        ],
      }),
    );
    expect(answers).toEqual([
      { id: "Q1", kind: "sub_question", text: "Does it hold overnight?", missing: false },
      { id: "H2", kind: "hypothesis", text: "It holds", missing: false },
    ]);
  });

  it("keeps an id the protocol no longer carries, and says it is missing", () => {
    // Deleting H2 does not make the claim stop answering it. A claim that quietly answers nothing
    // is worse than one that says what it was written against.
    expect(readClaimAnswers(claim({ answers: ["H2"] }), protocol())).toEqual([
      { id: "H2", kind: "hypothesis", text: "", missing: true },
    ]);
  });

  it("offers the sub-questions before the hypotheses, in the order they were asked", () => {
    const choices = claimAnswerChoices(
      protocol({
        sub_questions: [
          { id: "Q1", text: "First" },
          { id: "Q2", text: "Second" },
        ],
        hypotheses: [{ id: "H1", statement: "It rises", direction: "increase", status: "open" }],
      }),
    );
    expect(choices.map((choice) => choice.id)).toEqual(["Q1", "Q2", "H1"]);
    expect(choices[2]?.text).toBe("It rises");
  });

  it("offers nothing when the project has no protocol yet", () => {
    expect(claimAnswerChoices(null)).toEqual([]);
    expect(readClaimAnswers(claim({ answers: ["Q1"] }), null)).toEqual([
      { id: "Q1", kind: "sub_question", text: "", missing: true },
    ]);
  });
});

describe("reading a stored claim", () => {
  it("falls back on a status and a confidence it has never heard of", () => {
    expect(readClaim({ statement: "Something.", status: "wobbly", confidence: 7 })).toEqual({
      statement: "Something.",
      status: "draft",
      confidence: "low",
      answers: [],
    });
  });

  it("drops an answer id nothing in a protocol could ever match", () => {
    expect(readClaim({ statement: "S", answers: ["Q1", "banana", "Q1", 3] })?.answers).toEqual([
      "Q1",
    ]);
  });

  it("refuses what is not a claim at all", () => {
    expect(readClaim(null)).toBeNull();
    expect(readClaim(["Q1"])).toBeNull();
    expect(readClaim({ status: "draft" })).toBeNull();
  });
});

describe("what a claim is called", () => {
  it("is the statement when it fits", () => {
    expect(claimTitle(claim({ statement: "  Sleep debt slows reaction time.  " }))).toBe(
      "Sleep debt slows reaction time.",
    );
  });

  it("cuts on a word and says it was cut", () => {
    const title = claimTitle(claim({ statement: "one two three four five six seven" }), 20);
    expect(title).toBe("one two three four...");
  });

  it("says so when there is nothing to call it", () => {
    expect(claimTitle(claim())).toBe("Untitled claim");
  });

  it("is searchable by everything it says", () => {
    expect(claimContent(claim({ statement: "Sleep debt slows reaction time." }))).toBe(
      "Sleep debt slows reaction time.",
    );
  });
});

describe("what may be evidence", () => {
  it("takes the things somebody can point at, and not a claim", () => {
    expect(isEvidenceObjectType("annotation")).toBe(true);
    expect(isEvidenceObjectType("run")).toBe(true);
    // A claim resting on a claim rests on nothing until the second one has evidence of its own.
    expect(isEvidenceObjectType("claim")).toBe(false);
    expect(isEvidenceObjectType("project")).toBe(false);
  });
});
