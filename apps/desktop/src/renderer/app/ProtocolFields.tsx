import { useEffect, useState } from "react";
import {
  CRITERION_KINDS,
  EXTRACTION_FIELD_TYPES,
  EXTRACTION_FIELD_TYPE_LABELS,
  HYPOTHESIS_DIRECTIONS,
  HYPOTHESIS_DIRECTION_LABELS,
  HYPOTHESIS_STATUSES,
  HYPOTHESIS_STATUS_LABELS,
  type Criterion,
  type ExtractionField,
  type ExtractionFieldType,
  type Hypothesis,
  type HypothesisDirection,
  type HypothesisStatus,
  type SubQuestion,
} from "@kiwi/contracts";
import {
  addCriterion,
  addExtractionField,
  addHypothesis,
  addSubQuestion,
  changeEntry,
  removeEntry,
} from "./protocol.js";

/**
 * The lists on the protocol page, and the two controls all of them are built from.
 *
 * Every list here holds part of one object, so none of them saves on its own: each hands the
 * whole list back to the page, which sends it against the version it was shown. That is why the
 * components take `onSave(next)` rather than a workspace and a project.
 *
 * Nothing is written while somebody is typing. A protocol saved on every keystroke would be a
 * hundred versions of one sentence in History, and the page would be arguing with itself about
 * which version it was editing. Text is saved when a field is left, which is also when somebody
 * has finished saying the thing.
 */

export function EditableText({
  value,
  label,
  onCommit,
  disabled = false,
  rows,
  placeholder,
  maxLength,
}: {
  value: string;
  /** What this field is, for anybody who cannot see the row it sits in. */
  label: string;
  onCommit: (value: string) => void;
  disabled?: boolean;
  /** A textarea when it is set, and a single line when it is not. */
  rows?: number;
  placeholder?: string;
  maxLength?: number;
}): React.JSX.Element {
  const [draft, setDraft] = useState(value);

  // The stored value moves only when a save lands, so this does not fight with typing: while a
  // field is being typed into, what it was last saved as has not changed underneath it.
  useEffect(() => setDraft(value), [value]);

  function commit(): void {
    if (draft !== value) onCommit(draft);
  }

  const shared = {
    value: draft,
    disabled,
    "aria-label": label,
    onBlur: commit,
    onChange: (event: { currentTarget: { value: string } }) => setDraft(event.currentTarget.value),
    ...(placeholder === undefined ? {} : { placeholder }),
    ...(maxLength === undefined ? {} : { maxLength }),
  };

  function keyDown(event: React.KeyboardEvent): void {
    // Escape puts back what is stored, which is the only undo a field like this can offer.
    if (event.key === "Escape") {
      event.preventDefault();
      setDraft(value);
      return;
    }
    if (event.key === "Enter" && rows === undefined) {
      event.preventDefault();
      commit();
    }
  }

  return rows === undefined ? (
    <input type="text" {...shared} onKeyDown={keyDown} />
  ) : (
    <textarea rows={rows} {...shared} onKeyDown={keyDown} />
  );
}

/**
 * The row that adds an entry to a list.
 *
 * A blank row is not a sub-question, and the protocol refuses one: every entry has to say
 * something. So the entry is typed before it exists rather than added empty and filled in, and
 * nothing reaches the store that would come straight back refused.
 */
export function AddEntry({
  label,
  placeholder,
  disabled,
  onAdd,
}: {
  label: string;
  placeholder: string;
  disabled: boolean;
  onAdd: (text: string) => void;
}): React.JSX.Element {
  const [text, setText] = useState("");

  function add(): void {
    const said = text.trim();
    if (said === "") return;
    onAdd(said);
    setText("");
  }

  return (
    <div className="protocol__add">
      <input
        type="text"
        value={text}
        aria-label={label}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(event) => setText(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          add();
        }}
      />
      <button type="button" disabled={disabled || text.trim() === ""} onClick={add}>
        Add
      </button>
    </div>
  );
}

export function SubQuestionList({
  entries,
  disabled,
  onSave,
}: {
  entries: readonly SubQuestion[];
  disabled: boolean;
  onSave: (next: SubQuestion[]) => void;
}): React.JSX.Element {
  return (
    <>
      <ul className="protocol__entries">
        {entries.map((entry) => (
          <li key={entry.id}>
            <span className="protocol__code">{entry.id}</span>
            <EditableText
              value={entry.text}
              label={`Sub-question ${entry.id}`}
              disabled={disabled}
              onCommit={(text) => onSave(changeEntry(entries, entry.id, { text }))}
            />
            <button
              type="button"
              disabled={disabled}
              onClick={() => onSave(removeEntry(entries, entry.id))}
            >
              Remove
            </button>
          </li>
        ))}
      </ul>
      <AddEntry
        label="New sub-question"
        placeholder="Another thing this project has to answer"
        disabled={disabled}
        onAdd={(text) => onSave(addSubQuestion(entries, text))}
      />
    </>
  );
}

export function HypothesisList({
  entries,
  disabled,
  onSave,
}: {
  entries: readonly Hypothesis[];
  disabled: boolean;
  onSave: (next: Hypothesis[]) => void;
}): React.JSX.Element {
  return (
    <>
      <ul className="protocol__entries">
        {entries.map((entry) => (
          <li key={entry.id}>
            <span className="protocol__code">{entry.id}</span>
            <EditableText
              value={entry.statement}
              label={`Hypothesis ${entry.id}`}
              disabled={disabled}
              onCommit={(statement) => onSave(changeEntry(entries, entry.id, { statement }))}
            />
            <select
              aria-label={`What ${entry.id} predicts`}
              value={entry.direction}
              disabled={disabled}
              onChange={(event) =>
                onSave(
                  changeEntry(entries, entry.id, {
                    direction: event.currentTarget.value as HypothesisDirection,
                  }),
                )
              }
            >
              {HYPOTHESIS_DIRECTIONS.map((direction) => (
                <option key={direction} value={direction}>
                  {HYPOTHESIS_DIRECTION_LABELS[direction]}
                </option>
              ))}
            </select>
            <select
              aria-label={`Where ${entry.id} stands`}
              value={entry.status}
              disabled={disabled}
              onChange={(event) =>
                onSave(
                  changeEntry(entries, entry.id, {
                    status: event.currentTarget.value as HypothesisStatus,
                  }),
                )
              }
            >
              {HYPOTHESIS_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {HYPOTHESIS_STATUS_LABELS[status]}
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={disabled}
              onClick={() => onSave(removeEntry(entries, entry.id))}
            >
              Remove
            </button>
          </li>
        ))}
      </ul>
      <AddEntry
        label="New hypothesis"
        placeholder="What this project expects to find"
        disabled={disabled}
        onAdd={(statement) => onSave(addHypothesis(entries, statement))}
      />
    </>
  );
}

const CRITERION_HEADINGS: Record<(typeof CRITERION_KINDS)[number], string> = {
  inclusion: "A paper is included when",
  exclusion: "A paper is excluded when",
};

/**
 * The screening rules, in the two groups a screener reads them in.
 *
 * A criterion's kind is fixed when it is added. The code says which it is -- `E3` is an exclusion
 * on its face -- and a screening decision has already recorded that code, so turning `E3` into an
 * inclusion would quietly restate every decision that named it. Moving one is removing it and
 * adding it again, which gives it a new code, and that is the truth of what happened.
 */
export function CriterionList({
  entries,
  disabled,
  onSave,
}: {
  entries: readonly Criterion[];
  disabled: boolean;
  onSave: (next: Criterion[]) => void;
}): React.JSX.Element {
  return (
    <>
      {CRITERION_KINDS.map((kind) => (
        <div key={kind} className="protocol__criteria">
          <h5>{CRITERION_HEADINGS[kind]}</h5>
          <ul className="protocol__entries">
            {entries
              .filter((entry) => entry.kind === kind)
              .map((entry) => (
                <li key={entry.id}>
                  <span className="protocol__code">{entry.code}</span>
                  <EditableText
                    value={entry.text}
                    label={`Criterion ${entry.code}`}
                    disabled={disabled}
                    onCommit={(text) => onSave(changeEntry(entries, entry.id, { text }))}
                  />
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => onSave(removeEntry(entries, entry.id))}
                  >
                    Remove
                  </button>
                </li>
              ))}
          </ul>
          <AddEntry
            label={kind === "inclusion" ? "New inclusion rule" : "New exclusion rule"}
            placeholder={kind === "inclusion" ? "It reports an outcome" : "It has no control group"}
            disabled={disabled}
            onAdd={(text) => onSave(addCriterion(entries, kind, text))}
          />
        </div>
      ))}
    </>
  );
}

/**
 * What changing a field's type takes with it.
 *
 * Only a number has a unit and only a list to choose from has choices, and the protocol refuses a
 * field that says otherwise. A text field that still carried `mg/dL` from when it was a number
 * would be a save that comes back refused for something nobody can see on the screen.
 */
function retyped(field: ExtractionField, type: ExtractionFieldType): Partial<ExtractionField> {
  return {
    type,
    allowed: type === "choice" ? field.allowed : [],
    unit: type === "number" ? field.unit : null,
  };
}

export function ExtractionList({
  entries,
  disabled,
  onSave,
}: {
  entries: readonly ExtractionField[];
  disabled: boolean;
  onSave: (next: ExtractionField[]) => void;
}): React.JSX.Element {
  return (
    <>
      <ul className="protocol__fields">
        {entries.map((field) => (
          <li key={field.id}>
            <EditableText
              value={field.name}
              label={`Field ${field.id}`}
              placeholder="Column heading"
              disabled={disabled}
              onCommit={(name) => onSave(changeEntry(entries, field.id, { name }))}
            />
            <select
              aria-label={`What ${field.name === "" ? field.id : field.name} holds`}
              value={field.type}
              disabled={disabled}
              onChange={(event) =>
                onSave(
                  changeEntry(
                    entries,
                    field.id,
                    retyped(field, event.currentTarget.value as ExtractionFieldType),
                  ),
                )
              }
            >
              {EXTRACTION_FIELD_TYPES.map((type) => (
                <option key={type} value={type}>
                  {EXTRACTION_FIELD_TYPE_LABELS[type]}
                </option>
              ))}
            </select>
            {field.type === "number" ? (
              <EditableText
                value={field.unit ?? ""}
                label={`Unit of ${field.name === "" ? field.id : field.name}`}
                placeholder="Unit"
                disabled={disabled}
                onCommit={(unit) =>
                  onSave(changeEntry(entries, field.id, { unit: unit.trim() === "" ? null : unit }))
                }
              />
            ) : null}
            {field.type === "choice" ? (
              <EditableText
                value={field.allowed.join(", ")}
                label={`Choices for ${field.name === "" ? field.id : field.name}`}
                placeholder="One, another, a third"
                disabled={disabled}
                onCommit={(allowed) =>
                  onSave(
                    changeEntry(entries, field.id, {
                      allowed: allowed
                        .split(",")
                        .map((one) => one.trim())
                        .filter((one) => one !== ""),
                    }),
                  )
                }
              />
            ) : null}
            <label className="protocol__required">
              <input
                type="checkbox"
                checked={field.required}
                disabled={disabled}
                onChange={(event) =>
                  onSave(changeEntry(entries, field.id, { required: event.currentTarget.checked }))
                }
              />
              Required
            </label>
            <button
              type="button"
              disabled={disabled}
              onClick={() => onSave(removeEntry(entries, field.id))}
            >
              Remove
            </button>
          </li>
        ))}
      </ul>
      <AddEntry
        label="New field to extract"
        placeholder="Something to record from every paper"
        disabled={disabled}
        onAdd={(name) => onSave(addExtractionField(entries, name))}
      />
    </>
  );
}
