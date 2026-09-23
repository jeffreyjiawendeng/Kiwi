import { readFile, stat } from "node:fs/promises";
import {
  CITATION_STYLES,
  bareFields,
  bibtexKey,
  citationText,
  documentCitationCounts,
  documentCitations,
  formatInTextCitation,
  formatReferenceEntry,
  importCandidates,
  isNumericStyle,
  LIBRARY_EXPORT_FORMATS,
  libraryExportFile,
  orderBibliography,
  parseReferenceFile,
  readReference,
  toBibtexFile,
  validateReference,
  type BibtexEntry,
  type CitationStyle,
  type HeldWork,
  type ImportEntry,
  type ImportMatch,
  type LibraryExportFormat,
  type OriginSurface,
  type Reference,
} from "@kiwi/contracts";
import { CommandError, defineCommand, type CommandDefinition } from "@kiwi/commands";
import {
  createObject,
  listCanonicalObjects,
  readCanonicalObject,
  type CanonicalObject,
} from "./objects.js";
import {
  commandIds,
  commandWorkspaceId,
  idProperty,
  rootProperty,
  type ObjectCommandDeps,
} from "./object-commands.js";

const SCHEMA = "https://json-schema.org/draft/2020-12/schema";

/**
 * A bibliography is built from what a manuscript actually cites, never from the whole library.
 *
 * A reference list that includes everything the author happens to own is wrong in a way that
 * gets a paper rejected, so the cited set is read out of the document rather than assembled by
 * hand.
 */

interface CitedWork {
  id: string;
  title: string;
  reference: Reference;
}

function referenceOf(object: CanonicalObject): Reference | null {
  const raw = object["reference"];
  return raw === undefined || raw === null ? null : readReference(raw);
}

/** Which fields a style needs before it can print a usable entry. */
function missingFields(reference: Reference, style: CitationStyle): string[] {
  const missing = bareFields(reference);
  if (style === "mla" && reference.pages === null) missing.push("pages");
  return missing;
}

/**
 * Why a row was not created, in the words the receipt uses.
 *
 * Four reasons rather than one, because "duplicate" on its own gives somebody nothing to act
 * on. A DOI already held is a fact to accept; a title that merely reads alike is a judgement
 * worth checking; a paper listed twice in the file is the file's problem and not the library's.
 */
function skipReason(duplicate: ImportMatch): string {
  if (duplicate.where === "file") return "repeated_in_file";
  if (duplicate.by === "doi") return "duplicate_doi";
  return duplicate.by === "file" ? "duplicate_file" : "duplicate_title";
}

interface DuplicateReport {
  where: "library" | "file";
  by: "doi" | "file" | "title";
  certain: boolean;
  object_id: string | null;
  row: number | null;
  title: string;
}

/** The one verdict, spelled the way the wire spells things. */
function duplicateReport(duplicate: ImportMatch | null): DuplicateReport | null {
  if (duplicate === null) return null;
  return {
    where: duplicate.where,
    by: duplicate.by,
    certain: duplicate.certain,
    object_id: duplicate.objectId,
    row: duplicate.row,
    title: duplicate.title,
  };
}

/** Every Paper that carries a record, which is what an arriving entry is measured against. */
async function heldWorks(root: string): Promise<HeldWork[]> {
  const held: HeldWork[] = [];
  for (const object of await listCanonicalObjects(root)) {
    if (object.type !== "source") continue;
    const reference = referenceOf(object);
    if (reference !== null) held.push({ id: object.id, title: object.title, reference });
  }
  return held;
}

/** A row as it came back from the preview, with whatever was corrected in it corrected. */
interface ReviewedEntry {
  title: string;
  reference?: unknown;
  file_hash?: string | null;
  /**
   * What the sender calls this row, if it calls it anything.
   *
   * Only the sender's own name for it is kept, and only so the receipt can say it back. A row
   * read out of a PDF stands for a file that is still sitting in somebody's folder, and once the
   * Paper exists that file has to be attached to it -- which cannot be done by counting, because
   * the receipt lists what was created and what was held back separately, and the created list
   * alone no longer lines up with the rows that were sent.
   *
   * Nothing in the workspace reads it. It is a name to hand back, not a thing to look up, so
   * what it means is entirely the sender's business and a sender with no use for it sends none.
   */
  key?: string;
}

/**
 * The most a reference file may be, in bytes.
 *
 * The same figure the `source` argument is capped at, because a file read off disk and a file
 * handed over as an argument are the same file and a person should not have to know which way
 * in they used to know whether theirs is too big. Checked before the read rather than during
 * it: a mistaken pick of a video file should cost a `stat` and not a gigabyte of memory.
 */
const MAX_REFERENCE_FILE_BYTES = 8_000_000;

/**
 * Surfaces allowed to name a file on disk.
 *
 * A path means something only on the machine the file is on, and these two are the only
 * surfaces that are a person sitting at that machine. Everything else -- an extension, the
 * local API, a model asking on somebody's behalf -- is speaking to Kiwi from outside it, where
 * a path names a file the sender cannot see, did not choose, and has no business reading. The
 * pasted-in `source` argument stays open to all of them, because that is a file they already
 * have rather than one they are asking Kiwi to go and fetch.
 */
const PATH_SURFACES: readonly OriginSurface[] = ["ui", "cli"];

/**
 * Turns the bytes of a reference file into the text of one.
 *
 * Exports arrive in whatever the exporting program felt like writing. EndNote on Windows still
 * produces UTF-16, and almost anything on Windows will put a byte order mark in front of UTF-8.
 * Read flatly as UTF-8, a UTF-16 file is unreadable noise and a marked UTF-8 RIS file loses its
 * first record, because the sniffer looks for `TY  -` at the start of a line and the mark is
 * sitting in front of it. Both are the same mistake -- reading the bytes without reading what
 * the file said the bytes were -- and both look to the person like an import that found
 * nothing in a file that plainly has something in it.
 */
const BYTE_ORDER_MARK = String.fromCodePoint(0xfeff);

function decodeReferenceFile(bytes: Buffer): string {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe)
    return bytes.subarray(2).toString("utf16le");
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    // Big-endian, which Node cannot decode directly. Swapping the pairs makes it the
    // little-endian file Node can read; an odd trailing byte is a truncated file, and the last
    // half-character is dropped rather than allowed to throw over it.
    const swapped = Buffer.from(bytes.subarray(2, bytes.length - ((bytes.length - 2) % 2)));
    swapped.swap16();
    return swapped.toString("utf16le");
  }
  const text = bytes.toString("utf8");
  return text.startsWith(BYTE_ORDER_MARK) ? text.slice(BYTE_ORDER_MARK.length) : text;
}

/**
 * Reads a reference file the caller named, rather than one it sent.
 *
 * A Zotero library of a few hundred entries is comfortably larger than a single command is
 * allowed to be, so the file that would not fit in an argument is fetched by the command
 * instead. What the renderer sends is never a path: the main process swaps a file the person
 * picked for its real location on the way past, the same way a managed asset import already
 * works, so this side sees a path only from something entitled to name one.
 */
async function readReferenceFileAt(path: string, surface: OriginSurface): Promise<string> {
  if (!PATH_SURFACES.includes(surface))
    throw new CommandError("KIWI_PATH_DENIED", "This surface cannot import a file by its path.", {
      details: { surface },
      recoveryActions: ["correct_input"],
    });

  const found = await stat(path).catch((cause: unknown) => fileUnreadable(cause));
  if (!found.isFile())
    throw new CommandError("KIWI_INVALID_ARGUMENTS", "That is a folder, not a reference file.", {
      recoveryActions: ["correct_input"],
    });
  if (found.size > MAX_REFERENCE_FILE_BYTES)
    throw new CommandError(
      "KIWI_INVALID_ARGUMENTS",
      `That file is larger than the ${MAX_REFERENCE_FILE_BYTES / 1_000_000} MB an import can read. Export the library in parts.`,
      { details: { bytes: found.size, limit: MAX_REFERENCE_FILE_BYTES }, recoveryActions: [] },
    );

  const bytes = await readFile(path).catch((cause: unknown) => fileUnreadable(cause));
  return decodeReferenceFile(bytes);
}

/** Says which of the ordinary reasons a file would not open, and keeps the path out of it. */
function fileUnreadable(cause: unknown): never {
  const code = (cause as NodeJS.ErrnoException | null)?.code;
  if (code === "ENOENT")
    throw new CommandError("KIWI_NOT_FOUND", "That file is no longer there.", {
      recoveryActions: ["correct_input"],
    });
  if (code === "EACCES" || code === "EPERM")
    throw new CommandError("KIWI_PATH_DENIED", "Kiwi is not allowed to read that file.", {
      recoveryActions: ["retry"],
    });
  throw new CommandError("KIWI_UNAVAILABLE", "That file could not be read.", {
    recoveryActions: ["retry"],
  });
}

/**
 * Settles which of the ways in a caller used, and refuses to guess between two of them.
 *
 * Three arguments can carry a file: the text of one, the location of one, and the rows a
 * person already picked out of one. Sent two, the command has no way to tell which was meant,
 * and picking the one it likes best would quietly import the wrong file half the time.
 */
async function importSource(
  args: { source?: string; source_path?: string },
  surface: OriginSurface,
): Promise<string | null> {
  if (args.source !== undefined && args.source_path !== undefined)
    throw new CommandError(
      "KIWI_INVALID_ARGUMENTS",
      "Send the contents of the file or where it is, not both.",
      { recoveryActions: ["correct_input"] },
    );
  if (args.source !== undefined) return args.source;
  if (args.source_path !== undefined) return readReferenceFileAt(args.source_path, surface);
  return null;
}

/**
 * The rows an import is about, whichever way the caller chose to say what they were.
 *
 * Three arguments in and one list out. A file is what somebody has not read yet; rows are what
 * somebody has, either because a preview showed them or because they were read somewhere else
 * -- a folder of PDFs is opened in the window, not here, and arrives already written down.
 * Sent a file and rows at once, the command has no way to tell which was meant, so it says so
 * rather than picking one and quietly importing the wrong thing half the time.
 *
 * Both commands ask this the same way. A preview that read its argument differently from the
 * import that follows would show one thing and create another, which is the one failure this
 * whole feature exists to prevent.
 */
async function importEntries(
  args: { source?: string; source_path?: string; entries?: ReviewedEntry[] },
  surface: OriginSurface,
  nothingSent: string,
): Promise<ImportEntry[]> {
  const reviewed = args.entries;
  if (reviewed !== undefined && (args.source !== undefined || args.source_path !== undefined))
    throw new CommandError(
      "KIWI_INVALID_ARGUMENTS",
      "Send the file or the rows read out of it, not both.",
      { recoveryActions: ["correct_input"] },
    );
  if (reviewed !== undefined)
    return reviewed.map((entry, index) => ({
      // The sender's name for the row where there is one, and its position where there is not.
      // Position is what a `.bib` file has to offer and it is enough for a file, since every row
      // in one is created or held back in the order it was read.
      key: entry.key ?? `row-${index}`,
      title: entry.title,
      // Read back through `readReference` because the rows crossed a wire on the way, and a
      // field that has been past a person is still a field that has been past everything else.
      reference: readReference(entry.reference),
      fileHash: entry.file_hash ?? null,
    }));

  const source = await importSource(args, surface);
  if (source === null)
    throw new CommandError("KIWI_INVALID_ARGUMENTS", nothingSent, {
      recoveryActions: ["correct_input"],
    });
  return parseReferenceFile(source);
}

export function bibliographyCommands(deps: ObjectCommandDeps): CommandDefinition[] {
  const styleProperty = { type: "string", enum: [...CITATION_STYLES] } as const;

  const forDocument = defineCommand<{ root: string; object_id: string; style: CitationStyle }>({
    name: "kiwi.bibliography.for-document",
    summary: "Build the reference list a manuscript actually cites",
    idempotency: "idempotent",
    cancellation: "not_cancellable",
    origins: ["ui", "cli", "api"],
    argsSchema: {
      $schema: SCHEMA,
      type: "object",
      required: ["root", "object_id", "style"],
      additionalProperties: false,
      properties: { root: rootProperty, object_id: idProperty, style: styleProperty },
    },
    resultSchema: { $schema: SCHEMA, type: "object" },
    async handler(args) {
      const found = await readCanonicalObject(args.root, args.object_id);
      if (found === null)
        throw new CommandError("KIWI_NOT_FOUND", "That manuscript was not found.");

      const citedOrder = documentCitations(found.object["document"]);
      const citedCounts = documentCitationCounts(found.object["document"]);
      const objects = await listCanonicalObjects(args.root);
      const byId = new Map(objects.map((object) => [object.id, object]));

      const works: CitedWork[] = [];
      // A citation whose Paper has been deleted is the report's whole point: silently dropping
      // it would leave a manuscript citing something the reader cannot find.
      const broken: Array<{ object_id: string; reason: string }> = [];
      for (const id of citedOrder) {
        const object = byId.get(id);
        if (object === undefined) {
          broken.push({ object_id: id, reason: "deleted" });
          continue;
        }
        const reference = referenceOf(object);
        if (reference === null) {
          broken.push({ object_id: id, reason: "no_reference" });
          continue;
        }
        works.push({ id, title: object.title, reference });
      }

      const ordered = orderBibliography(works, args.style, citedOrder);
      const taken = new Set<string>();
      const entries = ordered.map((work) => {
        const key = bibtexKey(work, taken);
        taken.add(key);
        const segments = formatReferenceEntry(work, args.style);
        return {
          id: work.id,
          number: work.number,
          key,
          title: work.title,
          segments,
          text: citationText(segments),
          in_text: formatInTextCitation(work, args.style, { number: work.number }),
          // How often the manuscript cites it, not how many entries it has. A work cited
          // eleven times and one cited once are the same line in a reference list.
          count: citedCounts[work.id] ?? 0,
          incomplete: missingFields(work.reference, args.style),
          problems: validateReference(work.reference, new Date(deps.now())),
        };
      });

      // Everything in the library that this manuscript does not cite, which is what tells an
      // author whether they forgot to cite something they meant to.
      const cited = new Set(citedOrder);
      const uncited = objects
        .filter((object) => object.type === "source" && !cited.has(object.id))
        .map((object) => ({ id: object.id, title: object.title }));

      return {
        data: {
          style: args.style,
          numbered: isNumericStyle(args.style),
          entries,
          broken,
          uncited,
          bibtex: toBibtexFile(
            ordered.map((work, index): BibtexEntry => {
              const key = entries[index]?.key ?? work.id;
              return { key, title: work.title, reference: work.reference };
            }),
          ),
        },
      };
    },
  });

  /**
   * The same papers, spelled three ways.
   *
   * Which format a library leaves in is somebody else's requirement, not Kiwi's: a journal asks
   * for BibTeX, a co-author's reference manager reads RIS, and a supervisor wants a spreadsheet.
   * Choosing between them changes how the file is written and never which papers are in it.
   */
  const exportSelection = defineCommand<{
    root: string;
    object_ids?: string[];
    format?: LibraryExportFormat;
  }>({
    name: "kiwi.bibliography.export",
    summary: "Write chosen Papers as a BibTeX, RIS, or CSV file",
    idempotency: "idempotent",
    cancellation: "not_cancellable",
    origins: ["ui", "cli", "api"],
    argsSchema: {
      $schema: SCHEMA,
      type: "object",
      required: ["root"],
      additionalProperties: false,
      properties: {
        root: rootProperty,
        object_ids: { type: "array", maxItems: 5_000, items: idProperty },
        format: { type: "string", enum: [...LIBRARY_EXPORT_FORMATS] },
      },
    },
    resultSchema: { $schema: SCHEMA, type: "object" },
    async handler(args) {
      const wanted = args.object_ids === undefined ? null : new Set(args.object_ids);
      const objects = await listCanonicalObjects(args.root);
      const taken = new Set<string>();
      const entries: BibtexEntry[] = [];
      for (const object of objects) {
        if (object.type !== "source") continue;
        if (wanted !== null && !wanted.has(object.id)) continue;
        const reference = referenceOf(object);
        if (reference === null) continue;
        const key = bibtexKey({ title: object.title, reference }, taken);
        taken.add(key);
        entries.push({ key, title: object.title, reference });
      }
      const format = args.format ?? "bibtex";
      const file = libraryExportFile(format, entries);
      return {
        data: {
          format,
          text: file.text,
          extension: file.extension,
          media_type: file.mediaType,
          count: entries.length,
        },
      };
    },
  });

  const sourceProperty = { type: "string", maxLength: 8_000_000 } as const;
  const sourcePathProperty = { type: "string", minLength: 1, maxLength: 32_767 } as const;
  const entriesProperty = {
    type: "array",
    maxItems: 5_000,
    items: {
      type: "object",
      required: ["title"],
      additionalProperties: false,
      properties: {
        title: { type: "string", minLength: 1, maxLength: 2_000 },
        reference: { type: "object" },
        file_hash: { type: ["string", "null"], maxLength: 200 },
        key: { type: "string", minLength: 1, maxLength: 200 },
      },
    },
  } as const;

  /**
   * What a file would add, worked out and handed back rather than acted on.
   *
   * An import that runs and then reports has already happened; a person reading its receipt is
   * reading a decision somebody else made. This is the same work stopped one step short. The
   * file is parsed, every entry is checked against the library and against the entries above it,
   * and the rows come back to be looked at, corrected, and ticked or unticked. Nothing is
   * written, so previewing a file that turns out to be the wrong file costs nothing at all.
   *
   * The file arrives either as its text or as where it is. A library of any size is the second:
   * a few hundred entries of BibTeX is past what one command may carry, and a file the command
   * fetches for itself has no such ceiling over it.
   *
   * Rows are the third way in, and the reason for it is a folder of PDFs. Those are opened in
   * the window, because that is where a PDF renderer already lives, and what comes back is a
   * list of works with no idea whether the library already holds any of them. That question is
   * this command's to answer whatever the rows were read out of: one definition of a duplicate,
   * asked once, so that the folder and the file cannot disagree about what a second copy is.
   */
  const previewImport = defineCommand<{
    root: string;
    source?: string;
    source_path?: string;
    entries?: ReviewedEntry[];
  }>({
    name: "kiwi.bibliography.import-preview",
    summary: "Show what a reference file, or rows read out of one, would add",
    idempotency: "idempotent",
    cancellation: "not_cancellable",
    origins: ["ui", "cli", "api"],
    argsSchema: {
      $schema: SCHEMA,
      type: "object",
      required: ["root"],
      additionalProperties: false,
      properties: {
        root: rootProperty,
        source: sourceProperty,
        source_path: sourcePathProperty,
        entries: entriesProperty,
      },
    },
    resultSchema: { $schema: SCHEMA, type: "object" },
    async handler(args, context) {
      const parsed = await importEntries(
        args,
        context.origin.surface,
        "Send a file to preview, where one is, or the rows read out of one.",
      );
      if (parsed.length === 0)
        throw new CommandError("KIWI_INVALID_ARGUMENTS", "No references were found in that file.", {
          recoveryActions: ["correct_input"],
        });

      const checked = new Date(deps.now());
      return {
        data: {
          found: parsed.length,
          rows: importCandidates(parsed, await heldWorks(args.root)).map((candidate) => ({
            row: candidate.row,
            key: candidate.key,
            title: candidate.title,
            reference: candidate.reference,
            file_hash: candidate.fileHash,
            selected: candidate.selected,
            duplicate: duplicateReport(candidate.duplicate),
            // What is wrong with the record, and what the exporter left out of it, said while
            // somebody is looking at the row rather than found later in a bibliography that
            // will not format. An unusual export is then something to correct, not to refuse.
            problems: validateReference(candidate.reference, checked),
            missing: bareFields(candidate.reference),
          })),
        },
      };
    },
  });

  const importFile = defineCommand<{
    root: string;
    source?: string;
    source_path?: string;
    entries?: ReviewedEntry[];
  }>({
    name: "kiwi.bibliography.import",
    summary: "Create a Paper per entry in a reference file, or per row chosen from one",
    idempotency: "not_idempotent",
    cancellation: "not_cancellable",
    origins: ["ui", "cli", "api"],
    argsSchema: {
      $schema: SCHEMA,
      type: "object",
      required: ["root"],
      additionalProperties: false,
      properties: {
        root: rootProperty,
        source: sourceProperty,
        source_path: sourcePathProperty,
        entries: entriesProperty,
      },
    },
    resultSchema: { $schema: SCHEMA, type: "object" },
    async handler(args, context) {
      const reviewed = args.entries;
      const parsed = await importEntries(
        args,
        context.origin.surface,
        "Send a file to import, where one is, or the rows chosen from one.",
      );
      if (parsed.length === 0)
        throw new CommandError("KIWI_INVALID_ARGUMENTS", "No references were found in that file.", {
          recoveryActions: ["correct_input"],
        });

      // What the library already holds, so re-importing an overlapping export does not double
      // every paper in it. The deciding is `importCandidates`' and not this command's: the
      // folder, the dropped file and the picker all have to agree on what a duplicate is.
      const held = await heldWorks(args.root);

      // Both lists say which row they are about. The two of them together account for every row
      // that was sent, and neither of them on its own lines up with the rows in order, so a
      // caller with something still to do per row -- a file to attach to the Paper the row just
      // became -- can only find its way back by being told.
      const created: Array<{
        key: string;
        id: string;
        title: string;
        duplicate: DuplicateReport | null;
      }> = [];
      const skipped: Array<{
        key: string;
        title: string;
        reason: string;
        object_id: string | null;
      }> = [];
      for (const candidate of importCandidates(parsed, held)) {
        // A row nobody has read is held back where it looks like a copy, because there is
        // nobody to have decided otherwise. A reviewed row is created even so: it was shown
        // with what it resembled and ticked anyway, and the receipt says it went in over a
        // warning rather than pretending there was never one.
        if (reviewed === undefined && candidate.duplicate !== null) {
          skipped.push({
            key: candidate.key,
            title: candidate.title,
            reason: skipReason(candidate.duplicate),
            object_id: candidate.duplicate.objectId,
          });
          continue;
        }
        const allocated = commandIds(deps);
        const object = await createObject({
          root: args.root,
          workspaceId: commandWorkspaceId(context),
          objectId: deps.newId(),
          type: "source",
          title: candidate.title,
          content: candidate.reference.abstract ?? "",
          additionalFields: { reference: candidate.reference },
          actor: context.actor.id,
          requestId: context.requestId,
          now: deps.now(),
          ...allocated,
        }).catch(() => null);
        if (object === null) {
          skipped.push({
            key: candidate.key,
            title: candidate.title,
            reason: "rejected",
            object_id: null,
          });
          continue;
        }
        created.push({
          key: candidate.key,
          id: object.id,
          title: object.title,
          duplicate: duplicateReport(candidate.duplicate),
        });
      }

      return {
        // Reporting both is the point: an import that says "400 added" while silently
        // dropping 12 is worse than one that says 388 and 12.
        data: { created, skipped, found: parsed.length, reviewed: reviewed !== undefined },
      };
    },
  });

  return [forDocument, exportSelection, previewImport, importFile];
}
