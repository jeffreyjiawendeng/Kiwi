import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import {
  assigneeId,
  assigneesFrom,
  forgetAssignees,
  useAssignees,
  type Assignee,
} from "./assignees.js";
import type {
  RendererBridge,
  RendererWorkspaceCollaborationResult,
  RendererWorkspaceCollaborationSnapshot,
} from "./bridge.js";

const account = { id: "account-1", email: "wren@example.test" };

function snapshotOf(
  members: RendererWorkspaceCollaborationSnapshot["members"],
): RendererWorkspaceCollaborationSnapshot {
  return {
    workspace: { id: "workspace-1", title: "Orchard", role: "owner" },
    members,
    invitations: [],
    projects: [],
  };
}

const workspaceMembers = snapshotOf([
  {
    user_id: "account-1",
    email: "wren@example.test",
    display_name: "Wren Adeyemi",
    phone: null,
    role: "owner",
  },
  {
    user_id: "account-2",
    email: "sam@example.test",
    display_name: "Sam Okoye",
    phone: null,
    role: "editor",
  },
  {
    user_id: "account-3",
    email: "ada@example.test",
    display_name: "Ada Lindqvist",
    phone: null,
    role: "commenter",
  },
]);

function installBridge(
  answer: (workspaceId: string) => Promise<RendererWorkspaceCollaborationResult>,
) {
  const manageWorkspaceCollaboration = vi.fn(
    async (input: { action: string; input: Record<string, unknown> }) =>
      answer(input.input["workspace_id"] as string),
  );
  window.kiwiDesktop = { manageWorkspaceCollaboration } as unknown as RendererBridge;
  return manageWorkspaceCollaboration;
}

function names(assignees: Assignee[]): string[] {
  return assignees.map((assignee) => assignee.name);
}

beforeEach(() => {
  forgetAssignees();
});

afterEach(() => {
  cleanup();
  delete window.kiwiDesktop;
});

describe("assigneeId", () => {
  it("matches the way the main process signs a command", () => {
    // The Dashboard finds your work by asking for `mine`, which the command answers by
    // comparing the caller's actor id. A different shape here is work you can never see.
    expect(assigneeId("account-1")).toBe("account:account-1");
  });
});

describe("assigneesFrom", () => {
  it("offers the signed-in person when nothing is known about the workspace", () => {
    const assignees = assigneesFrom(account, null);
    expect(assignees).toEqual([
      {
        id: "account:account-1",
        name: "wren@example.test",
        email: "wren@example.test",
        role: null,
        isSelf: true,
      },
    ]);
  });

  it("does not list the signed-in person twice, and takes their name from the workspace", () => {
    const assignees = assigneesFrom(account, workspaceMembers);
    expect(assignees.filter((assignee) => assignee.isSelf)).toHaveLength(1);
    expect(assignees[0]).toEqual({
      id: "account:account-1",
      name: "Wren Adeyemi",
      email: "wren@example.test",
      role: "owner",
      isSelf: true,
    });
  });

  it("puts you first and sorts everybody else by name", () => {
    expect(names(assigneesFrom(account, workspaceMembers))).toEqual([
      "Wren Adeyemi",
      "Ada Lindqvist",
      "Sam Okoye",
    ]);
  });

  it("tells two people with the same name apart by address", () => {
    const twins = snapshotOf([
      {
        user_id: "b",
        email: "wei.zhang@example.test",
        display_name: "Wei",
        phone: null,
        role: "editor",
      },
      {
        user_id: "a",
        email: "wei.chen@example.test",
        display_name: "Wei",
        phone: null,
        role: "editor",
      },
    ]);
    expect(assigneesFrom(account, twins).map((assignee) => assignee.email)).toEqual([
      "wren@example.test",
      "wei.chen@example.test",
      "wei.zhang@example.test",
    ]);
  });

  it("falls back to the address for an account that has not filled in a name", () => {
    const unnamed = snapshotOf([
      {
        user_id: "account-9",
        email: "new@example.test",
        display_name: "   ",
        phone: null,
        role: "viewer",
      },
    ]);
    expect(names(assigneesFrom(account, unnamed))).toEqual([
      "wren@example.test",
      "new@example.test",
    ]);
  });
});

describe("useAssignees", () => {
  it("has somebody to assign to on the first render, before anything is asked", () => {
    installBridge(async () => ({ status: "ok", settings: workspaceMembers }));
    const { result } = renderHook(() => useAssignees({ workspaceId: "workspace-1", account }));

    // No await: this is the render the menu opens on, and it is already usable.
    expect(result.current.reach).toBe("self");
    expect(names(result.current.assignees)).toEqual(["wren@example.test"]);
  });

  it("fills in the workspace once the service answers", async () => {
    installBridge(async () => ({ status: "ok", settings: workspaceMembers }));
    const { result } = renderHook(() => useAssignees({ workspaceId: "workspace-1", account }));

    await waitFor(() => expect(result.current.reach).toBe("workspace"));
    expect(names(result.current.assignees)).toEqual(["Wren Adeyemi", "Ada Lindqvist", "Sam Okoye"]);
  });

  it.each([
    ["queued", { status: "queued" } as const],
    ["unavailable", { status: "error", code: "service_unavailable", message: "Offline." } as const],
  ])("keeps the local list when the service is %s", async (_label, answer) => {
    const asked = installBridge(async () => answer);
    const { result } = renderHook(() => useAssignees({ workspaceId: "workspace-1", account }));

    await waitFor(() => expect(asked).toHaveBeenCalled());
    expect(result.current.reach).toBe("self");
    expect(names(result.current.assignees)).toEqual(["wren@example.test"]);
  });

  it("keeps the local list when the request itself fails", async () => {
    const asked = installBridge(async () => {
      throw new Error("The account service refused the connection.");
    });
    const { result } = renderHook(() => useAssignees({ workspaceId: "workspace-1", account }));

    await waitFor(() => expect(asked).toHaveBeenCalled());
    expect(names(result.current.assignees)).toEqual(["wren@example.test"]);
  });

  it("works with no bridge at all", () => {
    const { result } = renderHook(() => useAssignees({ workspaceId: "workspace-1", account }));
    expect(names(result.current.assignees)).toEqual(["wren@example.test"]);
  });

  it("opens the second surface with everybody already in it", async () => {
    installBridge(async () => ({ status: "ok", settings: workspaceMembers }));
    const first = renderHook(() => useAssignees({ workspaceId: "workspace-1", account }));
    await waitFor(() => expect(first.result.current.reach).toBe("workspace"));
    first.unmount();

    // The board and the table are the same list. Asking again is fine; showing one name and then
    // three, every time, reads as the list changing rather than as it arriving.
    const second = renderHook(() => useAssignees({ workspaceId: "workspace-1", account }));
    expect(second.result.current.reach).toBe("workspace");
    expect(names(second.result.current.assignees)).toHaveLength(3);
  });

  it("does not show one workspace's people while a second is being asked about", async () => {
    installBridge(async (workspaceId) =>
      workspaceId === "workspace-1"
        ? { status: "ok", settings: workspaceMembers }
        : new Promise<RendererWorkspaceCollaborationResult>(() => undefined),
    );
    const { result, rerender } = renderHook(
      (workspaceId: string) => useAssignees({ workspaceId, account }),
      { initialProps: "workspace-1" },
    );
    await waitFor(() => expect(result.current.reach).toBe("workspace"));

    rerender("workspace-2");
    expect(result.current.reach).toBe("self");
    expect(names(result.current.assignees)).toEqual(["wren@example.test"]);
  });
});
