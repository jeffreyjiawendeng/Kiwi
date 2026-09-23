import { describePresence, type PresentPerson } from "./presence.js";

/**
 * Who else has this open, in the top bar.
 *
 * Nobody else here draws nothing at all. An empty slot that says "0 people" would be a permanent
 * fixture on a workspace of one, and the whole value of this row is that something appearing in
 * it means something. It is also why there is no placeholder while presence is unknown: a
 * greyed-out avatar is still an avatar, and it would be claiming somebody.
 *
 * The names carry the meaning and the colours only separate them. Eight colours cannot tell forty
 * people apart, so the label is on hover and in the accessible name, and the colour is left to do
 * the one job it is good at, which is showing at a glance that these are two different people.
 */

/** Beyond this the row stops being something you take in at a glance and becomes a count. */
const SHOWN = 3;

export function PresenceAvatars({
  people,
}: {
  people: readonly PresentPerson[];
}): React.JSX.Element | null {
  if (people.length === 0) return null;
  const shown = people.slice(0, SHOWN);
  const rest = people.length - shown.length;
  return (
    <div className="presence" role="group" aria-label={describePresence(people)}>
      {shown.map((person) => (
        <span
          key={person.userId}
          className="presence__person"
          data-unnamed={!person.named || undefined}
          style={{ backgroundColor: person.colour }}
          title={person.name}
          aria-hidden="true"
        >
          {person.initials}
        </span>
      ))}
      {rest > 0 ? (
        <span
          className="presence__more"
          title={people
            .slice(SHOWN)
            .map((person) => person.name)
            .join(", ")}
          aria-hidden="true"
        >
          +{rest}
        </span>
      ) : null}
    </div>
  );
}
