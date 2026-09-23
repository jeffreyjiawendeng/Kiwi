import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AccountSettings } from "./AccountSettings.js";
import type {
  RendererAccountProfile,
  RendererAccountSettingsSnapshot,
  RendererBridge,
} from "./bridge.js";

const snapshot: RendererAccountSettingsSnapshot = {
  account: {
    id: "account-1",
    email: "reader@example.test",
    profile: {
      given_name: "Kiwi",
      family_name: "Reader",
      phone: null,
    },
    display_name: "Kiwi Reader",
    profile_complete: true,
    email_verified: true,
    avatar: null,
  },
  sign_in_methods: ["google", "password"],
  sessions: [
    {
      id: "session-current",
      device_name: "This computer",
      current: true,
      started_at: "2026-08-20T12:00:00.000Z",
      last_authenticated_at: "2026-08-22T12:00:00.000Z",
      last_seen_at: "2026-08-23T12:00:00.000Z",
    },
    {
      id: "session-other",
      device_name: "Travel laptop",
      current: false,
      started_at: "2026-08-19T12:00:00.000Z",
      last_authenticated_at: "2026-08-21T12:00:00.000Z",
      last_seen_at: "2026-08-21T18:00:00.000Z",
    },
  ],
  emails: [
    {
      id: "email-1",
      address: "reader@example.test",
      kind: "personal" as const,
      verified: true,
      primary: true,
      receives_notifications: true,
    },
    {
      id: "email-2",
      address: "reader@university.test",
      kind: "institutional" as const,
      verified: true,
      primary: false,
      receives_notifications: false,
    },
  ],
  security_activity: [
    {
      id: "event-1",
      event: "account.google_sign_in",
      outcome: "succeeded",
      occurred_at: "2026-08-23T12:00:00.000Z",
    },
    {
      id: "event-2",
      event: "account.google_unlink",
      outcome: "rejected",
      occurred_at: "2026-08-22T12:00:00.000Z",
    },
  ],
  notifications: [
    { category: "workspace_invitations", email: true },
    { category: "collaboration", email: true },
    { category: "synchronization", email: true },
    { category: "product", email: false },
  ],
  deletion_impact: {
    sole_owner_workspaces: [{ id: "workspace-1", title: "Photocatalysis" }],
    shared_workspaces: 2,
    addresses: 2,
    connections: 1,
  },
  deletion: { status: "none" },
};

function install(overrides: Partial<RendererBridge> = {}) {
  const bridge = {
    getAccountSettings: vi.fn(async () => ({ status: "ok" as const, settings: snapshot })),
    updateAccountProfile: vi.fn(async (input: RendererAccountProfile) => ({
      status: "ok" as const,
      settings: {
        ...snapshot,
        account: {
          ...snapshot.account,
          profile: input,
          display_name:
            [input.given_name, input.family_name].filter((part) => part !== null).join(" ") ||
            snapshot.account.display_name,
          profile_complete: true,
        },
      },
    })),
    revokeAccountSession: vi.fn(async () => ({ status: "session_revoked" as const })),
    revokeOtherAccountSessions: vi.fn(async () => ({ status: "session_revoked" as const })),
    requestAccountDeletion: vi.fn(async () => ({
      status: "deletion_requested" as const,
      recover_until: "2026-09-21T12:00:00.000Z",
    })),
    chooseAccountAvatar: vi.fn(async () => ({ status: "ok" as const, settings: snapshot })),
    removeAccountAvatar: vi.fn(async () => ({ status: "ok" as const, settings: snapshot })),
    readAccountAvatar: vi.fn(async () => null),
    exportAccountData: vi.fn(async () => ({
      status: "written" as const,
      path: "kiwi-account.json",
    })),
    setAccountNotificationPreference: vi.fn(async () => ({
      status: "ok" as const,
      settings: snapshot,
    })),
    setAccountPassword: vi.fn(async () => ({ status: "ok" as const, settings: snapshot })),
    removeAccountPassword: vi.fn(async () => ({ status: "ok" as const, settings: snapshot })),
    linkSignInMethod: vi.fn(async () => ({
      status: "identity_linked" as const,
      provider: "orcid" as const,
    })),
    unlinkSignInMethod: vi.fn(async () => ({
      status: "identity_unlinked" as const,
      provider: "google" as const,
      provider_revocation: "not_supported" as const,
    })),
    reauthenticateWithPassword: vi.fn(async () => ({
      status: "reauthenticated" as const,
      provider: "password" as const,
    })),
    reauthenticateWithProvider: vi.fn(async () => ({
      status: "reauthenticated" as const,
      provider: "google" as const,
    })),
    cancelProviderSignIn: vi.fn(async () => false),
    addAccountEmail: vi.fn(async () => ({ status: "ok" as const, settings: snapshot })),
    verifyAccountEmailAddress: vi.fn(async () => ({ status: "ok" as const, settings: snapshot })),
    resendAccountEmail: vi.fn(async () => ({ status: "ok" as const, settings: snapshot })),
    promoteAccountEmail: vi.fn(async () => ({ status: "ok" as const, settings: snapshot })),
    setAccountNotificationEmail: vi.fn(async () => ({ status: "ok" as const, settings: snapshot })),
    removeAccountEmail: vi.fn(async () => ({ status: "ok" as const, settings: snapshot })),
    listConnections: vi.fn(async () => ({
      status: "ok" as const,
      connections: {
        connections: [
          {
            provider: "github",
            account_label: "kiwi-researcher",
            scopes: "read:user",
            connected_at: "2026-08-23T12:00:00.000Z",
            authorization_status: "active",
          },
        ],
        available: ["github", "zenodo"],
      },
    })),
    startConnection: vi.fn(async () => ({
      status: "device_required" as const,
      transaction_id: "transaction-1",
      prompt: {
        verification_uri: "https://github.com/login/device",
        user_code: "ABCD-1234",
        expires_in_seconds: 899,
      },
    })),
    pollConnection: vi.fn(async () => ({ status: "connected" as const, provider: "github" })),
    disconnectConnection: vi.fn(async () => ({
      status: "disconnected" as const,
      provider: "github",
      provider_revocation: "not_supported" as const,
    })),
    ...overrides,
  };
  window.kiwiDesktop = bridge as unknown as RendererBridge;
  return bridge;
}

afterEach(() => {
  cleanup();
  delete window.kiwiDesktop;
  window.localStorage.clear();
});

describe("ED-ACCOUNT", () => {
  it("confirms the current account and retries the exact refused action", async () => {
    const revoke = vi
      .fn()
      .mockResolvedValueOnce({
        status: "error" as const,
        code: "recent_auth_required",
        message: "Sign in again before changing account security.",
      })
      .mockResolvedValueOnce({ status: "session_revoked" as const });
    const bridge = install({ revokeAccountSession: revoke });
    render(<AccountSettings onClose={vi.fn()} onAccountDeletion={vi.fn()} />);

    await screen.findByRole("heading", { name: "Account" });
    await userEvent.click(screen.getByRole("button", { name: "Sessions" }));
    await userEvent.click(screen.getByRole("button", { name: "Revoke" }));
    const dialog = await screen.findByRole("dialog", { name: "Confirm it's you" });
    await userEvent.type(within(dialog).getByLabelText("Password"), "the old one");
    await userEvent.click(within(dialog).getByRole("button", { name: "Continue" }));

    await waitFor(() => expect(revoke).toHaveBeenCalledTimes(2));
    expect(bridge.reauthenticateWithPassword).toHaveBeenCalledWith({ password: "the old one" });
    expect(screen.queryByRole("dialog", { name: "Confirm it's you" })).not.toBeInTheDocument();
  });

  it("opens on Profile and shows the derived display name", async () => {
    install();
    render(<AccountSettings onClose={vi.fn()} onAccountDeletion={vi.fn()} />);
    expect(await screen.findByRole("heading", { name: "Account" })).toBeInTheDocument();
    expect(await screen.findByDisplayValue("Kiwi")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Reader")).toBeInTheDocument();
    expect(screen.getByText("Kiwi Reader")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Email addresses" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Contact" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Email addresses" })).not.toBeInTheDocument();
  });

  it("always opens on Profile instead of restoring the previous category", async () => {
    window.localStorage.setItem("kiwi.account-settings.category", "security");
    install();
    render(<AccountSettings onClose={vi.fn()} onAccountDeletion={vi.fn()} />);

    expect(await screen.findByRole("heading", { name: "Profile" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Change password" })).not.toBeInTheDocument();
  });

  it("shows one category at a time and reaches sessions through the rail", async () => {
    install();
    render(<AccountSettings onClose={vi.fn()} onAccountDeletion={vi.fn()} />);
    expect(await screen.findByRole("heading", { name: "Profile" })).toBeInTheDocument();
    expect(screen.queryByText("Travel laptop")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Sessions" }));
    expect(screen.getByText("Current device")).toBeInTheDocument();
    expect(screen.getByText("Travel laptop")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Profile" })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Authentication" }));
    expect(screen.getAllByText("Connected")).toHaveLength(2);
  });

  it("offers explicit sign-out for the current device from Sessions", async () => {
    const onSignOut = vi.fn();
    install();
    render(<AccountSettings onClose={vi.fn()} onAccountDeletion={vi.fn()} onSignOut={onSignOut} />);
    await userEvent.click(await screen.findByRole("button", { name: "Sessions" }));
    await userEvent.click(screen.getByRole("button", { name: "Sign out this device" }));
    expect(onSignOut).toHaveBeenCalledOnce();
  });

  it("saves every profile field and revokes another device", async () => {
    const bridge = install();
    render(<AccountSettings onClose={vi.fn()} onAccountDeletion={vi.fn()} />);
    const given = await screen.findByLabelText("First name");
    await userEvent.clear(given);
    await userEvent.type(given, "Research Lead");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(bridge.updateAccountProfile).toHaveBeenCalledWith({
        given_name: "Research Lead",
        family_name: "Reader",
        phone: null,
      }),
    );

    await userEvent.click(screen.getByRole("button", { name: "Sessions" }));
    await userEvent.click(screen.getByRole("button", { name: "Revoke" }));
    await waitFor(() =>
      expect(bridge.revokeAccountSession).toHaveBeenCalledWith({ session_id: "session-other" }),
    );
  });

  it("places the Profile save action below the Contact panel", async () => {
    install();
    render(<AccountSettings onClose={vi.fn()} onAccountDeletion={vi.fn()} />);

    const contact = (await screen.findByRole("heading", { name: "Contact" })).closest("section");
    const save = screen.getByRole("button", { name: "Save" });
    expect(contact).not.toBeNull();
    expect(contact).not.toContainElement(save);
    expect(save.closest(".settings-profile-actions")).not.toBeNull();
  });

  it("clears a name field to null rather than sending an empty string", async () => {
    const bridge = install();
    render(<AccountSettings onClose={vi.fn()} onAccountDeletion={vi.fn()} />);
    const family = await screen.findByLabelText("Last name");
    await userEvent.clear(family);
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(bridge.updateAccountProfile).toHaveBeenCalledWith(
        expect.objectContaining({ family_name: null }),
      ),
    );
  });

  it("requires an explicit deletion phrase and hands completion back to the shell", async () => {
    const bridge = install();
    const onAccountDeletion = vi.fn();
    render(<AccountSettings onClose={vi.fn()} onAccountDeletion={onAccountDeletion} />);
    await userEvent.click(await screen.findByRole("button", { name: "Data and account removal" }));
    const button = await screen.findByRole("button", { name: "Request deletion" });
    expect(button).toBeDisabled();
    await userEvent.type(screen.getByLabelText("Type DELETE to confirm"), "DELETE");
    await userEvent.click(button);
    await waitFor(() => expect(onAccountDeletion).toHaveBeenCalledOnce());
    expect(bridge.requestAccountDeletion).toHaveBeenCalledWith({ confirmation: "DELETE" });
  });
  it("accepts a commonly formatted phone number without format instructions", async () => {
    const bridge = install();
    render(<AccountSettings onClose={vi.fn()} onAccountDeletion={vi.fn()} />);
    const phone = await screen.findByLabelText("Phone number");
    await userEvent.type(phone, "+1 (415) 555-0134");
    expect(screen.queryByText(/E\.164|authentication factor/i)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(bridge.updateAccountProfile).toHaveBeenCalledWith(
        expect.objectContaining({ phone: "+1 (415) 555-0134" }),
      ),
    );
  });

  it("flags an invalid phone beside the field without submitting it", async () => {
    const bridge = install();
    render(<AccountSettings onClose={vi.fn()} onAccountDeletion={vi.fn()} />);
    const phone = await screen.findByLabelText("Phone number");
    await userEvent.type(phone, "call me later");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(screen.getByRole("alert")).toHaveTextContent("Enter a valid phone number.");
    expect(phone).toHaveFocus();
    expect(phone).toHaveAttribute("aria-invalid", "true");
    expect(bridge.updateAccountProfile).not.toHaveBeenCalled();
  });

  it("changes a password by proving the current one, with no emailed code", async () => {
    const bridge = install();
    render(<AccountSettings onClose={vi.fn()} onAccountDeletion={vi.fn()} />);
    await userEvent.click(await screen.findByRole("button", { name: "Security" }));

    // A code is sent only to prove a first address or to recover a lost password.
    expect(screen.queryByLabelText(/code/i)).not.toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Current password"), "the old one");
    await userEvent.type(screen.getByLabelText("New password"), "a long orchard password");
    await userEvent.type(screen.getByLabelText("Retype new password"), "a long orchard password");
    await userEvent.click(screen.getByRole("button", { name: "Change password" }));

    await waitFor(() =>
      expect(bridge.setAccountPassword).toHaveBeenCalledWith({
        current_password: "the old one",
        new_password: "a long orchard password",
      }),
    );
    expect(await screen.findByText("Password updated.")).toBeInTheDocument();
  });

  it("uses Kiwi validation and an explicit reveal control for password changes", async () => {
    const bridge = install();
    render(<AccountSettings onClose={vi.fn()} onAccountDeletion={vi.fn()} />);
    await userEvent.click(await screen.findByRole("button", { name: "Security" }));

    const form = screen.getByRole("button", { name: "Change password" }).closest("form");
    expect(form).toHaveAttribute("novalidate");
    await userEvent.click(screen.getByRole("button", { name: "Change password" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Enter your current password.");
    expect(screen.getByLabelText("Current password")).toHaveFocus();
    expect(bridge.setAccountPassword).not.toHaveBeenCalled();

    const next = screen.getByLabelText("New password");
    expect(next).toHaveAttribute("type", "password");
    await userEvent.click(screen.getByRole("button", { name: "Show" }));
    expect(next).toHaveAttribute("type", "text");
    await userEvent.click(screen.getByRole("button", { name: "Hide" }));
    expect(next).toHaveAttribute("type", "password");
  });

  it("does not submit a password change until both new-password fields match", async () => {
    const bridge = install();
    render(<AccountSettings onClose={vi.fn()} onAccountDeletion={vi.fn()} />);
    await userEvent.click(await screen.findByRole("button", { name: "Security" }));
    await userEvent.type(screen.getByLabelText("Current password"), "the old one");
    await userEvent.type(screen.getByLabelText("New password"), "a long orchard password");
    await userEvent.type(screen.getByLabelText("Retype new password"), "a different password");

    expect(screen.getByRole("alert")).toHaveTextContent("The passwords do not match.");
    expect(screen.getByRole("button", { name: "Change password" })).toBeDisabled();
    expect(bridge.setAccountPassword).not.toHaveBeenCalled();
  });

  it("creates a first password without asking for one the account does not have", async () => {
    const bridge = install({
      getAccountSettings: vi.fn(async () => ({
        status: "ok" as const,
        settings: { ...snapshot, sign_in_methods: ["google" as const] },
      })),
    });
    render(<AccountSettings onClose={vi.fn()} onAccountDeletion={vi.fn()} />);
    await userEvent.click(await screen.findByRole("button", { name: "Security" }));

    expect(await screen.findByRole("heading", { name: "Change password" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Current password")).not.toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("New password"), "a long orchard password");
    await userEvent.type(screen.getByLabelText("Retype new password"), "a long orchard password");
    await userEvent.click(screen.getByRole("button", { name: "Change password" }));

    await waitFor(() =>
      expect(bridge.setAccountPassword).toHaveBeenCalledWith({
        current_password: null,
        new_password: "a long orchard password",
      }),
    );
  });

  it("sends an account with no password from Authentication to the password screen", async () => {
    install({
      getAccountSettings: vi.fn(async () => ({
        status: "ok" as const,
        settings: { ...snapshot, sign_in_methods: ["google" as const] },
      })),
    });
    render(<AccountSettings onClose={vi.fn()} onAccountDeletion={vi.fn()} />);
    await userEvent.click(await screen.findByRole("button", { name: "Authentication" }));
    await userEvent.click(await screen.findByRole("button", { name: "Change password" }));

    expect(await screen.findByRole("heading", { name: "Change password" })).toBeInTheDocument();
  });

  it("removes the password only while another method remains", async () => {
    const bridge = install();
    render(<AccountSettings onClose={vi.fn()} onAccountDeletion={vi.fn()} />);
    await userEvent.click(await screen.findByRole("button", { name: "Authentication" }));

    // The snapshot holds Google and a password, so either one may be removed.
    await userEvent.click(await screen.findByRole("button", { name: "Remove password" }));
    await waitFor(() => expect(bridge.removeAccountPassword).toHaveBeenCalledOnce());
  });

  it("refuses to remove a password that is the only method configured", async () => {
    install({
      getAccountSettings: vi.fn(async () => ({
        status: "ok" as const,
        settings: { ...snapshot, sign_in_methods: ["password" as const] },
      })),
    });
    render(<AccountSettings onClose={vi.fn()} onAccountDeletion={vi.fn()} />);
    await userEvent.click(await screen.findByRole("button", { name: "Authentication" }));

    expect(await screen.findByRole("button", { name: "Remove password" })).toBeDisabled();
  });
  it("lists every sign-in method and offers to connect the ones that are not set up", async () => {
    install();
    render(<AccountSettings onClose={vi.fn()} onAccountDeletion={vi.fn()} />);
    await userEvent.click(await screen.findByRole("button", { name: "Authentication" }));

    expect(screen.getByText("Password")).toBeInTheDocument();
    expect(screen.getByText("Google")).toBeInTheDocument();
    expect(screen.getAllByText("Connected")).toHaveLength(2);

    // Connected accounts and every identity provider other than Google are deferred, so
    // Authentication must not offer one. An unregistered provider fails at the provider.
    expect(screen.queryByText("ORCID")).not.toBeInTheDocument();
  });

  it("connects Google through the trusted broker and reloads the snapshot", async () => {
    const bridge = install({
      getAccountSettings: vi.fn(async () => ({
        status: "ok" as const,
        settings: { ...snapshot, sign_in_methods: ["password" as const] },
      })),
    });
    render(<AccountSettings onClose={vi.fn()} onAccountDeletion={vi.fn()} />);
    await userEvent.click(await screen.findByRole("button", { name: "Authentication" }));
    await userEvent.click(screen.getByRole("button", { name: "Connect" }));

    await waitFor(() =>
      expect(bridge.linkSignInMethod).toHaveBeenCalledWith({ provider: "google" }),
    );
    expect(await screen.findByText("Authentication method linked.")).toBeInTheDocument();
    expect(bridge.getAccountSettings).toHaveBeenCalledTimes(2);
  });

  it("removes a connected method while another remains", async () => {
    const bridge = install();
    render(<AccountSettings onClose={vi.fn()} onAccountDeletion={vi.fn()} />);
    await userEvent.click(await screen.findByRole("button", { name: "Authentication" }));
    await userEvent.click(screen.getByRole("button", { name: "Remove Google" }));

    await waitFor(() =>
      expect(bridge.unlinkSignInMethod).toHaveBeenCalledWith({ provider: "google" }),
    );
    expect(
      await screen.findByText(
        "Authentication method unlinked from Kiwi. Review authorized applications at the provider if you also want to remove its authorization there.",
      ),
    ).toBeInTheDocument();
  });

  it("cannot remove the last remaining sign-in method", async () => {
    install({
      getAccountSettings: vi.fn(async () => ({
        status: "ok" as const,
        settings: { ...snapshot, sign_in_methods: ["google" as const] },
      })),
    });
    render(<AccountSettings onClose={vi.fn()} onAccountDeletion={vi.fn()} />);
    await userEvent.click(await screen.findByRole("button", { name: "Authentication" }));

    expect(screen.getByRole("button", { name: "Remove Google" })).toBeDisabled();
  });

  it("surfaces a provider failure without claiming the method changed", async () => {
    const bridge = install({
      getAccountSettings: vi.fn(async () => ({
        status: "ok" as const,
        settings: { ...snapshot, sign_in_methods: ["password" as const] },
      })),
      linkSignInMethod: vi.fn(async () => ({
        status: "error" as const,
        code: "identity_link_required",
        message: "That account is already connected to a different Kiwi account.",
      })),
    });
    render(<AccountSettings onClose={vi.fn()} onAccountDeletion={vi.fn()} />);
    await userEvent.click(await screen.findByRole("button", { name: "Authentication" }));
    await userEvent.click(screen.getByRole("button", { name: "Connect" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "already connected to a different Kiwi account",
    );
    expect(screen.queryByText("Authentication method linked.")).not.toBeInTheDocument();
    expect(bridge.getAccountSettings).toHaveBeenCalledOnce();
  });
  // Connected accounts are deferred. The service still implements them, so the guard that
  // matters is that no route into the settings window reaches them.
  it("offers no connected-accounts surface at all", async () => {
    const bridge = install();
    render(<AccountSettings onClose={vi.fn()} onAccountDeletion={vi.fn()} />);
    await screen.findByRole("button", { name: "Authentication" });

    expect(screen.queryByRole("button", { name: "Connected accounts" })).not.toBeInTheDocument();
    expect(bridge.listConnections).not.toHaveBeenCalled();
  });

  it("lists recent account activity in readable terms", async () => {
    install();
    render(<AccountSettings onClose={vi.fn()} onAccountDeletion={vi.fn()} />);
    await userEvent.click(await screen.findByRole("button", { name: "Security" }));

    expect(await screen.findByText("Signed in with Google")).toBeInTheDocument();
    expect(screen.getByText("Google unlinked")).toBeInTheDocument();
    expect(screen.getByText("Succeeded")).toBeInTheDocument();
    expect(screen.getByText("Rejected")).toBeInTheDocument();
    expect(screen.queryByText("account.google_sign_in")).not.toBeInTheDocument();
  });

  it("states plainly when no activity has been recorded", async () => {
    install({
      getAccountSettings: vi.fn(async () => ({
        status: "ok" as const,
        settings: { ...snapshot, security_activity: [] },
      })),
    });
    render(<AccountSettings onClose={vi.fn()} onAccountDeletion={vi.fn()} />);
    await userEvent.click(await screen.findByRole("button", { name: "Security" }));

    expect(await screen.findByText("No activity has been recorded yet.")).toBeInTheDocument();
  });
  it("lists each address with its verification, primary, and notification state", async () => {
    install();
    render(<AccountSettings onClose={vi.fn()} onAccountDeletion={vi.fn()} />);

    expect(await screen.findByText("reader@example.test")).toBeInTheDocument();
    expect(screen.getByText("reader@university.test")).toBeInTheDocument();
    expect(screen.getByText("Primary")).toBeInTheDocument();
    expect(screen.getAllByText("Institutional").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Notifications").length).toBeGreaterThan(1);
    expect(screen.getAllByText("Verified")).toHaveLength(2);
    expect(screen.queryByText("Unverified")).not.toBeInTheDocument();
  });

  it("uses one entry bar, then the shared verification panel before listing an address", async () => {
    const pendingSettings = {
      ...snapshot,
      emails: [
        ...snapshot.emails,
        {
          id: "email-3",
          address: "lab@university.test",
          kind: "institutional" as const,
          verified: false,
          primary: false,
          receives_notifications: false,
        },
      ],
    };
    const verifiedSettings = {
      ...pendingSettings,
      emails: pendingSettings.emails.map((entry) =>
        entry.id === "email-3" ? { ...entry, verified: true } : entry,
      ),
    };
    const bridge = install({
      addAccountEmail: vi.fn(async () => ({
        status: "ok" as const,
        settings: pendingSettings,
        email_verification: {
          email_id: "email-3",
          address: "lab@university.test",
          fixture_code: "KIWI-VERIFY-000003",
        },
      })),
      verifyAccountEmailAddress: vi.fn(async () => ({
        status: "ok" as const,
        settings: verifiedSettings,
      })),
    });
    render(<AccountSettings onClose={vi.fn()} onAccountDeletion={vi.fn()} />);

    const address = await screen.findByLabelText("Add an address");
    const kind = screen.getByLabelText("Address type");
    expect(address.closest(".email-entry__bar")).toContainElement(kind);
    await userEvent.type(address, "lab@university.test");
    await userEvent.selectOptions(kind, "institutional");
    expect(screen.queryByText(/grants no additional access/i)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Add address" }));

    await waitFor(() =>
      expect(bridge.addAccountEmail).toHaveBeenCalledWith({
        address: "lab@university.test",
        kind: "institutional",
      }),
    );
    expect(await screen.findByRole("heading", { name: "Check your email" })).toBeInTheDocument();
    expect(screen.getByLabelText("Verification code")).toHaveValue("KIWI-VERIFY-000003");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(
      screen
        .getAllByRole("listitem")
        .some((item) => item.textContent?.includes("lab@university.test")),
    ).toBe(false);

    await userEvent.click(screen.getByRole("button", { name: "Verify and continue" }));
    await waitFor(() =>
      expect(bridge.verifyAccountEmailAddress).toHaveBeenCalledWith({
        email_id: "email-3",
        code: "KIWI-VERIFY-000003",
      }),
    );
    expect(await screen.findByRole("heading", { name: "Email addresses" })).toBeInTheDocument();
    expect(screen.getByText("lab@university.test")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    expect(screen.queryByText("Profile updated.")).not.toBeInTheDocument();
  });

  it("uses inline Kiwi validation for an additional email address", async () => {
    const bridge = install();
    render(<AccountSettings onClose={vi.fn()} onAccountDeletion={vi.fn()} />);

    await userEvent.click(await screen.findByRole("button", { name: "Add address" }));
    const address = screen.getByLabelText("Add an address");
    expect(screen.getByRole("alert")).toHaveTextContent("Enter an email address.");
    expect(screen.getByRole("alert")).toHaveClass("auth__error");
    expect(address).toHaveFocus();
    expect(address).toHaveAttribute("aria-invalid", "true");
    expect(bridge.addAccountEmail).not.toHaveBeenCalled();
  });

  it("stops offering another address when the account already has three", async () => {
    install({
      getAccountSettings: vi.fn(async () => ({
        status: "ok" as const,
        settings: {
          ...snapshot,
          emails: [
            ...snapshot.emails,
            {
              id: "email-3",
              address: "reader@affiliation.test",
              kind: "institutional" as const,
              verified: true,
              primary: false,
              receives_notifications: false,
            },
          ],
        },
      })),
    });
    render(<AccountSettings onClose={vi.fn()} onAccountDeletion={vi.fn()} />);

    expect(await screen.findByText(/maximum of three email addresses/i)).toBeInTheDocument();
    expect(screen.queryByLabelText("Add an address")).not.toBeInTheDocument();
  });

  it("resumes an interrupted email verification when Profile opens", async () => {
    const pendingSettings = {
      ...snapshot,
      emails: snapshot.emails.map((entry) =>
        entry.id === "email-2" ? { ...entry, verified: false } : entry,
      ),
    };
    const bridge = install({
      getAccountSettings: vi.fn(async () => ({
        status: "ok" as const,
        settings: pendingSettings,
      })),
    });
    render(<AccountSettings onClose={vi.fn()} onAccountDeletion={vi.fn()} />);

    expect(await screen.findByRole("heading", { name: "Check your email" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Enter code" })).not.toBeInTheDocument();
    await userEvent.type(await screen.findByLabelText("Verification code"), "ABCD-2345");
    await userEvent.click(screen.getByRole("button", { name: "Verify and continue" }));

    await waitFor(() =>
      expect(bridge.verifyAccountEmailAddress).toHaveBeenCalledWith({
        email_id: "email-2",
        code: "ABCD-2345",
      }),
    );
  });

  it("replaces the code for a pending additional address", async () => {
    const pendingSettings = {
      ...snapshot,
      emails: snapshot.emails.map((entry) =>
        entry.id === "email-2" ? { ...entry, verified: false } : entry,
      ),
    };
    const bridge = install({
      getAccountSettings: vi.fn(async () => ({
        status: "ok" as const,
        settings: pendingSettings,
      })),
      resendAccountEmail: vi.fn(async () => ({
        status: "ok" as const,
        settings: pendingSettings,
        email_verification: {
          email_id: "email-2",
          address: "reader@university.test",
          fixture_code: "KIWI-VERIFY-000004",
        },
      })),
    });
    render(<AccountSettings onClose={vi.fn()} onAccountDeletion={vi.fn()} />);

    await userEvent.click(await screen.findByRole("button", { name: "Send a new code" }));

    await waitFor(() =>
      expect(bridge.resendAccountEmail).toHaveBeenCalledWith({ email_id: "email-2" }),
    );
    expect(screen.getByLabelText("Verification code")).toHaveValue("KIWI-VERIFY-000004");
    expect(screen.getByRole("status")).toHaveTextContent("A new verification code was sent.");
  });

  it("resumes a pending address after its first delivery fails", async () => {
    const pendingSettings = {
      ...snapshot,
      emails: [
        ...snapshot.emails,
        {
          id: "email-3",
          address: "lab@university.test",
          kind: "institutional" as const,
          verified: false,
          primary: false,
          receives_notifications: false,
        },
      ],
    };
    const getSettings = vi
      .fn<RendererBridge["getAccountSettings"]>()
      .mockResolvedValueOnce({ status: "ok", settings: snapshot })
      .mockResolvedValue({ status: "ok", settings: pendingSettings });
    install({
      getAccountSettings: getSettings,
      addAccountEmail: vi.fn(async () => ({
        status: "error" as const,
        code: "service_unavailable",
        message:
          "Kiwi saved this pending address but could not send its code. Use Send a new code to try again.",
      })),
    });
    render(<AccountSettings onClose={vi.fn()} onAccountDeletion={vi.fn()} />);
    await userEvent.type(await screen.findByLabelText("Add an address"), "lab@university.test");
    await userEvent.click(screen.getByRole("button", { name: "Add address" }));

    expect(await screen.findByRole("heading", { name: "Check your email" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("saved this pending address");
    expect(screen.getByRole("button", { name: "Send a new code" })).toBeEnabled();
  });

  it("removes a mistyped pending address before returning to email entry", async () => {
    const pendingSettings = {
      ...snapshot,
      emails: snapshot.emails.map((entry) =>
        entry.id === "email-2" ? { ...entry, verified: false } : entry,
      ),
    };
    const bridge = install({
      getAccountSettings: vi.fn(async () => ({
        status: "ok" as const,
        settings: pendingSettings,
      })),
    });
    render(<AccountSettings onClose={vi.fn()} onAccountDeletion={vi.fn()} />);

    await userEvent.click(await screen.findByRole("button", { name: "Use a different email" }));
    await waitFor(() =>
      expect(bridge.removeAccountEmail).toHaveBeenCalledWith({ email_id: "email-2" }),
    );
    expect(await screen.findByRole("heading", { name: "Email addresses" })).toBeInTheDocument();
    expect(screen.getByLabelText("Add an address")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  });

  it("offers no removal or promotion control on the primary address", async () => {
    install();
    render(<AccountSettings onClose={vi.fn()} onAccountDeletion={vi.fn()} />);

    const primaryRow = (await screen.findByText("reader@example.test")).closest("li");
    expect(primaryRow).not.toBeNull();
    expect(within(primaryRow!).queryByRole("button", { name: "Remove" })).not.toBeInTheDocument();
    expect(
      within(primaryRow!).queryByRole("button", { name: "Make primary" }),
    ).not.toBeInTheDocument();
  });

  it("promotes a verified address and moves notification delivery", async () => {
    const verified = {
      ...snapshot,
      emails: [{ ...snapshot.emails[0]! }, { ...snapshot.emails[1]!, verified: true }],
    };
    const bridge = install({
      getAccountSettings: vi.fn(async () => ({ status: "ok" as const, settings: verified })),
      promoteAccountEmail: vi.fn(async () => ({ status: "ok" as const, settings: verified })),
      setAccountNotificationEmail: vi.fn(async () => ({
        status: "ok" as const,
        settings: verified,
      })),
    });
    render(<AccountSettings onClose={vi.fn()} onAccountDeletion={vi.fn()} />);

    await userEvent.click(await screen.findByRole("button", { name: "Make primary" }));
    await waitFor(() =>
      expect(bridge.promoteAccountEmail).toHaveBeenCalledWith({ email_id: "email-2" }),
    );

    await userEvent.click(screen.getByRole("button", { name: "Send notifications here" }));
    await waitFor(() =>
      expect(bridge.setAccountNotificationEmail).toHaveBeenCalledWith({ email_id: "email-2" }),
    );
  });
  it("states what deletion would cost before offering the confirmation", async () => {
    install();
    render(<AccountSettings onClose={vi.fn()} onAccountDeletion={vi.fn()} />);
    await userEvent.click(await screen.findByRole("button", { name: "Data and account removal" }));

    expect(await screen.findByText(/Photocatalysis/)).toBeInTheDocument();
    expect(screen.getByText("Workspaces you would lose access to")).toBeInTheDocument();
    expect(screen.getByText("Email addresses released")).toBeInTheDocument();
    expect(screen.queryByText("Connected accounts disconnected")).not.toBeInTheDocument();
  });

  it("says no workspace depends on the account when none is solely owned", async () => {
    install({
      getAccountSettings: vi.fn(async () => ({
        status: "ok" as const,
        settings: {
          ...snapshot,
          deletion_impact: { ...snapshot.deletion_impact, sole_owner_workspaces: [] },
        },
      })),
    });
    render(<AccountSettings onClose={vi.fn()} onAccountDeletion={vi.fn()} />);
    await userEvent.click(await screen.findByRole("button", { name: "Data and account removal" }));

    expect(
      await screen.findByText(/No workspace depends on this account alone/),
    ).toBeInTheDocument();
  });
  it("shows each delivery category with its current state and no security switch", async () => {
    install();
    render(<AccountSettings onClose={vi.fn()} onAccountDeletion={vi.fn()} />);
    await userEvent.click(await screen.findByRole("button", { name: "Notifications" }));

    expect(await screen.findByText("Workspace invitations")).toBeInTheDocument();
    expect(screen.getByText("Collaboration activity")).toBeInTheDocument();
    expect(screen.getByText("Synchronization")).toBeInTheDocument();
    expect(screen.getByText("Product announcements")).toBeInTheDocument();
    // Security correspondence is not a preference, so it has no control.
    expect(screen.queryByRole("switch", { name: /security/i })).not.toBeInTheDocument();
    expect(screen.getByText(/cannot be turned off/i)).toBeInTheDocument();
  });

  it("turns one category off without touching the others", async () => {
    const bridge = install();
    render(<AccountSettings onClose={vi.fn()} onAccountDeletion={vi.fn()} />);
    await userEvent.click(await screen.findByRole("button", { name: "Notifications" }));

    const control = await screen.findByRole("switch", { name: "Email for Synchronization" });
    expect(control).toHaveAttribute("aria-checked", "true");
    await userEvent.click(control);

    await waitFor(() =>
      expect(bridge.setAccountNotificationPreference).toHaveBeenCalledWith({
        category: "synchronization",
        email: false,
      }),
    );
  });

  it("names the address correspondence is delivered to", async () => {
    install();
    render(<AccountSettings onClose={vi.fn()} onAccountDeletion={vi.fn()} />);
    await userEvent.click(await screen.findByRole("button", { name: "Notifications" }));

    // The snapshot marks the primary address for notifications.
    expect(await screen.findByText(/reader@example.test/)).toBeInTheDocument();
  });
  it("names the file an export was written to and never receives its contents", async () => {
    const bridge = install();
    render(<AccountSettings onClose={vi.fn()} onAccountDeletion={vi.fn()} />);
    await userEvent.click(await screen.findByRole("button", { name: "Data and account removal" }));
    await userEvent.click(screen.getByRole("button", { name: "Export account data" }));

    await waitFor(() => expect(bridge.exportAccountData).toHaveBeenCalledOnce());
    expect(await screen.findByText("Exported to kiwi-account.json.")).toBeInTheDocument();
  });

  it("says nothing when an export is cancelled at the file dialog", async () => {
    install({ exportAccountData: vi.fn(async () => ({ status: "cancelled" as const })) });
    render(<AccountSettings onClose={vi.fn()} onAccountDeletion={vi.fn()} />);
    await userEvent.click(await screen.findByRole("button", { name: "Data and account removal" }));
    await userEvent.click(screen.getByRole("button", { name: "Export account data" }));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Export account data" })).toBeEnabled(),
    );
    expect(screen.queryByText(/Exported to/)).not.toBeInTheDocument();
  });

  it("reports a refused export without claiming a file was written", async () => {
    install({
      exportAccountData: vi.fn(async () => ({
        status: "error" as const,
        message: "Sign in again before changing account security.",
      })),
    });
    render(<AccountSettings onClose={vi.fn()} onAccountDeletion={vi.fn()} />);
    await userEvent.click(await screen.findByRole("button", { name: "Data and account removal" }));
    await userEvent.click(screen.getByRole("button", { name: "Export account data" }));

    expect(
      await screen.findByText("Sign in again before changing account security."),
    ).toBeInTheDocument();
  });

  it("reports when each session was last used, not only when it signed in", async () => {
    install();
    render(<AccountSettings onClose={vi.fn()} onAccountDeletion={vi.fn()} />);
    await userEvent.click(await screen.findByRole("button", { name: "Sessions" }));

    expect(await screen.findByText("This computer")).toBeInTheDocument();
    expect(screen.getByText("Travel laptop")).toBeInTheDocument();
    expect(screen.getAllByText(/^Last active /)).toHaveLength(2);
    expect(screen.getAllByText(/^Signed in /)).toHaveLength(2);
    expect(screen.getByText("Current device")).toBeInTheDocument();
  });
  it("shows derived initials for an account that has no picture", async () => {
    install();
    render(<AccountSettings onClose={vi.fn()} onAccountDeletion={vi.fn()} />);

    expect(await screen.findByText("KR")).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Upload profile picture" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove picture" })).not.toBeInTheDocument();
  });

  it("shows the picture an account has and offers to replace or remove it", async () => {
    const bridge = install({
      getAccountSettings: vi.fn(async () => ({
        status: "ok" as const,
        settings: {
          ...snapshot,
          account: {
            ...snapshot.account,
            avatar: { content_hash: "a".repeat(64), media_type: "image/png" },
          },
        },
      })),
      readAccountAvatar: vi.fn(async () => "data:image/png;base64,iVBORw0KGgo="),
    });
    render(<AccountSettings onClose={vi.fn()} onAccountDeletion={vi.fn()} />);

    const replace = await screen.findByRole("button", { name: "Replace profile picture" });
    await waitFor(() => expect(replace.querySelector("img")).not.toBeNull());
    const image = replace.querySelector("img");
    expect(image).toHaveAttribute("src", "data:image/png;base64,iVBORw0KGgo=");
    expect(bridge.readAccountAvatar).toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Remove picture" }));
    await waitFor(() => expect(bridge.removeAccountAvatar).toHaveBeenCalledOnce());
  });

  it("says nothing when the picture dialog is cancelled", async () => {
    const bridge = install({ chooseAccountAvatar: vi.fn(async () => null) });
    render(<AccountSettings onClose={vi.fn()} onAccountDeletion={vi.fn()} />);
    await userEvent.click(await screen.findByRole("button", { name: "Upload profile picture" }));

    await waitFor(() => expect(bridge.chooseAccountAvatar).toHaveBeenCalledOnce());
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("reports a refused picture without changing what is displayed", async () => {
    install({
      chooseAccountAvatar: vi.fn(async () => ({
        status: "error" as const,
        code: "invalid_input",
        message: "That file is not a PNG, JPEG, or WebP image.",
      })),
    });
    render(<AccountSettings onClose={vi.fn()} onAccountDeletion={vi.fn()} />);
    await userEvent.click(await screen.findByRole("button", { name: "Upload profile picture" }));

    expect(
      await screen.findByText("That file is not a PNG, JPEG, or WebP image."),
    ).toBeInTheDocument();
    expect(screen.getByText("KR")).toBeInTheDocument();
  });
});
