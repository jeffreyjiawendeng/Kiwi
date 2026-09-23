import { CommandButtons, CommandCenter } from "./CommandSurfaces.js";
import { findUiCommand, type UiCommand, type UiContext } from "./commands.js";
import type { useCommandRunner } from "./useCommandRunner.js";

export interface CommandPanelProps {
  context: UiContext;
  runner: ReturnType<typeof useCommandRunner>;
  onRun: (command: UiCommand) => void;
}

export function CommandPanel({ context, runner, onRun }: CommandPanelProps): React.JSX.Element {
  return (
    <section className="commands" aria-labelledby="commands-title">
      <h2 className="commands__title" id="commands-title">
        Commands
      </h2>

      <div className="commands__surfaces">
        <CommandButtons context={context} onRun={onRun} />
      </div>

      <CommandCenter context={context} onRun={onRun} />

      <div className="commands__result" aria-live="polite">
        <CommandOutcome runner={runner} />
      </div>
    </section>
  );
}

function CommandOutcome({
  runner,
}: {
  runner: ReturnType<typeof useCommandRunner>;
}): React.JSX.Element {
  const { state } = runner;

  if (state.status === "idle") {
    return <p className="commands__status">No command has run yet.</p>;
  }

  if (state.status === "running") {
    const title = findUiCommand(state.commandId)?.title ?? state.commandId;
    return (
      <div className="commands__running">
        <p className="commands__status">
          Running {title}
          <span className="commands__spinner" aria-hidden="true" />
        </p>
        <button type="button" onClick={() => void runner.cancel()}>
          Cancel
        </button>
      </div>
    );
  }

  if (state.status === "error") {
    const problems = Object.entries(state.error.details).filter(([key]) =>
      key.startsWith("problem_"),
    );
    return (
      <div className="commands__error" role="alert">
        <p className="commands__error-message">{state.error.message}</p>
        {problems.length > 0 ? (
          <ul className="commands__problems">
            {problems.map(([key, value]) => (
              <li key={key}>{String(value)}</li>
            ))}
          </ul>
        ) : null}
        <dl className="commands__facts">
          <dt>Code</dt>
          <dd>
            <code>{state.error.code}</code>
          </dd>
          <dt>Reference</dt>
          <dd>
            <code>{state.error.correlation_id}</code>
          </dd>
        </dl>
        <button type="button" onClick={runner.reset}>
          Dismiss
        </button>
      </div>
    );
  }

  const { result } = state;
  return (
    <div className="commands__receipt">
      <dl className="commands__facts">
        <dt>Status</dt>
        <dd>
          <code>{result.status}</code>
        </dd>
        <dt>Request</dt>
        <dd>
          <code>{result.request_id}</code>
        </dd>
        {result.replayed === true ? (
          <>
            <dt>Delivery</dt>
            <dd>Replayed from an earlier receipt</dd>
          </>
        ) : null}
        {Object.entries(result.data ?? {}).map(([key, value]) => (
          <ItemRow key={key} label={key} value={value} />
        ))}
      </dl>
      <button type="button" onClick={runner.reset}>
        Clear
      </button>
    </div>
  );
}

function ItemRow({ label, value }: { label: string; value: unknown }): React.JSX.Element {
  return (
    <>
      <dt>{label}</dt>
      <dd>{typeof value === "object" ? JSON.stringify(value) : String(value)}</dd>
    </>
  );
}
