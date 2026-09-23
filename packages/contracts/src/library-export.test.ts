import { describe, expect, it } from "vitest";
import {
  isLibraryExportFormat,
  libraryExportFile,
  parseReferenceFile,
  parseRis,
  toReferenceCsv,
  toRis,
  toRisFile,
} from "./library-export.js";
import { EMPTY_REFERENCE, type Reference } from "./reference.js";
import type { BibtexEntry } from "./bibtex.js";

function entry(
  overrides: Partial<Reference> = {},
  title = "Attention is all you need",
): BibtexEntry {
  return {
    key: "vaswani2017",
    title,
    reference: {
      ...EMPTY_REFERENCE,
      authors: ["Ashish Vaswani", "Noam Shazeer"],
      container: "Advances in Neural Information Processing Systems",
      year: 2017,
      volume: "30",
      pages: "5998-6008",
      ...overrides,
    },
  };
}

function lines(text: string): string[] {
  return text.split("\r\n");
}

describe("toRis", () => {
  it("writes the tag, two spaces, a hyphen, a space, and the value", () => {
    // A reader that splits on a fixed column takes nothing else.
    expect(lines(toRis(entry()))).toContain("TI  - Attention is all you need");
  });

  it("names the type RIS uses rather than the one Kiwi uses", () => {
    expect(lines(toRis(entry({ kind: "conference" })))[0]).toBe("TY  - CPAPER");
    expect(lines(toRis(entry({ kind: "thesis" })))[0]).toBe("TY  - THES");
  });

  it("gives every author a line of their own, family name first", () => {
    const written = lines(toRis(entry()));
    expect(written).toContain("AU  - Vaswani, Ashish");
    expect(written).toContain("AU  - Shazeer, Noam");
  });

  it("keeps an organization whole rather than making Organization the surname", () => {
    // The trailing comma is how a record says the whole string is one name.
    expect(lines(toRis(entry({ authors: ["World Health Organization,"] })))).toContain(
      "AU  - World Health Organization",
    );
  });

  it("splits a page range into a start and an end", () => {
    const written = lines(toRis(entry()));
    expect(written).toContain("SP  - 5998");
    expect(written).toContain("EP  - 6008");
  });

  it("writes a single page as a start with no end", () => {
    const written = lines(toRis(entry({ pages: "e1234" })));
    expect(written).toContain("SP  - e1234");
    expect(written.some((line) => line.startsWith("EP"))).toBe(false);
  });

  it("leaves out a field the record does not have", () => {
    const written = lines(toRis(entry({ volume: null, doi: null, publisher: null })));
    expect(written.some((line) => line.startsWith("VL"))).toBe(false);
    expect(written.some((line) => line.startsWith("DO"))).toBe(false);
  });

  it("ends the record, because a reader drops one that has no ER", () => {
    expect(lines(toRis(entry())).at(-1)).toBe("ER  - ");
  });

  it("keeps an abstract on one line", () => {
    // A value that wraps onto a second line reads as a new tag, and a bad tag ends the record.
    const written = lines(toRis(entry({ abstract: "First sentence.\nSecond sentence." })));
    expect(written).toContain("AB  - First sentence. Second sentence.");
  });
});

describe("toRisFile", () => {
  it("separates records with a blank line", () => {
    const text = toRisFile([entry(), { ...entry(), key: "second" }]);
    expect(text.split("ER  - ")).toHaveLength(3);
    expect(text.endsWith("ER  - \r\n\r\n")).toBe(true);
  });

  it("writes nothing at all for nothing", () => {
    expect(toRisFile([])).toBe("");
  });
});

describe("toReferenceCsv", () => {
  it("opens with a byte order mark, so Excel does not mangle an accented name", () => {
    expect(toReferenceCsv([]).codePointAt(0)).toBe(0xfeff);
  });

  it("names its columns on the first row", () => {
    const [header] = lines(toReferenceCsv([]).slice(1));
    expect(header).toBe(
      "key,title,authors,kind,container,year,volume,issue,pages,publisher,doi,url,abstract",
    );
  });

  it("puts one paper on one row", () => {
    const [, row] = lines(toReferenceCsv([entry()]));
    expect(row).toContain("vaswani2017,Attention is all you need,Ashish Vaswani; Noam Shazeer");
  });

  it("quotes a field holding a comma and doubles a quote inside one", () => {
    const [, row] = lines(toReferenceCsv([entry({}, 'On "attention", briefly')]));
    expect(row).toContain('"On ""attention"", briefly"');
  });

  it("does not let a title become a formula", () => {
    // A cell opening with = is something Excel computes. An export should not hand somebody a
    // file that runs when they open it.
    const [, row] = lines(toReferenceCsv([entry({}, "=cmd|' /c calc'!A1")]));
    expect(row).toContain("'=cmd|' /c calc'!A1");
  });

  it("leaves a missing field empty rather than writing null", () => {
    const [, row] = lines(toReferenceCsv([entry({ doi: null, publisher: null })]));
    expect(row).not.toContain("null");
  });

  it("keeps a multi-line abstract inside its quoted cell", () => {
    const text = toReferenceCsv([entry({ abstract: "First.\nSecond." })]);
    expect(text).toContain('"First.\nSecond."');
  });
});

describe("libraryExportFile", () => {
  it("gives each format its own extension", () => {
    expect(libraryExportFile("bibtex", []).extension).toBe("bib");
    expect(libraryExportFile("ris", []).extension).toBe("ris");
    expect(libraryExportFile("csv", []).extension).toBe("csv");
  });

  it("writes the same papers whichever format is chosen", () => {
    for (const format of ["bibtex", "ris", "csv"] as const) {
      expect(libraryExportFile(format, [entry()]).text).toContain("Attention is all you need");
    }
  });

  it("recognises only the three formats", () => {
    expect(isLibraryExportFormat("ris")).toBe(true);
    expect(isLibraryExportFormat("endnote")).toBe(false);
    expect(isLibraryExportFormat(null)).toBe(false);
  });
});

function ris(...records: string[]): string {
  return records.join("\r\n");
}

describe("parseRis", () => {
  const record = [
    "TY  - JOUR",
    "ID  - vaswani2017",
    "TI  - Attention is all you need",
    "AU  - Vaswani, Ashish",
    "AU  - Shazeer, Noam",
    "T2  - Advances in Neural Information Processing Systems",
    "PY  - 2017",
    "VL  - 30",
    "SP  - 5998",
    "EP  - 6008",
    "DO  - 10.5555/3295222",
    "ER  - ",
  ].join("\r\n");

  it("reads a record into the same shape a .bib file arrives in", () => {
    const [first] = parseRis(record);
    expect(first?.key).toBe("vaswani2017");
    expect(first?.title).toBe("Attention is all you need");
    expect(first?.reference.container).toBe("Advances in Neural Information Processing Systems");
    expect(first?.reference.year).toBe(2017);
    expect(first?.reference.doi).toBe("10.5555/3295222");
  });

  it("keeps every author, in the order they were written", () => {
    // Names come across as written. Kiwi does not take a name apart, so it does not put one
    // back together either, and "Vaswani, Ashish" is a name a citation style already reads.
    expect(parseRis(record)[0]?.reference.authors).toEqual(["Vaswani, Ashish", "Shazeer, Noam"]);
  });

  it("does not make an editor into an author", () => {
    // A2 is the editor of the book. Taking it would put the editor in front of the writer.
    const parsed = parseRis(ris("TY  - CHAP", "AU  - Writer, A", "A2  - Editor, B", "ER  - "));
    expect(parsed[0]?.reference.authors).toEqual(["Writer, A"]);
  });

  it("joins a start and an end page back into a range", () => {
    expect(parseRis(record)[0]?.reference.pages).toBe("5998-6008");
  });

  it("leaves a single page as one page", () => {
    const parsed = parseRis(ris("TY  - JOUR", "TI  - One page", "SP  - 41", "ER  - "));
    expect(parsed[0]?.reference.pages).toBe("41");
  });

  it("names the kind Kiwi uses rather than the one RIS uses", () => {
    expect(parseRis(ris("TY  - CPAPER", "TI  - A", "ER  - "))[0]?.reference.kind).toBe(
      "conference",
    );
    expect(parseRis(ris("TY  - THES", "TI  - A", "ER  - "))[0]?.reference.kind).toBe("thesis");
  });

  it("takes a record whose type it has never seen rather than dropping it", () => {
    // The type is the least of what a reference carries, so an unknown one costs the type only.
    const parsed = parseRis(ris("TY  - PAT", "TI  - A patent", "ER  - "));
    expect(parsed[0]?.title).toBe("A patent");
    expect(parsed[0]?.reference.kind).toBe("other");
  });

  it("reads a year out of a full date", () => {
    const parsed = parseRis(ris("TY  - JOUR", "TI  - A", "PY  - 2017/06/12/", "ER  - "));
    expect(parsed[0]?.reference.year).toBe(2017);
  });

  it("puts an abstract back together across the lines it was wrapped onto", () => {
    const parsed = parseRis(
      ris("TY  - JOUR", "TI  - A", "AB  - The first half", "of a wrapped abstract.", "ER  - "),
    );
    expect(parsed[0]?.reference.abstract).toBe("The first half of a wrapped abstract.");
  });

  it("reads a file written with one space where the format asks for two", () => {
    // Every other reference manager opens these, so refusing them refuses real libraries.
    expect(parseRis(ris("TY - JOUR", "TI - Loosely written", "ER - "))[0]?.title).toBe(
      "Loosely written",
    );
  });

  it("keeps a record whose writer forgot the terminator", () => {
    const parsed = parseRis(ris("TY  - JOUR", "TI  - First", "TY  - BOOK", "TI  - Second"));
    expect(parsed.map((found) => found.title)).toEqual(["First", "Second"]);
  });

  it("ignores whatever came before the first record", () => {
    const parsed = parseRis(ris("Exported by a program", "", "TY  - JOUR", "TI  - A", "ER  - "));
    expect(parsed).toHaveLength(1);
  });

  it("costs one unreadable record that record and not the file", () => {
    const parsed = parseRis(ris("TY  - JOUR", "ER  - ", record));
    expect(parsed.map((found) => found.title)).toEqual(["Attention is all you need"]);
  });

  it("gives a record with no title a name rather than an empty one", () => {
    expect(parseRis(ris("TY  - JOUR", "AU  - Nobody, A", "ER  - "))[0]?.title).toBe("Untitled");
  });

  it("reads a book's title out of BT when that is where the title was put", () => {
    const parsed = parseRis(ris("TY  - BOOK", "BT  - The whole book", "ER  - "));
    expect(parsed[0]?.title).toBe("The whole book");
    expect(parsed[0]?.reference.container).toBeNull();
  });

  it("reads BT as the container when the record named its own title", () => {
    const parsed = parseRis(
      ris("TY  - CHAP", "TI  - One chapter", "BT  - The whole book", "ER  -"),
    );
    expect(parsed[0]?.title).toBe("One chapter");
    expect(parsed[0]?.reference.container).toBe("The whole book");
  });

  it("reads back what it wrote", () => {
    // The pair is kept in one file so that a field added to the writer is a field missing from
    // the reader on the same screen. This is the test that notices when it is not.
    //
    // Names are the one thing a round trip changes. RIS asks for "Family, Given" and the writer
    // obliges; the reader takes a name as written rather than guessing which half is which. So
    // the author comes back spelled the way RIS spells it, and is still the same person.
    const [returned] = parseRis(toRisFile([entry()]));
    expect(returned?.title).toBe("Attention is all you need");
    expect(returned?.reference).toMatchObject({
      ...entry().reference,
      authors: ["Vaswani, Ashish", "Shazeer, Noam"],
    });
  });

  it("finds nothing in a file that holds nothing", () => {
    expect(parseRis("")).toEqual([]);
  });
});

describe("parseReferenceFile", () => {
  it("reads a .bib file as BibTeX", () => {
    expect(parseReferenceFile("@article{k, title = {A paper}}")[0]?.title).toBe("A paper");
  });

  it("reads a .ris file as RIS", () => {
    expect(parseReferenceFile(ris("TY  - JOUR", "TI  - A paper", "ER  - "))[0]?.title).toBe(
      "A paper",
    );
  });

  it("goes by what is in the file rather than what it was called", () => {
    // An export off an older EndNote arrives as .txt and is RIS inside, and a file somebody
    // sends has whatever extension they happened to save it under.
    const parsed = parseReferenceFile(ris("Record 1 of 1", "TY  - BOOK", "TI  - A book", "ER  - "));
    expect(parsed[0]?.reference.kind).toBe("book");
  });

  it("is not fooled by an at sign in an abstract", () => {
    // A RIS record whose text mentions an email address is still a RIS record. Whichever
    // marker comes first is the one that decides.
    const parsed = parseReferenceFile(
      ris("TY  - JOUR", "TI  - A paper", "AB  - Write to a@{b} about it", "ER  - "),
    );
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.title).toBe("A paper");
  });

  it("finds nothing in a file that is neither", () => {
    expect(parseReferenceFile("Just some prose about a paper.")).toEqual([]);
  });
});
