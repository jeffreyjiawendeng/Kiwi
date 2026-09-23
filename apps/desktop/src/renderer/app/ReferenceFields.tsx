import { useEffect, useState } from "react";
import { REFERENCE_KINDS, type Reference, type ReferenceKind } from "@kiwi/contracts";
import { readBridge } from "./bridge.js";

/** A Paper already carrying the DOI being entered. */
interface DoiMatch {
  id: string;
  title: string;
  year: number | null;
}

/** The title and year are enough to recognise a record without opening it. */
function describeMatch(match: DoiMatch): string {
  return match.year === null ? match.title : `${match.title} (${String(match.year)})`;
}

/**
 * The fields a bibliographic record is edited through.
 *
 * They live apart from any one page because the same record is corrected from two places: the
 * Paper itself, and the Bibliography page, where an entry that cannot be formatted is noticed.
 * Two forms would drift, and the one an author reached first would be the one missing a field.
 *
 * This renders the fields only. The surrounding form, its buttons, and what saving means are
 * the caller's, because they differ: one saves a Paper, the other corrects an entry and rebuilds
 * the list around it. The one exception is the DOI check below, which lives here for the same
 * reason the fields do: a duplicate noticed on one of the two forms and not the other is a
 * duplicate that depends on which door somebody came through.
 */
export function ReferenceFields({
  reference,
  onChange,
  workspaceId,
  objectId,
  disabled = false,
  idPrefix = "paper",
}: {
  reference: Reference;
  onChange(next: Reference): void;
  workspaceId: string;
  /** The Paper being edited. It is never a duplicate of itself. */
  objectId: string;
  disabled?: boolean;
  /** Two of these can be on one screen, and an id has to be unique for a label to reach it. */
  idPrefix?: string;
}): React.JSX.Element {
  const [matches, setMatches] = useState<DoiMatch[]>([]);

  // A different Paper is a different question, and an answer left over from the last one would be
  // about a record nobody is looking at any more.
  useEffect(() => {
    setMatches([]);
  }, [objectId]);

  /**
   * Who else in the library has this DOI, asked when the field is left rather than as it is typed.
   *
   * A DOI is pasted far more often than typed, and checking every keystroke would ask the
   * workspace about eleven prefixes of one number. Leaving the field is the moment the value is
   * meant to be a whole DOI.
   */
  async function checkDoi(value: string): Promise<void> {
    const bridge = readBridge();
    if (bridge === null || value.trim() === "") {
      setMatches([]);
      return;
    }
    const requestId = crypto.randomUUID();
    const result = await bridge
      .invokeCommand({
        protocol_version: "1.0.0",
        request_id: requestId,
        idempotency_key: requestId,
        workspace_id: workspaceId,
        command: "kiwi.object.doi-matches",
        args: { doi: value, object_id: objectId },
      })
      .catch(() => null);
    // A workspace that will not answer says nothing. This is a remark beside a field that saves
    // either way, and an alarm about a failed remark is worse than the silence.
    const found =
      result === null || result.error !== undefined
        ? undefined
        : ((result.data ?? {})["matches"] as DoiMatch[] | undefined);
    setMatches(found ?? []);
  }

  function field(
    label: string,
    key: keyof Reference,
    type: "text" | "number" = "text",
  ): React.JSX.Element {
    const id = `${idPrefix}-${key}`;
    const value = reference[key];
    return (
      <div className="settings-field">
        <label htmlFor={id}>{label}</label>
        <input
          id={id}
          type={type}
          value={value === null || value === undefined ? "" : String(value)}
          disabled={disabled}
          onChange={(event) => {
            const raw = event.target.value;
            onChange({
              ...reference,
              [key]:
                type === "number"
                  ? raw.trim() === ""
                    ? null
                    : Number.parseInt(raw, 10)
                  : raw === ""
                    ? null
                    : raw,
            });
          }}
        />
      </div>
    );
  }

  return (
    <>
      <div className="settings-field">
        <label htmlFor={`${idPrefix}-kind`}>Reference type</label>
        <select
          id={`${idPrefix}-kind`}
          value={reference.kind}
          disabled={disabled}
          onChange={(event) =>
            onChange({ ...reference, kind: event.target.value as ReferenceKind })
          }
        >
          {REFERENCE_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {kind.slice(0, 1).toLocaleUpperCase("en-US") + kind.slice(1)}
            </option>
          ))}
        </select>
      </div>

      <div className="settings-field">
        <label htmlFor={`${idPrefix}-authors`}>Authors</label>
        <input
          id={`${idPrefix}-authors`}
          value={reference.authors.join("; ")}
          disabled={disabled}
          placeholder="Vaswani, Ashish; Shazeer, Noam"
          onChange={(event) =>
            onChange({
              ...reference,
              // Semicolons, because a comma already separates family and given names.
              authors: event.target.value
                .split(";")
                .map((author) => author.trim())
                .filter((author) => author !== ""),
            })
          }
        />
      </div>

      {field("Journal, book, or conference", "container")}
      {field("Year", "year", "number")}
      {field("Pages", "pages")}

      <div className="settings-field">
        <label htmlFor={`${idPrefix}-doi`}>DOI</label>
        <input
          id={`${idPrefix}-doi`}
          value={reference.doi ?? ""}
          disabled={disabled}
          onChange={(event) =>
            onChange({
              ...reference,
              doi: event.target.value === "" ? null : event.target.value,
            })
          }
          onBlur={(event) => void checkDoi(event.target.value)}
        />
        {matches.length === 0 ? null : (
          // Said, not enforced. Two records under one DOI is sometimes deliberate, and a save that
          // refused would leave somebody holding the correct DOI unable to write it down.
          <p className="settings-field__hint settings-field__hint--notice" role="status">
            {matches.length === 1
              ? "Another paper in this library has this DOI"
              : `${String(matches.length)} other papers in this library have this DOI`}
            : {matches.map(describeMatch).join("; ")}. Kiwi will still save this one; it does not
            merge records.
          </p>
        )}
      </div>

      {field("Link", "url")}
      {field("Publisher", "publisher")}
    </>
  );
}
