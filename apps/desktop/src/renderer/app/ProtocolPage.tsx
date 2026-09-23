import { useEffect, useRef, useState } from "react";
import {
  OPTIONAL_PROJECT_PAGES,
  documentText,
  type Deviation,
  type Preregistration,
  type ProjectSettings,
  type RichDocument,
} from "@kiwi/contracts";
import { readBridge } from "./bridge.js";
import {
  CriterionList,
  EditableText,
  ExtractionList,
  HypothesisList,
  SubQuestionList,
} from "./ProtocolFields.js";
import { useProtocol } from "./protocol.js";

/**
 * What the project is asking, and how it says it will answer.
 *
 * One page over one object. Each section saves the part it changed against the version the page
 * was shown, and takes back the whole protocol the write produced, so two people editing
 * different sections do not have to agree about anything except that neither is editing the same
 * one twice.
 *
 * The freeze is the point of the page. After it, every edit here is refused, and the refusal
 * arrives naming the deviation log -- so the page offers to open it rather than only saying no.
 * There is no unfreeze, and this page does not pretend otherwise.
 */

/** A day, in the reader's own format, or the stored text when it is not a day at all. */
function day(at: string): string {
  const date = new Date(at);
  return Number.isNaN(date.valueOf()) ? at : date.toLocaleDateString();
}

/**
 * The protocol prose, as paragraphs.
 *
 * The rich editor is not wired to this block: it saves through `kiwi.object.set-document`, which
 * knows nothing about the freeze and would write straight past it. Plain paragraphs go through
 * `kiwi.protocol.update` like every other part of the protocol, and are refused with the rest.
 */
function proseDocument(text: string): RichDocument {
  const paragraphs = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => ({ type: "paragraph", content: [{ type: "text", text: line }] }));
  return { type: "doc", content: paragraphs.length === 0 ? [{ type: "paragraph" }] : paragraphs };
}

async function configureProject(args: Record<string, unknown>): Promise<boolean> {
  const bridge = readBridge();
  if (bridge === null) return false;
  const result = await bridge
    .invokeCommand({
      protocol_version: "1.0.0",
      request_id: crypto.randomUUID(),
      command: "kiwi.project.configure",
      args,
    })
    .catch(() => null);
  return result !== null && result.error === undefined;
}

export interface ProtocolPageProps {
  workspaceId: string;
  projectId: string;
  projectTitle: string;
  settings: ProjectSettings;
  projectVersion: number;
  projectHash: string;
  writable: boolean;
  /** Told when the project's pages change, so the rail redraws with the new one on it. */
  onProjectSaved: () => void;
}

export function ProtocolPage({
  workspaceId,
  projectId,
  projectTitle,
  settings,
  projectVersion,
  projectHash,
  writable,
  onProjectSaved,
}: ProtocolPageProps): React.JSX.Element {
  const page = useProtocol({ workspaceId, projectId });
  const [confirmingFreeze, setConfirmingFreeze] = useState(false);
  const [logging, setLogging] = useState(false);
  const [enabling, setEnabling] = useState(false);
  const freezeReturnFocus = useRef<HTMLButtonElement>(null);

  const protocol = page.protocol;
  /*
   * Read-only while a write is out, so two saves cannot be sent against the same version, and
   * read-only once frozen, because every edit after a freeze is refused and offering a field
   * that cannot be saved is worse than not offering it.
   *
   * The refusal still reaches this page: somebody else freezing the protocol while it is open
   * turns the next save into one, and that is the case where the way out matters, because the
   * person who typed it has no other way to keep what they wrote.
   */
  const locked = !writable || page.busy || page.frozen;
  const coding = settings.pages.includes("codebook");

  useEffect(() => {
    setConfirmingFreeze(false);
    setLogging(false);
  }, [projectId]);

  async function enableCoding(): Promise<void> {
    setEnabling(true);
    const saved = await configureProject({
      project_id: projectId,
      expected_version: projectVersion,
      expected_hash: projectHash,
      title: projectTitle,
      settings: {
        ...settings,
        // Rail order, not the order the pages were switched on, which is what Settings does too.
        pages: OPTIONAL_PROJECT_PAGES.filter(
          (entry) => entry === "codebook" || settings.pages.includes(entry),
        ),
      },
    });
    setEnabling(false);
    if (saved) onProjectSaved();
  }

  function savePreregistration(changes: Partial<Preregistration>): void {
    // All four go together: a registration with an id and no registry is nothing anybody can
    // look up, so the command takes the whole thing rather than a field at a time.
    void page.save({ preregistration: { ...protocol.preregistration, ...changes } });
  }

  return (
    <section className="protocol page-fields" aria-labelledby="protocol-title">
      <header className="protocol__header">
        <span>Question &amp; Protocol</span>
        <h3 id="protocol-title">
          {protocol.question.trim() === "" ? "What is this project asking?" : protocol.question}
        </h3>
        <div className="protocol__spacer" />
        <button type="button" disabled={page.busy} onClick={() => void page.reload()}>
          Refresh
        </button>
      </header>

      {page.frozen ? (
        <p className="protocol__frozen" role="status">
          Frozen on {day(protocol.frozen_at ?? "")}, covering version {protocol.frozen_version}.
          What it says now is what this project committed to, and the way it changes from here is a
          deviation.
        </p>
      ) : null}

      {page.error === null ? null : (
        <p className="protocol__error" role="alert">
          {page.error}
          {page.instead === "kiwi.protocol.log-deviation" ? (
            <button
              type="button"
              onClick={() => {
                page.dismissError();
                setLogging(true);
              }}
            >
              Log a deviation
            </button>
          ) : null}
          <button type="button" onClick={page.dismissError}>
            Dismiss
          </button>
        </p>
      )}

      {page.loading ? (
        <p className="protocol__quiet">Reading the protocol</p>
      ) : (
        <div className="protocol__sections">
          <section className="protocol__section" aria-labelledby="protocol-question">
            <h4 id="protocol-question">The question</h4>
            <EditableText
              value={protocol.question}
              label="The primary question"
              placeholder="The one thing this project set out to find out"
              rows={2}
              disabled={locked}
              onCommit={(question) => void page.save({ question })}
            />
            <SubQuestionList
              entries={protocol.sub_questions}
              disabled={locked}
              onSave={(sub_questions) => void page.save({ sub_questions })}
            />
          </section>

          <section className="protocol__section" aria-labelledby="protocol-hypotheses">
            <h4 id="protocol-hypotheses">Hypotheses</h4>
            <p className="protocol__quiet">
              A claim points at one of these by its number, so a number is never given to a second
              hypothesis, even after the first is deleted.
            </p>
            <HypothesisList
              entries={protocol.hypotheses}
              disabled={locked}
              onSave={(hypotheses) => void page.save({ hypotheses })}
            />
          </section>

          <section className="protocol__section" aria-labelledby="protocol-criteria">
            <h4 id="protocol-criteria">What counts as evidence</h4>
            <CriterionList
              entries={protocol.criteria}
              disabled={locked}
              onSave={(criteria) => void page.save({ criteria })}
            />
          </section>

          <section className="protocol__section" aria-labelledby="protocol-extraction">
            <h4 id="protocol-extraction">What to record from every paper</h4>
            <ExtractionList
              entries={protocol.extraction_schema}
              disabled={locked}
              onSave={(extraction_schema) => void page.save({ extraction_schema })}
            />
          </section>

          <section className="protocol__section" aria-labelledby="protocol-method">
            <h4 id="protocol-method">How it will be answered</h4>
            <EditableText
              value={protocol.method}
              label="The method"
              placeholder="How the papers will be found, screened, and read"
              rows={4}
              disabled={locked}
              onCommit={(method) => void page.save({ method })}
            />
            <EditableText
              value={documentText(protocol.document)}
              label="The protocol in full"
              placeholder="Anything the sections above do not hold"
              rows={6}
              disabled={locked}
              onCommit={(text) => void page.save({ document: proseDocument(text) })}
            />
          </section>

          <section className="protocol__section" aria-labelledby="protocol-registration">
            <h4 id="protocol-registration">Where it was registered</h4>
            <div className="protocol__registration">
              <EditableText
                value={protocol.preregistration.registry ?? ""}
                label="Registry"
                placeholder="OSF, PROSPERO"
                disabled={locked}
                onCommit={(registry) =>
                  savePreregistration({ registry: registry.trim() === "" ? null : registry })
                }
              />
              <EditableText
                value={protocol.preregistration.id ?? ""}
                label="Registration number"
                placeholder="Registration number"
                disabled={locked}
                onCommit={(id) => savePreregistration({ id: id.trim() === "" ? null : id })}
              />
              <EditableText
                value={protocol.preregistration.url ?? ""}
                label="Registration address"
                placeholder="Where it can be read"
                disabled={locked}
                onCommit={(url) => savePreregistration({ url: url.trim() === "" ? null : url })}
              />
              <label className="protocol__day">
                Registered
                <input
                  type="date"
                  value={protocol.preregistration.on ?? ""}
                  disabled={locked}
                  onChange={(event) =>
                    savePreregistration({
                      on: event.currentTarget.value === "" ? null : event.currentTarget.value,
                    })
                  }
                />
              </label>
            </div>
          </section>

          <section className="protocol__section" aria-labelledby="protocol-freeze">
            <h4 id="protocol-freeze">Committing to it</h4>
            {page.frozen ? null : confirmingFreeze ? (
              <p className="protocol__confirm" role="alert">
                Freezing cannot be undone. After it, every change to this protocol is written down
                as a deviation, with the day it happened and who approved it.
                <button
                  className="button"
                  type="button"
                  disabled={!writable || page.busy}
                  onClick={() => {
                    setConfirmingFreeze(false);
                    void page.freeze();
                  }}
                >
                  Freeze it
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setConfirmingFreeze(false);
                    freezeReturnFocus.current?.focus();
                  }}
                >
                  Not yet
                </button>
              </p>
            ) : (
              <button
                ref={freezeReturnFocus}
                className="button"
                type="button"
                disabled={!writable || page.busy}
                onClick={() => setConfirmingFreeze(true)}
              >
                Freeze this protocol
              </button>
            )}

            {protocol.deviations.length === 0 ? (
              page.frozen ? (
                <p className="protocol__quiet">Nothing has departed from it yet.</p>
              ) : null
            ) : (
              <ul className="protocol__deviations">
                {protocol.deviations.map((entry) => (
                  <li key={entry.id}>
                    <span className="protocol__code">{entry.id}</span>
                    <div>
                      <p>{entry.what}</p>
                      <p className="protocol__quiet">
                        {day(entry.on)} &middot; {entry.why} &middot; approved by{" "}
                        {entry.approved_by}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            )}

            {page.frozen ? (
              <button
                type="button"
                disabled={!writable || page.busy}
                onClick={() => setLogging(true)}
              >
                Log a deviation
              </button>
            ) : null}
          </section>

          <section className="protocol__section" aria-labelledby="protocol-coding">
            <h4 id="protocol-coding">Qualitative coding</h4>
            <p className="protocol__quiet">
              {coding
                ? "The Codebook is on the rail. It is the same switch Settings offers."
                : "Turns on the Codebook page, where the labels applied to what is read are kept."}
            </p>
            {coding ? null : (
              <button
                type="button"
                disabled={!writable || enabling}
                onClick={() => void enableCoding()}
              >
                Enable qualitative coding
              </button>
            )}
          </section>
        </div>
      )}

      {logging ? (
        <DeviationDialog
          busy={page.busy}
          onLog={async (entry) => {
            const logged = await page.logDeviation(entry);
            if (logged) setLogging(false);
            return logged;
          }}
          onClose={() => setLogging(false)}
        />
      ) : null}
    </section>
  );
}

/**
 * What departed from the frozen protocol, and who said it could.
 *
 * Every field is asked for, because a deviation that does not say why it happened or who approved
 * it is a note rather than a record. It is appended and never edited afterwards.
 */
function DeviationDialog({
  busy,
  onLog,
  onClose,
}: {
  busy: boolean;
  onLog: (entry: Omit<Deviation, "id">) => Promise<boolean>;
  onClose: () => void;
}): React.JSX.Element {
  const [on, setOn] = useState("");
  const [what, setWhat] = useState("");
  const [why, setWhy] = useState("");
  const [approvedBy, setApprovedBy] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const whatRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    whatRef.current?.focus();
  }, []);

  async function submit(): Promise<void> {
    if (on === "" || what.trim() === "" || why.trim() === "" || approvedBy.trim() === "") {
      setProblem("A deviation records what changed, when, why, and who approved it.");
      return;
    }
    setProblem(null);
    await onLog({ on, what: what.trim(), why: why.trim(), approved_by: approvedBy.trim() });
  }

  return (
    <div className="task-dialog__backdrop">
      <div
        className="task-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="deviation-title"
        onKeyDown={(event) => {
          if (event.key === "Escape" && !busy) {
            event.preventDefault();
            onClose();
          }
        }}
      >
        <header>
          <h3 id="deviation-title">Log a deviation</h3>
        </header>
        <label>
          What changed
          <textarea
            ref={whatRef}
            value={what}
            rows={2}
            disabled={busy}
            onChange={(event) => setWhat(event.currentTarget.value)}
          />
        </label>
        <label>
          When
          <input
            type="date"
            value={on}
            disabled={busy}
            onChange={(event) => setOn(event.currentTarget.value)}
          />
        </label>
        <label>
          Why
          <textarea
            value={why}
            rows={2}
            disabled={busy}
            onChange={(event) => setWhy(event.currentTarget.value)}
          />
        </label>
        <label>
          Approved by
          <input
            type="text"
            value={approvedBy}
            disabled={busy}
            onChange={(event) => setApprovedBy(event.currentTarget.value)}
          />
        </label>
        {problem === null ? null : (
          <p className="task-dialog__problem" role="alert">
            {problem}
          </p>
        )}
        <footer>
          <button type="button" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button className="button" type="button" disabled={busy} onClick={() => void submit()}>
            Log it
          </button>
        </footer>
      </div>
    </div>
  );
}
