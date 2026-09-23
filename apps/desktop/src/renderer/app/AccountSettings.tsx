import { useEffect, useId, useRef, useState } from "react";
import { deriveInitials, normalizePhone } from "@kiwi/contracts";
import {
  readBridge,
  type RendererBridge,
  type RendererAccountAuthResult,
  type RendererAccountProfile,
  type RendererAccountSettingsSnapshot,
  type RendererAccountSettingsResult,
} from "./bridge.js";
import {
  EmailAddressEntry,
  EmailVerificationPanel,
  type EmailAddressKind,
} from "./EmailControls.js";

export interface AccountSettingsProps {
  onClose(): void;
  onAccountDeletion(): void;
  onSignOut?(): void;
}

const CATEGORIES = [
  { id: "profile", label: "Profile" },
  { id: "sign-in", label: "Authentication" },
  { id: "security", label: "Security" },
  { id: "sessions", label: "Sessions" },
  { id: "notifications", label: "Notifications" },
  { id: "data", label: "Data and account removal" },
] as const;

type CategoryId = (typeof CATEGORIES)[number]["id"];

// The service records these event names. The map keeps the log readable without asking
// the service to send display text that the renderer would have to trust.
const SECURITY_EVENT_LABELS: Record<string, string> = {
  "account.created": "Account created",
  "account.email_verified": "Email address verified",
  "account.email_added": "Email address added",
  "account.additional_email_verification": "Additional email address verified",
  "account.email_verification_resent": "Email verification resent",
  "account.primary_email_changed": "Primary email address changed",
  "account.notification_email_changed": "Notification email address changed",
  "account.email_removed": "Email address removed",
  "account.session_revoked": "Device session revoked",
  "account.other_sessions_revoked": "Other device sessions revoked",
  "account.deletion_requested": "Account deletion scheduled",
  "account.signed_in": "Signed in with password",
  "account.google_sign_in": "Signed in with Google",
  "account.orcid_sign_in": "Signed in with ORCID",
  "account.password_reauthentication": "Identity confirmed with password",
  "account.google_reauthentication": "Identity confirmed with Google",
  "account.orcid_reauthentication": "Identity confirmed with ORCID",
  "account.google_link": "Google linked",
  "account.orcid_link": "ORCID linked",
  "account.google_unlink": "Google unlinked",
  "account.orcid_unlink": "ORCID unlinked",
  "account.password_reset_requested": "Password reset requested",
  "account.password_reset": "Password reset",
  "account.password_created": "Password created",
  "account.password_change": "Password changed",
  "account.password_removed": "Password removed",
  "account.deletion_cancelled": "Scheduled deletion cancelled",
  "account.data_exported": "Account data exported",
};

const SECURITY_OUTCOME_LABELS: Record<string, string> = {
  succeeded: "Succeeded",
  accepted: "Accepted",
  rejected: "Rejected",
  link_required: "Link required",
  unknown_identity: "Unrecognized identity",
  session_failed: "Session not issued",
  attention_required: "Attention required",
};

function securityEventLabel(event: string): string {
  const known = SECURITY_EVENT_LABELS[event];
  if (known !== undefined) return known;
  const match = /^account\.connection_([a-z]+)_(added|removed|reauthorization_required)$/u.exec(
    event,
  );
  if (match === null) return event;
  const provider = CONNECTED_PROVIDER_LABELS[match[1] ?? ""] ?? match[1];
  if (match[2] === "added") return `${provider} connected`;
  if (match[2] === "removed") return `${provider} disconnected`;
  return `${provider} needs authorization`;
}

const NOTIFICATION_LABELS: Record<string, { label: string; description: string }> = {
  workspace_invitations: {
    label: "Workspace invitations",
    description: "An invitation to join a workspace, and the response to one you sent.",
  },
  collaboration: {
    label: "Collaboration activity",
    description: "Comments, review requests, and mentions directed at you.",
  },
  synchronization: {
    label: "Synchronization",
    description: "Failed synchronization runs and unresolved edit conflicts.",
  },
  product: {
    label: "Product announcements",
    description: "Release notes and changes to how Kiwi works.",
  },
};

// A session list is read to answer "is that still me?", so recent activity reads better
// as elapsed time and anything older reads better as a date.
function formatMoment(value: string): string {
  const moment = new Date(value);
  if (Number.isNaN(moment.getTime())) return "at an unknown time";
  const elapsed = Date.now() - moment.getTime();
  if (elapsed < 60_000) return "just now";
  if (elapsed < 60 * 60_000) return `${Math.floor(elapsed / 60_000)} min ago`;
  if (elapsed < 24 * 60 * 60_000) return `${Math.floor(elapsed / (60 * 60_000))} h ago`;
  if (elapsed < 7 * 24 * 60 * 60_000) return `${Math.floor(elapsed / (24 * 60 * 60_000))} d ago`;
  return moment.toLocaleDateString();
}

// Connected accounts are deferred and no longer reachable from the app. These labels stay so
// that a security event recorded before the deferral still reads as words rather than an id.
const CONNECTED_PROVIDER_LABELS: Record<string, string> = {
  github: "GitHub",
  zotero: "Zotero",
  mendeley: "Mendeley",
  osf: "Open Science Framework",
  figshare: "figshare",
  zenodo: "Zenodo",
};

const SIGN_IN_METHODS = [
  {
    id: "password",
    label: "Password",
    description: "Email address and password.",
  },
  { id: "google", label: "Google", description: "Google identity via OpenID Connect." },
] as const;

type ProfileFields = Record<keyof RendererAccountProfile, string>;

const EMPTY_FIELDS: ProfileFields = {
  given_name: "",
  family_name: "",
  phone: "",
};

function toFields(profile: RendererAccountProfile): ProfileFields {
  return {
    given_name: profile.given_name ?? "",
    family_name: profile.family_name ?? "",
    phone: profile.phone ?? "",
  };
}

// Trimming happens on submit. Trimming while typing would delete the space between
// two words as soon as the user types it.
function toProfile(fields: ProfileFields): RendererAccountProfile {
  const value = (text: string): string | null => {
    const trimmed = text.trim();
    return trimmed.length === 0 ? null : trimmed;
  };
  return {
    given_name: value(fields.given_name),
    family_name: value(fields.family_name),
    phone: value(fields.phone),
  };
}

export function AccountSettings({
  onClose,
  onAccountDeletion,
  onSignOut,
}: AccountSettingsProps): React.JSX.Element {
  const [settings, setSettings] = useState<RendererAccountSettingsSnapshot | null>(null);
  const [category, setCategory] = useState<CategoryId>("profile");
  const [fields, setFields] = useState<ProfileFields>(EMPTY_FIELDS);
  const [confirmation, setConfirmation] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const givenNameId = useId();
  const familyNameId = useId();
  const phoneId = useId();
  const phoneErrorId = useId();
  const confirmationId = useId();
  const currentPasswordId = useId();
  const newAddressId = useId();
  const newAddressKindId = useId();
  const newAddressErrorId = useId();
  const emailCodeId = useId();
  const emailCodeErrorId = useId();
  const [newAddress, setNewAddress] = useState("");
  const [newAddressError, setNewAddressError] = useState<string | null>(null);
  const [newAddressKind, setNewAddressKind] = useState<EmailAddressKind>("personal");
  const [emailCode, setEmailCode] = useState("");
  const [emailCodeInvalid, setEmailCodeInvalid] = useState(false);
  const [emailNotice, setEmailNotice] = useState<string | null>(null);
  const newPasswordId = useId();
  const confirmPasswordId = useId();
  const passwordHelpId = useId();
  const passwordErrorId = useId();
  const [passwordSaved, setPasswordSaved] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [passwordInvalidField, setPasswordInvalidField] = useState<
    "current" | "new" | "confirm" | null
  >(null);
  const [revealNewPassword, setRevealNewPassword] = useState(false);
  const [exportNotice, setExportNotice] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [avatarPending, setAvatarPending] = useState(false);
  const [avatarNotice, setAvatarNotice] = useState<string | null>(null);
  const [methodPending, setMethodPending] = useState<string | null>(null);
  const [methodNotice, setMethodNotice] = useState<string | null>(null);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [reauthOpen, setReauthOpen] = useState(false);
  const [reauthPassword, setReauthPassword] = useState("");
  const [reauthPending, setReauthPending] = useState<"password" | "google" | null>(null);
  const [reauthError, setReauthError] = useState<string | null>(null);
  const reauthPasswordId = useId();
  const reauthRetry = useRef<(() => void) | null>(null);

  function requestRecentAuthentication(retry: () => void): void {
    reauthRetry.current = retry;
    setReauthPassword("");
    setReauthError(null);
    setReauthOpen(true);
  }

  function closeReauthentication(): void {
    if (reauthPending !== null) void readBridge()?.cancelProviderSignIn();
    reauthRetry.current = null;
    setReauthOpen(false);
    setReauthPassword("");
    setReauthError(null);
    setReauthPending(null);
  }

  async function confirmReauthentication(method: "password" | "google"): Promise<void> {
    const bridge = readBridge();
    if (bridge === null || reauthPending !== null) return;
    setReauthPending(method);
    setReauthError(null);
    try {
      const result =
        method === "password"
          ? await bridge.reauthenticateWithPassword({ password: reauthPassword })
          : await bridge.reauthenticateWithProvider({ provider: method });
      if (result.status === "error") {
        setReauthError(result.message);
        return;
      }
      if (result.status !== "reauthenticated") {
        setReauthError("Kiwi could not confirm this account. Try again.");
        return;
      }
      const retry = reauthRetry.current;
      reauthRetry.current = null;
      setReauthOpen(false);
      setReauthPassword("");
      setReauthError(null);
      // Let the original operation finish clearing its pending state before replaying the
      // exact closure that was refused.
      setTimeout(() => retry?.(), 0);
    } catch {
      setReauthError("The account service is unreachable.");
    } finally {
      setReauthPending(null);
    }
  }

  function selectCategory(next: CategoryId): void {
    setCategory(next);
    setSaved(false);
  }

  function showPasswordValidation(field: "current" | "new" | "confirm", message: string): void {
    setPasswordInvalidField(field);
    setPasswordError(message);
    const id =
      field === "current" ? currentPasswordId : field === "new" ? newPasswordId : confirmPasswordId;
    document.getElementById(id)?.focus();
  }

  function clearPasswordValidation(field: "current" | "new" | "confirm"): void {
    if (passwordInvalidField !== field) return;
    setPasswordInvalidField(null);
    setPasswordError(null);
  }

  async function load(): Promise<void> {
    const result = await readBridge()?.getAccountSettings();
    if (result === undefined || result.status === "error") {
      setError(result?.message ?? "The account service is unreachable.");
      return;
    }
    if (result.status === "ok") {
      setSettings(result.settings);
      setFields(toFields(result.settings.account.profile));
      setError(null);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const avatarHash = settings?.account.avatar?.content_hash ?? null;

  useEffect(() => {
    if (avatarHash === null) {
      setAvatarUrl(null);
      return;
    }
    let active = true;
    void readBridge()
      ?.readAccountAvatar()
      .then((url) => {
        if (active) setAvatarUrl(url);
      })
      .catch(() => {
        if (active) setAvatarUrl(null);
      });
    return () => {
      active = false;
    };
  }, [avatarHash]);

  // Choosing a picture opens a file dialog in the main process, so a cancelled dialog
  // returns nothing at all and must not read as a failure.
  async function changeAvatar(
    action: (bridge: RendererBridge) => Promise<RendererAccountSettingsResult | null>,
  ): Promise<void> {
    const bridge = readBridge();
    if (bridge === null || avatarPending) return;
    setAvatarPending(true);
    setAvatarNotice(null);
    try {
      const result = await action(bridge);
      if (result === null) return;
      if (result.status === "error") setAvatarNotice(result.message);
      else if (result.status === "ok") setSettings(result.settings);
    } catch {
      setAvatarNotice("The account service is unreachable.");
    } finally {
      setAvatarPending(false);
    }
  }

  async function run(
    action: () => Promise<RendererAccountSettingsResult>,
    markProfileSaved = false,
  ): Promise<void> {
    if (pending) return;
    setPending(true);
    setError(null);
    setSaved(false);
    try {
      const result = await action();
      if (result.status === "error") {
        if (result.code === "recent_auth_required") {
          requestRecentAuthentication(() => void run(action, markProfileSaved));
          return;
        }
        setError(result.message);
        if (result.code === "service_unavailable") {
          const refreshed = await readBridge()
            ?.getAccountSettings()
            .catch(() => undefined);
          if (refreshed?.status === "ok") {
            setSettings(refreshed.settings);
            setFields(toFields(refreshed.settings.account.profile));
          }
        }
      } else if (result.status === "deletion_requested") {
        onAccountDeletion();
      } else if (result.status === "ok") {
        setSettings(result.settings);
        setFields(toFields(result.settings.account.profile));
        setSaved(markProfileSaved);
      } else {
        await load();
      }
    } catch {
      setError("The account service is unreachable.");
    } finally {
      setPending(false);
    }
  }

  async function runMethod(
    provider: "google",
    action: (
      bridge: NonNullable<ReturnType<typeof readBridge>>,
    ) => Promise<RendererAccountAuthResult>,
  ): Promise<void> {
    const bridge = readBridge();
    if (bridge === null || methodPending !== null) return;
    setMethodPending(provider);
    setError(null);
    setMethodNotice(null);
    try {
      const result = await action(bridge);
      if (result.status === "error") {
        if (result.code === "recent_auth_required") {
          requestRecentAuthentication(() => void runMethod(provider, action));
          return;
        }
        setError(result.message);
      } else {
        setMethodNotice(
          result.status === "identity_unlinked"
            ? result.provider_revocation === "confirmed"
              ? "Authentication method unlinked and its provider authorization revoked."
              : result.provider_revocation === "failed"
                ? "Authentication method unlinked from Kiwi. Provider revocation could not be confirmed; review authorized applications at the provider."
                : "Authentication method unlinked from Kiwi. Review authorized applications at the provider if you also want to remove its authorization there."
            : "Authentication method linked.",
        );
        await load();
      }
    } catch {
      setError("The account service is unreachable.");
    } finally {
      setMethodPending(null);
    }
  }

  async function exportAccountData(): Promise<void> {
    const bridge = readBridge();
    if (bridge === null || exporting) return;
    setExporting(true);
    setExportNotice(null);
    try {
      const outcome = await bridge.exportAccountData();
      if (outcome.status === "written") {
        setExportNotice(`Exported to ${outcome.path}.`);
      } else if (outcome.status === "error") {
        if (outcome.code === "recent_auth_required") {
          requestRecentAuthentication(() => void exportAccountData());
          return;
        }
        setExportNotice(outcome.message);
      }
    } catch {
      setExportNotice("The account service is unreachable.");
    } finally {
      setExporting(false);
    }
  }

  function saveProfile(): void {
    const unverifiedEmail = settings?.emails.find((entry) => !entry.verified);
    if (unverifiedEmail !== undefined) {
      setError("Verify the pending email address before saving your profile.");
      document.getElementById(emailCodeId)?.focus();
      return;
    }
    if (fields.phone.trim().length > 0 && normalizePhone(fields.phone) === null) {
      setPhoneError("Enter a valid phone number.");
      document.getElementById(phoneId)?.focus();
      return;
    }
    const bridge = readBridge();
    if (bridge !== null) {
      void run(() => bridge.updateAccountProfile(toProfile(fields)), true);
    }
  }

  const hasPassword = settings?.sign_in_methods.includes("password") ?? false;
  const pendingEmail = settings?.emails.find((entry) => !entry.verified) ?? null;
  const notificationAddress =
    settings?.emails.find((entry) => entry.receives_notifications)?.address ??
    settings?.account.email ??
    "your primary address";

  return (
    <section
      className="account-settings"
      aria-labelledby="account-settings-title"
      aria-busy={pending}
    >
      <button className="account-settings__back" type="button" onClick={onClose}>
        Back to workspaces
      </button>
      <header>
        <nav className="account-settings__breadcrumb" aria-label="Settings location">
          <span>Settings</span>
          <span aria-hidden="true">&gt;</span>
          <span>User</span>
        </nav>
        <h1 id="account-settings-title">Account</h1>
        <span>Identity, authentication methods, and active devices for this account.</span>
      </header>

      {error !== null && pendingEmail === null ? (
        <p className="auth__error" role="alert">
          {error}
        </p>
      ) : null}
      {settings === null && error === null ? <p role="status">Loading account settings</p> : null}

      {settings !== null ? (
        <div className="account-settings__body">
          <nav className="account-settings__rail" aria-label="Account settings categories">
            <ul>
              {CATEGORIES.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    aria-current={item.id === category ? "page" : undefined}
                    onClick={() => selectCategory(item.id)}
                  >
                    {item.label}
                  </button>
                </li>
              ))}
            </ul>
          </nav>

          <div className="account-settings__pane">
            {category === "profile" ? (
              <section className="settings-section" aria-labelledby="profile-heading">
                <h2 id="profile-heading">Profile</h2>
                <p className="settings-section__description">
                  Your name is displayed to collaborators in shared workspaces.
                </p>
                <div className="settings-identity">
                  <button
                    className="settings-identity__avatar-button"
                    type="button"
                    aria-label={
                      settings.account.avatar === null
                        ? "Upload profile picture"
                        : "Replace profile picture"
                    }
                    disabled={pending || avatarPending}
                    onClick={() => void changeAvatar((bridge) => bridge.chooseAccountAvatar())}
                  >
                    {avatarUrl === null ? (
                      <span className="settings-identity__avatar" aria-hidden="true">
                        {deriveInitials(settings.account.display_name)}
                      </span>
                    ) : (
                      <img
                        className="settings-identity__avatar settings-identity__avatar--image"
                        src={avatarUrl}
                        alt=""
                      />
                    )}
                    <span className="settings-identity__avatar-action" aria-hidden="true">
                      <svg viewBox="0 0 16 16">
                        <path d="M3 5.5h2l1-1.5h4l1 1.5h2v6.75H3z" />
                        <circle cx="8" cy="8.75" r="2.1" />
                      </svg>
                    </span>
                  </button>
                  <span>
                    <strong>{settings.account.display_name}</strong>
                  </span>
                  <div className="settings-inline settings-identity__actions">
                    {settings.account.avatar !== null ? (
                      <button
                        className="button"
                        type="button"
                        disabled={pending || avatarPending}
                        onClick={() => void changeAvatar((bridge) => bridge.removeAccountAvatar())}
                      >
                        Remove picture
                      </button>
                    ) : null}
                    {avatarNotice !== null ? <span role="status">{avatarNotice}</span> : null}
                  </div>
                </div>
                <div
                  className="settings-profile-fields"
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                      event.preventDefault();
                      saveProfile();
                    }
                  }}
                >
                  <div className="settings-fields--split">
                    <div className="settings-field">
                      <label htmlFor={givenNameId}>First name</label>
                      <input
                        id={givenNameId}
                        autoComplete="given-name"
                        maxLength={80}
                        value={fields.given_name}
                        onChange={(event) =>
                          setFields({ ...fields, given_name: event.target.value })
                        }
                      />
                    </div>
                    <div className="settings-field">
                      <label htmlFor={familyNameId}>Last name</label>
                      <input
                        id={familyNameId}
                        autoComplete="family-name"
                        maxLength={80}
                        value={fields.family_name}
                        onChange={(event) =>
                          setFields({ ...fields, family_name: event.target.value })
                        }
                      />
                    </div>
                  </div>
                </div>
              </section>
            ) : null}

            {category === "profile" ? (
              <section className="settings-section" aria-labelledby="emails-heading">
                {pendingEmail !== null ? (
                  <EmailVerificationPanel
                    headingId="emails-heading"
                    headingLevel="h2"
                    codeId={emailCodeId}
                    email={pendingEmail.address}
                    code={emailCode}
                    pending={pending}
                    invalid={emailCodeInvalid}
                    describedBy={error === null ? undefined : emailCodeErrorId}
                    error={error}
                    errorId={emailCodeErrorId}
                    message={emailNotice}
                    maximumCodeLength={100}
                    resendAction={{
                      label: "Send a new code",
                      onClick: () => {
                        const bridge = readBridge();
                        if (bridge === null) return;
                        void run(async () => {
                          const result = await bridge.resendAccountEmail({
                            email_id: pendingEmail.id,
                          });
                          if (result.status === "ok") {
                            setEmailCode(result.email_verification?.fixture_code ?? "");
                            setEmailCodeInvalid(false);
                            setEmailNotice("A new verification code was sent.");
                          }
                          return result;
                        });
                      },
                    }}
                    secondaryAction={{
                      label: "Use a different email",
                      onClick: () => {
                        const bridge = readBridge();
                        if (bridge === null) return;
                        void run(async () => {
                          const result = await bridge.removeAccountEmail({
                            email_id: pendingEmail.id,
                          });
                          if (result.status === "ok") {
                            setEmailCode("");
                            setEmailCodeInvalid(false);
                            setEmailNotice(null);
                          }
                          return result;
                        });
                      },
                    }}
                    onCodeChange={(value) => {
                      setEmailCode(value);
                      setEmailCodeInvalid(false);
                      setEmailNotice(null);
                      setError(null);
                    }}
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (emailCode.trim().length === 0) {
                        setEmailCodeInvalid(true);
                        setError("Enter your verification code.");
                        document.getElementById(emailCodeId)?.focus();
                        return;
                      }
                      const bridge = readBridge();
                      if (bridge === null) return;
                      void run(async () => {
                        const result = await bridge.verifyAccountEmailAddress({
                          email_id: pendingEmail.id,
                          code: emailCode,
                        });
                        if (result.status === "ok") {
                          setEmailCode("");
                          setEmailCodeInvalid(false);
                          setEmailNotice(null);
                        } else if (result.status === "error") {
                          setEmailCodeInvalid(true);
                        }
                        return result;
                      });
                    }}
                  />
                ) : (
                  <>
                    <h2 id="emails-heading">Email addresses</h2>
                    <p className="settings-section__description">
                      The primary address is the one you sign in with, and it is what a password
                      reset is sent to. Kiwi sends other correspondence to the address marked for
                      notifications.
                    </p>
                    <ul className="settings-list">
                      {settings.emails.map((entry) => (
                        <li key={entry.id}>
                          <div>
                            <strong>{entry.address}</strong>
                            <span className="settings-list__meta">
                              {entry.primary ? <span className="settings-tag">Primary</span> : null}
                              {entry.kind === "institutional" ? (
                                <span className="settings-tag">Institutional</span>
                              ) : null}
                              {entry.receives_notifications ? (
                                <span className="settings-tag">Notifications</span>
                              ) : null}
                              <span className="settings-tag settings-tag--verified">Verified</span>
                            </span>
                          </div>
                          <div className="settings-inline">
                            {!entry.primary ? (
                              <button
                                className="button"
                                type="button"
                                disabled={pending}
                                onClick={() => {
                                  const bridge = readBridge();
                                  if (bridge !== null)
                                    void run(() =>
                                      bridge.promoteAccountEmail({ email_id: entry.id }),
                                    );
                                }}
                              >
                                Make primary
                              </button>
                            ) : null}
                            {!entry.receives_notifications ? (
                              <button
                                className="button"
                                type="button"
                                disabled={pending}
                                onClick={() => {
                                  const bridge = readBridge();
                                  if (bridge !== null)
                                    void run(() =>
                                      bridge.setAccountNotificationEmail({ email_id: entry.id }),
                                    );
                                }}
                              >
                                Send notifications here
                              </button>
                            ) : null}
                            {!entry.primary ? (
                              <button
                                className="button"
                                type="button"
                                disabled={pending}
                                onClick={() => {
                                  const bridge = readBridge();
                                  if (bridge !== null)
                                    void run(() =>
                                      bridge.removeAccountEmail({ email_id: entry.id }),
                                    );
                                }}
                              >
                                Remove
                              </button>
                            ) : null}
                          </div>
                        </li>
                      ))}
                    </ul>

                    {settings.emails.length < 3 ? (
                      <form
                        className="settings-form"
                        noValidate
                        onSubmit={(event) => {
                          event.preventDefault();
                          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(newAddress.trim())) {
                            setNewAddressError(
                              newAddress.trim().length === 0
                                ? "Enter an email address."
                                : "Enter a valid email address.",
                            );
                            document.getElementById(newAddressId)?.focus();
                            return;
                          }
                          const bridge = readBridge();
                          if (bridge === null) return;
                          void run(async () => {
                            const result = await bridge.addAccountEmail({
                              address: newAddress,
                              kind: newAddressKind,
                            });
                            if (result.status === "ok") {
                              setNewAddress("");
                              setNewAddressError(null);
                              setEmailCode(result.email_verification?.fixture_code ?? "");
                              setEmailNotice(null);
                            }
                            return result;
                          });
                        }}
                      >
                        <EmailAddressEntry
                          addressId={newAddressId}
                          kindId={newAddressKindId}
                          label="Add an address"
                          address={newAddress}
                          kind={newAddressKind}
                          invalid={newAddressError !== null}
                          describedBy={newAddressError === null ? undefined : newAddressErrorId}
                          disabled={pending}
                          onAddressChange={(value) => {
                            setNewAddress(value);
                            setNewAddressError(null);
                          }}
                          onKindChange={setNewAddressKind}
                        />
                        {newAddressError === null ? null : (
                          <p className="auth__error" id={newAddressErrorId} role="alert">
                            {newAddressError}
                          </p>
                        )}
                        <div className="settings-inline">
                          <button
                            className="button button--primary"
                            type="submit"
                            disabled={pending}
                          >
                            Add address
                          </button>
                        </div>
                      </form>
                    ) : (
                      <p className="settings-section__pending">
                        This account has the maximum of three email addresses.
                      </p>
                    )}
                  </>
                )}
              </section>
            ) : null}

            {category === "profile" ? (
              <section className="settings-section" aria-labelledby="contact-heading">
                <h2 id="contact-heading">Contact</h2>
                <div className="settings-field">
                  <label htmlFor={phoneId}>Phone number</label>
                  <input
                    id={phoneId}
                    type="tel"
                    autoComplete="tel"
                    maxLength={40}
                    value={fields.phone}
                    aria-invalid={phoneError !== null}
                    aria-describedby={phoneError === null ? undefined : phoneErrorId}
                    onChange={(event) => {
                      setFields({ ...fields, phone: event.target.value });
                      setPhoneError(null);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                        event.preventDefault();
                        saveProfile();
                      }
                    }}
                  />
                  {phoneError === null ? null : (
                    <p className="auth__error" id={phoneErrorId} role="alert">
                      {phoneError}
                    </p>
                  )}
                </div>
              </section>
            ) : null}

            {category === "profile" ? (
              <div className="settings-profile-actions">
                <button
                  className="button button--primary"
                  type="button"
                  disabled={pending || pendingEmail !== null}
                  onClick={saveProfile}
                >
                  Save
                </button>
                {pendingEmail !== null ? (
                  <span>Verify the pending email address before saving.</span>
                ) : saved ? (
                  <span role="status">Profile updated.</span>
                ) : null}
              </div>
            ) : null}

            {category === "sign-in" ? (
              <section className="settings-section" aria-labelledby="sign-in-heading">
                <h2 id="sign-in-heading">Authentication</h2>
                <p className="settings-section__description">
                  Google or a password opens this account from Log In. At least one of them must
                  remain configured.
                </p>
                {methodNotice !== null ? <p role="status">{methodNotice}</p> : null}
                <ul className="settings-list">
                  {SIGN_IN_METHODS.map((method) => {
                    const connected = settings.sign_in_methods.includes(method.id);
                    const logInMethodCount =
                      Number(settings.sign_in_methods.includes("password")) +
                      Number(settings.sign_in_methods.includes("google"));
                    const removable = connected && logInMethodCount > 1;
                    return (
                      <li key={method.id}>
                        <div>
                          <strong>{method.label}</strong>
                          {connected ? (
                            <span className="settings-list__meta">
                              <span className="settings-tag settings-tag--verified">Connected</span>
                            </span>
                          ) : (
                            <span>{method.description}</span>
                          )}
                        </div>
                        {method.id === "password" ? (
                          connected ? (
                            <button
                              className="button"
                              type="button"
                              aria-label="Remove password"
                              disabled={pending || !removable}
                              title={
                                removable
                                  ? undefined
                                  : "At least one authentication method must remain configured."
                              }
                              onClick={() => {
                                const bridge = readBridge();
                                if (bridge !== null) void run(() => bridge.removeAccountPassword());
                              }}
                            >
                              Remove
                            </button>
                          ) : (
                            <button
                              className="button"
                              type="button"
                              disabled={pending}
                              onClick={() => selectCategory("security")}
                            >
                              Change password
                            </button>
                          )
                        ) : connected ? (
                          <button
                            className="button"
                            type="button"
                            aria-label={`Remove ${method.label}`}
                            disabled={pending || methodPending !== null || !removable}
                            title={
                              removable
                                ? undefined
                                : "At least one authentication method must remain configured."
                            }
                            onClick={() => {
                              void runMethod(method.id, (bridge) =>
                                bridge.unlinkSignInMethod({ provider: method.id }),
                              );
                            }}
                          >
                            Remove
                          </button>
                        ) : (
                          <button
                            className="button"
                            type="button"
                            disabled={pending || methodPending !== null}
                            onClick={() => {
                              void runMethod(method.id, (bridge) =>
                                bridge.linkSignInMethod({ provider: method.id }),
                              );
                            }}
                          >
                            {methodPending === method.id ? "Awaiting authorization" : "Connect"}
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </section>
            ) : null}

            {category === "security" ? (
              <section className="settings-section" aria-labelledby="security-heading">
                <h2 id="security-heading">Change password</h2>
                <p className="settings-section__description">
                  {hasPassword
                    ? "Setting a new password ends every other signed-in session. This session stays open."
                    : "Add email and password as another way to sign in to this account."}
                </p>
                <form
                  className="settings-form"
                  noValidate
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (hasPassword && currentPassword.length === 0) {
                      showPasswordValidation("current", "Enter your current password.");
                      return;
                    }
                    if (newPassword.length === 0) {
                      showPasswordValidation("new", "Enter a new password.");
                      return;
                    }
                    if ([...newPassword.normalize("NFC")].length < 8) {
                      showPasswordValidation(
                        "new",
                        "Password must be at least 8 characters long. Avoid using common or easy passwords.",
                      );
                      return;
                    }
                    if (confirmPassword.length === 0) {
                      showPasswordValidation("confirm", "Retype your new password.");
                      return;
                    }
                    if (newPassword !== confirmPassword) {
                      showPasswordValidation("confirm", "The passwords do not match.");
                      return;
                    }
                    setPasswordInvalidField(null);
                    setPasswordError(null);
                    const bridge = readBridge();
                    if (bridge === null) return;
                    void run(async () => {
                      const result = await bridge.setAccountPassword({
                        current_password: hasPassword ? currentPassword : null,
                        new_password: newPassword,
                      });
                      if (result.status === "ok") {
                        setCurrentPassword("");
                        setNewPassword("");
                        setConfirmPassword("");
                        setPasswordSaved(true);
                        setRevealNewPassword(false);
                      }
                      return result;
                    });
                  }}
                >
                  {hasPassword ? (
                    <div className="settings-field">
                      <label htmlFor={currentPasswordId}>Current password</label>
                      <input
                        id={currentPasswordId}
                        type="password"
                        required
                        autoComplete="current-password"
                        maxLength={1024}
                        value={currentPassword}
                        aria-invalid={passwordInvalidField === "current"}
                        aria-describedby={passwordError === null ? undefined : passwordErrorId}
                        onChange={(event) => {
                          setCurrentPassword(event.target.value);
                          setPasswordSaved(false);
                          clearPasswordValidation("current");
                        }}
                      />
                    </div>
                  ) : null}
                  <div className="settings-field">
                    <label htmlFor={newPasswordId}>New password</label>
                    <div className="auth__password">
                      <input
                        id={newPasswordId}
                        type={revealNewPassword ? "text" : "password"}
                        required
                        minLength={8}
                        maxLength={1024}
                        autoComplete="new-password"
                        value={newPassword}
                        aria-invalid={passwordInvalidField === "new"}
                        aria-describedby={
                          passwordError === null
                            ? passwordHelpId
                            : `${passwordHelpId} ${passwordErrorId}`
                        }
                        onChange={(event) => {
                          setNewPassword(event.target.value);
                          setPasswordSaved(false);
                          clearPasswordValidation("new");
                        }}
                      />
                      <button
                        className="auth__reveal"
                        type="button"
                        aria-pressed={revealNewPassword}
                        onClick={() => setRevealNewPassword((visible) => !visible)}
                      >
                        {revealNewPassword ? "Hide" : "Show"}
                      </button>
                    </div>
                    <p className="settings-field__hint" id={passwordHelpId}>
                      Password must be at least 8 characters long. Avoid using common or easy
                      passwords.
                    </p>
                  </div>
                  <div className="settings-field">
                    <label htmlFor={confirmPasswordId}>Retype new password</label>
                    <input
                      id={confirmPasswordId}
                      type="password"
                      required
                      minLength={8}
                      maxLength={1024}
                      autoComplete="new-password"
                      value={confirmPassword}
                      aria-invalid={
                        passwordInvalidField === "confirm" ||
                        (confirmPassword.length > 0 && confirmPassword !== newPassword)
                      }
                      aria-describedby={passwordError === null ? undefined : passwordErrorId}
                      onChange={(event) => {
                        setConfirmPassword(event.target.value);
                        setPasswordSaved(false);
                        clearPasswordValidation("confirm");
                      }}
                    />
                    {passwordError !== null ? (
                      <p className="auth__error" id={passwordErrorId} role="alert">
                        {passwordError}
                      </p>
                    ) : confirmPassword.length > 0 && confirmPassword !== newPassword ? (
                      <p className="auth__error" role="alert">
                        The passwords do not match.
                      </p>
                    ) : null}
                  </div>
                  <div className="settings-inline">
                    <button
                      className="button button--primary"
                      type="submit"
                      disabled={
                        pending || (confirmPassword.length > 0 && newPassword !== confirmPassword)
                      }
                    >
                      Change password
                    </button>
                    {passwordSaved ? <span role="status">Password updated.</span> : null}
                  </div>
                </form>
              </section>
            ) : null}

            {category === "security" ? (
              <section className="settings-section" aria-labelledby="activity-heading">
                <h2 id="activity-heading">Recent account activity</h2>
                <p className="settings-section__description">
                  Authentication and credential events recorded for this account. Report anything
                  you do not recognize.
                </p>
                {settings.security_activity.length === 0 ? (
                  <p className="settings-section__pending">No activity has been recorded yet.</p>
                ) : (
                  <ul className="settings-list">
                    {settings.security_activity.map((entry) => (
                      <li key={entry.id}>
                        <div>
                          <strong>{securityEventLabel(entry.event)}</strong>
                          <span className="settings-list__meta">
                            <span className="settings-tag">
                              {new Date(entry.occurred_at).toLocaleString()}
                            </span>
                            <span
                              className={
                                entry.outcome === "succeeded" || entry.outcome === "accepted"
                                  ? "settings-tag settings-tag--verified"
                                  : "settings-tag"
                              }
                            >
                              {SECURITY_OUTCOME_LABELS[entry.outcome] ?? entry.outcome}
                            </span>
                          </span>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            ) : null}

            {category === "sessions" ? (
              <section className="settings-section" aria-labelledby="sessions-heading">
                <div className="settings-section__heading">
                  <div>
                    <h2 id="sessions-heading">Sessions</h2>
                    <p className="settings-section__description">
                      These devices hold an active session for this account. Last activity is when
                      the session last reached the service, not when it last signed in.
                    </p>
                  </div>
                  <div className="settings-list__actions">
                    <button
                      className="button"
                      type="button"
                      disabled={pending || settings.sessions.every((session) => session.current)}
                      onClick={() => {
                        const bridge = readBridge();
                        if (bridge !== null) void run(() => bridge.revokeOtherAccountSessions());
                      }}
                    >
                      Revoke other sessions
                    </button>
                    <button className="button" type="button" disabled={pending} onClick={onSignOut}>
                      Sign out this device
                    </button>
                  </div>
                </div>
                <ul className="session-list">
                  {settings.sessions.map((session) => (
                    <li key={session.id}>
                      <div>
                        <strong>{session.device_name}</strong>
                        <span className="settings-list__meta">
                          {session.current ? (
                            <span className="settings-tag settings-tag--verified">
                              Current device
                            </span>
                          ) : null}
                          <span className="settings-tag">
                            Last active {formatMoment(session.last_seen_at)}
                          </span>
                          <span className="settings-tag">
                            Signed in {formatMoment(session.started_at)}
                          </span>
                        </span>
                      </div>
                      {!session.current ? (
                        <button
                          className="button"
                          type="button"
                          disabled={pending}
                          onClick={() => {
                            const bridge = readBridge();
                            if (bridge !== null)
                              void run(() =>
                                bridge.revokeAccountSession({ session_id: session.id }),
                              );
                          }}
                        >
                          Revoke
                        </button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            {category === "notifications" ? (
              <section className="settings-section" aria-labelledby="notifications-heading">
                <h2 id="notifications-heading">Notifications</h2>
                <p className="settings-section__description">
                  Correspondence is delivered to {notificationAddress}. Account security notices are
                  always delivered and cannot be turned off.
                </p>
                <ul className="settings-list">
                  {settings.notifications.map((preference) => {
                    const copy = NOTIFICATION_LABELS[preference.category];
                    return (
                      <li key={preference.category}>
                        <div>
                          <strong>{copy?.label ?? preference.category}</strong>
                          {copy === undefined ? null : <span>{copy.description}</span>}
                        </div>
                        <button
                          className="settings-switch"
                          type="button"
                          role="switch"
                          aria-checked={preference.email}
                          aria-label={`Email for ${copy?.label ?? preference.category}`}
                          disabled={pending}
                          onClick={() => {
                            const bridge = readBridge();
                            if (bridge !== null)
                              void run(() =>
                                bridge.setAccountNotificationPreference({
                                  category: preference.category,
                                  email: !preference.email,
                                }),
                              );
                          }}
                        >
                          <span className="settings-switch__track" aria-hidden="true">
                            <span />
                          </span>
                          <span>{preference.email ? "On" : "Off"}</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ) : null}

            {category === "data" ? (
              <section className="settings-section" aria-labelledby="export-heading">
                <h2 id="export-heading">Export account data</h2>
                <p className="settings-section__description">
                  Kiwi writes one JSON file holding this account&apos;s profile, addresses,
                  authentication methods, sessions, security log, delivery preferences, and
                  workspace memberships. Workspace contents are exported from each workspace.
                </p>
                <div className="settings-inline">
                  <button
                    className="button"
                    type="button"
                    disabled={pending || exporting}
                    onClick={() => void exportAccountData()}
                  >
                    {exporting ? "Preparing export" : "Export account data"}
                  </button>
                  {exportNotice !== null ? <span role="status">{exportNotice}</span> : null}
                </div>
              </section>
            ) : null}

            {category === "data" ? (
              <section
                className="settings-section settings-section--danger"
                aria-labelledby="deletion-heading"
              >
                <h2 id="deletion-heading">Delete account</h2>
                <p className="settings-section__description">
                  Deletion revokes every session and begins a 30-day recovery window. Signing in
                  again during that window cancels the deletion and restores the account.
                </p>
                <ul className="settings-list">
                  <li>
                    <div>
                      <strong>Workspaces you solely own</strong>
                      <span>
                        {settings.deletion_impact.sole_owner_workspaces.length === 0
                          ? "None. No workspace depends on this account alone."
                          : `${settings.deletion_impact.sole_owner_workspaces
                              .map((workspace) => workspace.title)
                              .join(
                                ", ",
                              )}. Transfer ownership first, or these workspaces are removed with the account.`}
                      </span>
                    </div>
                  </li>
                  <li>
                    <div>
                      <strong>Workspaces you would lose access to</strong>
                      <span>{settings.deletion_impact.shared_workspaces}</span>
                    </div>
                  </li>
                  <li>
                    <div>
                      <strong>Email addresses released</strong>
                      <span>{settings.deletion_impact.addresses}</span>
                    </div>
                  </li>
                </ul>
                <label htmlFor={confirmationId}>Type DELETE to confirm</label>
                <div className="settings-inline">
                  <input
                    id={confirmationId}
                    value={confirmation}
                    onChange={(event) => setConfirmation(event.target.value)}
                  />
                  <button
                    className="button button--danger"
                    type="button"
                    disabled={pending || confirmation !== "DELETE"}
                    onClick={() => {
                      const bridge = readBridge();
                      if (bridge !== null)
                        void run(() => bridge.requestAccountDeletion({ confirmation: "DELETE" }));
                    }}
                  >
                    Request deletion
                  </button>
                </div>
              </section>
            ) : null}
          </div>
        </div>
      ) : null}
      {reauthOpen && settings !== null ? (
        <div
          className="account-reauth__backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeReauthentication();
          }}
        >
          <section
            className="account-reauth"
            role="dialog"
            aria-modal="true"
            aria-labelledby="account-reauth-title"
            aria-describedby="account-reauth-description"
            onKeyDown={(event) => {
              if (event.key === "Escape") closeReauthentication();
            }}
          >
            <span>Security check</span>
            <h2 id="account-reauth-title">Confirm it&apos;s you</h2>
            <p id="account-reauth-description">
              Confirm this account to continue the change you just requested.
            </p>
            {settings.sign_in_methods.includes("password") ? (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void confirmReauthentication("password");
                }}
              >
                <div className="settings-field">
                  <label htmlFor={reauthPasswordId}>Password</label>
                  <input
                    id={reauthPasswordId}
                    type="password"
                    autoFocus
                    required
                    autoComplete="current-password"
                    maxLength={1024}
                    value={reauthPassword}
                    disabled={reauthPending !== null}
                    onChange={(event) => {
                      setReauthPassword(event.target.value);
                      setReauthError(null);
                    }}
                  />
                </div>
                <button
                  className="button button--primary account-reauth__action"
                  type="submit"
                  disabled={reauthPending !== null || reauthPassword.length === 0}
                >
                  {reauthPending === "password" ? "Confirming" : "Continue"}
                </button>
              </form>
            ) : null}
            {settings.sign_in_methods.some((method) => method !== "password") ? (
              <div className="account-reauth__providers">
                {settings.sign_in_methods.includes("google") ? (
                  <button
                    className="button"
                    type="button"
                    disabled={reauthPending !== null}
                    onClick={() => void confirmReauthentication("google")}
                  >
                    {reauthPending === "google" ? "Finish in your browser" : "Continue with Google"}
                  </button>
                ) : null}
              </div>
            ) : null}
            {reauthError !== null ? (
              <p className="auth__error" role="alert">
                {reauthError}
              </p>
            ) : null}
            <div className="account-reauth__footer">
              <button className="button" type="button" onClick={closeReauthentication}>
                Cancel
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </section>
  );
}
