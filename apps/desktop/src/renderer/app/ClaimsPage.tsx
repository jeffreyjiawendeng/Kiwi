import { useEffect, useMemo, useRef, useState } from "react";
import {
  CLAIM_CONFIDENCES,
  CLAIM_CONFIDENCE_LABELS,
  CLAIM_LIMITS,
  CLAIM_STATUSES,
  CLAIM_STATUS_LABELS,
  EVIDENCE_STANCE_LABELS,
  claimAnswerChoices,
  objectTypeLabel,
  readClaimAnswers,
  type ClaimConfidence,
  type ClaimStatus,
  type EvidenceStance,
} from "@kiwi/contracts";
import { useProtocol } from "./protocol.js";
import {
  evidenceOf,
  standsOnNothing,
  useClaims,
  withAnswer,
  type ClaimView,
  type NewClaim,
} from "./claims.js";

/**
 * What the project asserts, and what each assertion is standing on.
 *
 * One claim to a card, with its evidence under it, rather than a table. A claim is a sentence and
 * the evidence is a list of titles, and neither of those is a cell -- a table of them would be a
 * table of two columns where one wraps to five lines.
 *
 * The list is filtered rather than sorted. Which claims are still standing on nothing is the
 * question this page exists to answer, and it is asked of the store rather than worked out from a
 * page of rows, so that the answer is the same one the rest of Kiwi would give.
 */

type StatusFilter = ClaimStatus | "";

export interface ClaimsPageProps {
  workspaceId: string;
  /** The project whose claims these are, or null for everything in the workspace. */
  projectId: string | null;
  writable: boolean;
}

export function ClaimsPage({
  workspaceId,
  projectId,
  writable,
}: ClaimsPageProps): React.JSX.Element {
  const [status, setStatus] = useState<StatusFilter>("");
  const [answers, setAnswers] = useState("");
  const [unsupportedOnly, setUnsupportedOnly] = useState(false);
  const [composing, setComposing] = useState(false);
  const composeReturnFocus = useRef<HTMLButtonElement>(null);

  const list = useClaims({
    workspaceId,
    projectId,
    status: status === "" ? null : status,
    answers: answers === "" ? null : answers,
    unsupported: unsupportedOnly,
  });

  // The protocol is read for the questions and hypotheses a claim can be written against. It is
  // only read: opening this page must not make a protocol object for a project that has none.
  const { protocol } = useProtocol({ workspaceId, projectId });
  const choices = useMemo(() => claimAnswerChoices(protocol), [protocol]);

  useEffect(() => {
    // A different project's claims are a different set of questions. The filters asked about the
    // last one go with it rather than following somebody across.
    setStatus("");
    setAnswers("");
    setUnsupportedOnly(false);
    setComposing(false);
  }, [workspaceId, projectId]);

  const unstood = list.claims.filter(standsOnNothing).length;

  async function create(input: NewClaim): Promise<boolean> {
    const made = await list.create(input);
    if (made) setComposing(false);
    return made;
  }

  function closeCompose(): void {
    setComposing(false);
    composeReturnFocus.current?.focus();
  }

  return (
    <section className="claims page-fields" aria-labelledby="claims-title">
      <div className="claims__bar" role="toolbar" aria-label="Claim controls">
        <h3 id="claims-title">
          {list.claims.length} {list.claims.length === 1 ? "claim" : "claims"}
          {unstood === 0 ? "" : `, ${unstood} standing on nothing`}
        </h3>
        <label className="claims__filter">
          Where it stands
          <select
            value={status}
            onChange={(event) => setStatus(event.currentTarget.value as StatusFilter)}
          >
            <option value="">Anywhere</option>
            {CLAIM_STATUSES.map((value) => (
              <option key={value} value={value}>
                {CLAIM_STATUS_LABELS[value]}
              </option>
            ))}
          </select>
        </label>
        <label className="claims__filter">
          Answering
          <select value={answers} onChange={(event) => setAnswers(event.currentTarget.value)}>
            <option value="">Anything</option>
            {choices.map((choice) => (
              <option key={choice.id} value={choice.id}>
                {choice.id}
              </option>
            ))}
          </select>
        </label>
        <label className="claims__filter">
          <input
            type="checkbox"
            checked={unsupportedOnly}
            onChange={(event) => setUnsupportedOnly(event.currentTarget.checked)}
          />
          Only unsupported
        </label>
        <div className="claims__spacer" />
        <button type="button" onClick={() => void list.reload()} disabled={list.busy}>
          Refresh
        </button>
        <button
          ref={composeReturnFocus}
          className="button"
          type="button"
          disabled={!writable || list.busy || projectId === null}
          onClick={() => setComposing(true)}
        >
          New claim
        </button>
      </div>

      {list.error === null ? null : (
        <p className="claims__error" role="alert">
          {list.error}
          <button type="button" onClick={list.dismissError}>
            Dismiss
          </button>
        </p>
      )}

      {list.loading ? (
        <p className="claims__quiet">Reading the claims</p>
      ) : list.claims.length === 0 ? (
        <p className="claims__quiet">
          {unsupportedOnly
            ? "Every claim here is standing on something."
            : "Nothing asserted yet. A claim is one sentence the project is prepared to defend."}
        </p>
      ) : (
        <ul className="claims__list">
          {list.claims.map((claim) => (
            <ClaimCard
              key={claim.id}
              claim={claim}
              choices={choices}
              protocolAnswers={readClaimAnswers(claim.claim, protocol)}
              writable={writable}
              busy={list.busy}
              onChange={(changes) => void list.update(claim, changes)}
              onRestance={(objectId, stance) => void list.attach(claim.id, objectId, stance)}
              onDetach={(objectId) => void list.detach(claim.id, objectId)}
            />
          ))}
        </ul>
      )}

      {composing ? (
        <NewClaimDialog
          choices={choices}
          busy={list.busy}
          onCreate={create}
          onClose={closeCompose}
        />
      ) : null}
    </section>
  );
}

type AnswerChoice = ReturnType<typeof claimAnswerChoices>[number];

function ClaimCard({
  claim,
  choices,
  protocolAnswers,
  writable,
  busy,
  onChange,
  onRestance,
  onDetach,
}: {
  claim: ClaimView;
  choices: readonly AnswerChoice[];
  protocolAnswers: ReturnType<typeof readClaimAnswers>;
  writable: boolean;
  busy: boolean;
  onChange: (changes: {
    statement?: string;
    status?: ClaimStatus;
    confidence?: ClaimConfidence;
    answers?: string[];
  }) => void;
  onRestance: (objectId: string, stance: EvidenceStance) => void;
  onDetach: (objectId: string) => void;
}): React.JSX.Element {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(claim.claim.statement);
  const statementRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (editing) statementRef.current?.focus();
  }, [editing]);

  function save(): void {
    const said = draft.trim();
    // An empty statement is not an edit, it is a claim being erased, and the command would
    // refuse it anyway. Saying nothing and closing is the same as having cancelled.
    if (said !== "" && said !== claim.claim.statement) onChange({ statement: said });
    setEditing(false);
  }

  const locked = !writable || busy;
  const supports = evidenceOf(claim, "supports");
  const contradicts = evidenceOf(claim, "contradicts");

  return (
    <li className="claims__claim" data-unsupported={standsOnNothing(claim) ? "true" : undefined}>
      <header className="claims__head">
        {editing ? (
          <textarea
            ref={statementRef}
            className="claims__statement-edit"
            value={draft}
            rows={3}
            maxLength={CLAIM_LIMITS.statement}
            disabled={busy}
            aria-label="Claim"
            onChange={(event) => setDraft(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                setDraft(claim.claim.statement);
                setEditing(false);
              }
              if (event.key === "Enter" && event.ctrlKey) {
                event.preventDefault();
                save();
              }
            }}
          />
        ) : (
          <p className="claims__statement">{claim.claim.statement}</p>
        )}
        {editing ? (
          <div className="claims__editing">
            <button type="button" disabled={busy} onClick={() => setEditing(false)}>
              Cancel
            </button>
            <button className="button" type="button" disabled={busy} onClick={save}>
              Save
            </button>
          </div>
        ) : (
          <button
            type="button"
            disabled={locked}
            onClick={() => {
              setDraft(claim.claim.statement);
              setEditing(true);
            }}
          >
            Edit
          </button>
        )}
      </header>

      <div className="claims__meta">
        <label>
          Stands
          <select
            value={claim.claim.status}
            disabled={locked}
            onChange={(event) => onChange({ status: event.currentTarget.value as ClaimStatus })}
          >
            {CLAIM_STATUSES.map((value) => (
              <option key={value} value={value}>
                {CLAIM_STATUS_LABELS[value]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Confidence
          <select
            value={claim.claim.confidence}
            disabled={locked}
            onChange={(event) =>
              onChange({ confidence: event.currentTarget.value as ClaimConfidence })
            }
          >
            {CLAIM_CONFIDENCES.map((value) => (
              <option key={value} value={value}>
                {CLAIM_CONFIDENCE_LABELS[value]}
              </option>
            ))}
          </select>
        </label>
        {standsOnNothing(claim) ? (
          <span className="claims__unstood">Nothing supports this yet</span>
        ) : null}
      </div>

      <details className="claims__answers">
        <summary>
          {protocolAnswers.length === 0
            ? "Answers nothing in the protocol"
            : `Answers ${protocolAnswers.map((answer) => answer.id).join(", ")}`}
        </summary>
        {choices.length === 0 ? (
          <p className="claims__quiet">
            The protocol has no sub-questions or hypotheses yet. Write them on the Question page and
            a claim can say which one it answers.
          </p>
        ) : (
          <ul>
            {choices.map((choice) => (
              <li key={choice.id}>
                <label>
                  <input
                    type="checkbox"
                    checked={claim.claim.answers.includes(choice.id)}
                    disabled={locked}
                    onChange={(event) => {
                      const next = withAnswer(claim, choice.id, event.currentTarget.checked);
                      if (next !== null) onChange({ answers: next });
                    }}
                  />
                  <span className="claims__answer-id">{choice.id}</span> {choice.text}
                </label>
              </li>
            ))}
          </ul>
        )}
        {protocolAnswers
          .filter((answer) => answer.missing)
          .map((answer) => (
            // The hypothesis this claim was written against has been deleted. Saying so is the
            // better of the two ways to handle it: the claim quietly answering nothing is worse.
            <p key={answer.id} className="claims__missing">
              {answer.id} is not in the protocol any more.
            </p>
          ))}
      </details>

      <EvidenceList
        heading="Supports"
        pieces={supports}
        stance="supports"
        locked={locked}
        onRestance={onRestance}
        onDetach={onDetach}
      />
      <EvidenceList
        heading="Contradicts"
        pieces={contradicts}
        stance="contradicts"
        locked={locked}
        onRestance={onRestance}
        onDetach={onDetach}
      />
    </li>
  );
}

/**
 * One side of a claim's evidence.
 *
 * The two sides are shown separately even when one of them is empty, because "nothing contradicts
 * this" is a thing worth reading, and a single mixed list makes somebody count the labels to find
 * out. Moving a piece across is one click: it is the same relation changing what it says, which
 * is what the command does with it in one transaction.
 */
function EvidenceList({
  heading,
  pieces,
  stance,
  locked,
  onRestance,
  onDetach,
}: {
  heading: string;
  pieces: ClaimView["evidence"];
  stance: EvidenceStance;
  locked: boolean;
  onRestance: (objectId: string, stance: EvidenceStance) => void;
  onDetach: (objectId: string) => void;
}): React.JSX.Element {
  const other: EvidenceStance = stance === "supports" ? "contradicts" : "supports";
  return (
    <section className="claims__evidence" aria-label={`${heading} this claim`}>
      <h4>
        {heading} <span>{pieces.length}</span>
      </h4>
      {pieces.length === 0 ? (
        <p className="claims__quiet">
          Nothing yet. Send a highlight, a note, a paper, a run, or a dataset here from where you
          were reading it.
        </p>
      ) : (
        <ul>
          {pieces.map((piece) => (
            <li key={piece.relation_id}>
              <span className="claims__kind">{objectTypeLabel(piece.object_type)}</span>
              <span className="claims__evidence-title">{piece.title}</span>
              <button
                type="button"
                disabled={locked}
                onClick={() => onRestance(piece.object_id, other)}
              >
                {EVIDENCE_STANCE_LABELS[other]} instead
              </button>
              <button type="button" disabled={locked} onClick={() => onDetach(piece.object_id)}>
                Detach
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function NewClaimDialog({
  choices,
  busy,
  onCreate,
  onClose,
}: {
  choices: readonly AnswerChoice[];
  busy: boolean;
  onCreate: (input: NewClaim) => Promise<boolean>;
  onClose: () => void;
}): React.JSX.Element {
  const [statement, setStatement] = useState("");
  const [confidence, setConfidence] = useState<ClaimConfidence>("low");
  const [answers, setAnswers] = useState<string[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const statementRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    statementRef.current?.focus();
  }, []);

  async function submit(): Promise<void> {
    if (statement.trim() === "") {
      setProblem("A claim has to assert something.");
      statementRef.current?.focus();
      return;
    }
    setProblem(null);
    // A new claim is a draft. Where it stands is what the evidence decides, and letting somebody
    // declare it supported before anything supports it is what the unsupported list is against.
    await onCreate({ statement: statement.trim(), confidence, answers });
  }

  function keyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    if (event.key === "Escape" && !busy) {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === "Enter" && event.ctrlKey && !busy) {
      event.preventDefault();
      void submit();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [
      ...(dialogRef.current?.querySelectorAll<HTMLElement>("input, textarea, select, button") ??
        []),
    ].filter((element) => !element.hasAttribute("disabled"));
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  }

  return (
    <div className="claims-dialog__backdrop">
      <div
        ref={dialogRef}
        className="claims-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-claim-title"
        onKeyDown={keyDown}
      >
        <header>
          <h3 id="new-claim-title">New claim</h3>
        </header>
        <label>
          What the project asserts
          <textarea
            ref={statementRef}
            value={statement}
            rows={4}
            maxLength={CLAIM_LIMITS.statement}
            disabled={busy}
            onChange={(event) => setStatement(event.currentTarget.value)}
          />
        </label>
        <label>
          Confidence
          <select
            value={confidence}
            disabled={busy}
            onChange={(event) => setConfidence(event.currentTarget.value as ClaimConfidence)}
          >
            {CLAIM_CONFIDENCES.map((value) => (
              <option key={value} value={value}>
                {CLAIM_CONFIDENCE_LABELS[value]}
              </option>
            ))}
          </select>
        </label>
        {choices.length === 0 ? null : (
          <fieldset className="claims-dialog__answers">
            <legend>Answers</legend>
            {choices.map((choice) => (
              <label key={choice.id}>
                <input
                  type="checkbox"
                  checked={answers.includes(choice.id)}
                  disabled={busy}
                  onChange={(event) => {
                    // Read before the updater runs: React has let go of the event by then, and
                    // the box would be asked whether it is ticked after it stopped being one.
                    const ticked = event.currentTarget.checked;
                    setAnswers((current) =>
                      ticked ? [...current, choice.id] : current.filter((id) => id !== choice.id),
                    );
                  }}
                />
                <span className="claims__answer-id">{choice.id}</span> {choice.text}
              </label>
            ))}
          </fieldset>
        )}
        {problem === null ? null : (
          <p className="claims-dialog__problem" role="alert">
            {problem}
          </p>
        )}
        <footer>
          <button type="button" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button className="button" type="button" disabled={busy} onClick={() => void submit()}>
            Add claim
          </button>
        </footer>
      </div>
    </div>
  );
}
