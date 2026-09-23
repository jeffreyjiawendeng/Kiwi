import { useEffect, useState } from "react";
import {
  groupLinks,
  linkPhrase,
  objectTypeLabel,
  readObjectLinks,
  type LinkGroup,
} from "@kiwi/contracts";
import { readBridge } from "./bridge.js";

/**
 * What this draws on, and what draws on it.
 *
 * Three surfaces want this and they want the same thing: the Note page, so that thinking shows
 * what it rests on; the Library inspector, so that a paper shows what has already been made of
 * it; and the dock, for whatever is selected. They are one query read from either end, so they
 * are one component -- three near-copies would disagree within a month about what counts as a
 * link, and the first anybody would hear of it is a note that appears under a paper but not the
 * other way round.
 *
 * The index does the walking. A note quotes a highlight and the highlight is on a paper, and it
 * is the paper this names, because nobody thinks of the highlight as the thing they drew on. The
 * passage is kept beside the row -- it is what gets a reader back to the page the words are on.
 */

export interface LinksPanelProps {
  workspaceId: string;
  objectId: string;
  /**
   * Follows a link to what it points at.
   *
   * Absent where the surface has nowhere to send anyone, and a link is then a name rather than a
   * way of getting somewhere. A detached window is the case: it holds one document and no way to
   * show another.
   */
  onOpen?: (objectId: string, type: string) => void;
  /** Bumped by a surface that has just written a link, so the panel does not lag the sentence. */
  reload?: number;
}

async function findLinks(workspaceId: string, objectId: string): Promise<LinkGroup[]> {
  const bridge = readBridge();
  if (bridge === null) return [];
  const requestId = crypto.randomUUID();
  const result = await bridge.invokeCommand({
    protocol_version: "1.0.0",
    request_id: requestId,
    idempotency_key: requestId,
    workspace_id: workspaceId,
    command: "kiwi.projection.links",
    args: { object_id: objectId },
  });
  return groupLinks(readObjectLinks(result.data));
}

function Section({
  title,
  groups,
  onOpen,
}: {
  title: string;
  groups: LinkGroup[];
  onOpen: LinksPanelProps["onOpen"];
}): React.JSX.Element | null {
  // A heading over nothing is a heading that has to be read before it can be dismissed.
  if (groups.length === 0) return null;
  return (
    <div className="links__section">
      <h5>{title}</h5>
      <ul className="links__list">
        {groups.map((group) => {
          const kind = `${objectTypeLabel(group.object_type)} · ${linkPhrase(
            group.relation_type,
            group.direction,
            group.count,
          )}`;
          const inside = (
            <>
              <span className="links__title">{group.title}</span>
              <span className="links__kind">{kind}</span>
            </>
          );
          return (
            <li key={`${group.direction}-${group.relation_type}-${group.object_id}`}>
              {onOpen === undefined ? (
                <span className="links__row">{inside}</span>
              ) : (
                <button
                  type="button"
                  className="links__row links__row--open"
                  onClick={() => onOpen(group.object_id, group.object_type)}
                >
                  {inside}
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function LinksPanel({
  workspaceId,
  objectId,
  onOpen,
  reload = 0,
}: LinksPanelProps): React.JSX.Element {
  const [groups, setGroups] = useState<LinkGroup[] | null>(null);

  useEffect(() => {
    let active = true;
    setGroups(null);
    void findLinks(workspaceId, objectId)
      .then((found) => {
        if (active) setGroups(found);
      })
      .catch(() => {
        // An index that cannot be read is an empty panel rather than a broken page. Nothing here
        // is a fact somebody would act on without seeing it, so silence is the honest state.
        if (active) setGroups([]);
      });
    return () => {
      active = false;
    };
  }, [objectId, reload, workspaceId]);

  const outgoing = (groups ?? []).filter((group) => group.direction === "outgoing");
  const incoming = (groups ?? []).filter((group) => group.direction === "incoming");

  return (
    <section className="links" aria-label="Links">
      {groups === null ? (
        <p className="links__quiet">Reading the links on this</p>
      ) : groups.length === 0 ? (
        <p className="links__quiet">Nothing links to this yet.</p>
      ) : (
        <>
          <Section title="Draws on" groups={outgoing} onOpen={onOpen} />
          <Section title="Linked from" groups={incoming} onOpen={onOpen} />
        </>
      )}
    </section>
  );
}
