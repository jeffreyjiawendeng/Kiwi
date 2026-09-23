// @vitest-environment jsdom
// This file runs in jsdom for one reason: DOMParser. It is the only strict XML parser the
// repository already has, and a part Word would call damaged has to fail here instead.
import { describe, expect, it } from "vitest";
import { crc32, inflateRawSync } from "node:zlib";
import { documentToDocxParts } from "@kiwi/contracts";
import { writeZip } from "./zip.js";

/**
 * Reads an archive the way a reader that has never seen this one would: from the end.
 *
 * Nothing in Kiwi opens a ZIP, so this lives with the tests rather than beside the writer. It
 * exists to check the writer against the format rather than against itself, it starts at the
 * end-of-central-directory record and follows the offsets, so a wrong offset or a wrong length
 * fails here instead of in Word.
 */
function readZip(bytes: Uint8Array): Map<string, { data: Uint8Array; method: number }> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = bytes.length - 22;
  while (end >= 0 && view.getUint32(end, true) !== 0x0605_4b50) end -= 1;
  if (end < 0) throw new Error("no end-of-central-directory record");

  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const found = new Map<string, { data: Uint8Array; method: number }>();

  for (let index = 0; index < count; index += 1) {
    if (view.getUint32(at, true) !== 0x0201_4b50) throw new Error("no central directory entry");
    const method = view.getUint16(at + 10, true);
    const stated = view.getUint32(at + 16, true);
    const compressedSize = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true);
    const offset = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength));

    if (view.getUint32(offset, true) !== 0x0403_4b50)
      throw new Error(`no local header for ${name}`);
    const localName = view.getUint16(offset + 26, true);
    const localExtra = view.getUint16(offset + 28, true);
    const start = offset + 30 + localName + localExtra;
    const stored = bytes.subarray(start, start + compressedSize);
    const data = method === 8 ? new Uint8Array(inflateRawSync(stored)) : stored;
    if (crc32(data) !== stated) throw new Error(`checksum does not match for ${name}`);
    found.set(name, { data, method });
    at += 46 + nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
  }
  return found;
}

const xml =
  '<?xml version="1.0"?><w:document><w:body><w:p><w:r><w:t>Hello</w:t></w:r></w:p></w:body></w:document>';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

describe("writing an archive", () => {
  it("comes back out the way it went in", () => {
    const archive = writeZip([
      { name: "[Content_Types].xml", data: bytesOf(xml) },
      { name: "word/document.xml", data: bytesOf("second") },
      { name: "word/media/figure.png", data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) },
    ]);
    const found = readZip(archive);
    expect([...found.keys()]).toEqual([
      "[Content_Types].xml",
      "word/document.xml",
      "word/media/figure.png",
    ]);
    expect(new TextDecoder().decode(found.get("[Content_Types].xml")?.data)).toBe(xml);
    expect(found.get("word/media/figure.png")?.data).toEqual(
      new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    );
  });

  it("compresses a part worth compressing and leaves the rest alone", () => {
    const repetitive = bytesOf("<w:p><w:r><w:t>a</w:t></w:r></w:p>".repeat(200));
    const incompressible = new Uint8Array([1, 2, 3]);
    const found = readZip(
      writeZip([
        { name: "big.xml", data: repetitive },
        { name: "small.bin", data: incompressible },
      ]),
    );
    expect(found.get("big.xml")?.method).toBe(8);
    // Deflating three bytes makes them longer, which is a worse archive, not a smaller one.
    expect(found.get("small.bin")?.method).toBe(0);
  });

  it("holds an empty part without losing it", () => {
    const found = readZip(writeZip([{ name: "word/empty.xml", data: new Uint8Array() }]));
    expect(found.get("word/empty.xml")?.data).toEqual(new Uint8Array());
  });

  it("writes the same bytes for the same parts", () => {
    // The timestamp is fixed rather than read from the clock, so two exports of a manuscript
    // nobody edited are the same file and can be told apart from one that changed.
    const parts = [{ name: "word/document.xml", data: bytesOf(xml) }];
    expect(writeZip(parts)).toEqual(writeZip(parts));
  });
});

describe("packing a manuscript", () => {
  it("puts every part of a document where Word looks for it", () => {
    // The two halves are written apart, the XML in contracts, the container here, so this is
    // the one place that checks a real manuscript comes out the other side as an archive.
    const { parts } = documentToDocxParts(
      {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: "Body" }] }],
      },
      { title: "A paper" },
    );
    const encoder = new TextEncoder();
    const found = readZip(
      writeZip(
        parts.map((part) => ({
          name: part.name,
          data: typeof part.data === "string" ? encoder.encode(part.data) : part.data,
        })),
      ),
    );
    expect([...found.keys()]).toContain("[Content_Types].xml");
    const document = new TextDecoder().decode(found.get("word/document.xml")?.data);
    expect(document.startsWith("<?xml")).toBe(true);
    expect(document).toContain("A paper");
    expect(document.endsWith("</w:document>")).toBe(true);
  });
  it("writes XML a strict parser accepts, in every part", () => {
    // Word does not forgive a malformed part. It reports the document as damaged and offers to
    // repair it, and what a repair keeps is not the author's decision. A parser here is the
    // closest thing to that check that can run without Word.
    const { parts } = documentToDocxParts(
      {
        type: "doc",
        content: [
          { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "M & M" }] },
          {
            type: "paragraph",
            content: [
              { type: "text", text: "a < b", marks: [{ type: "bold" }] },
              { type: "citation", attrs: { objectId: "obj-1", label: "(Smith, 2019)" } },
            ],
          },
          {
            type: "bulletList",
            content: [
              {
                type: "listItem",
                content: [{ type: "paragraph", content: [{ type: "text", text: "one" }] }],
              },
            ],
          },
          {
            type: "table",
            content: [
              { type: "tableRow", content: [{ type: "tableHeader" }, { type: "tableCell" }] },
            ],
          },
          { type: "mathBlock", attrs: { latex: "a > b" } },
          { type: "image", attrs: { src: "kiwi-asset://ws/asset-1", alt: "A figure" } },
        ],
      },
      {
        title: "A & B",
        figures: [{ name: "figure-asset-1.png", bytes: PNG }],
        references: ["Smith, J. (2019)."],
      },
    );
    const parser = new DOMParser();
    for (const part of parts) {
      if (typeof part.data !== "string") continue;
      const parsed = parser.parseFromString(part.data, "application/xml");
      expect(
        parsed.getElementsByTagName("parsererror").length,
        `${part.name} is not well formed`,
      ).toBe(0);
    }
  });
});
