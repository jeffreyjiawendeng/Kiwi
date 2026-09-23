import { describe, expect, it } from "vitest";
import { describeRoleChange, roleOptions, roleRefusal, warnSelfChange } from "./member-roles.js";

describe("what a role may be changed to", () => {
  it("offers an owner every role", () => {
    expect(roleOptions("owner", "viewer")).toEqual([
      "owner",
      "admin",
      "editor",
      "commenter",
      "viewer",
    ]);
  });

  it("does not offer an admin the owner role, which the service would refuse from them", () => {
    expect(roleOptions("admin", "viewer")).toEqual(["admin", "editor", "commenter", "viewer"]);
  });

  it("shows the role somebody has now even where this account could not assign it", () => {
    // An admin looking at an owner: the menu still has to be able to say what they are.
    expect(roleOptions("admin", "owner")).toEqual([
      "owner",
      "admin",
      "editor",
      "commenter",
      "viewer",
    ]);
  });

  it("shows a role this build has never heard of as what they have", () => {
    expect(roleOptions("owner", "archivist")).toContain("archivist");
  });
});

describe("saying a role change happened", () => {
  it("names the person and their new role", () => {
    expect(describeRoleChange("Wei Chen", "editor", false)).toBe(
      "Wei Chen is now an editor in this workspace.",
    );
  });

  it("tells somebody who stepped down what they have given up", () => {
    expect(describeRoleChange("Ada Lovelace", "viewer", true)).toContain("You are now a viewer");
    expect(describeRoleChange("Ada Lovelace", "viewer", true)).toContain("no longer invite people");
  });

  it("says nothing about giving anything up where an owner became an admin", () => {
    expect(describeRoleChange("Ada Lovelace", "admin", true)).toBe(
      "Ada Lovelace is now an admin in this workspace.",
    );
  });
});

describe("warning before a role change", () => {
  it("warns somebody about to give up their own hold on this page", () => {
    expect(warnSelfChange(true, "commenter")).toContain("gives up your own ability");
  });

  it("says nothing where the reader would still be managing", () => {
    expect(warnSelfChange(true, "admin")).toBeNull();
  });

  it("says nothing about anybody else's row", () => {
    expect(warnSelfChange(false, "viewer")).toBeNull();
  });
});

describe("why a role could not be changed", () => {
  it("reads the last owner as needing somebody else made owner first", () => {
    const said = roleRefusal(
      "last_owner",
      "Transfer ownership before changing the last owner.",
      "Ada",
    );
    expect(said).toBe(
      "Ada's role was not changed. A workspace has to keep an owner. Make somebody else an owner first, and then this can change.",
    );
  });

  it("reads a missing member as somebody who has already left", () => {
    const said = roleRefusal("not_found", "That collaborator is no longer a member.", "Wei");
    expect(said).toContain("no longer a member of this workspace");
    expect(said).toContain("Refresh");
  });

  it("repeats a refusal about who may do what in the service's own words", () => {
    expect(roleRefusal("forbidden", "Only an owner can assign that role.", "Wei")).toBe(
      "Wei's role was not changed. Only an owner can assign that role.",
    );
  });

  it("passes anything else on as what the account service said", () => {
    expect(roleRefusal("wobbly", "The database is on fire.", "Wei")).toBe(
      "Wei's role was not changed. The account service said: The database is on fire.",
    );
  });
});
