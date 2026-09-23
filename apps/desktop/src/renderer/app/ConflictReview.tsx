import { useState } from "react";
import type { ConflictReading, ConflictSide } from "./conflict-review.js";

/**
 * One conflict, laid out to be chosen between.
 *
 * The sentence comes first and the line by line last, because the sentence is what most people
 * decide on and the lines are what the careful ones check it against. Between them are the two
 * versions themselves, each with the button that keeps it directly underneath, so nobody has to
 * hold "the left one is mine" in their head while moving to a control somewhere else.
 *
 * Neither version is presented as the right one. Kiwi has no way to know which of two people meant
 * what, and a default here would be a guess wearing a recommendation's clothes.
 *
 * Keeping both is offered as a change to the same two buttons rather than as two more. Choosing a
 * version and deciding whether the other one survives are one decision made in one place, and the
 * buttons say what they will do once it is made, so nobody has to remember that a tick somewhere
 * above changed what "keep mine" means.
 */
export function ConflictReview({
  reading,
  disabled,
  onKeep,
}: {
  reading: ConflictReading;
  disabled: boolean;
  onKeep: (side: "mine" | "theirs", keepOther: boolean) => void;
}): React.JSX.Element {
  const [keepOther, setKeepOther] = useState(false);
  const sides: ConflictSide[] = [
    ...(reading.base === null ? [] : [reading.base]),
    ...(reading.mine === null ? [] : [reading.mine]),
    reading.theirs,
  ];
  // With one version there is no other one to keep, so the offer would be a control that does
  // nothing.
  const bothExist = reading.mine !== null;

  function label(side: "mine" | "theirs"): string {
    if (!keepOther)
      return side === "mine" ? "Keep mine as new version" : "Use theirs as new version";
    return side === "mine"
      ? "Keep mine, and save theirs beside it"
      : "Use theirs, and save mine beside it";
  }

  return (
    <div className="conflict-review">
      <p className="conflict-review__summary">{reading.summary}</p>

      {bothExist ? (
        <label className="conflict-review__both">
          <input
            type="checkbox"
            checked={keepOther}
            disabled={disabled}
            onChange={(event) => setKeepOther(event.currentTarget.checked)}
          />
          Keep the other version too, as a separate note beside this one
        </label>
      ) : null}

      <div className="conflict-compare">
        {sides.map((item) => (
          <article key={item.side} aria-label={item.heading}>
            <span>
              {item.heading} · version {item.version}
            </span>
            <strong>{item.title}</strong>
            <small>{item.attribution}</small>
            <p>{item.content}</p>
            {item.side === "base" ? (
              // Kept for reading, not for choosing: restoring what both people edited away from
              // would throw away two pieces of work instead of one.
              <small>Shown so you can see what changed. There is nothing to keep here.</small>
            ) : (
              <button
                type="button"
                disabled={disabled}
                onClick={() => onKeep(item.side === "mine" ? "mine" : "theirs", keepOther)}
              >
                {label(item.side === "mine" ? "mine" : "theirs")}
              </button>
            )}
          </article>
        ))}
      </div>

      {reading.titles === null ? null : (
        <div className="conflict-review__titles" data-differs={reading.titles.differs}>
          <strong>Title</strong>
          <span>{reading.titles.mine}</span>
          <span aria-label="compared with">vs</span>
          <span>{reading.titles.theirs}</span>
        </div>
      )}

      {/* A diff of two identical texts is a page of unchanged lines saying nothing. The summary
          already says they match, and both are printed above. */}
      {reading.places === 0 ? null : (
        <>
          <p className="conflict-review__legend">
            Lines marked <b data-kind="removed">−</b> are only in yours. Lines marked{" "}
            <b data-kind="added">+</b> are only in theirs.
          </p>
          <ol className="object-version-diff" aria-label="Line by line">
            {reading.lines.map((line, index) => (
              <li key={`${String(index)}-${line.kind}`} data-kind={line.kind}>
                <span aria-hidden="true">
                  {line.kind === "added" ? "+" : line.kind === "removed" ? "−" : " "}
                </span>
                <code>{line.text === "" ? " " : line.text}</code>
              </li>
            ))}
          </ol>
        </>
      )}

      {reading.simplified ? (
        <small>The line view is simplified because these versions are large.</small>
      ) : null}
    </div>
  );
}
