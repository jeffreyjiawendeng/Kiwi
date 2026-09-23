import { describe, expect, it } from "vitest";
import type { RendererWorkspaceCollaborationSnapshot } from "./bridge.js";
import { describeAge, pendingInvitations, roleLabel, rosterFrom } from "./members-roster.js";

type Snapshot = RendererWorkspaceCollaborationSnapshot;

function snapshot(input: Partial<Snapshot>): Snapshot {
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
    email: "a@example.org",
    display_name: "Ada Lovelace",
    phone: null,
    role: "editor",
    ...input,
  };
}

function invitation(
  input: Partial<Snapshot["invitations"][number]>,
): Snapshot["invitations"][number] {
  return {
    id: "invitation-1",
    email: "a@example.org",
    role: "editor",
    status: "pending",
    expires_at: "2026-09-03T00:00:00.000Z",
    ...input,
  };
}

const NOW = new Date("2026-08-27T00:00:00.000Z");

describe("the roster", () => {
  it("puts the people who can change things first, then reads alphabetically", () => {
    const people = rosterFrom(
      snapshot({
        members: [
          member({ user_id: "user-1", display_name: "Zoe Byrne", role: "viewer" }),
          member({ user_id: "user-2", display_name: "Ada Lovelace", role: "owner" }),
          member({ user_id: "user-3", display_name: "Wei Chen", role: "admin" }),
          member({ user_id: "user-4", display_name: "Bo Andersen", role: "admin" }),
        ],
      }),
      null,
    );

    expect(people.map((person) => person.name)).toEqual([
      "Ada Lovelace",
      "Bo Andersen",
      "Wei Chen",
      "Zoe Byrne",
    ]);
  });

  it("marks the person reading it, so they can find their own row", () => {
    const people = rosterFrom(
      snapshot({
        members: [
          member({ user_id: "user-1", display_name: "Ada Lovelace", role: "owner" }),
          member({ user_id: "user-2", display_name: "Wei Chen", role: "editor" }),
        ],
      }),
      "user-2",
    );

    expect(people.map((person) => person.isSelf)).toEqual([false, true]);
  });

  it("calls somebody by their address when they have not given a name", () => {
    // A blank name is a person with access all the same, and the row has to say who.
    const people = rosterFrom(
      snapshot({ members: [member({ display_name: "  ", email: "wei@example.org" })] }),
      null,
    );

    expect(people[0]?.name).toBe("wei@example.org");
  });

  it("shows a role it has never heard of rather than dropping the person who holds it", () => {
    // A newer service could add a role. Leaving that person off the roster would be a page that
    // says who has access and is wrong about it, which is the one thing it must not be.
    const people = rosterFrom(
      snapshot({
        members: [
          member({ user_id: "user-1", display_name: "Ada Lovelace", role: "archivist" }),
          member({ user_id: "user-2", display_name: "Wei Chen", role: "viewer" }),
        ],
      }),
      null,
    );

    expect(people.map((person) => [person.name, person.role])).toEqual([
      ["Wei Chen", "viewer"],
      ["Ada Lovelace", "archivist"],
    ]);
    expect(roleLabel("archivist")).toBe("archivist");
  });
});

describe("invitations still worth showing", () => {
  it("leaves out one that was accepted, because that person is already a member", () => {
    // Listed in both places, five people would fill six rows and nothing would say which.
    const rows = pendingInvitations(
      snapshot({
        invitations: [
          invitation({ id: "invitation-1", email: "a@example.org", status: "accepted" }),
          invitation({ id: "invitation-2", email: "b@example.org", status: "pending" }),
        ],
      }),
      NOW,
    );

    expect(rows.map((row) => row.id)).toEqual(["invitation-2"]);
  });

  it("leaves out one that was revoked, because that is a decision already made", () => {
    const rows = pendingInvitations(
      snapshot({ invitations: [invitation({ status: "revoked" })] }),
      NOW,
    );

    expect(rows).toEqual([]);
  });

  it("keeps one that ran out, because it answers where somebody got to", () => {
    const rows = pendingInvitations(
      snapshot({
        invitations: [
          invitation({
            id: "invitation-1",
            status: "expired",
            expires_at: "2026-08-20T00:00:00.000Z",
          }),
        ],
      }),
      NOW,
    );

    expect(rows).toEqual([
      {
        id: "invitation-1",
        email: "a@example.org",
        role: "editor",
        expired: true,
        expiry: "Expired",
      },
    ]);
  });

  it("counts an invitation out even where the service has not caught up with the clock", () => {
    // The service marks these expired when somebody asks for the settings. Between that sweep and
    // this page, a `pending` row whose date has gone is still an invitation nobody can accept.
    const rows = pendingInvitations(
      snapshot({ invitations: [invitation({ expires_at: "2026-08-26T00:00:00.000Z" })] }),
      NOW,
    );

    expect(rows[0]?.expired).toBe(true);
    expect(rows[0]?.expiry).toBe("Expired");
  });

  it("says how long is left in days, and names today and tomorrow", () => {
    const rows = pendingInvitations(
      snapshot({
        invitations: [
          invitation({ id: "a", email: "a@example.org", expires_at: "2026-08-27T18:00:00.000Z" }),
          invitation({ id: "b", email: "b@example.org", expires_at: "2026-08-28T06:00:00.000Z" }),
          invitation({ id: "c", email: "c@example.org", expires_at: "2026-09-02T00:00:00.000Z" }),
        ],
      }),
      NOW,
    );

    expect(rows.map((row) => row.expiry)).toEqual([
      "Expires today",
      "Expires tomorrow",
      "Expires in 6 days",
    ]);
  });

  it("puts the outstanding ones above the ones that ran out", () => {
    const rows = pendingInvitations(
      snapshot({
        invitations: [
          invitation({ id: "a", email: "a@example.org", status: "expired" }),
          invitation({ id: "b", email: "b@example.org", status: "pending" }),
        ],
      }),
      NOW,
    );

    expect(rows.map((row) => row.id)).toEqual(["b", "a"]);
  });

  it("says nothing about a date it cannot read rather than guessing at one", () => {
    const rows = pendingInvitations(
      snapshot({ invitations: [invitation({ expires_at: "soon" })] }),
      NOW,
    );

    expect(rows[0]).toEqual({
      id: "invitation-1",
      email: "a@example.org",
      role: "editor",
      expired: false,
      expiry: "",
    });
  });
});

describe("how old a reading is", () => {
  const at = new Date("2026-08-27T12:00:00.000Z");
  const later = (minutes: number): Date => new Date(at.getTime() + minutes * 60_000);

  it("counts in the units somebody would say it in", () => {
    expect(describeAge(at, later(0))).toBe("a moment ago");
    expect(describeAge(at, later(1))).toBe("a minute ago");
    expect(describeAge(at, later(42))).toBe("42 minutes ago");
    expect(describeAge(at, later(70))).toBe("an hour ago");
    expect(describeAge(at, later(60 * 5))).toBe("5 hours ago");
    expect(describeAge(at, later(60 * 26))).toBe("yesterday");
    expect(describeAge(at, later(60 * 24 * 9))).toBe("9 days ago");
  });

  it("does not report a reading from the future as ageing", () => {
    // Two machines whose clocks disagree is ordinary. A negative age would read as nonsense; the
    // reading itself is still the newest thing there is.
    expect(describeAge(at, new Date(at.getTime() - 60_000))).toBe("a moment ago");
  });
});
