import { describe, expect, it } from "vitest";
import { confirmsRemoval, describeRemoved, removalRefusal, warnRemoval } from "./member-removal.js";

describe("confirming a removal by typing the name", () => {
  it("accepts the name as it is written on the row", () => {
    expect(confirmsRemoval("Wei Chen", "Wei Chen")).toBe(true);
  });

  it("does not hold case or stray space against somebody who plainly read the row", () => {
    expect(confirmsRemoval("  wei chen ", "Wei Chen")).toBe(true);
  });

  it("refuses a different person's name, which is the mistake this is for", () => {
    expect(confirmsRemoval("Ada Lovelace", "Wei Chen")).toBe(false);
  });

  it("refuses a name that is only the beginning of the one on the row", () => {
    expect(confirmsRemoval("Wei", "Wei Chen")).toBe(false);
  });

  it("is not satisfied by an empty box even where the row has no name", () => {
    expect(confirmsRemoval("", "")).toBe(false);
  });
});

describe("what removing somebody costs", () => {
  it("says the invitation has to be sent again", () => {
    expect(warnRemoval("Wei Chen", false)).toBe(
      "Wei Chen loses access to this workspace. They can be invited back, but the invitation has to be sent again and accepted.",
    );
  });

  it("says whose access ends where somebody is removing themselves", () => {
    expect(warnRemoval("Ada Lovelace", true)).toContain("removes your own access");
  });
});

describe("saying a removal happened", () => {
  it("names the person and that they can come back", () => {
    expect(describeRemoved("Wei Chen", false)).toBe(
      "Wei Chen is no longer a member of this workspace. They can be invited back at any time.",
    );
  });

  it("tells somebody who removed themselves who can invite them back", () => {
    expect(describeRemoved("Ada Lovelace", true)).toContain("has to invite you back");
  });
});

describe("why somebody could not be removed", () => {
  it("reads the last owner as needing somebody else made owner first", () => {
    const said = removalRefusal(
      "last_owner",
      "Transfer ownership before changing the last owner.",
      "Ada",
    );
    expect(said).toBe(
      "Ada was not removed. A workspace has to keep an owner. Make somebody else an owner first, and then they can be removed.",
    );
  });

  it("reads a missing member as somebody who has already left", () => {
    const said = removalRefusal("not_found", "That collaborator is no longer a member.", "Wei");
    expect(said).toContain("no longer a member of this workspace");
    expect(said).toContain("Refresh");
  });

  it("repeats a refusal about who may do what in the service's own words", () => {
    expect(removalRefusal("forbidden", "Your workspace role cannot make this change.", "Wei")).toBe(
      "Wei was not removed. Your workspace role cannot make this change.",
    );
  });

  it("passes anything else on as what the account service said", () => {
    expect(removalRefusal("wobbly", "The database is on fire.", "Wei")).toBe(
      "Wei was not removed. The account service said: The database is on fire.",
    );
  });
});
