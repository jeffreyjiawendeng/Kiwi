import { describe, expect, it } from "vitest";
import {
  citationText,
  formatInTextCitation,
  formatReferenceEntry,
  initials,
  isNumericStyle,
  orderBibliography,
  parseAuthorName,
  type CitationInput,
} from "./citation.js";
import { EMPTY_REFERENCE, type Reference } from "./reference.js";
import { CITATION_STYLES } from "./project.js";

function work(
  overrides: Partial<Reference> = {},
  title = "Attention is all you need",
): CitationInput {
  return {
    title,
    reference: {
      ...EMPTY_REFERENCE,
      authors: ["Ashish Vaswani", "Noam Shazeer"],
      container: "Advances in Neural Information Processing Systems",
      year: 2017,
      volume: "30",
      issue: "1",
      pages: "5998-6008",
      ...overrides,
    },
  };
}

describe("parseAuthorName", () => {
  it("takes a comma at its word", () => {
    // Whoever typed the comma has already answered the question.
    expect(parseAuthorName("van der Berg, Anna")).toEqual({
      family: "van der Berg",
      given: "Anna",
      literal: null,
    });
  });

  it("treats the last word as the family name when there is no comma", () => {
    expect(parseAuthorName("Ashish Vaswani")).toEqual({
      family: "Vaswani",
      given: "Ashish",
      literal: null,
    });
  });

  it("keeps lowercase particles with the family name", () => {
    // "Berg, L." would be wrong; the particles are part of the name.
    expect(parseAuthorName("Ludwig van der Berg").family).toBe("van der Berg");
    expect(parseAuthorName("Ludwig von Mises").family).toBe("von Mises");
  });

  it("uses a single word whole rather than splitting it", () => {
    expect(parseAuthorName("Aristotle")).toMatchObject({ literal: "Aristotle" });
  });

  it("keeps middle names out of the family name", () => {
    expect(parseAuthorName("John Quincy Adams")).toEqual({
      family: "Adams",
      given: "John Quincy",
      literal: null,
    });
  });

  it("survives an empty name", () => {
    expect(parseAuthorName("   ")).toMatchObject({ literal: "" });
  });
});

describe("initials", () => {
  it("reduces given names to initials", () => {
    expect(initials("John Quincy")).toBe("J. Q.");
  });

  it("does not double the stops on a name already initialised", () => {
    expect(initials("J. Q.")).toBe("J. Q.");
  });

  it("can run them together, as Nature does", () => {
    expect(initials("John Quincy", "")).toBe("J.Q.");
  });
});

describe("every style", () => {
  it("formats an entry without leaving a trailing space", () => {
    for (const style of CITATION_STYLES) {
      const text = citationText(formatReferenceEntry(work(), style));
      expect(text).toBe(text.trimEnd());
      expect(text.length).toBeGreaterThan(20);
    }
  });

  it("names the authors, the title, and the year", () => {
    for (const style of CITATION_STYLES) {
      const text = citationText(formatReferenceEntry(work(), style));
      expect(text).toContain("Vaswani");
      expect(text).toContain("Attention is all you need");
      expect(text).toContain("2017");
    }
  });

  it("italicises the container and nothing else structural", () => {
    for (const style of CITATION_STYLES) {
      const italics = formatReferenceEntry(work(), style)
        .filter((segment) => segment.italic === true)
        .map((segment) => segment.text)
        .join("");
      expect(italics).toContain("Advances in Neural");
    }
  });

  it("skips a field that is missing rather than printing a blank", () => {
    // A reference with no volume should read as one with no volume, not as one with an empty
    // pair of brackets.
    for (const style of CITATION_STYLES) {
      const text = citationText(
        formatReferenceEntry(work({ volume: null, issue: null, pages: null }), style),
      );
      expect(text).not.toMatch(/\(\)|vol\. ,|no\. ,|pp\. ,/u);
    }
  });

  it("says the date is unknown rather than leaving a hole", () => {
    for (const style of CITATION_STYLES) {
      const text = citationText(formatReferenceEntry(work({ year: null }), style));
      expect(text).not.toContain("null");
      expect(text).not.toContain("undefined");
    }
  });

  it("never prints a doubled full stop", () => {
    for (const style of CITATION_STYLES) {
      const text = citationText(formatReferenceEntry(work({}, "A title ending in a stop."), style));
      expect(text).not.toContain("..");
    }
  });
});

describe("APA", () => {
  it("inverts every author and initialises the given names", () => {
    expect(citationText(formatReferenceEntry(work(), "apa"))).toContain(
      "Vaswani, A., & Shazeer, N.",
    );
  });

  it("puts the year in brackets after the authors", () => {
    expect(citationText(formatReferenceEntry(work(), "apa"))).toContain("(2017).");
  });

  it("uses an en dash in the page range", () => {
    expect(citationText(formatReferenceEntry(work(), "apa"))).toContain("5998–6008");
  });

  it("links the DOI", () => {
    const text = citationText(formatReferenceEntry(work({ doi: "10.1000/xyz" }), "apa"));
    expect(text).toContain("https://doi.org/10.1000/xyz");
  });
});

describe("MLA", () => {
  it("inverts only the first author", () => {
    const text = citationText(formatReferenceEntry(work(), "mla"));
    // MLA 9 keeps the comma before "and" even with two authors.
    expect(text).toContain("Vaswani, Ashish, and Noam Shazeer");
  });

  it("uses a hyphen in the page range, as MLA does", () => {
    expect(citationText(formatReferenceEntry(work(), "mla"))).toContain("5998-6008");
  });

  it("labels the volume and the issue", () => {
    const text = citationText(formatReferenceEntry(work(), "mla"));
    expect(text).toContain("vol. 30");
    expect(text).toContain("no. 1");
  });
});

describe("IEEE", () => {
  it("puts initials before the family name", () => {
    expect(citationText(formatReferenceEntry(work(), "ieee"))).toContain("A. Vaswani");
  });

  it("ends with the year", () => {
    expect(citationText(formatReferenceEntry(work(), "ieee"))).toContain("2017.");
  });
});

describe("Nature", () => {
  it("runs the initials together after the family name", () => {
    expect(citationText(formatReferenceEntry(work(), "nature"))).toContain("Vaswani, A.");
  });

  it("puts the year in brackets at the end", () => {
    expect(citationText(formatReferenceEntry(work(), "nature"))).toContain("(2017).");
  });
});

describe("long author lists", () => {
  const many = work({
    authors: Array.from({ length: 30 }, (_unused, index) => `Author${String(index)} Family`),
  });

  it("truncates rather than printing thirty names", () => {
    for (const style of CITATION_STYLES) {
      const text = citationText(formatReferenceEntry(many, style));
      expect(text).toContain("et al.");
    }
  });

  it("says it truncated rather than silently cutting the list", () => {
    // A truncated list with no sign that it was truncated is a misleading citation.
    expect(citationText(formatReferenceEntry(many, "mla"))).toContain("et al.");
  });
});

describe("in-text citations", () => {
  it("names author and year for the author-date styles", () => {
    expect(formatInTextCitation(work(), "apa")).toBe("(Vaswani & Shazeer, 2017)");
    expect(formatInTextCitation(work(), "chicago")).toBe("(Vaswani and Shazeer, 2017)");
  });

  it("cites a place rather than a year in MLA", () => {
    expect(formatInTextCitation(work(), "mla", { locator: "p. 45" })).toBe(
      "(Vaswani and Shazeer 45)",
    );
  });

  it("numbers the reference for the numeric styles", () => {
    expect(formatInTextCitation(work(), "ieee", { number: 3 })).toBe("[3]");
    expect(formatInTextCitation(work(), "nature", { number: 3 })).toBe("[3]");
  });

  it("shortens a long author list to et al.", () => {
    const many = work({ authors: ["A One", "B Two", "C Three", "D Four"] });
    expect(formatInTextCitation(many, "apa")).toBe("(One et al., 2017)");
  });

  it("carries a locator when one was given", () => {
    expect(formatInTextCitation(work(), "apa", { locator: "p. 45" })).toBe(
      "(Vaswani & Shazeer, 2017, p. 45)",
    );
  });

  it("says the date is unknown rather than omitting it", () => {
    expect(formatInTextCitation(work({ year: null }), "apa")).toContain("n.d.");
  });

  it("falls back to the title when a work has no authors", () => {
    expect(formatInTextCitation(work({ authors: [] }), "apa")).toContain(
      "Attention is all you need",
    );
  });
});

describe("ordering the reference list", () => {
  const first = { ...work({ authors: ["Zoe Young"], year: 2020 }, "Later"), id: "b" };
  const second = { ...work({ authors: ["Alice Adams"], year: 2019 }, "Earlier"), id: "a" };

  it("numbers a numeric style by order of first citation", () => {
    // That is what the numbers mean; sorting them alphabetically would make them lie.
    const ordered = orderBibliography([second, first], "ieee", ["b", "a"]);
    expect(ordered.map((entry) => entry.id)).toEqual(["b", "a"]);
    expect(ordered.map((entry) => entry.number)).toEqual([1, 2]);
  });

  it("sorts an author-date style by author", () => {
    const ordered = orderBibliography([first, second], "apa", ["b", "a"]);
    expect(ordered.map((entry) => entry.id)).toEqual(["a", "b"]);
  });

  it("sinks a work that was never cited below everything that was", () => {
    const ordered = orderBibliography([second, first], "ieee", ["b"]);
    expect(ordered[0]?.id).toBe("b");
  });
});

describe("isNumericStyle", () => {
  it("separates the numbered styles from the named ones", () => {
    expect(isNumericStyle("ieee")).toBe(true);
    expect(isNumericStyle("nature")).toBe(true);
    expect(isNumericStyle("apa")).toBe(false);
  });
});
