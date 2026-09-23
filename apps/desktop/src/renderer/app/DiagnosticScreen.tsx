import { readBridge, type RendererError } from "./bridge.js";

const ACTION_LABELS: Record<string, string> = {
  retry: "Restart Kiwi",
  restart_application: "Restart Kiwi",
  open_logs: "Open log folder",
  copy_diagnostic_reference: "Copy reference",
  quit: "Close window",
};

export interface DiagnosticScreenProps {
  error: RendererError;
}

export function DiagnosticScreen({ error }: DiagnosticScreenProps): React.JSX.Element {
  async function run(action: string): Promise<void> {
    if (action === "copy_diagnostic_reference") {
      await navigator.clipboard.writeText(error.correlation_id);
      return;
    }
    await readBridge()?.performRecoveryAction(action);
  }

  return (
    <section className="diagnostic" role="alert" aria-labelledby="diagnostic-title">
      <h1 className="diagnostic__title" id="diagnostic-title">
        Kiwi could not start this session
      </h1>
      <p className="diagnostic__message">{error.message}</p>

      <dl className="diagnostic__facts">
        <dt>Reference</dt>
        <dd>
          <code>{error.correlation_id}</code>
        </dd>
        <dt>Code</dt>
        <dd>
          <code>{error.code}</code>
        </dd>
      </dl>

      <p className="diagnostic__hint">
        Details stay on this computer. The log folder holds a redacted record of what happened.
      </p>

      <div className="diagnostic__actions">
        {error.recovery_actions.map((action) => (
          <button key={action} type="button" onClick={() => void run(action)}>
            {ACTION_LABELS[action] ?? action}
          </button>
        ))}
      </div>
    </section>
  );
}
