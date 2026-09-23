import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MembersPage } from "./MembersPage.js";
import { forgetCollaborationSnapshots } from "./collaboration-snapshot.js";
import type {
  RendererBridge,
  RendererWorkspaceCollaborationResult,
  RendererWorkspaceCollaborationSnapshot,
} from "./bridge.js";

afterEach(() => {
  cleanup();
  forgetCollaborationSnapshots();
  delete window.kiwiDesktop;
});

type Snapshot = RendererWorkspaceCollaborationSnapshot;

const ADA: Snapshot["members"][number] = {
  user_id: "user-1",
  email: "ada@example.org",
  display_name: "Ada Lovelace",
  phone: null,
  role: "owner",
};

const WEI: Snapshot["members"][number] = {
  user_id: "user-2",
  email: "wei@example.org",
  display_name: "Wei Chen",
  phone: "+44 20 7946 0000",
  role: "viewer",
};

function snapshot(input: Partial<Snapshot> = {}): Snapshot {
  return {
    workspace: { id: "workspace-1", title: "Sleep and memory", role: "owner" },
    members: [ADA, WEI],
    invitations: [],
    projects: [],
    ...input,
  };
}

type Ask = Parameters<RendererBridge["manageWorkspaceCollaboration"]>[0];

/** Answers what the page asks the service, and records what it asked. */
function installBridge(
  answer:
    RendererWorkspaceCollaborationResult | ((ask: Ask) => RendererWorkspaceCollaborationResult),
) {
  const manageWorkspaceCollaboration = vi.fn(async (ask: Ask) =>
    typeof answer === "function" ? answer(ask) : answer,
  );
  window.kiwiDesktop = { manageWorkspaceCollaboration } as unknown as RendererBridge;
  return manageWorkspaceCollaboration;
}

const ACCOUNT = { id: "user-1", email: "ada@example.org" };

describe("Members page", () => {
  it("shows everybody with their role, the reader marked, and what the role means", async () => {
    const ask = installBridge({ status: "ok", settings: snapshot() });

    render(<MembersPage workspaceId="workspace-1" account={ACCOUNT} />);

    expect(await screen.findByText("Ada Lovelace")).toBeInTheDocument();
    expect(ask).toHaveBeenCalledWith({
      action: "snapshot",
      input: { workspace_id: "workspace-1" },
    });
    // Scoped to the roster: the same role words are said again in the invitation form below it.
    const roster = within(screen.getByRole("table"));
    expect(screen.getByText("(you)")).toBeInTheDocument();
    expect(roster.getByText("Owner")).toBeInTheDocument();
    expect(roster.getByText("Reads everything.")).toBeInTheDocument();
    // The phone number is on the roster because the service knows it and a collaborator is
    // somebody you may need to reach outside the app.
    expect(roster.getByText("+44 20 7946 0000")).toBeInTheDocument();
    expect(screen.getByText("2 people")).toBeInTheDocument();
  });

  it("says the reader's own role in the workspace, above the list", async () => {
    installBridge({
      status: "ok",
      settings: snapshot({
        workspace: { id: "workspace-1", title: "Sleep and memory", role: "admin" },
      }),
    });

    render(<MembersPage workspaceId="workspace-1" account={ACCOUNT} />);

    expect(await screen.findByText("Sleep and memory. You are an admin here.")).toBeInTheDocument();
  });

  it("lists an outstanding invitation with how long is left on it", async () => {
    // Three and a half days out, so the answer is three days whatever hour the test runs at.
    const expires = new Date(Date.now() + 3.5 * 24 * 60 * 60 * 1_000).toISOString();
    installBridge({
      status: "ok",
      settings: snapshot({
        invitations: [
          {
            id: "invitation-1",
            email: "bo@example.org",
            role: "editor",
            status: "pending",
            expires_at: expires,
          },
        ],
      }),
    });

    render(<MembersPage workspaceId="workspace-1" account={ACCOUNT} />);

    expect(await screen.findByText("bo@example.org")).toBeInTheDocument();
    const waiting = within(screen.getByRole("region", { name: "Invitations" }));
    expect(waiting.getByText("Editor")).toBeInTheDocument();
    expect(waiting.getByText("Expires in 3 days")).toBeInTheDocument();
  });

  it("says nobody is waiting rather than showing an empty list", async () => {
    installBridge({ status: "ok", settings: snapshot() });

    render(<MembersPage workspaceId="workspace-1" account={ACCOUNT} />);

    expect(
      await screen.findByText(
        "Nobody is waiting on an invitation. An invitation lasts seven days.",
      ),
    ).toBeInTheDocument();
  });

  it("has nothing to show when it has never heard from the service, and says that", async () => {
    installBridge({
      status: "error",
      code: "service_unavailable",
      message: "Workspace collaboration is unavailable.",
    });

    render(<MembersPage workspaceId="workspace-1" account={ACCOUNT} />);

    expect(
      await screen.findByText(
        "Kiwi cannot reach the account service, which is where the roster is kept. This window has not heard from it since it opened, so there is nothing to show yet.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText("Ada Lovelace")).not.toBeInTheDocument();
  });

  it("keeps showing the last roster when the service goes away, and says how old it is", async () => {
    // An empty roster reads as "you are alone here", which is a false statement about a workspace
    // with two people in it. The date is what keeps the old one honest.
    installBridge({ status: "ok", settings: snapshot() });
    render(<MembersPage workspaceId="workspace-1" account={ACCOUNT} />);
    expect(await screen.findByText("Ada Lovelace")).toBeInTheDocument();
    cleanup();

    installBridge({
      status: "error",
      code: "service_unavailable",
      message: "Workspace collaboration is unavailable.",
    });
    render(<MembersPage workspaceId="workspace-1" account={ACCOUNT} />);

    expect(
      await screen.findByText(
        "Kiwi cannot reach the account service. This is what it said a moment ago, and somebody may have been added or removed since.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("Wei Chen")).toBeInTheDocument();
  });

  it("explains a workspace the service has never been told about", async () => {
    installBridge({ status: "error", code: "not_found", message: "Workspace was not found." });

    render(<MembersPage workspaceId="workspace-1" account={ACCOUNT} />);

    expect(
      await screen.findByText(
        "This workspace has not been registered with the account service, so it has no roster yet. It is registered the first time you sign in with it open.",
      ),
    ).toBeInTheDocument();
  });

  it("asks again when told to, because the roster changes without this machine", async () => {
    let members = [ADA];
    const ask = installBridge(() => ({ status: "ok", settings: snapshot({ members }) }));

    render(<MembersPage workspaceId="workspace-1" account={ACCOUNT} />);
    expect(await screen.findByText("1 person")).toBeInTheDocument();

    members = [ADA, WEI];
    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));

    await waitFor(() => {
      expect(screen.getByText("Wei Chen")).toBeInTheDocument();
    });
    expect(ask).toHaveBeenCalledTimes(2);
  });
});

describe("inviting somebody", () => {
  const PENDING: Snapshot["invitations"][number] = {
    id: "invitation-1",
    email: "bo@example.org",
    role: "commenter",
    status: "pending",
    expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000).toISOString(),
  };

  /** Answers a snapshot with the workspace as it stands, and an invitation with `invited`. */
  function installInviting(invited: RendererWorkspaceCollaborationResult) {
    return installBridge((ask) =>
      ask.action === "invite" ? invited : { status: "ok", settings: snapshot() },
    );
  }

  it("says what each role can do where the role is chosen", async () => {
    // Five words in a menu mean nothing to somebody who has not read the schema, and this is the
    // moment the meaning is wanted.
    installInviting({ status: "ok", settings: snapshot() });

    render(<MembersPage workspaceId="workspace-1" account={ACCOUNT} />);

    expect(await screen.findByRole("radio", { name: /^Admin/ })).toBeInTheDocument();
    expect(
      within(screen.getByRole("region", { name: "Invite somebody" })).getByText(
        "Invites people, changes roles, and removes people.",
      ),
    ).toBeInTheDocument();
    // Ownership is not handed to an address that may not answer for a week, and the service
    // refuses it outright.
    expect(screen.queryByRole("radio", { name: /^Owner/ })).not.toBeInTheDocument();
  });

  it("sends the address and role, and says an invitation is out", async () => {
    const ask = installInviting({
      status: "ok",
      settings: snapshot({ invitations: [PENDING] }),
    });

    render(<MembersPage workspaceId="workspace-1" account={ACCOUNT} />);
    await screen.findByText("Ada Lovelace");
    await userEvent.type(screen.getByLabelText("Email address"), "  Bo@Example.org ");
    await userEvent.click(screen.getByRole("radio", { name: /^Commenter/ }));
    await userEvent.click(screen.getByRole("button", { name: "Send invitation" }));

    expect(
      await screen.findByText(
        "Invited bo@example.org as a commenter. Kiwi has queued an email to that address, and the invitation lasts seven days.",
      ),
    ).toBeInTheDocument();
    expect(ask).toHaveBeenLastCalledWith({
      action: "invite",
      input: { workspace_id: "workspace-1", email: "bo@example.org", role: "commenter" },
    });
  });

  it("says somebody joined outright when the address already had an account", async () => {
    // The service adds them on the spot in that case. "Invitation sent" would have the sender
    // watching for an acceptance that has already happened.
    const joined: Snapshot["members"][number] = {
      user_id: "user-3",
      email: "bo@example.org",
      display_name: "Bo Andersen",
      phone: null,
      role: "editor",
    };
    installInviting({ status: "ok", settings: snapshot({ members: [ADA, WEI, joined] }) });

    render(<MembersPage workspaceId="workspace-1" account={ACCOUNT} />);
    await screen.findByText("Ada Lovelace");
    await userEvent.type(screen.getByLabelText("Email address"), "bo@example.org");
    await userEvent.click(screen.getByRole("button", { name: "Send invitation" }));

    expect(
      await screen.findByText(
        "Bo Andersen is now an editor in this workspace. That address already had a Kiwi account, so there was nothing for them to accept.",
      ),
    ).toBeInTheDocument();
    // The roster is brought up to date from the same reply rather than asked for again.
    expect(screen.getByText("3 people")).toBeInTheDocument();
  });

  it("repeats what the service said when it refuses", async () => {
    // An invitation that fails quietly is an invitation somebody believes they sent, and they will
    // not find out otherwise for a week.
    installInviting({
      status: "error",
      code: "forbidden",
      message: "Your workspace role cannot make this change.",
    });

    render(<MembersPage workspaceId="workspace-1" account={ACCOUNT} />);
    await screen.findByText("Ada Lovelace");
    await userEvent.type(screen.getByLabelText("Email address"), "bo@example.org");
    await userEvent.click(screen.getByRole("button", { name: "Send invitation" }));

    expect(
      await screen.findByText(
        "The invitation was not sent. The account service said: Your workspace role cannot make this change.",
      ),
    ).toBeInTheDocument();
  });

  it("does not send something that is not an address", async () => {
    const ask = installInviting({ status: "ok", settings: snapshot() });

    render(<MembersPage workspaceId="workspace-1" account={ACCOUNT} />);
    await screen.findByText("Ada Lovelace");
    await userEvent.type(screen.getByLabelText("Email address"), "wei");
    await userEvent.click(screen.getByRole("button", { name: "Send invitation" }));

    expect(
      await screen.findByText(
        "That is not an email address. An invitation goes to an address like wei@example.org.",
      ),
    ).toBeInTheDocument();
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("will not invite somebody who is already here", async () => {
    // The service would take it as a role change. That is a different decision, made where the
    // role it is changing from is on screen.
    const ask = installInviting({ status: "ok", settings: snapshot() });

    render(<MembersPage workspaceId="workspace-1" account={ACCOUNT} />);
    await screen.findByText("Ada Lovelace");
    await userEvent.type(screen.getByLabelText("Email address"), "wei@example.org");
    await userEvent.click(screen.getByRole("button", { name: "Send invitation" }));

    expect(
      await screen.findByText(
        "Wei Chen is already a viewer here. Change their role on the roster rather than inviting them again.",
      ),
    ).toBeInTheDocument();
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("offers nothing to send while the roster on screen is an old one", async () => {
    installBridge({ status: "ok", settings: snapshot() });
    render(<MembersPage workspaceId="workspace-1" account={ACCOUNT} />);
    await screen.findByText("Ada Lovelace");
    cleanup();

    installBridge({
      status: "error",
      code: "service_unavailable",
      message: "Workspace collaboration is unavailable.",
    });
    render(<MembersPage workspaceId="workspace-1" account={ACCOUNT} />);

    expect(
      await screen.findByText(
        "Kiwi cannot reach the account service, so nothing can be sent from here until it can.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Email address")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Send invitation" })).toBeDisabled();
  });

  it("does not offer the form to somebody the service would refuse", async () => {
    installBridge({
      status: "ok",
      settings: snapshot({
        workspace: { id: "workspace-1", title: "Sleep and memory", role: "viewer" },
      }),
    });

    render(<MembersPage workspaceId="workspace-1" account={ACCOUNT} />);

    expect(
      await screen.findByText(
        "Invitations are sent by an owner or an admin. Ask one of the people above to invite somebody.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Email address")).not.toBeInTheDocument();
  });
});

describe("revoking an invitation", () => {
  const WAITING: Snapshot["invitations"][number] = {
    id: "invitation-1",
    email: "bo@example.org",
    role: "editor",
    status: "pending",
    expires_at: new Date(Date.now() + 3 * 24 * 60 * 60 * 1_000).toISOString(),
  };

  const LAPSED: Snapshot["invitations"][number] = {
    id: "invitation-2",
    email: "kit@example.org",
    role: "viewer",
    status: "expired",
    expires_at: new Date(Date.now() - 24 * 60 * 60 * 1_000).toISOString(),
  };

  /** Answers a snapshot with `WAITING` outstanding, and a revoke with `revoked`. */
  function installRevoking(revoked: RendererWorkspaceCollaborationResult) {
    return installBridge((ask) =>
      ask.action === "revoke_invitation"
        ? revoked
        : { status: "ok", settings: snapshot({ invitations: [WAITING] }) },
    );
  }

  it("takes back the invitation it names, and drops the row the service dropped", async () => {
    const ask = installRevoking({ status: "ok", settings: snapshot() });

    render(<MembersPage workspaceId="workspace-1" account={ACCOUNT} />);
    await userEvent.click(
      await screen.findByRole("button", { name: "Revoke the invitation to bo@example.org" }),
    );

    expect(ask).toHaveBeenLastCalledWith({
      action: "revoke_invitation",
      input: { workspace_id: "workspace-1", invitation_id: "invitation-1" },
    });
    expect(
      await screen.findByText(
        "The invitation to bo@example.org has been revoked. It can no longer be accepted, and that address can be invited again.",
      ),
    ).toBeInTheDocument();
    // The row leaves because the reply says it has left, not because the click was assumed to work.
    expect(
      screen.getByText("Nobody is waiting on an invitation. An invitation lasts seven days."),
    ).toBeInTheDocument();
  });

  it("reads a missing invitation as somebody having joined in the meantime", async () => {
    installRevoking({
      status: "error",
      code: "not_found",
      message: "That pending invitation was not found.",
    });

    render(<MembersPage workspaceId="workspace-1" account={ACCOUNT} />);
    await userEvent.click(
      await screen.findByRole("button", { name: "Revoke the invitation to bo@example.org" }),
    );

    expect(
      await screen.findByText(
        "The invitation to bo@example.org is no longer waiting. It was either accepted or it ran out. Refresh to see where it stands.",
      ),
    ).toBeInTheDocument();
    // Still listed: this window has not been told otherwise, and saying so is what Refresh is for.
    expect(screen.getByText("bo@example.org")).toBeInTheDocument();
  });

  it("offers nothing to revoke on an invitation that ran out, and says why", async () => {
    installBridge({ status: "ok", settings: snapshot({ invitations: [WAITING, LAPSED] }) });

    render(<MembersPage workspaceId="workspace-1" account={ACCOUNT} />);

    expect(await screen.findByText("kit@example.org")).toBeInTheDocument();
    const waiting = within(screen.getByRole("region", { name: "Invitations" }));
    expect(waiting.getAllByRole("button")).toHaveLength(1);
    expect(
      waiting.getByRole("button", { name: "Revoke the invitation to bo@example.org" }),
    ).toBeInTheDocument();
    expect(
      waiting.getByText(
        "An invitation that ran out cannot be accepted, so there is nothing to revoke. Invite the address again to send a new one.",
      ),
    ).toBeInTheDocument();
  });

  it("does not offer it to somebody the service would refuse", async () => {
    installBridge({
      status: "ok",
      settings: snapshot({
        workspace: { id: "workspace-1", title: "Sleep and memory", role: "viewer" },
        invitations: [WAITING],
      }),
    });

    render(<MembersPage workspaceId="workspace-1" account={ACCOUNT} />);

    expect(await screen.findByText("bo@example.org")).toBeInTheDocument();
    expect(
      within(screen.getByRole("region", { name: "Invitations" })).queryByRole("button"),
    ).not.toBeInTheDocument();
  });

  it("cannot be used while the list on screen is an old reading", async () => {
    installBridge({ status: "ok", settings: snapshot({ invitations: [WAITING] }) });
    render(<MembersPage workspaceId="workspace-1" account={ACCOUNT} />);
    await screen.findByText("bo@example.org");
    cleanup();

    installBridge({
      status: "error",
      code: "service_unavailable",
      message: "Workspace collaboration is unavailable.",
    });
    render(<MembersPage workspaceId="workspace-1" account={ACCOUNT} />);

    // Said once for the whole page, not beside each of the controls it disables.
    expect(
      await screen.findByText(
        "Kiwi cannot reach the account service, so nothing can be sent from here until it can.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Revoke the invitation to bo@example.org" }),
    ).toBeDisabled();
  });
});

describe("changing somebody's role", () => {
  /** Two owners, so that the roster offers a change on rows the service would take one for. */
  const OWNERS = [ADA, { ...WEI, role: "owner" }];

  it("changes the role it was asked to, and shows the roster the service answered with", async () => {
    const ask = installBridge((question) =>
      question.action === "update_member"
        ? { status: "ok", settings: snapshot({ members: [ADA, { ...WEI, role: "editor" }] }) }
        : { status: "ok", settings: snapshot() },
    );

    render(<MembersPage workspaceId="workspace-1" account={ACCOUNT} />);
    await userEvent.click(await screen.findByRole("button", { name: "Change Wei Chen's role" }));
    await userEvent.selectOptions(screen.getByLabelText("New role for Wei Chen"), "editor");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(ask).toHaveBeenLastCalledWith({
      action: "update_member",
      input: { workspace_id: "workspace-1", user_id: "user-2", role: "editor" },
    });
    expect(
      await screen.findByText("Wei Chen is now an editor in this workspace."),
    ).toBeInTheDocument();
    // The row reads Editor because the reply says so, not because the click was assumed to work.
    expect(within(screen.getByRole("table")).getByText("Editor")).toBeInTheDocument();
  });

  it("sends nothing until a different role has been picked", async () => {
    const ask = installBridge({ status: "ok", settings: snapshot() });

    render(<MembersPage workspaceId="workspace-1" account={ACCOUNT} />);
    await userEvent.click(await screen.findByRole("button", { name: "Change Wei Chen's role" }));

    // Opening the menu to read what is on it cannot end in a change.
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByLabelText("New role for Wei Chen")).not.toBeInTheDocument();
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("offers nothing on the only owner, and says what would have to happen first", async () => {
    installBridge({ status: "ok", settings: snapshot() });

    render(<MembersPage workspaceId="workspace-1" account={ACCOUNT} />);

    expect(
      await screen.findByText(
        "The only owner. Make somebody else an owner before changing this role or removing them.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Change Ada Lovelace's role" }),
    ).not.toBeInTheDocument();
    // The service refuses both on the same branch, so the row offers neither.
    expect(
      screen.queryByRole("button", { name: "Remove Ada Lovelace from this workspace" }),
    ).not.toBeInTheDocument();
  });

  it("warns the reader before they give up their own hold on this page", async () => {
    installBridge({ status: "ok", settings: snapshot({ members: OWNERS }) });

    render(<MembersPage workspaceId="workspace-1" account={ACCOUNT} />);
    await userEvent.click(
      await screen.findByRole("button", { name: "Change Ada Lovelace's role" }),
    );
    await userEvent.selectOptions(screen.getByLabelText("New role for Ada Lovelace"), "viewer");

    expect(
      screen.getByText(
        "This gives up your own ability to invite people, change roles, and remove people in this workspace. Only an owner or an admin can give it back.",
      ),
    ).toBeInTheDocument();
    // Said before the change, and it does not stand in the way of making it.
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  });

  it("reads the last owner refusal as needing somebody else made owner first", async () => {
    installBridge((question) =>
      question.action === "update_member"
        ? {
            status: "error",
            code: "last_owner",
            message: "Transfer ownership before changing the last owner.",
          }
        : { status: "ok", settings: snapshot({ members: OWNERS }) },
    );

    render(<MembersPage workspaceId="workspace-1" account={ACCOUNT} />);
    await userEvent.click(await screen.findByRole("button", { name: "Change Wei Chen's role" }));
    await userEvent.selectOptions(screen.getByLabelText("New role for Wei Chen"), "viewer");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(
      await screen.findByText(
        "Wei Chen's role was not changed. A workspace has to keep an owner. Make somebody else an owner first, and then this can change.",
      ),
    ).toBeInTheDocument();
  });

  it("does not offer it to somebody the service would refuse", async () => {
    installBridge({
      status: "ok",
      settings: snapshot({
        workspace: { id: "workspace-1", title: "Sleep and memory", role: "viewer" },
      }),
    });

    render(<MembersPage workspaceId="workspace-1" account={ACCOUNT} />);

    expect(await screen.findByText("Wei Chen")).toBeInTheDocument();
    expect(within(screen.getByRole("table")).queryByRole("button")).not.toBeInTheDocument();
  });

  it("cannot be used while the roster on screen is an old reading", async () => {
    installBridge({ status: "ok", settings: snapshot() });
    render(<MembersPage workspaceId="workspace-1" account={ACCOUNT} />);
    await screen.findByText("Wei Chen");
    cleanup();

    installBridge({
      status: "error",
      code: "service_unavailable",
      message: "Workspace collaboration is unavailable.",
    });
    render(<MembersPage workspaceId="workspace-1" account={ACCOUNT} />);

    expect(await screen.findByRole("button", { name: "Change Wei Chen's role" })).toBeDisabled();
  });
});

describe("removing somebody", () => {
  /** Two owners, so that the reader's own row is one the service would remove. */
  const OWNERS = [ADA, { ...WEI, role: "owner" }];

  it("removes the person whose name was typed, and shows the roster without them", async () => {
    const ask = installBridge((question) =>
      question.action === "remove_member"
        ? { status: "ok", settings: snapshot({ members: [ADA] }) }
        : { status: "ok", settings: snapshot() },
    );

    render(<MembersPage workspaceId="workspace-1" account={ACCOUNT} />);
    await userEvent.click(
      await screen.findByRole("button", { name: "Remove Wei Chen from this workspace" }),
    );
    await userEvent.type(screen.getByLabelText("Type Wei Chen to confirm"), "Wei Chen");
    await userEvent.click(screen.getByRole("button", { name: "Remove" }));

    expect(ask).toHaveBeenLastCalledWith({
      action: "remove_member",
      input: { workspace_id: "workspace-1", user_id: "user-2" },
    });
    expect(
      await screen.findByText(
        "Wei Chen is no longer a member of this workspace. They can be invited back at any time.",
      ),
    ).toBeInTheDocument();
    // The row is gone because the reply no longer has them in it.
    expect(within(screen.getByRole("table")).queryByText("Wei Chen")).not.toBeInTheDocument();
  });

  it("sends nothing until the name on the row has been typed", async () => {
    const ask = installBridge({ status: "ok", settings: snapshot() });

    render(<MembersPage workspaceId="workspace-1" account={ACCOUNT} />);
    await userEvent.click(
      await screen.findByRole("button", { name: "Remove Wei Chen from this workspace" }),
    );

    expect(screen.getByRole("button", { name: "Remove" })).toBeDisabled();
    // The mistake this is for: the right name, on the wrong row.
    await userEvent.type(screen.getByLabelText("Type Wei Chen to confirm"), "Ada Lovelace");
    expect(screen.getByRole("button", { name: "Remove" })).toBeDisabled();
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("forgets what was typed when the row is closed", async () => {
    installBridge({ status: "ok", settings: snapshot() });

    render(<MembersPage workspaceId="workspace-1" account={ACCOUNT} />);
    await userEvent.click(
      await screen.findByRole("button", { name: "Remove Wei Chen from this workspace" }),
    );
    await userEvent.type(screen.getByLabelText("Type Wei Chen to confirm"), "Wei Chen");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await userEvent.click(
      screen.getByRole("button", { name: "Remove Wei Chen from this workspace" }),
    );

    // A confirmation left standing from the last time it was opened is not a confirmation.
    expect(screen.getByLabelText("Type Wei Chen to confirm")).toHaveValue("");
    expect(screen.getByRole("button", { name: "Remove" })).toBeDisabled();
  });

  it("leaves one row open at a time", async () => {
    installBridge({ status: "ok", settings: snapshot({ members: OWNERS }) });

    render(<MembersPage workspaceId="workspace-1" account={ACCOUNT} />);
    await userEvent.click(
      await screen.findByRole("button", { name: "Change Ada Lovelace's role" }),
    );
    expect(screen.getByLabelText("New role for Ada Lovelace")).toBeInTheDocument();

    // Two half-answered rows is the state in which the wrong one gets finished.
    await userEvent.click(
      screen.getByRole("button", { name: "Remove Wei Chen from this workspace" }),
    );
    expect(screen.queryByLabelText("New role for Ada Lovelace")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Type Wei Chen to confirm")).toBeInTheDocument();
  });

  it("says whose access ends where the reader is removing themselves", async () => {
    installBridge({ status: "ok", settings: snapshot({ members: OWNERS }) });

    render(<MembersPage workspaceId="workspace-1" account={ACCOUNT} />);
    await userEvent.click(
      await screen.findByRole("button", { name: "Remove Ada Lovelace from this workspace" }),
    );

    expect(
      screen.getByText(
        "This removes your own access to this workspace. Only somebody who is still an owner or an admin here can invite you back.",
      ),
    ).toBeInTheDocument();
  });

  it("reads the last owner refusal as needing somebody else made owner first", async () => {
    installBridge((question) =>
      question.action === "remove_member"
        ? {
            status: "error",
            code: "last_owner",
            message: "Transfer ownership before changing the last owner.",
          }
        : { status: "ok", settings: snapshot({ members: OWNERS }) },
    );

    render(<MembersPage workspaceId="workspace-1" account={ACCOUNT} />);
    await userEvent.click(
      await screen.findByRole("button", { name: "Remove Wei Chen from this workspace" }),
    );
    await userEvent.type(screen.getByLabelText("Type Wei Chen to confirm"), "Wei Chen");
    await userEvent.click(screen.getByRole("button", { name: "Remove" }));

    expect(
      await screen.findByText(
        "Wei Chen was not removed. A workspace has to keep an owner. Make somebody else an owner first, and then they can be removed.",
      ),
    ).toBeInTheDocument();
  });

  it("cannot be used while the roster on screen is an old reading", async () => {
    installBridge({ status: "ok", settings: snapshot() });
    render(<MembersPage workspaceId="workspace-1" account={ACCOUNT} />);
    await screen.findByText("Wei Chen");
    cleanup();

    installBridge({
      status: "error",
      code: "service_unavailable",
      message: "Workspace collaboration is unavailable.",
    });
    render(<MembersPage workspaceId="workspace-1" account={ACCOUNT} />);

    expect(
      await screen.findByRole("button", { name: "Remove Wei Chen from this workspace" }),
    ).toBeDisabled();
  });
});

describe("project exceptions", () => {
  /** An editor, because an exception can only take access away and a viewer has none to lose. */
  const MAYA: Snapshot["members"][number] = {
    user_id: "user-3",
    email: "maya@example.org",
    display_name: "Maya Okonkwo",
    phone: null,
    role: "editor",
  };

  function withProjects(overrides: Snapshot["projects"][number]["member_overrides"]): Snapshot {
    return snapshot({
      members: [ADA, WEI, MAYA],
      projects: [
        {
          id: "project-1",
          name: "Pilot",
          sensitivity: "confidential",
          review_required: true,
          member_overrides: overrides,
        },
        {
          id: "project-2",
          name: "Trial two",
          sensitivity: "internal",
          review_required: false,
          member_overrides: [],
        },
      ],
    });
  }

  const NARROWED = {
    user_id: "user-3",
    display_name: "Maya Okonkwo",
    workspace_role: "editor",
    project_role: "commenter",
  };

  it("lists who is not on their usual footing, under the project it is on", async () => {
    installBridge({ status: "ok", settings: withProjects([NARROWED]) });

    render(<MembersPage workspaceId="workspace-1" account={ACCOUNT} />);

    expect(await screen.findByRole("heading", { name: "Pilot" })).toBeInTheDocument();
    expect(
      screen.getByText(
        "Commenter on this project, and an editor everywhere else in this workspace.",
      ),
    ).toBeInTheDocument();
    // A project with nothing unusual on it is not a row that says nothing; it is not a row.
    expect(screen.queryByRole("heading", { name: "Trial two" })).not.toBeInTheDocument();
  });

  it("says so plainly when nobody's access differs anywhere", async () => {
    installBridge({ status: "ok", settings: withProjects([]) });

    render(<MembersPage workspaceId="workspace-1" account={ACCOUNT} />);

    expect(
      await screen.findByText(
        "Everybody has their workspace role on every project here. This is where an exception to that would be listed.",
      ),
    ).toBeInTheDocument();
  });

  it("sends the project's own policy back unchanged with a changed exception", async () => {
    const ask = installBridge((question) =>
      question.action === "update_project"
        ? { status: "ok", settings: withProjects([{ ...NARROWED, project_role: "viewer" }]) }
        : { status: "ok", settings: withProjects([NARROWED]) },
    );

    render(<MembersPage workspaceId="workspace-1" account={ACCOUNT} />);
    await userEvent.click(
      await screen.findByRole("button", { name: "Change Maya Okonkwo's access on Pilot" }),
    );
    await userEvent.selectOptions(
      screen.getByLabelText("New access for Maya Okonkwo on Pilot"),
      "viewer",
    );
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    // The service takes the policy and the exception together, so an untouched policy still has to
    // be sent, and sent as it was read.
    expect(ask).toHaveBeenLastCalledWith({
      action: "update_project",
      input: {
        workspace_id: "workspace-1",
        project_id: "project-1",
        sensitivity: "confidential",
        review_required: true,
        member_user_id: "user-3",
        member_role: "viewer",
      },
    });
  });

  it("ends an exception by putting somebody back on their workspace role", async () => {
    const ask = installBridge((question) =>
      question.action === "update_project"
        ? { status: "ok", settings: withProjects([]) }
        : { status: "ok", settings: withProjects([NARROWED]) },
    );

    render(<MembersPage workspaceId="workspace-1" account={ACCOUNT} />);
    await userEvent.click(
      await screen.findByRole("button", { name: "Change Maya Okonkwo's access on Pilot" }),
    );
    await userEvent.selectOptions(
      screen.getByLabelText("New access for Maya Okonkwo on Pilot"),
      "editor",
    );
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(ask).toHaveBeenLastCalledWith({
      action: "update_project",
      input: {
        workspace_id: "workspace-1",
        project_id: "project-1",
        sensitivity: "confidential",
        review_required: true,
        member_user_id: "user-3",
        member_role: "editor",
      },
    });
    expect(
      await screen.findByText(
        "Maya Okonkwo is back to their workspace role on Pilot, so they are an editor there like everywhere else.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Pilot" })).not.toBeInTheDocument();
  });

  it("sends nothing until the choice is different from what is recorded", async () => {
    const ask = installBridge({ status: "ok", settings: withProjects([NARROWED]) });

    render(<MembersPage workspaceId="workspace-1" account={ACCOUNT} />);
    await userEvent.click(
      await screen.findByRole("button", { name: "Change Maya Okonkwo's access on Pilot" }),
    );

    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("adds one by naming the project, the person, and what they are left with", async () => {
    const ask = installBridge((question) =>
      question.action === "update_project"
        ? { status: "ok", settings: withProjects([NARROWED]) }
        : { status: "ok", settings: withProjects([]) },
    );

    render(<MembersPage workspaceId="workspace-1" account={ACCOUNT} />);
    await userEvent.selectOptions(await screen.findByLabelText("Project"), "project-1");
    await userEvent.selectOptions(screen.getByLabelText("Person"), "user-3");
    await userEvent.selectOptions(screen.getByLabelText("Access on Pilot"), "commenter");
    await userEvent.click(screen.getByRole("button", { name: "Add exception" }));

    expect(ask).toHaveBeenLastCalledWith({
      action: "update_project",
      input: {
        workspace_id: "workspace-1",
        project_id: "project-1",
        sensitivity: "confidential",
        review_required: true,
        member_user_id: "user-3",
        member_role: "commenter",
      },
    });
    expect(
      await screen.findByText(
        "Maya Okonkwo is a commenter on Pilot, and keeps their workspace role everywhere else.",
      ),
    ).toBeInTheDocument();
  });

  it("does not offer somebody who has nothing left to lose or who already has one", async () => {
    installBridge({ status: "ok", settings: withProjects([NARROWED]) });

    render(<MembersPage workspaceId="workspace-1" account={ACCOUNT} />);
    await userEvent.selectOptions(await screen.findByLabelText("Project"), "project-1");

    const people = within(screen.getByLabelText("Person"));
    expect(people.getByRole("option", { name: "Ada Lovelace (Owner here)" })).toBeInTheDocument();
    // Wei is a viewer, which is the least there is to give; Maya already has an exception here.
    expect(people.queryByRole("option", { name: /Wei Chen/ })).not.toBeInTheDocument();
    expect(people.queryByRole("option", { name: /Maya Okonkwo/ })).not.toBeInTheDocument();
  });

  it("forgets an answer given before the project was changed", async () => {
    installBridge({ status: "ok", settings: withProjects([]) });

    render(<MembersPage workspaceId="workspace-1" account={ACCOUNT} />);
    await userEvent.selectOptions(await screen.findByLabelText("Project"), "project-1");
    await userEvent.selectOptions(screen.getByLabelText("Person"), "user-3");
    await userEvent.selectOptions(screen.getByLabelText("Access on Pilot"), "commenter");
    await userEvent.selectOptions(screen.getByLabelText("Project"), "project-2");

    expect(screen.getByLabelText("Person")).toHaveValue("");
    expect(screen.getByRole("button", { name: "Add exception" })).toBeDisabled();
  });

  it("shows access above a workspace role and says it cannot be set again", async () => {
    installBridge({
      status: "ok",
      settings: withProjects([{ ...NARROWED, project_role: "admin" }]),
    });

    render(<MembersPage workspaceId="workspace-1" account={ACCOUNT} />);

    expect(
      await screen.findByText(
        "This is more than Maya Okonkwo has in the rest of the workspace. It was recorded before their workspace role changed and cannot be set again. Choose a role at or below their workspace role to put it right.",
      ),
    ).toBeInTheDocument();
  });

  it("repeats the rule about narrowing when the service refuses", async () => {
    installBridge((question) =>
      question.action === "update_project"
        ? {
            status: "error",
            code: "forbidden",
            message: "Project access can narrow a workspace role, but it cannot expand it.",
          }
        : { status: "ok", settings: withProjects([NARROWED]) },
    );

    render(<MembersPage workspaceId="workspace-1" account={ACCOUNT} />);
    await userEvent.click(
      await screen.findByRole("button", { name: "Change Maya Okonkwo's access on Pilot" }),
    );
    await userEvent.selectOptions(
      screen.getByLabelText("New access for Maya Okonkwo on Pilot"),
      "viewer",
    );
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(
      await screen.findByText(
        "Maya Okonkwo's access on Pilot was not changed. Project access can narrow a workspace role, but it cannot expand it.",
      ),
    ).toBeInTheDocument();
  });

  it("shows the list to somebody who cannot change it, and offers them nothing", async () => {
    installBridge({
      status: "ok",
      settings: {
        ...withProjects([NARROWED]),
        workspace: { id: "workspace-1", title: "Sleep and memory", role: "editor" },
      },
    });

    render(<MembersPage workspaceId="workspace-1" account={ACCOUNT} />);

    expect(await screen.findByRole("heading", { name: "Pilot" })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Change Maya Okonkwo's access on Pilot" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Project")).not.toBeInTheDocument();
  });

  it("cannot be used while the list on screen is an old reading", async () => {
    installBridge({ status: "ok", settings: withProjects([NARROWED]) });
    render(<MembersPage workspaceId="workspace-1" account={ACCOUNT} />);
    await screen.findByRole("heading", { name: "Pilot" });
    cleanup();

    installBridge({
      status: "error",
      code: "service_unavailable",
      message: "Workspace collaboration is unavailable.",
    });
    render(<MembersPage workspaceId="workspace-1" account={ACCOUNT} />);

    expect(
      await screen.findByRole("button", { name: "Change Maya Okonkwo's access on Pilot" }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "Add exception" })).toBeDisabled();
  });
});
