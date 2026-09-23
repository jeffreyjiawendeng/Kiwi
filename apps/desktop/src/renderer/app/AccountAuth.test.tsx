import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AccountAuth } from "./AccountAuth.js";
import type { RendererAccountAuthResult, RendererBridge } from "./bridge.js";

function installAuthBridge(overrides: Partial<RendererBridge> = {}) {
  const bridge = {
    getPublicLinks: vi.fn(async () => ({ terms: true, privacy: true, support: true })),
    openPublicLink: vi.fn(async () => true),
    createPasswordAccount: vi.fn(async () => ({
      status: "accepted" as const,
      next: "verify_email" as const,
      fixture_code: "KIWI-VERIFY-000001",
    })),
    verifyAccountEmail: vi.fn(async () => ({
      status: "authenticated" as const,
      account: { id: "account-1", email: "reader@example.test", email_verified: true as const },
    })),
    resendAccountEmailVerification: vi.fn(async () => ({
      status: "accepted" as const,
      next: "verify_email" as const,
      fixture_code: "KIWI-VERIFY-000002",
    })),
    signInWithPassword: vi.fn(async () => ({
      status: "error" as const,
      code: "invalid_credentials",
      message: "The email or password is not correct.",
    })),
    requestPasswordReset: vi.fn(async () => ({
      status: "accepted" as const,
      next: "check_email" as const,
      fixture_code: "KIWI-RESET-000001",
    })),
    resetPassword: vi.fn(async () => ({ status: "password_reset" as const })),
    signInWithProvider: vi.fn(async () => ({
      status: "authenticated" as const,
      account: { id: "google-1", email: "google@example.test", email_verified: true as const },
    })),
    cancelProviderSignIn: vi.fn(async () => true),
    ...overrides,
  };
  window.kiwiDesktop = bridge as unknown as RendererBridge;
  return bridge;
}

afterEach(() => {
  cleanup();
  delete window.kiwiDesktop;
});

async function fillAccountCreation(
  email = "reader@example.test",
  password = "a long orchard password",
): Promise<void> {
  await userEvent.type(screen.getByLabelText("First name"), "Kiwi");
  await userEvent.type(screen.getByLabelText("Last name"), "Reader");
  await userEvent.type(screen.getByLabelText("Phone number"), "(415) 555-0134");
  await userEvent.type(screen.getByLabelText("Email"), email);
  await userEvent.type(screen.getByLabelText("Password"), password);
  await userEvent.type(screen.getByLabelText("Retype password"), password);
}

describe("ED-AUTH", () => {
  it("starts as a quiet login form", () => {
    installAuthBridge();
    render(<AccountAuth onAuthenticated={vi.fn()} />);

    expect(screen.getByRole("heading", { name: "Log In" })).toBeInTheDocument();
    expect(screen.getByLabelText("Email")).toHaveAttribute("autocomplete", "email");
    expect(screen.getByLabelText("Password")).toHaveAttribute("autocomplete", "current-password");
    const googleButton = screen.getByRole("button", { name: "Log in with Google" });
    const loginButton = screen.getByRole("button", { name: "Log In" });
    expect(googleButton).toBeEnabled();
    expect(googleButton).toHaveClass("auth__control");
    expect(screen.getByLabelText("Email")).toHaveClass("auth__control");
    expect(screen.getByLabelText("Password")).toHaveClass("auth__control");
    expect(loginButton).toHaveClass("auth__control");
    expect(googleButton.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByRole("button", { name: "Create an Account" })).toBeEnabled();
    expect(document.querySelector("form")).toHaveAttribute("novalidate");
    expect(screen.queryByText("Kiwi")).not.toBeInTheDocument();
    expect(screen.queryByText(/no account required/i)).not.toBeInTheDocument();
  });

  it("opens packaged Terms and Privacy destinations only through named broker actions", async () => {
    const bridge = installAuthBridge();
    render(<AccountAuth onAuthenticated={vi.fn()} />);

    await userEvent.click(await screen.findByRole("button", { name: "Terms" }));
    await userEvent.click(screen.getByRole("button", { name: "Privacy" }));
    expect(bridge.openPublicLink).toHaveBeenNthCalledWith(1, "terms");
    expect(bridge.openPublicLink).toHaveBeenNthCalledWith(2, "privacy");
  });

  it("offers no legal links until the destinations are actually published", async () => {
    installAuthBridge({
      getPublicLinks: vi.fn(async () => ({ terms: false, privacy: false, support: false })),
    });
    render(<AccountAuth onAuthenticated={vi.fn()} />);
    await screen.findByRole("button", { name: "Log In" });

    // A disabled Terms button taught people to click something that never answers. Until the
    // document exists there is nothing to open, so the row is absent rather than inert.
    expect(screen.queryByRole("navigation", { name: "Legal information" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Terms" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Privacy" })).not.toBeInTheDocument();
  });

  it("uses inline Kiwi validation instead of the browser validation bubble", async () => {
    const bridge = installAuthBridge();
    render(<AccountAuth onAuthenticated={vi.fn()} />);

    await userEvent.click(screen.getByRole("button", { name: "Log In" }));

    const email = screen.getByLabelText("Email");
    expect(screen.getByRole("alert")).toHaveTextContent("Enter your email address.");
    expect(screen.getByRole("alert")).toHaveClass("auth__error");
    expect(email).toHaveFocus();
    expect(email).toHaveAttribute("aria-invalid", "true");
    expect(bridge.signInWithPassword).not.toHaveBeenCalled();
  });

  it("hands Google sign-in to the browser and continues when it succeeds", async () => {
    let complete!: (value: RendererAccountAuthResult) => void;
    const signIn = new Promise<RendererAccountAuthResult>((resolve) => {
      complete = resolve;
    });
    const bridge = installAuthBridge({ signInWithProvider: vi.fn(async () => signIn) });
    const onAuthenticated = vi.fn();
    render(<AccountAuth onAuthenticated={onAuthenticated} />);

    await userEvent.click(screen.getByRole("button", { name: "Log in with Google" }));
    expect(
      await screen.findByRole("heading", { name: "Finish signing in with Google" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();

    complete({
      status: "authenticated",
      account: { id: "google-1", email: "google@example.test", email_verified: true },
    });
    await waitFor(() => expect(onAuthenticated).toHaveBeenCalledOnce());
    expect(bridge.signInWithProvider).toHaveBeenCalledOnce();
  });

  it("cancels a pending Google browser handoff", async () => {
    let complete!: (value: RendererAccountAuthResult) => void;
    const signIn = new Promise<RendererAccountAuthResult>((resolve) => {
      complete = resolve;
    });
    const bridge = installAuthBridge({ signInWithProvider: vi.fn(async () => signIn) });
    render(<AccountAuth onAuthenticated={vi.fn()} />);

    await userEvent.click(screen.getByRole("button", { name: "Log in with Google" }));
    await userEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(bridge.cancelProviderSignIn).toHaveBeenCalledOnce();
    complete({ status: "error", code: "provider_cancelled", message: "Canceled." });
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("Google sign-in was canceled."),
    );
  });

  it("creates an account and resumes in verification mode with local fixture mail", async () => {
    const bridge = installAuthBridge();
    render(<AccountAuth onAuthenticated={vi.fn()} />);

    await userEvent.click(screen.getByRole("button", { name: "Create an Account" }));
    await fillAccountCreation("Reader@Example.Test");
    const email = screen.getByLabelText("Email");
    const kind = screen.getByLabelText("Address type");
    expect(email.closest(".email-entry__bar")).toContainElement(kind);
    await userEvent.selectOptions(kind, "institutional");
    await userEvent.click(screen.getByRole("button", { name: "Create an Account" }));

    expect(await screen.findByRole("heading", { name: "Check your email" })).toBeInTheDocument();
    expect(screen.getByLabelText("Verification code")).toHaveValue("KIWI-VERIFY-000001");
    expect(screen.getByText(/local mail fixture filled this code/i)).toBeInTheDocument();
    expect(bridge.createPasswordAccount).toHaveBeenCalledWith({
      email: "Reader@Example.Test",
      email_kind: "institutional",
      password: "a long orchard password",
      given_name: "Kiwi",
      family_name: "Reader",
      phone: "(415) 555-0134",
    });
  });

  it("continues only after the verification boundary authenticates", async () => {
    installAuthBridge();
    const onAuthenticated = vi.fn();
    render(<AccountAuth onAuthenticated={onAuthenticated} />);
    await userEvent.click(screen.getByRole("button", { name: "Create an Account" }));
    await fillAccountCreation();
    await userEvent.click(screen.getByRole("button", { name: "Create an Account" }));
    await userEvent.click(await screen.findByRole("button", { name: "Verify and continue" }));

    await waitFor(() =>
      expect(onAuthenticated).toHaveBeenCalledWith({
        id: "account-1",
        email: "reader@example.test",
        email_verified: true,
      }),
    );
  });

  it("requests a replacement verification code without leaving the verification panel", async () => {
    const bridge = installAuthBridge();
    render(<AccountAuth onAuthenticated={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Create an Account" }));
    await fillAccountCreation();
    await userEvent.click(screen.getByRole("button", { name: "Create an Account" }));

    await userEvent.click(await screen.findByRole("button", { name: "Send a new code" }));

    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("A new verification code was sent."),
    );
    expect(screen.getByLabelText("Verification code")).toHaveValue("KIWI-VERIFY-000002");
    expect(bridge.resendAccountEmailVerification).toHaveBeenCalledWith({
      email: "reader@example.test",
    });
  });

  it("uses a generic sign-in error and clears the submitted password", async () => {
    installAuthBridge();
    render(<AccountAuth onAuthenticated={vi.fn()} />);
    await userEvent.type(screen.getByLabelText("Email"), "unknown@example.test");
    await userEvent.type(screen.getByLabelText("Password"), "an incorrect long password");
    await userEvent.click(screen.getByRole("button", { name: "Log In" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The email or password is not correct.",
    );
    expect(screen.getByLabelText("Password")).toHaveValue("");
  });

  it("reveals and hides the password through an explicit accessible control", async () => {
    installAuthBridge();
    render(<AccountAuth onAuthenticated={vi.fn()} />);
    const password = screen.getByLabelText("Password");
    expect(password).toHaveAttribute("type", "password");
    await userEvent.click(screen.getByRole("button", { name: "Show" }));
    expect(password).toHaveAttribute("type", "text");
    expect(screen.getByRole("button", { name: "Hide" })).toHaveAttribute("aria-pressed", "true");
  });

  it("requests a generic reset and returns to sign in after changing the password", async () => {
    const bridge = installAuthBridge();
    render(<AccountAuth onAuthenticated={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Forgot Password?" }));
    await userEvent.type(screen.getByLabelText("Email"), "reader@example.test");
    await userEvent.click(screen.getByRole("button", { name: "Send reset code" }));

    expect(
      await screen.findByRole("heading", { name: "Choose a new password" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Reset code")).toHaveValue("KIWI-RESET-000001");
    await userEvent.type(screen.getByLabelText("New password"), "a different orchard password");
    await userEvent.type(screen.getByLabelText("Retype password"), "a different orchard password");
    await userEvent.click(screen.getByRole("button", { name: "Reset password" }));

    expect(await screen.findByRole("heading", { name: "Log In" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Your password was reset");
    expect(bridge.resetPassword).toHaveBeenCalledWith({
      email: "reader@example.test",
      code: "KIWI-RESET-000001",
      new_password: "a different orchard password",
    });
  });

  it("collects the required profile and confirms the password once during account creation", async () => {
    const bridge = installAuthBridge();
    render(<AccountAuth onAuthenticated={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Create an Account" }));
    expect(screen.getByLabelText("First name")).toHaveAttribute("autocomplete", "given-name");
    expect(screen.getByLabelText("Last name")).toHaveAttribute("autocomplete", "family-name");
    expect(screen.getByLabelText("Phone number")).toHaveAttribute("autocomplete", "tel");
    await fillAccountCreation("reader@example.test", "twelve orchard trees");
    await userEvent.click(screen.getByRole("button", { name: "Create an Account" }));

    expect(bridge.createPasswordAccount).toHaveBeenCalledWith({
      email: "reader@example.test",
      email_kind: "personal",
      password: "twelve orchard trees",
      given_name: "Kiwi",
      family_name: "Reader",
      phone: "(415) 555-0134",
    });
  });

  it("creates a complete Google account from the same one-time profile form", async () => {
    const bridge = installAuthBridge();
    render(<AccountAuth onAuthenticated={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Create an Account" }));

    const google = screen.getByRole("button", { name: "Sign up with Google" });
    await userEvent.click(google);
    expect(screen.getByRole("alert")).toHaveTextContent("Enter your first name.");
    expect(bridge.signInWithProvider).not.toHaveBeenCalled();

    await userEvent.type(screen.getByLabelText("First name"), "Kiwi");
    await userEvent.type(screen.getByLabelText("Last name"), "Reader");
    await userEvent.type(screen.getByLabelText("Phone number"), "(415) 555-0134");
    await userEvent.click(google);

    await waitFor(() =>
      expect(bridge.signInWithProvider).toHaveBeenCalledWith({
        provider: "google",
        registration_profile: {
          given_name: "Kiwi",
          family_name: "Reader",
          phone: "+14155550134",
        },
      }),
    );
  });

  it("shows only the requested password guidance on account creation", async () => {
    installAuthBridge();
    render(<AccountAuth onAuthenticated={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Create an Account" }));

    expect(
      screen.getByText(
        "Password must be at least 8 characters long. Avoid using common or easy passwords.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/welcome/i)).not.toBeInTheDocument();
    expect(screen.getByLabelText("Password")).toHaveAttribute("minlength", "8");
  });

  it("keeps mismatched account-creation passwords local to the form", async () => {
    const bridge = installAuthBridge();
    render(<AccountAuth onAuthenticated={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Create an Account" }));
    await userEvent.type(screen.getByLabelText("First name"), "Kiwi");
    await userEvent.type(screen.getByLabelText("Last name"), "Reader");
    await userEvent.type(screen.getByLabelText("Phone number"), "415-555-0134");
    await userEvent.type(screen.getByLabelText("Email"), "reader@example.test");
    await userEvent.type(screen.getByLabelText("Password"), "a long orchard password");
    await userEvent.type(screen.getByLabelText("Retype password"), "a different password");
    await userEvent.click(screen.getByRole("button", { name: "Create an Account" }));

    expect(screen.getByRole("alert")).toHaveTextContent("The passwords do not match.");
    expect(screen.getByLabelText("Retype password")).toHaveFocus();
    expect(bridge.createPasswordAccount).not.toHaveBeenCalled();
  });
  it("keeps primary account entry to Google and email with password", async () => {
    installAuthBridge();
    render(<AccountAuth onAuthenticated={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Log in with Google" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /ORCID/u })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
    expect(screen.getByLabelText("Password")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Create an Account" }));
    expect(screen.queryByRole("button", { name: /ORCID/u })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign up with Google" })).toBeInTheDocument();
  });
  it("tells the person a scheduled deletion was cancelled before continuing", async () => {
    const account = {
      id: "account-1",
      email: "reader@example.test",
      email_verified: true as const,
    };
    const onAuthenticated = vi.fn();
    installAuthBridge({
      signInWithPassword: vi.fn(async () => ({
        status: "authenticated" as const,
        account,
        deletion_cancelled: true as const,
      })),
    });
    render(<AccountAuth onAuthenticated={onAuthenticated} />);

    await userEvent.type(screen.getByLabelText("Email"), "reader@example.test");
    await userEvent.type(screen.getByLabelText("Password"), "a long orchard password");
    await userEvent.click(screen.getByRole("button", { name: "Log In" }));

    expect(await screen.findByRole("heading", { name: "Account restored" })).toBeInTheDocument();
    // The session already exists, but the person has to see what happened to it.
    expect(onAuthenticated).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(onAuthenticated).toHaveBeenCalledWith(account);
  });

  it("reports the same restoration after a provider sign-in", async () => {
    const account = {
      id: "account-1",
      email: "reader@example.test",
      email_verified: true as const,
    };
    installAuthBridge({
      signInWithProvider: vi.fn(async () => ({
        status: "authenticated" as const,
        account,
        deletion_cancelled: true as const,
      })),
    });
    render(<AccountAuth onAuthenticated={vi.fn()} />);

    await userEvent.click(screen.getByRole("button", { name: "Log in with Google" }));
    expect(await screen.findByRole("heading", { name: "Account restored" })).toBeInTheDocument();
  });
});
