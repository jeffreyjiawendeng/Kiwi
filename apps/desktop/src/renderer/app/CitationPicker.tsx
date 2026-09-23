import { useEffect, useId, useMemo, useState } from "react";
import {
  citationText,
  formatInTextCitation,
  readReference,
  type CitationStyle,
} from "@kiwi/contracts";
import { readBridge } from "./bridge.js";

/**
 * Choosing a Paper to cite.
 *
 * Searching the Library from inside the editor, rather than making the author leave, look up
 * a key, and come back with it. What is inserted is the link to the Paper; how it reads is
 * decided later by the style.
 */

export interface CitablePaper {
  id: string;
  title: string;
  authors: string[];
  year: number | null;
  preview: string;
}

export interface CitationPickerProps {
  workspaceId: string;
  style: CitationStyle;
  busy?: boolean;
  onInsert: (paper: CitablePaper, locator: string) => void;
  onCancel: () => void;
}

/** Every Paper in the workspace that carries enough of a record to cite. */
export async function listCitablePapers(
  workspaceId: string,
  style: CitationStyle,
): Promise<CitablePaper[]> {
  const bridge = readBridge();
  if (bridge === null) return [];
  const requestId = crypto.randomUUID();
  const result = await bridge
    .invokeCommand({
      protocol_version: "1.0.0",
      request_id: requestId,
      workspace_id: workspaceId,
      command: "kiwi.projection.list",
      args: {
        object_types: ["source"],
        text: "",
        sort: { field: "updated_at", direction: "descending" },
        page: { offset: 0, limit: 500 },
      },
    })
    .catch(() => null);
  const objects = ((result?.data ?? {})["objects"] ?? []) as Array<{
    id: string;
    title: string;
    reference?: unknown;
  }>;

  return objects.map((object) => {
    const reference = readReference(object.reference ?? {});
    return {
      id: object.id,
      title: object.title,
      authors: reference.authors,
      year: reference.year,
      preview: formatInTextCitation({ reference, title: object.title }, style, { number: 1 }),
    };
  });
}

export function CitationPicker({
  workspaceId,
  style,
  busy = false,
  onInsert,
  onCancel,
}: CitationPickerProps): React.JSX.Element {
  const [papers, setPapers] = useState<CitablePaper[] | null>(null);
  const [query, setQuery] = useState("");
  const [chosen, setChosen] = useState<string | null>(null);
  const [locator, setLocator] = useState("");
  const searchId = useId();
  const locatorId = useId();

  useEffect(() => {
    let active = true;
    void listCitablePapers(workspaceId, style).then((found) => {
      if (active) setPapers(found);
    });
    return () => {
      active = false;
    };
  }, [style, workspaceId]);

  const matching = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    const all = papers ?? [];
    if (needle === "") return all.slice(0, 50);
    return all
      .filter(
        (paper) =>
          paper.title.toLocaleLowerCase().includes(needle) ||
          paper.authors.some((name) => name.toLocaleLowerCase().includes(needle)) ||
          String(paper.year ?? "").includes(needle),
      )
      .slice(0, 50);
  }, [papers, query]);

  const selected = matching.find((paper) => paper.id === chosen) ?? matching[0] ?? null;

  return (
    <div className="citation-picker__backdrop" role="presentation">
      <section
        className="citation-picker"
        role="dialog"
        aria-modal="true"
        aria-label="Insert a citation"
        onKeyDown={(event) => {
          if (event.key === "Escape" && !busy) onCancel();
        }}
      >
        <label htmlFor={searchId}>Find a paper</label>
        <input
          id={searchId}
          type="search"
          autoFocus
          value={query}
          placeholder="Author, title, or year"
          onChange={(event) => setQuery(event.target.value)}
        />

        {papers === null ? (
          <p className="citation-picker__quiet">Reading the Library</p>
        ) : matching.length === 0 ? (
          <p className="citation-picker__quiet">
            {(papers ?? []).length === 0
              ? "There are no Papers in this project yet. Import one, and it becomes citable."
              : "Nothing here matches that."}
          </p>
        ) : (
          <ul className="citation-picker__results">
            {matching.map((paper) => (
              <li key={paper.id}>
                <button
                  type="button"
                  aria-pressed={selected?.id === paper.id}
                  className={selected?.id === paper.id ? "is-chosen" : undefined}
                  onClick={() => setChosen(paper.id)}
                >
                  <strong>{paper.title}</strong>
                  <span>
                    {paper.authors.length === 0 ? "No authors recorded" : paper.authors.join(", ")}
                    {paper.year === null ? "" : ` · ${String(paper.year)}`}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}

        <label htmlFor={locatorId}>Page or section, if you want one</label>
        <input
          id={locatorId}
          type="text"
          maxLength={80}
          value={locator}
          placeholder="p. 45"
          onChange={(event) => setLocator(event.target.value)}
        />

        {selected === null ? null : (
          <p className="citation-picker__preview">
            Will read <code>{selected.preview}</code> in this style.
          </p>
        )}

        <div className="citation-picker__actions">
          <button className="button" type="button" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
          <button
            className="button button--primary"
            type="button"
            disabled={busy || selected === null}
            onClick={() => {
              if (selected !== null) onInsert(selected, locator.trim());
            }}
          >
            Insert
          </button>
        </div>
      </section>
    </div>
  );
}

/** The reference-list entry, as the Bibliography page and the editor both show it. */
export function entryText(segments: Array<{ text: string; italic?: boolean }>): string {
  return citationText(segments);
}
