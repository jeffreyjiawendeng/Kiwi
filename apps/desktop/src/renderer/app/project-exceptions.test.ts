import { describe, expect, it } from "vitest";
import type { RendererWorkspaceCollaborationSnapshot } from "./bridge.js";
import {
  canBeExcepted,
  candidateMembers,
  describeException,
  describeExceptionLifted,
  describeExceptionSet,
  exceptionRefusal,
  exceptionRoleOptions,
  exceptionsFrom,
  lesserRoles,
  projectPolicies,
  warnWidened,
} from "./project-exceptions.js";

type Snapshot = RendererWorkspaceCollaborationSnapshot;
type Override = Snapshot["projects"][number]["member_overrides"][number];

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
  phone: null,
  role: "editor",
};

const SAM: Snapshot["members"][number] = {
  user_id: "user-3",
  email: "sam@example.org",
  display_name: "Sam Okafor",
  phone: null,
  role: "viewer",
};

function project(
  id: string,
  name: string,
  overrides: Override[] = [],
): Snapshot["projects"][number] {
  return {
    id,
    name,
    sensitivity: "internal",
    review_required: false,
    member_overrides: overrides,
  };
}

function snapshot(projects: Snapshot["projects"]): Snapshot {
  return {
    workspace: { id: "workspace-1", title: "Sleep and memory", role: "owner" },
    members: [ADA, WEI, SAM],
    invitations: [],
    projects,
  };
}

const NARROWED: Override = {
  user_id: "user-2",
  display_name: "Wei Chen",
  workspace_role: "editor",
  project_role: "commenter",
};

describe("finding the exceptions", () => {
  it("keeps only the access that differs from the workspace role", () => {
    const groups = exceptionsFrom(
      snapshot([
        project("project-1", "Trial two", [
          NARROWED,
          {
            user_id: "user-1",
            display_name: "Ada Lovelace",
            workspace_role: "owner",
            project_role: "owner",
          },
        ]),
      ]),
    );

    expect(groups).toHaveLength(1);
    expect(groups[0]?.people.map((person) => person.name)).toEqual(["Wei Chen"]);
  });

  it("leaves out a project that has nothing unusual on it", () => {
    const groups = exceptionsFrom(
      snapshot([project("project-1", "Trial two"), project("project-2", "Pilot", [NARROWED])]),
    );

    expect(groups.map((group) => group.project.name)).toEqual(["Pilot"]);
  });

  it("carries the policy that has to be sent back with any change to it", () => {
    const one = project("project-1", "Pilot", [NARROWED]);
    one.sensitivity = "confidential";
    one.review_required = true;

    const groups = exceptionsFrom(snapshot([one]));

    expect(groups[0]?.project.sensitivity).toBe("confidential");
    expect(groups[0]?.project.reviewRequired).toBe(true);
  });

  it("marks access that is above the workspace role, which cannot be set today", () => {
    const groups = exceptionsFrom(
      snapshot([
        project("project-1", "Pilot", [
          {
            user_id: "user-2",
            display_name: "Wei Chen",
            workspace_role: "editor",
            project_role: "admin",
          },
        ]),
      ]),
    );

    expect(groups[0]?.people[0]?.widens).toBe(true);
  });

  it("does not call access above or below anything where the role is one it has never heard of", () => {
    const groups = exceptionsFrom(
      snapshot([
        project("project-1", "Pilot", [
          {
            user_id: "user-2",
            display_name: "Wei Chen",
            workspace_role: "editor",
            project_role: "auditor",
          },
        ]),
      ]),
    );

    expect(groups[0]?.people[0]?.widens).toBe(false);
  });

  it("names people the way the roster does rather than the way the override does", () => {
    const groups = exceptionsFrom(
      snapshot([project("project-1", "Pilot", [{ ...NARROWED, display_name: "  " }])]),
    );

    expect(groups[0]?.people[0]?.name).toBe("Wei Chen");
  });

  it("puts the projects and the people in each of them in reading order", () => {
    const groups = exceptionsFrom(
      snapshot([
        project("project-1", "Trial two", [NARROWED]),
        project("project-2", "Pilot", [
          NARROWED,
          {
            user_id: "user-1",
            display_name: "Ada Lovelace",
            workspace_role: "owner",
            project_role: "viewer",
          },
        ]),
      ]),
    );

    expect(groups.map((group) => group.project.name)).toEqual(["Pilot", "Trial two"]);
    expect(groups[0]?.people.map((person) => person.name)).toEqual(["Ada Lovelace", "Wei Chen"]);
  });

  it("lists every project for the form that adds one, exceptions or not", () => {
    const policies = projectPolicies(
      snapshot([project("project-1", "Trial two"), project("project-2", "Pilot")]),
    );

    expect(policies.map((policy) => policy.name)).toEqual(["Pilot", "Trial two"]);
  });
});

describe("what an exception may be", () => {
  it("offers only what is below the workspace role", () => {
    expect(lesserRoles("editor")).toEqual(["commenter", "viewer"]);
  });

  it("offers nothing below a viewer, because there is nothing below it", () => {
    expect(lesserRoles("viewer")).toEqual([]);
    expect(canBeExcepted("viewer")).toBe(false);
  });

  it("offers nothing for a role this build has never heard of rather than guessing", () => {
    expect(lesserRoles("auditor")).toEqual([]);
  });

  it("puts the workspace role at the top of the menu, since choosing it ends the exception", () => {
    expect(exceptionRoleOptions("editor", "commenter")).toEqual(["editor", "commenter", "viewer"]);
  });

  it("keeps what is recorded in the menu even where it could not be chosen again", () => {
    expect(exceptionRoleOptions("editor", "admin")).toEqual([
      "editor",
      "commenter",
      "viewer",
      "admin",
    ]);
  });
});

describe("who can be given an exception", () => {
  it("leaves out somebody who already has one on that project", () => {
    const people = candidateMembers(
      snapshot([project("project-1", "Pilot", [NARROWED])]),
      "project-1",
    );

    expect(people.map((person) => person.name)).toEqual(["Ada Lovelace"]);
  });

  it("leaves out a viewer, who has nothing to be narrowed to", () => {
    const people = candidateMembers(snapshot([project("project-1", "Pilot")]), "project-1");

    expect(people.map((person) => person.name)).toEqual(["Ada Lovelace", "Wei Chen"]);
  });

  it("counts somebody whose recorded access matches their workspace role as not having one", () => {
    const people = candidateMembers(
      snapshot([
        project("project-1", "Pilot", [
          {
            user_id: "user-2",
            display_name: "Wei Chen",
            workspace_role: "editor",
            project_role: "editor",
          },
        ]),
      ]),
      "project-1",
    );

    expect(people.map((person) => person.name)).toContain("Wei Chen");
  });
});

describe("saying what an exception is", () => {
  it("says what somebody has here and what they have elsewhere", () => {
    expect(
      describeException({
        userId: "user-2",
        name: "Wei Chen",
        workspaceRole: "editor",
        projectRole: "commenter",
        widens: false,
      }),
    ).toBe("Commenter on this project, and an editor everywhere else in this workspace.");
  });

  it("says why access above the workspace role is still shown", () => {
    expect(warnWidened("Wei Chen")).toContain("cannot be set again");
  });

  it("says what was given, and that the rest of the workspace is unchanged", () => {
    expect(describeExceptionSet("Wei Chen", "Pilot", "commenter")).toBe(
      "Wei Chen is a commenter on Pilot, and keeps their workspace role everywhere else.",
    );
  });

  it("says an ended exception as being back on the same footing", () => {
    expect(describeExceptionLifted("Wei Chen", "Pilot", "editor")).toContain(
      "back to their workspace role on Pilot",
    );
  });
});

describe("why an exception could not be set", () => {
  it("reads a missing project as this reading being behind the workspace", () => {
    const said = exceptionRefusal(
      "not_found",
      "That project was not found in this workspace.",
      "Wei Chen",
      "Pilot",
    );
    expect(said).toContain("no longer in this workspace");
    expect(said).toContain("Refresh");
  });

  it("repeats the rule about narrowing in the service's own words", () => {
    expect(
      exceptionRefusal(
        "forbidden",
        "Project access can narrow a workspace role, but it cannot expand it.",
        "Wei Chen",
        "Pilot",
      ),
    ).toBe(
      "Wei Chen's access on Pilot was not changed. Project access can narrow a workspace role, but it cannot expand it.",
    );
  });

  it("says a refused request as the settings sent with it, which is not what was asked for", () => {
    expect(
      exceptionRefusal("invalid_input", "Choose valid project policy settings.", "Wei", "Pilot"),
    ).toContain("would not accept the settings sent with it");
  });

  it("passes anything else on as what the account service said", () => {
    expect(exceptionRefusal("wobbly", "The database is on fire.", "Wei", "Pilot")).toBe(
      "Wei's access on Pilot was not changed. The account service said: The database is on fire.",
    );
  });
});
