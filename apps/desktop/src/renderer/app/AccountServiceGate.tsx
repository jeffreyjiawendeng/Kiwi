import type { RendererAccountServiceStatus } from "./bridge.js";
import { BrandMark } from "./BrandMark.js";

export interface AccountServiceGateProps {
  status: RendererAccountServiceStatus;
  retrying: boolean;
  onRetry(): void;
}

export function AccountServiceGate({
  status,
  retrying,
  onRetry,
}: AccountServiceGateProps): React.JSX.Element {
  const ready = status.status === "ready";
  return (
    <section className="account-gate" aria-labelledby="account-gate-title">
      <BrandMark className="auth__mark" />
      <p className="account-gate__eyebrow">Kiwi account</p>
      <h1 id="account-gate-title">{ready ? "Kiwi is ready" : "Kiwi is offline"}</h1>
      <p className="account-gate__message">
        {ready
          ? "Your account connection is available."
          : "Kiwi cannot reach the account service. Check your connection, then try again."}
      </p>
      <p className="account-gate__state" role="status" aria-live="polite">
        <span
          className={ready ? "status-dot status-dot--ready" : "status-dot"}
          aria-hidden="true"
        />
        {ready ? "Connected" : retrying ? "Checking connection" : "Service unavailable"}
      </p>
      {!ready ? (
        <button
          className="button button--primary"
          type="button"
          onClick={onRetry}
          disabled={retrying}
        >
          {retrying ? "Trying again..." : "Try again"}
        </button>
      ) : null}
    </section>
  );
}
