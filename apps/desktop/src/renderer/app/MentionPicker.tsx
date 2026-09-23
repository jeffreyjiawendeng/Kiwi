import { useEffect, useId, useRef, useState } from "react";
import { MENTIONABLE_TYPES, objectTypeLabel } from "@kiwi/contracts";
import { readBridge } from "./bridge.js";

/**
 * Choosing what an `@` points at.
 *
 * Papers, notes, manuscripts, and claims in one list, because the person typing is thinking of a
 * thing rather than of which folder it is in. What is inserted is the link; the name shown is
 * read back out of the workspace every time the document is opened.
 */

export interface MentionableObject {
  id: string;
  type: string;
  title: string;
  /** The opening of the object's text, so two things with the same title are told apart. */
  preview: string;
}

export interface MentionPickerProps {
  workspaceId: string;
  /** Left out of its own list, since a note that mentions itself points at the sentence it is in. */
  excludeId?: string;
  onInsert: (object: MentionableObject) => void;
  onCancel: () => void;
}

/** The mentionable objects matching what has been typed, most recently touched first. */
export async function findMentionable(
  workspaceId: string,
  text: string,
): Promise<MentionableObject[]> {
  const bridge = readBridge();
  if (bridge === null) return [];
  const result = await bridge
    .invokeCommand({
      protocol_version: "1.0.0",
      request_id: crypto.randomUUID(),
      workspace_id: workspaceId,
      command: "kiwi.projection.list",
      args: {
        object_types: [...MENTIONABLE_TYPES],
        text,
        sort: { field: "updated_at", direction: "descending" },
        page: { offset: 0, limit: 30 },
      },
    })
    .catch(() => null);
  const objects = ((result?.data ?? {})["objects"] ?? []) as Array<{
    id: string;
    type: string;
    title: string;
    content?: string;
  }>;
  return objects.map((object) => ({
    id: object.id,
    type: object.type,
    title: object.title,
    preview: (object.content ?? "").trim().replace(/\s+/gu, " ").slice(0, 90),
  }));
}

export function MentionPicker({
  workspaceId,
  excludeId,
  onInsert,
  onCancel,
}: MentionPickerProps): React.JSX.Element {
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<MentionableObject[] | null>(null);
  const searchId = useId();
  // Answers can come back in a different order than they were asked for. The last question asked
  // is the only one whose answer is still what the person is looking at.
  const asked = useRef(0);

  useEffect(() => {
    asked.current += 1;
    const mine = asked.current;
    let active = true;
    void findMentionable(workspaceId, query.trim()).then((objects) => {
      if (!active || mine !== asked.current) return;
      setFound(objects.filter((object) => object.id !== excludeId));
    });
    return () => {
      active = false;
    };
    // Asked of the workspace on every keystroke rather than filtered in the browser: the whole
    // workspace does not fit in a list, and the projection is a local index a few feet away.
  }, [excludeId, query, workspaceId]);

  const matching = found ?? [];

  return (
    <div className="citation-picker__backdrop" role="presentation">
      <section
        className="citation-picker"
        role="dialog"
        aria-modal="true"
        aria-label="Link to something"
        onKeyDown={(event) => {
          if (event.key === "Escape") onCancel();
        }}
      >
        <label htmlFor={searchId}>Link to</label>
        <input
          id={searchId}
          type="search"
          autoFocus
          value={query}
          placeholder="A paper, a note, a manuscript, or a claim"
          onChange={(event) => setQuery(event.target.value)}
        />

        {found === null ? (
          <p className="citation-picker__quiet">Looking</p>
        ) : matching.length === 0 ? (
          <p className="citation-picker__quiet">
            {query.trim() === ""
              ? "There is nothing to link to yet. A Paper, a Note, a Manuscript, or a Claim is what an @ points at."
              : "Nothing here matches that."}
          </p>
        ) : (
          <ul className="citation-picker__results">
            {matching.map((object) => (
              <li key={object.id}>
                <button type="button" onClick={() => onInsert(object)}>
                  <strong>{object.title === "" ? "Untitled" : object.title}</strong>
                  <span>
                    {objectTypeLabel(object.type)}
                    {object.preview === "" ? "" : ` · ${object.preview}`}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="citation-picker__actions">
          <button className="button" type="button" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </section>
    </div>
  );
}
