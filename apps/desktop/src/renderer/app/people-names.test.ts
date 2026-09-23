import { describe, expect, it } from "vitest";
import { peopleNames } from "./people-names.js";

const SNAPSHOT = {
  workspace: { id: "workspace-1", title: "Zhang Lab", role: "owner" },
  members: [
    {
      user_id: "ana",
      email: "ana@example.org",
      display_name: "Ana Lindqvist",
      phone: null,
      role: "owner",
    },
    { user_id: "ben", email: "ben@example.org", display_name: "", phone: null, role: "editor" },
  ],
  invitations: [],
  projects: [],
};

describe("what people are called", () => {
  it("names members by display name, and by address when they have none", () => {
    const names = peopleNames(SNAPSHOT, undefined);
    expect(names.get("ana")).toBe("Ana Lindqvist");
    expect(names.get("ben")).toBe("ben@example.org");
  });

  it("names the person reading from their sign-in when the service has not answered", () => {
    const names = peopleNames(null, { id: "ana", email: "ana@example.org" });
    expect(names.get("ana")).toBe("ana@example.org");
  });

  it("prefers the roster's name for the person reading", () => {
    const names = peopleNames(SNAPSHOT, { id: "ana", email: "ana@example.org" });
    expect(names.get("ana")).toBe("Ana Lindqvist");
  });
});
