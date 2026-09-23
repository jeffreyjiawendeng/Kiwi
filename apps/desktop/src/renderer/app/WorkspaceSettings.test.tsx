import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkspaceSettings } from "./WorkspaceSettings.js";
import type { RendererBridge, RendererWorkspaceCollaborationSnapshot } from "./bridge.js";

const settings: RendererWorkspaceCollaborationSnapshot = {
  workspace: { id: "workspace-1", title: "Orchard", role: "owner" },
  members: [
    {
      user_id: "owner-1",
      email: "owner@example.test",
      display_name: "Owner",
      phone: "+14155550134",
      role: "owner",
    },
    {
      user_id: "member-1",
      email: "member@example.test",
      display_name: "Researcher",
      phone: null,
      role: "editor",
    },
  ],
  invitations: [
    {
      id: "invite-1",
      email: "pending@example.test",
      role: "viewer",
      status: "pending",
      expires_at: "2026-08-29T12:00:00.000Z",
    },
  ],
  projects: [
    {
      id: "project-1",
      name: "Fieldwork",
      sensitivity: "internal",
      review_required: false,
      member_overrides: [],
    },
  ],
};

const workspace = {
  workspaceId: "workspace-1",
  title: "Orchard",
  root: "C:\\Research\\Orchard",
  formatVersion: "1.0.0",
  status: "ready",
  trust: "trusted",
  writable: true,
  problems: [],
};

function installBridge() {
  const manageWorkspaceCollaboration = vi.fn(async () => ({
    status: "ok" as const,
    settings,
  }));
  const invokeCommand = vi.fn(async () => ({
    protocol_version: "1.0.0",
    request_id: "rename-1",
    status: "committed",
    data: { workspace: { ...workspace, title: "Renamed orchard" }, registration: "pending" },
  }));
  const closeWorkspace = vi.fn(async () => true);
  window.kiwiDesktop = {
    manageWorkspaceCollaboration,
    invokeCommand,
    closeWorkspace,
  } as unknown as RendererBridge;
  return { manageWorkspaceCollaboration, invokeCommand, closeWorkspace };
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  delete document.documentElement.dataset["theme"];
  delete document.documentElement.dataset["density"];
  delete window.kiwiDesktop;
});

describe("workspace and project settings", () => {
  it("keeps device appearance in an explicit resettable Application scope", async () => {
    installBridge();
    render(
      <WorkspaceSettings
        workspace={workspace}
        onWorkspaceChange={() => undefined}
        onClose={() => undefined}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Application" }));
    await userEvent.selectOptions(screen.getByLabelText("Theme"), "dark");
    await userEvent.selectOptions(screen.getByLabelText("Density"), "comfortable");
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    expect(document.documentElement).toHaveAttribute("data-density", "comfortable");
    await userEvent.click(screen.getByRole("button", { name: "Reset Application settings" }));
    expect(screen.getByLabelText("Theme")).toHaveValue("system");
    expect(screen.getByLabelText("Density")).toHaveValue("default");
  });

  it("keeps a project's own policy here and sends it the way the service takes it", async () => {
    const { manageWorkspaceCollaboration: manage } = installBridge();
    render(
      <WorkspaceSettings
        workspace={workspace}
        onWorkspaceChange={() => undefined}
        onClose={() => undefined}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Project" }));
    await userEvent.selectOptions(
      await screen.findByLabelText("Sensitivity for Fieldwork"),
      "confidential",
    );

    await waitFor(() =>
      expect(manage).toHaveBeenCalledWith({
        action: "update_project",
        input: {
          workspace_id: "workspace-1",
          project_id: "project-1",
          sensitivity: "confidential",
          review_required: false,
        },
      }),
    );
  });

  it("no longer crosses every member against every project", async () => {
    installBridge();
    render(
      <WorkspaceSettings
        workspace={workspace}
        onWorkspaceChange={() => undefined}
        onClose={() => undefined}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Project" }));
    await screen.findByLabelText("Sensitivity for Fieldwork");
    // Access that is not somebody's workspace role is a short list on the Members page. A grid
    // here said the same thing as the roster once per member and hid the exceptions among it.
    expect(
      screen.queryByLabelText("Fieldwork access for member@example.test"),
    ).not.toBeInTheDocument();
  });

  it("saves a workspace rename through the active canonical command", async () => {
    const { invokeCommand } = installBridge();
    const changed = vi.fn();
    render(
      <WorkspaceSettings
        workspace={workspace}
        onWorkspaceChange={changed}
        onClose={() => undefined}
      />,
    );
    const input = await screen.findByLabelText("Workspace name");
    await userEvent.clear(input);
    await userEvent.type(input, "Renamed orchard");
    await userEvent.click(screen.getByRole("button", { name: "Save name" }));

    await waitFor(() =>
      expect(changed).toHaveBeenCalledWith(expect.objectContaining({ title: "Renamed orchard" })),
    );
    expect(invokeCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "kiwi.workspace.rename",
        args: { root: "C:\\Research\\Orchard", title: "Renamed orchard" },
      }),
    );
  });

  it("says your own role and sends everything about who is here to the Members page", async () => {
    const { manageWorkspaceCollaboration: manage } = installBridge();
    render(
      <WorkspaceSettings
        workspace={workspace}
        onWorkspaceChange={() => undefined}
        onClose={() => undefined}
      />,
    );

    expect(await screen.findByText(/You are an owner in this workspace/)).toBeInTheDocument();
    // The rough controls written before the Members page existed. Two places to change the same
    // thing is how the two come to disagree, and neither of these said how old its reading was.
    expect(screen.queryByLabelText("Role for member@example.test")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Invite by email")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Revoke invitation" })).not.toBeInTheDocument();
    expect(manage).toHaveBeenCalledWith({
      action: "snapshot",
      input: { workspace_id: "workspace-1" },
    });
  });
});

describe("closing a workspace", () => {
  it("says the folder is untouched and why closing is worth doing", () => {
    installBridge();
    render(
      <WorkspaceSettings
        workspace={workspace}
        onWorkspaceChange={() => undefined}
        onClose={() => undefined}
      />,
    );

    expect(screen.getByText(/Nothing in the folder changes/u)).toBeInTheDocument();
  });

  it("lets go of the workspace and tells the shell", async () => {
    const { closeWorkspace } = installBridge();
    const onWorkspaceClosed = vi.fn();
    render(
      <WorkspaceSettings
        workspace={workspace}
        onWorkspaceChange={() => undefined}
        onClose={() => undefined}
        onWorkspaceClosed={onWorkspaceClosed}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Close workspace" }));

    expect(closeWorkspace).toHaveBeenCalled();
    await waitFor(() => expect(onWorkspaceClosed).toHaveBeenCalled());
  });
});
