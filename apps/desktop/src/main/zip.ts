import { crc32, deflateRawSync } from "node:zlib";

/**
 * A ZIP archive, written by hand.
 *
 * A `.docx` is a ZIP of XML parts, and this is the only thing Kiwi needs a ZIP for. The format
 * is three record types and a handful of little-endian numbers; a dependency would be more code
 * to audit than the code it replaced, and this one has no ambition beyond what Word reads.
 *
 * The output is deterministic, the same parts produce the same bytes, because the timestamp is
 * fixed rather than taken from the clock. Two exports of an unchanged manuscript are then
 * identical files, which is what makes one comparable to the other.
 */

export interface ZipEntry {
  /** The path inside the archive, always with forward slashes. */
  name: string;
  data: Uint8Array;
}

/** 1980-01-01, the earliest date the format can hold, in DOS time and date fields. */
const DOS_TIME = 0;
const DOS_DATE = 0x0021;

const LOCAL_SIGNATURE = 0x0403_4b50;
const CENTRAL_SIGNATURE = 0x0201_4b50;
const END_SIGNATURE = 0x0605_4b50;

const STORED = 0;
const DEFLATED = 8;

interface Staged {
  name: Uint8Array;
  method: number;
  crc: number;
  compressed: Uint8Array;
  size: number;
  offset: number;
}

function encodeName(name: string): Uint8Array {
  return new TextEncoder().encode(name);
}

/**
 * Compresses an entry, unless compressing it is a waste.
 *
 * A PNG or a JPEG is already compressed, and deflating one again usually makes it slightly
 * larger. The XML parts, on the other hand, are repetitive enough to lose most of their size.
 */
function stage(entry: ZipEntry, offset: number): Staged {
  const name = encodeName(entry.name);
  const deflated = new Uint8Array(deflateRawSync(entry.data));
  const useDeflate = deflated.length < entry.data.length;
  return {
    name,
    method: useDeflate ? DEFLATED : STORED,
    crc: crc32(entry.data),
    compressed: useDeflate ? deflated : entry.data,
    size: entry.data.length,
    offset,
  };
}

class Writer {
  private readonly parts: Uint8Array[] = [];
  length = 0;

  push(bytes: Uint8Array): void {
    this.parts.push(bytes);
    this.length += bytes.length;
  }

  /** A header, written as the field widths the format states, in order. */
  record(fields: Array<[width: 2 | 4, value: number]>): void {
    const size = fields.reduce((total, [width]) => total + width, 0);
    const bytes = new Uint8Array(size);
    const view = new DataView(bytes.buffer);
    let at = 0;
    for (const [width, value] of fields) {
      if (width === 2) view.setUint16(at, value & 0xffff, true);
      else view.setUint32(at, value >>> 0, true);
      at += width;
    }
    this.push(bytes);
  }

  join(): Uint8Array {
    const out = new Uint8Array(this.length);
    let at = 0;
    for (const part of this.parts) {
      out.set(part, at);
      at += part.length;
    }
    return out;
  }
}

export function writeZip(entries: ZipEntry[]): Uint8Array {
  const writer = new Writer();
  const staged: Staged[] = [];

  for (const entry of entries) {
    const item = stage(entry, writer.length);
    staged.push(item);
    writer.record([
      [4, LOCAL_SIGNATURE],
      [2, 20],
      [2, 0],
      [2, item.method],
      [2, DOS_TIME],
      [2, DOS_DATE],
      [4, item.crc],
      [4, item.compressed.length],
      [4, item.size],
      [2, item.name.length],
      [2, 0],
    ]);
    writer.push(item.name);
    writer.push(item.compressed);
  }

  const directoryOffset = writer.length;
  for (const item of staged) {
    writer.record([
      [4, CENTRAL_SIGNATURE],
      [2, 20],
      [2, 20],
      [2, 0],
      [2, item.method],
      [2, DOS_TIME],
      [2, DOS_DATE],
      [4, item.crc],
      [4, item.compressed.length],
      [4, item.size],
      [2, item.name.length],
      [2, 0],
      [2, 0],
      [2, 0],
      [2, 0],
      [4, 0],
      [4, item.offset],
    ]);
    writer.push(item.name);
  }

  const directorySize = writer.length - directoryOffset;
  writer.record([
    [4, END_SIGNATURE],
    [2, 0],
    [2, 0],
    [2, staged.length],
    [2, staged.length],
    [4, directorySize],
    [4, directoryOffset],
    [2, 0],
  ]);
  return writer.join();
}
