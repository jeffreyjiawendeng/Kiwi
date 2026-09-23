import { describe, expect, it } from "vitest";
import type { RendererWorkspaceCollaborationSnapshot } from "./bridge.js";
import {
  checkInvite,
  describeInviteOutcome,
  describeRevoked,
  revokeRefusal,
} from "./member-invites.js";

type Snapshot = RendererWorkspaceCollaborationSnapshot;

function snapshot(input: Partial<Snapshot> = {}): Snapshot {
  return {
    workspace: { id: "workspace-1", title: "Sleep and memory", role: "owner" },
    members: [],
    invitations: [],
    projects: [],
    ...input,
  };
}

function member(input: Partial<Snapshot["members"][number]>): Snapshot["members"][number] {
  return {
    user_id: "user-1",
    email: "wei@example.org",
    display_name: "Wei Chen",
    phone: null,
    role: "viewer",
    ...input,
  };
}

function invitation(
  input: Partial<Snapshot["invitations"][number]>,
): Snapshot["invitations"][number] {
  return {
    id: "invitation-1",
    email: "bo@example.org",
    role: "editor",
    status: "pending",
    expires_at: "2026-09-03T00:00:00.000Z",
    ...input,
  };
}

describe("what may be invited", () => {
  it("takes an address the way the service will store it", () => {
    // The service trims and lowercases before it does anything else. Checking a different string
    // from the one that will be stored is how a check passes and the service still matches.
    expect(checkInvite(snapshot(), "  Bo@Example.org ")).toEqual({
      ok: true,
      email: "bo@example.org",
    });
  });

  it("asks for an address when the box is empty", () => {
    expect(checkInvite(snapshot(), "   ")).toEqual({
      ok: false,
      problem: "Enter the email address to invite.",
    });
  });

  it("will not send to something that is not an address at all", () => {
    const checked = checkInvite(snapshot(), "wei");

    expect(checked).toEqual({
      ok: false,
      problem:
        "That is not an email address. An invitation goes to an address like wei@example.org.",
    });
  });

  it("says somebody is already here rather than quietly changing their role", () => {
    // The service treats an invitation to an existing member as a role change. That is a different
    // decision, made where you can see what the role is now.
    const checked = checkInvite(snapshot({ members: [member({})] }), "WEI@example.org");

    expect(checked).toEqual({
      ok: false,
      problem:
        "Wei Chen is already a viewer here. Change their role on the roster rather than inviting them again.",
    });
  });

  it("calls somebody already here by their address when they have no name", () => {
    const checked = checkInvite(
      snapshot({ members: [member({ display_name: " ", role: "admin" })] }),
      "wei@example.org",
    );

    expect(checked).toEqual({
      ok: false,
      problem:
        "wei@example.org is already an admin here. Change their role on the roster rather than inviting them again.",
    });
  });

  it("will not send a second invitation to an address already waiting on one", () => {
    const checked = checkInvite(snapshot({ invitations: [invitation({})] }), "bo@example.org");

    expect(checked).toEqual({
      ok: false,
      problem:
        "bo@example.org already has an invitation waiting. Revoke it first if you want to invite them as something else.",
    });
  });

  it("lets an invitation that ran out or was revoked be sent again", () => {
    // Those are the two states somebody is looking at when they decide to invite again.
    const lapsed = snapshot({ invitations: [invitation({ status: "expired" })] });
    const dropped = snapshot({ invitations: [invitation({ status: "revoked" })] });

    expect(checkInvite(lapsed, "bo@example.org")).toEqual({ ok: true, email: "bo@example.org" });
    expect(checkInvite(dropped, "bo@example.org")).toEqual({ ok: true, email: "bo@example.org" });
  });
});

describe("what the service did with it", () => {
  it("says somebody joined when the address already had an account", () => {
    // The service adds them on the spot in that case. Telling somebody an invitation is waiting
    // would have them watching for an acceptance that has already happened.
    const after = snapshot({
      members: [member({ email: "bo@example.org", display_name: "Bo Andersen", role: "editor" })],
    });

    expect(describeInviteOutcome(after, "bo@example.org", "editor")).toBe(
      "Bo Andersen is now an editor in this workspace. That address already had a Kiwi account, so there was nothing for them to accept.",
    );
  });

  it("says an invitation is out when nobody was there to add", () => {
    const after = snapshot({ invitations: [invitation({ role: "commenter" })] });

    expect(describeInviteOutcome(after, "bo@example.org", "commenter")).toBe(
      "Invited bo@example.org as a commenter. Kiwi has queued an email to that address, and the invitation lasts seven days.",
    );
  });

  it("still says the service accepted it when the reply shows neither", () => {
    expect(describeInviteOutcome(snapshot(), "bo@example.org", "viewer")).toBe(
      "The account service accepted the invitation for bo@example.org.",
    );
  });
});

describe("taking an invitation back", () => {
  it("says the address can be invited again, which is the next question", () => {
    expect(describeRevoked("bo@example.org")).toBe(
      "The invitation to bo@example.org has been revoked. It can no longer be accepted, and that address can be invited again.",
    );
  });

  it("reads a missing invitation as somebody having joined or the week having run out", () => {
    // The service only revokes a pending row, and sweeps the lapsed ones out of pending first, so
    // its own words for this sound like a fault when they are nearly always a race.
    expect(
      revokeRefusal("not_found", "That pending invitation was not found.", "bo@example.org"),
    ).toBe(
      "The invitation to bo@example.org is no longer waiting. It was either accepted or it ran out. Refresh to see where it stands.",
    );
  });

  it("says who may revoke when the service says the role cannot", () => {
    expect(
      revokeRefusal("forbidden", "Your workspace role cannot make this change.", "bo@example.org"),
    ).toBe(
      "bo@example.org was not un-invited. Only an owner or an admin can revoke an invitation.",
    );
  });

  it("repeats anything else in the words the service used", () => {
    expect(revokeRefusal("internal_error", "Something went wrong.", "bo@example.org")).toBe(
      "bo@example.org was not un-invited. The account service said: Something went wrong.",
    );
  });
});
