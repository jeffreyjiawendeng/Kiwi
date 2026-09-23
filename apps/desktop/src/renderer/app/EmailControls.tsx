import type { FormEventHandler } from "react";

export type EmailAddressKind = "personal" | "institutional";

interface EmailAddressEntryProps {
  addressId: string;
  kindId: string;
  label: string;
  address: string;
  kind: EmailAddressKind;
  invalid?: boolean;
  describedBy?: string | undefined;
  disabled?: boolean;
  onAddressChange(value: string): void;
  onKindChange(value: EmailAddressKind): void;
}

export function EmailAddressEntry({
  addressId,
  kindId,
  label,
  address,
  kind,
  invalid = false,
  describedBy,
  disabled = false,
  onAddressChange,
  onKindChange,
}: EmailAddressEntryProps): React.JSX.Element {
  return (
    <div className="email-entry">
      <label htmlFor={addressId}>{label}</label>
      <div className="email-entry__bar">
        <input
          id={addressId}
          type="email"
          autoComplete="email"
          inputMode="email"
          required
          maxLength={254}
          value={address}
          disabled={disabled}
          aria-invalid={invalid}
          aria-describedby={describedBy}
          onChange={(event) => onAddressChange(event.target.value)}
        />
        <label className="sr-only" htmlFor={kindId}>
          Address type
        </label>
        <select
          id={kindId}
          value={kind}
          disabled={disabled}
          onChange={(event) =>
            onKindChange(event.target.value === "institutional" ? "institutional" : "personal")
          }
        >
          <option value="personal">Personal</option>
          <option value="institutional">Institutional</option>
        </select>
      </div>
    </div>
  );
}

interface EmailVerificationPanelProps {
  headingId: string;
  headingLevel: "h1" | "h2";
  codeId: string;
  email: string;
  code: string;
  pending: boolean;
  invalid?: boolean;
  describedBy?: string | undefined;
  error?: string | null;
  errorId?: string;
  message?: string | null;
  maximumCodeLength?: number;
  resendAction?: { label: string; onClick(): void } | undefined;
  secondaryAction?: { label: string; onClick(): void } | undefined;
  onCodeChange(value: string): void;
  onSubmit: FormEventHandler<HTMLFormElement>;
}

export function EmailVerificationPanel({
  headingId,
  headingLevel,
  codeId,
  email,
  code,
  pending,
  invalid = false,
  describedBy,
  error = null,
  errorId,
  message = null,
  maximumCodeLength = 256,
  resendAction,
  secondaryAction,
  onCodeChange,
  onSubmit,
}: EmailVerificationPanelProps): React.JSX.Element {
  const Heading = headingLevel;
  return (
    <form className="email-verification" noValidate onSubmit={onSubmit}>
      <header className="email-verification__header">
        <Heading id={headingId}>Check your email</Heading>
        <p>Enter the verification code for {email}. If it has not arrived, send a new code.</p>
      </header>
      <div className="email-verification__field">
        <label htmlFor={codeId}>Verification code</label>
        <input
          id={codeId}
          type="text"
          autoComplete="one-time-code"
          required
          maxLength={maximumCodeLength}
          value={code}
          autoFocus
          aria-invalid={invalid}
          aria-describedby={describedBy}
          onChange={(event) => onCodeChange(event.target.value)}
        />
        {code.startsWith("KIWI-") ? (
          <p className="auth__fixture-note">The local mail fixture filled this code.</p>
        ) : null}
      </div>
      <div className="auth__feedback">
        {error !== null ? (
          <p className="auth__error" id={errorId} role="alert">
            {error}
          </p>
        ) : null}
        {message !== null ? (
          <p className="auth__message" role="status" aria-live="polite">
            {message}
          </p>
        ) : null}
      </div>
      <button
        className="button button--primary email-verification__submit"
        type="submit"
        disabled={pending}
      >
        {pending ? "Please wait..." : "Verify and continue"}
      </button>
      {resendAction === undefined ? null : (
        <button
          className="email-verification__alternate"
          type="button"
          disabled={pending}
          onClick={resendAction.onClick}
        >
          {resendAction.label}
        </button>
      )}
      {secondaryAction === undefined ? null : (
        <button
          className="email-verification__alternate"
          type="button"
          disabled={pending}
          onClick={secondaryAction.onClick}
        >
          {secondaryAction.label}
        </button>
      )}
    </form>
  );
}
