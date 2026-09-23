import { useEffect, useId, useState } from "react";
import { BrandMark } from "./BrandMark.js";
import { normalizePhone } from "@kiwi/contracts";
import {
  readBridge,
  type RendererAccountAuthResult,
  type RendererAccountIdentity,
} from "./bridge.js";
import {
  EmailAddressEntry,
  EmailVerificationPanel,
  type EmailAddressKind,
} from "./EmailControls.js";

type AuthMode = "create" | "sign_in" | "verify" | "recover" | "reset";
type AuthField =
  "given_name" | "family_name" | "phone" | "email" | "password" | "confirm_password" | "code";

export interface AccountAuthProps {
  onAuthenticated(account: RendererAccountIdentity): void;
}

function GoogleMark(): React.JSX.Element {
  return (
    <svg className="auth__google-mark" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="#4285f4"
        d="M21.6 12.23c0-.71-.06-1.4-.18-2.07H12v3.91h5.38a4.6 4.6 0 0 1-2 3.02v2.54h3.24c1.9-1.75 2.98-4.33 2.98-7.4Z"
      />
      <path
        fill="#34a853"
        d="M12 22c2.7 0 4.98-.9 6.63-2.43l-3.24-2.54c-.9.6-2.05.96-3.39.96-2.61 0-4.82-1.76-5.61-4.13H3.04v2.62A10 10 0 0 0 12 22Z"
      />
      <path
        fill="#fbbc05"
        d="M6.39 13.86A6.01 6.01 0 0 1 6.08 12c0-.65.11-1.28.31-1.86V7.52H3.04A10 10 0 0 0 2 12c0 1.61.38 3.14 1.04 4.48l3.35-2.62Z"
      />
      <path
        fill="#ea4335"
        d="M12 6.01c1.47 0 2.79.51 3.82 1.49l2.87-2.87A9.64 9.64 0 0 0 12 2a10 10 0 0 0-8.96 5.52l3.35 2.62C7.18 7.77 9.39 6.01 12 6.01Z"
      />
    </svg>
  );
}

export function AccountAuth({ onAuthenticated }: AccountAuthProps): React.JSX.Element {
  const [mode, setMode] = useState<AuthMode>("sign_in");
  const [email, setEmail] = useState("");
  const [emailKind, setEmailKind] = useState<EmailAddressKind>("personal");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [givenName, setGivenName] = useState("");
  const [familyName, setFamilyName] = useState("");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [revealPassword, setRevealPassword] = useState(false);
  const [pending, setPending] = useState(false);
  const [providerPending, setProviderPending] = useState<"google" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [invalidField, setInvalidField] = useState<AuthField | null>(null);
  const [restored, setRestored] = useState<RendererAccountIdentity | null>(null);
  const [publicLinks, setPublicLinks] = useState({ terms: false, privacy: false });
  const emailId = useId();
  const emailKindId = useId();
  const passwordId = useId();
  const confirmPasswordId = useId();
  const givenNameId = useId();
  const familyNameId = useId();
  const phoneId = useId();
  const codeId = useId();
  const passwordHelpId = useId();
  const errorId = useId();

  useEffect(() => {
    let active = true;
    const request = readBridge()?.getPublicLinks?.();
    if (request === undefined) return;
    void request
      .then((links) => {
        if (active) setPublicLinks({ terms: links.terms, privacy: links.privacy });
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  function changeMode(next: AuthMode): void {
    setMode(next);
    setPassword("");
    setConfirmPassword("");
    setCode("");
    setError(null);
    setInvalidField(null);
    setMessage(null);
    setRevealPassword(false);
  }

  async function run(
    action: () => Promise<RendererAccountAuthResult>,
    verificationMessage: string | null = null,
  ): Promise<void> {
    if (pending) return;
    setPending(true);
    setInvalidField(null);
    setError(null);
    setMessage(null);
    try {
      const result = await action();
      if (result.status === "error") {
        setPassword("");
        setError(
          result.code === "rate_limited" && result.retry_after_seconds !== undefined
            ? `${result.message} Try again in ${result.retry_after_seconds} seconds.`
            : result.message,
        );
        return;
      }
      if (result.status === "authenticated") {
        setPassword("");
        setCode("");
        if (result.deletion_cancelled === true) setRestored(result.account);
        else onAuthenticated(result.account);
        return;
      }
      if (result.status === "accepted") {
        setPassword("");
        setCode(result.fixture_code ?? "");
        setMode(result.next === "verify_email" ? "verify" : "reset");
        setMessage(
          result.next === "verify_email"
            ? verificationMessage
            : "If this address can be recovered, check it for a reset code. Delivery can take a moment.",
        );
        return;
      }
      setPassword("");
      setCode("");
      setMode("sign_in");
      setMessage("Your password was reset. Sign in with the new password.");
    } catch {
      setError("Account access is unavailable. Try again.");
    } finally {
      setPending(false);
    }
  }

  async function signInWithProvider(provider: "google"): Promise<void> {
    if (pending) return;
    let registrationProfile: { given_name: string; family_name: string; phone: string } | undefined;
    if (mode === "create") {
      if (givenName.trim().length === 0) {
        showValidation("given_name", "Enter your first name.");
        return;
      }
      if (familyName.trim().length === 0) {
        showValidation("family_name", "Enter your last name.");
        return;
      }
      if (phone.trim().length === 0) {
        showValidation("phone", "Enter your phone number.");
        return;
      }
      const normalizedPhone = normalizePhone(phone);
      if (normalizedPhone === null) {
        showValidation("phone", "Enter a valid phone number.");
        return;
      }
      registrationProfile = {
        given_name: givenName.trim().normalize("NFC"),
        family_name: familyName.trim().normalize("NFC"),
        phone: normalizedPhone,
      };
    }
    const bridge = readBridge();
    if (bridge === null) {
      setError("The desktop bridge is unavailable.");
      return;
    }
    const label = "Google";
    setPending(true);
    setProviderPending(provider);
    setError(null);
    setMessage(null);
    try {
      const result = await bridge.signInWithProvider({
        provider,
        ...(registrationProfile === undefined ? {} : { registration_profile: registrationProfile }),
      });
      if (result.status === "authenticated") {
        if (result.deletion_cancelled === true) setRestored(result.account);
        else onAuthenticated(result.account);
      } else if (result.status === "error") {
        if (result.code === "provider_cancelled") {
          setMessage(
            mode === "create"
              ? `${label} account creation was canceled.`
              : `${label} sign-in was canceled.`,
          );
        } else {
          setError(result.message);
        }
      }
    } catch {
      setError(`${label} sign-in is unavailable. Try another method.`);
    } finally {
      setPending(false);
      setProviderPending(null);
    }
  }

  async function cancelProviderSignIn(): Promise<void> {
    await readBridge()?.cancelProviderSignIn();
  }

  function clearValidation(field: AuthField): void {
    if (invalidField !== field) return;
    setInvalidField(null);
    setError(null);
  }

  function showValidation(field: AuthField, validationMessage: string): false {
    setInvalidField(field);
    setError(validationMessage);
    const id = {
      given_name: givenNameId,
      family_name: familyNameId,
      phone: phoneId,
      email: emailId,
      password: passwordId,
      confirm_password: confirmPasswordId,
      code: codeId,
    }[field];
    document.getElementById(id)?.focus();
    return false;
  }

  function validateForm(): boolean {
    if (mode === "create") {
      if (givenName.trim().length === 0)
        return showValidation("given_name", "Enter your first name.");
      if (familyName.trim().length === 0)
        return showValidation("family_name", "Enter your last name.");
      if (phone.trim().length === 0) return showValidation("phone", "Enter your phone number.");
      if (normalizePhone(phone) === null) {
        return showValidation("phone", "Enter a valid phone number.");
      }
    }
    if (mode !== "verify" && mode !== "reset") {
      if (email.trim().length === 0) return showValidation("email", "Enter your email address.");
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email.trim())) {
        return showValidation("email", "Enter a valid email address.");
      }
    }
    if ((mode === "verify" || mode === "reset") && code.trim().length === 0) {
      return showValidation(
        "code",
        mode === "verify" ? "Enter your verification code." : "Enter your reset code.",
      );
    }
    if (mode === "create" || mode === "sign_in" || mode === "reset") {
      if (password.length === 0) return showValidation("password", "Enter your password.");
      if (mode !== "sign_in" && [...password.normalize("NFC")].length < 8) {
        return showValidation(
          "password",
          "Password must be at least 8 characters long. Avoid using common or easy passwords.",
        );
      }
    }
    if (mode === "create" || mode === "reset") {
      if (confirmPassword.length === 0) {
        return showValidation("confirm_password", "Retype your password.");
      }
      if (confirmPassword !== password) {
        return showValidation("confirm_password", "The passwords do not match.");
      }
    }
    return true;
  }

  const bridge = readBridge();
  const describedBy = error === null ? undefined : errorId;
  const passwordDescription =
    mode === "sign_in"
      ? describedBy
      : error === null
        ? passwordHelpId
        : `${passwordHelpId} ${errorId}`;
  const title =
    providerPending !== null
      ? mode === "create"
        ? "Finish creating your account with Google"
        : "Finish signing in with Google"
      : mode === "create"
        ? "Create an Account"
        : mode === "sign_in"
          ? "Log In"
          : mode === "verify"
            ? "Check your email"
            : mode === "recover"
              ? "Reset your password"
              : "Choose a new password";

  if (restored !== null) {
    return (
      <section className="auth" aria-labelledby="auth-title">
        <BrandMark className="auth__mark" />
        <h1 id="auth-title">Account restored</h1>
        <p className="auth__lead">
          This account was scheduled for deletion. Signing in cancelled that request, and the
          account and its workspaces remain intact. The Security pane records the change.
        </p>
        <button
          className="button button--primary auth__control auth__submit"
          type="button"
          onClick={() => onAuthenticated(restored)}
        >
          Continue
        </button>
      </section>
    );
  }

  return (
    <section
      className={`auth${mode === "create" ? " auth--create" : ""}`}
      aria-labelledby="auth-title"
      aria-busy={pending}
    >
      <BrandMark className="auth__mark" />
      {mode === "verify" ? null : <h1 id="auth-title">{title}</h1>}
      {providerPending === null &&
      (mode === "create" || mode === "sign_in" || mode === "verify") ? null : (
        <p className="auth__lead">
          {providerPending !== null
            ? "Kiwi opened Google in your system browser. This window will continue automatically."
            : mode === "recover"
              ? "Request a code to securely replace your password."
              : `Enter the code sent to ${email}.`}
        </p>
      )}

      {providerPending !== null ? (
        <div className="auth__browser-wait" role="status" aria-live="polite">
          <span className="auth__spinner" aria-hidden="true" />
          <button className="button" type="button" onClick={() => void cancelProviderSignIn()}>
            Cancel
          </button>
        </div>
      ) : mode === "sign_in" ? (
        <>
          <button
            className="button auth__control auth__google"
            type="button"
            onClick={() => void signInWithProvider("google")}
          >
            <GoogleMark />
            Log in with Google
          </button>
          <div className="auth__divider" role="separator">
            <span>or</span>
          </div>
        </>
      ) : null}

      {providerPending === null && mode === "verify" ? (
        <EmailVerificationPanel
          headingId="auth-title"
          headingLevel="h1"
          codeId={codeId}
          email={email}
          code={code}
          pending={pending}
          invalid={invalidField === "code"}
          describedBy={describedBy}
          error={error}
          errorId={errorId}
          message={message}
          resendAction={{
            label: "Send a new code",
            onClick: () => {
              if (bridge === null) {
                setError("The desktop bridge is unavailable.");
                return;
              }
              void run(
                () => bridge.resendAccountEmailVerification({ email }),
                "A new verification code was sent.",
              );
            },
          }}
          onCodeChange={(value) => {
            setCode(value);
            clearValidation("code");
          }}
          onSubmit={(event) => {
            event.preventDefault();
            if (!validateForm()) return;
            if (bridge === null) {
              setError("The desktop bridge is unavailable.");
              return;
            }
            void run(() => bridge.verifyAccountEmail({ email, code }));
          }}
        />
      ) : providerPending === null ? (
        <form
          className="auth__form"
          noValidate
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing && event.key === "Enter") event.preventDefault();
          }}
          onSubmit={(event) => {
            event.preventDefault();
            if (!validateForm()) return;
            if (bridge === null) {
              setError("The desktop bridge is unavailable.");
              return;
            }
            if (mode === "create") {
              void run(() =>
                bridge.createPasswordAccount({
                  email,
                  email_kind: emailKind,
                  password,
                  given_name: givenName,
                  family_name: familyName,
                  phone,
                }),
              );
            } else if (mode === "sign_in") {
              void run(() => bridge.signInWithPassword({ email, password }));
            } else if (mode === "recover") {
              void run(() => bridge.requestPasswordReset({ email }));
            } else {
              void run(() => bridge.resetPassword({ email, code, new_password: password }));
            }
          }}
        >
          {mode === "create" ? (
            <div className="auth__name-row">
              <div className="auth__field">
                <label htmlFor={givenNameId}>First name</label>
                <input
                  className="auth__control"
                  id={givenNameId}
                  autoComplete="given-name"
                  required
                  maxLength={80}
                  value={givenName}
                  aria-invalid={invalidField === "given_name"}
                  aria-describedby={describedBy}
                  onChange={(event) => {
                    setGivenName(event.target.value);
                    clearValidation("given_name");
                  }}
                />
              </div>
              <div className="auth__field">
                <label htmlFor={familyNameId}>Last name</label>
                <input
                  className="auth__control"
                  id={familyNameId}
                  autoComplete="family-name"
                  required
                  maxLength={80}
                  value={familyName}
                  aria-invalid={invalidField === "family_name"}
                  aria-describedby={describedBy}
                  onChange={(event) => {
                    setFamilyName(event.target.value);
                    clearValidation("family_name");
                  }}
                />
              </div>
            </div>
          ) : null}

          {mode === "create" ? (
            <div className="auth__field">
              <label htmlFor={phoneId}>Phone number</label>
              <input
                className="auth__control"
                id={phoneId}
                type="tel"
                autoComplete="tel"
                required
                maxLength={40}
                value={phone}
                aria-invalid={invalidField === "phone"}
                aria-describedby={describedBy}
                onChange={(event) => {
                  setPhone(event.target.value);
                  clearValidation("phone");
                }}
              />
            </div>
          ) : null}

          {mode === "create" ? (
            <>
              <button
                className="button auth__control auth__google"
                type="button"
                disabled={pending}
                onClick={() => void signInWithProvider("google")}
              >
                <GoogleMark />
                Sign up with Google
              </button>
              <div className="auth__divider" role="separator">
                <span>or</span>
              </div>
            </>
          ) : null}

          {mode === "create" ? (
            <EmailAddressEntry
              addressId={emailId}
              kindId={emailKindId}
              label="Email"
              address={email}
              kind={emailKind}
              invalid={invalidField === "email"}
              describedBy={describedBy}
              disabled={pending}
              onAddressChange={(value) => {
                setEmail(value);
                clearValidation("email");
              }}
              onKindChange={setEmailKind}
            />
          ) : mode !== "reset" ? (
            <div className="auth__field">
              <label htmlFor={emailId}>Email</label>
              <input
                className="auth__control"
                id={emailId}
                type="email"
                autoComplete="email"
                inputMode="email"
                required
                maxLength={254}
                value={email}
                aria-invalid={invalidField === "email"}
                aria-describedby={describedBy}
                onChange={(event) => {
                  setEmail(event.target.value);
                  clearValidation("email");
                }}
              />
            </div>
          ) : null}

          {mode === "reset" ? (
            <div className="auth__field">
              <label htmlFor={codeId}>Reset code</label>
              <input
                className="auth__control"
                id={codeId}
                type="text"
                autoComplete="one-time-code"
                required
                maxLength={256}
                value={code}
                aria-invalid={invalidField === "code"}
                aria-describedby={describedBy}
                onChange={(event) => {
                  setCode(event.target.value);
                  clearValidation("code");
                }}
              />
              {code.startsWith("KIWI-") ? (
                <p className="auth__fixture-note">The local mail fixture filled this code.</p>
              ) : null}
            </div>
          ) : null}

          {mode === "create" || mode === "sign_in" || mode === "reset" ? (
            <div className="auth__field">
              <label htmlFor={passwordId}>{mode === "reset" ? "New password" : "Password"}</label>
              <div className="auth__password">
                <input
                  className="auth__control"
                  id={passwordId}
                  type={revealPassword ? "text" : "password"}
                  autoComplete={mode === "sign_in" ? "current-password" : "new-password"}
                  required
                  minLength={mode === "sign_in" ? undefined : 8}
                  maxLength={1024}
                  value={password}
                  aria-invalid={invalidField === "password"}
                  aria-describedby={passwordDescription}
                  onChange={(event) => {
                    setPassword(event.target.value);
                    clearValidation("password");
                    if (invalidField === "confirm_password") {
                      setInvalidField(null);
                      setError(null);
                    }
                  }}
                />
                <button
                  className="auth__reveal"
                  type="button"
                  aria-pressed={revealPassword}
                  onClick={() => setRevealPassword((visible) => !visible)}
                >
                  {revealPassword ? "Hide" : "Show"}
                </button>
              </div>
              {mode === "sign_in" ? null : (
                <p className="auth__help" id={passwordHelpId}>
                  Password must be at least 8 characters long. Avoid using common or easy passwords.
                </p>
              )}
            </div>
          ) : null}

          {mode === "create" || mode === "reset" ? (
            <div className="auth__field">
              <label htmlFor={confirmPasswordId}>Retype password</label>
              <input
                className="auth__control"
                id={confirmPasswordId}
                type="password"
                autoComplete="new-password"
                required
                minLength={8}
                maxLength={1024}
                value={confirmPassword}
                aria-invalid={invalidField === "confirm_password"}
                aria-describedby={describedBy}
                onChange={(event) => {
                  setConfirmPassword(event.target.value);
                  clearValidation("confirm_password");
                }}
              />
            </div>
          ) : null}

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
            className="button button--primary auth__control auth__submit"
            type="submit"
            disabled={pending}
          >
            {pending
              ? "Please wait..."
              : mode === "create"
                ? "Create an Account"
                : mode === "sign_in"
                  ? "Log In"
                  : mode === "recover"
                    ? "Send reset code"
                    : "Reset password"}
          </button>
        </form>
      ) : null}

      {!pending ? (
        <div className="auth__alternate">
          {mode === "create" ? (
            <div className="auth__account-switch">
              Already have an account?{" "}
              <button type="button" onClick={() => changeMode("sign_in")}>
                Sign In
              </button>
            </div>
          ) : mode === "sign_in" ? (
            <div className="auth__sign-in-links">
              <button type="button" onClick={() => changeMode("recover")}>
                Forgot Password?
              </button>
              <button type="button" onClick={() => changeMode("create")}>
                Create an Account
              </button>
            </div>
          ) : (
            <button type="button" onClick={() => changeMode("sign_in")}>
              Back to sign in
            </button>
          )}
        </div>
      ) : null}
      {(mode === "sign_in" || mode === "create") && (publicLinks.terms || publicLinks.privacy) ? (
        <nav className="auth__legal" aria-label="Legal information">
          {publicLinks.terms ? (
            <button type="button" onClick={() => void readBridge()?.openPublicLink("terms")}>
              Terms
            </button>
          ) : null}
          {publicLinks.privacy ? (
            <button type="button" onClick={() => void readBridge()?.openPublicLink("privacy")}>
              Privacy
            </button>
          ) : null}
        </nav>
      ) : null}
    </section>
  );
}
