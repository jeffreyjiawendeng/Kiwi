import { describe, expect, it } from "vitest";
import {
  emptyProtocol,
  freezeProtocol,
  isProtocolFrozen,
  logDeviation,
  nextCriterionCode,
  nextProtocolId,
  protocolContent,
  readProtocol,
  validateProtocol,
  type Criterion,
  type ExtractionField,
  type Hypothesis,
  type ProtocolBody,
} from "./research-protocol.js";

function protocol(fields: Partial<ProtocolBody> = {}): ProtocolBody {
  return { ...emptyProtocol(), ...fields };
}

function hypothesis(id: string, fields: Partial<Hypothesis> = {}): Hypothesis {
  return {
    id,
    statement: "Sleep improves recall",
    direction: "increase",
    status: "open",
    ...fields,
  };
}

function criterion(id: string, code: string, fields: Partial<Criterion> = {}): Criterion {
  return {
    id,
    code,
    kind: code.startsWith("I") ? "inclusion" : "exclusion",
    text: "Adults",
    ...fields,
  };
}

function field(id: string, fields: Partial<ExtractionField> = {}): ExtractionField {
  return {
    id,
    name: "Sample size",
    type: "number",
    required: true,
    allowed: [],
    unit: null,
    ...fields,
  };
}

/** A protocol that has been committed to, which is what a deviation needs to exist against. */
function frozen(fields: Partial<ProtocolBody> = {}): ProtocolBody {
  return protocol({ frozen_at: "2026-08-01T09:00:00.000Z", frozen_version: 4, ...fields });
}

describe("ids inside a protocol", () => {
  it("takes the next unused number, not the next index", () => {
    // H2 was deleted. The next hypothesis is H4, because a claim still says H3 and must keep
    // meaning the hypothesis it meant.
    expect(nextProtocolId("H", ["H1", "H3"])).toBe("H4");
    expect(nextProtocolId("Q", [])).toBe("Q1");
  });

  it("ignores an id that was never part of the series", () => {
    expect(nextProtocolId("H", ["H1", "Hx", "Q9", ""])).toBe("H2");
  });

  it("numbers a criterion within its kind, so the code says which it is", () => {
    const criteria = [criterion("C1", "I1"), criterion("C2", "E1"), criterion("C3", "E2")];
    expect(nextCriterionCode("inclusion", criteria)).toBe("I2");
    expect(nextCriterionCode("exclusion", criteria)).toBe("E3");
  });
});

describe("freezing a protocol", () => {
  it("records when it was frozen and which version that was", () => {
    const at = freezeProtocol(protocol(), "2026-08-26T10:00:00.000Z", 7);
    expect(isProtocolFrozen(at)).toBe(true);
    expect(at.frozen_version).toBe(7);
  });

  it("does not move the date when it is frozen a second time", () => {
    const once = freezeProtocol(protocol(), "2026-08-26T10:00:00.000Z", 7);
    const twice = freezeProtocol(once, "2026-09-01T10:00:00.000Z", 9);
    expect(twice).toBe(once);
  });

  it("appends a deviation with an id of its own", () => {
    const logged = logDeviation(frozen(), {
      on: "2026-08-20",
      what: "Widened the age range to 65",
      why: "Recruitment fell short",
      approved_by: "R. Okonkwo",
    });
    expect(logged.deviations.map((entry) => entry.id)).toEqual(["D1"]);
    expect(logDeviation(logged, logged.deviations[0]!).deviations.map((one) => one.id)).toEqual([
      "D1",
      "D2",
    ]);
  });
});

describe("what a protocol refuses to be", () => {
  it("accepts an empty protocol, because a project that has not opened the page has one", () => {
    expect(validateProtocol(emptyProtocol())).toEqual([]);
  });

  it("refuses two criteria answering to the same code", () => {
    const problems = validateProtocol(
      protocol({ criteria: [criterion("C1", "E1"), criterion("C2", "E1")] }),
    );
    expect(problems.map((problem) => problem.message)).toContain(
      "Two criteria are both called E1.",
    );
  });

  it("refuses two extraction fields with the same name, whatever the case", () => {
    const problems = validateProtocol(
      protocol({ extraction_schema: [field("F1"), field("F2", { name: "sample size" })] }),
    );
    expect(problems.map((problem) => problem.message)).toContain(
      "Two fields are both called sample size.",
    );
  });

  it("refuses a choice with nothing to choose, and a list on anything else", () => {
    const empty = validateProtocol(
      protocol({ extraction_schema: [field("F1", { type: "choice", unit: null })] }),
    );
    expect(empty.map((problem) => problem.message)).toContain(
      "A field to choose from needs something to choose.",
    );

    const listed = validateProtocol(
      protocol({ extraction_schema: [field("F1", { type: "text", allowed: ["a", "b"] })] }),
    );
    expect(listed.map((problem) => problem.message)).toContain(
      "Only a field to choose from has a list of choices.",
    );
  });

  it("refuses a unit on anything that is not a number", () => {
    const problems = validateProtocol(
      protocol({ extraction_schema: [field("F1", { type: "text", unit: "weeks" })] }),
    );
    expect(problems.map((problem) => problem.message)).toContain("Only a number has a unit.");
  });

  it("refuses a deviation from a protocol nobody froze", () => {
    const problems = validateProtocol(
      protocol({
        deviations: [
          { id: "D1", on: "2026-08-20", what: "Widened it", why: "Slow", approved_by: "R" },
        ],
      }),
    );
    expect(problems.map((problem) => problem.message)).toContain(
      "A deviation is a departure from a protocol that was frozen.",
    );
  });

  it("refuses a freeze that does not say which version it covers", () => {
    const problems = validateProtocol(protocol({ frozen_at: "2026-08-01T09:00:00.000Z" }));
    expect(problems.map((problem) => problem.field)).toContain("frozen_version");
  });

  it("reports a clash once rather than once for every entry after it", () => {
    const problems = validateProtocol(
      protocol({ hypotheses: [hypothesis("H1"), hypothesis("H1"), hypothesis("H1")] }),
    );
    expect(problems).toHaveLength(1);
  });
});

describe("reading a stored protocol", () => {
  it("opens the page for a project that has nothing stored", () => {
    expect(readProtocol(undefined)).toEqual(emptyProtocol());
    expect(readProtocol("a protocol")).toEqual(emptyProtocol());
  });

  it("drops an entry with no id rather than minting one", () => {
    // Inventing an id here would mint a second H2 on the next machine to open the file.
    const read = readProtocol({
      question: "Does sleep help?",
      hypotheses: [hypothesis("H1"), { statement: "Nameless", direction: "none", status: "open" }],
    });
    expect(read.hypotheses.map((entry) => entry.id)).toEqual(["H1"]);
  });

  it("keeps an entry whose direction this build has never heard of", () => {
    const read = readProtocol({
      question: "",
      hypotheses: [{ id: "H1", statement: "Sleep helps", direction: "sideways", status: "later" }],
    });
    expect(read.hypotheses[0]).toEqual({
      id: "H1",
      statement: "Sleep helps",
      direction: "none",
      status: "open",
    });
  });

  it("does not keep half a freeze", () => {
    const noVersion = readProtocol({ question: "", frozen_at: "2026-08-01T09:00:00.000Z" });
    expect(noVersion.frozen_version).toBeNull();

    // A version with no date is not a freeze, and the deviations logged against it are not
    // departures from anything.
    const noDate = readProtocol({
      question: "",
      frozen_version: 4,
      deviations: [{ id: "D1", on: "2026-08-20", what: "x", why: "y", approved_by: "z" }],
    });
    expect(noDate.frozen_version).toBeNull();
    expect(noDate.deviations).toEqual([]);
  });

  it("drops a unit that was stored on something that is not a number", () => {
    const read = readProtocol({
      question: "",
      extraction_schema: [{ id: "F1", name: "Setting", type: "text", allowed: [], unit: "weeks" }],
    });
    expect(read.extraction_schema[0]?.unit).toBeNull();
  });
});

describe("what a search finds in a protocol", () => {
  it("reads the words and leaves out the identifiers", () => {
    const content = protocolContent(
      protocol({
        question: "Does sleep improve recall?",
        sub_questions: [{ id: "Q1", text: "In adults over 60?" }],
        hypotheses: [hypothesis("H1")],
        criteria: [criterion("C1", "E1", { text: "Under 18" })],
        method: "A randomised trial",
      }),
    );
    expect(content).toContain("Does sleep improve recall?");
    expect(content).toContain("In adults over 60?");
    expect(content).toContain("Under 18");
    expect(content).toContain("A randomised trial");
    // E3 is an identifier. Matching it as a word would answer a search for a chemical.
    expect(content).not.toContain("E1");
    expect(content).not.toContain("H1");
  });

  it("reads the prose the protocol was written in", () => {
    const content = protocolContent(
      protocol({
        document: {
          type: "doc",
          content: [
            { type: "paragraph", content: [{ type: "text", text: "Blinded throughout." }] },
          ],
        },
      }),
    );
    expect(content).toBe("Blinded throughout.");
  });
});
