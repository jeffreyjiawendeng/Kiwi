import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProjectCreate } from "./ProjectCreate.js";
import type {
  RendererBridge,
  RendererCommandResult,
  RendererProjectDirectoryEntry,
} from "./bridge.js";

function ok(data: Record<string, unknown>): RendererCommandResult {
  return { protocol_version: "1.0.0", request_id: crypto.randomUUID(), status: "committed", data };
}

function failed(message: string): RendererCommandResult {
  return {
    protocol_version: "1.0.0",
    request_id: crypto.randomUUID(),
    status: "failed",
    error: {
      code: "KIWI_INVALID_ARGUMENTS",
      message,
      details: {},
      retryable: false,
      recovery_actions: [],
      correlation_id: "corr-test",
    },
  };
}

const EXISTING: RendererProjectDirectoryEntry = {
  workspaceId: "workspace-1",
  workspaceTitle: "Zhang Lab",
  displayPath: "C:\\Research\\zhang-lab",
  lastOpenedAt: "2026-08-25T09:00:00.000Z",
  projects: [],
};

interface Harness {
  entries?: RendererProjectDirectoryEntry[];
  createResult?: RendererCommandResult;
  openResult?: RendererCommandResult;
}

function mount({ entries = [EXISTING], createResult, openResult }: Harness = {}) {
  const invoked: Array<{ command: string; args: Record<string, unknown> }> = [];
  const invokeCommand = vi.fn(async (raw: unknown) => {
    const envelope = raw as { command: string; args: Record<string, unknown> };
    invoked.push(envelope);
    if (envelope.command === "kiwi.workspace.open") {
      return (
        openResult ??
        ok({ workspace: { workspaceId: "workspace-1", root: "C:\\Research\\zhang-lab" } })
      );
    }
    if (envelope.command === "kiwi.project.create") {
      return createResult ?? ok({ project: { id: "project-9" } });
    }
    return ok({});
  });
  // Typed against the bridge on purpose: an untyped stub is what let a wrong field name
  // ("selectionId" rather than "id") pass a green test.
  const chooseWorkspaceFolder = vi.fn<RendererBridge["chooseWorkspaceFolder"]>(async () => ({
    id: "selection-1",
    suggestedTitle: "new-lab",
    displayPath: "D:\\new-lab",
    hasExistingContents: false,
  }));
  const createWorkspace = vi.fn(async () =>
    ok({ workspace: { workspaceId: "workspace-2", root: "D:\\new-lab" } }),
  );
  window.kiwiDesktop = {
    listProjectDirectory: vi.fn(async () => entries),
    invokeCommand,
    chooseWorkspaceFolder,
    createWorkspace,
  } as unknown as RendererBridge;

  const onCreated = vi.fn();
  const onCancel = vi.fn();
  render(<ProjectCreate onCreated={onCreated} onCancel={onCancel} />);
  return { onCreated, onCancel, invoked, invokeCommand, chooseWorkspaceFolder, createWorkspace };
}

afterEach(() => {
  cleanup();
  delete window.kiwiDesktop;
});

describe("creating a project", () => {
  it("cannot be submitted without a name", async () => {
    mount();
    expect(screen.getByRole("button", { name: "Create project" })).toHaveProperty("disabled", true);
  });

  it("creates the project in the workspace that is already there", async () => {
    // Defaulting to a new folder would make a second workspace the easy mistake.
    const { onCreated, invoked } = mount();
    await waitFor(() =>
      expect(screen.getByLabelText("Workspace")).toHaveProperty("value", "workspace-1"),
    );
    await userEvent.type(screen.getByLabelText("Project name"), "Ribosome assembly");
    await userEvent.click(screen.getByRole("button", { name: "Create project" }));

    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(invoked.map((entry) => entry.command)).toEqual([
      "kiwi.workspace.open",
      "kiwi.project.create",
    ]);
    expect(onCreated).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      root: "C:\\Research\\zhang-lab",
      projectId: "project-9",
    });
  });

  it("sends the template that was chosen", async () => {
    const { invoked } = mount();
    await userEvent.type(screen.getByLabelText("Project name"), "Review");
    await userEvent.click(screen.getByRole("radio", { name: /Literature review/u }));
    await userEvent.click(screen.getByRole("button", { name: "Create project" }));

    await waitFor(() => expect(invoked).toHaveLength(2));
    expect(invoked[1]?.args).toMatchObject({ title: "Review", template: "literature_review" });
  });

  it("names the pages a template turns on, and that it is reversible", async () => {
    mount();
    await userEvent.click(screen.getByRole("radio", { name: /Quantitative study/u }));
    expect(screen.getByText(/Turns on Data, Analysis, Results/u)).toBeTruthy();
    expect(screen.getByText(/Reversible in Settings/u)).toBeTruthy();
  });

  it("says General adds nothing rather than saying nothing", async () => {
    mount();
    expect(screen.getByText(/Adds no extra pages/u)).toBeTruthy();
  });

  it("requires a folder before a new workspace can be created", async () => {
    mount({ entries: [] });
    await userEvent.type(screen.getByLabelText("Project name"), "Thesis");
    await userEvent.type(screen.getByLabelText("Workspace name"), "Personal");
    expect(screen.getByRole("button", { name: "Create project" })).toHaveProperty("disabled", true);

    await userEvent.click(screen.getByRole("button", { name: "Choose folder" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Create project" })).toHaveProperty(
        "disabled",
        false,
      ),
    );
  });

  it("creates the workspace first when there is none", async () => {
    const { createWorkspace, onCreated, invoked } = mount({ entries: [] });
    await userEvent.type(screen.getByLabelText("Project name"), "Thesis");
    await userEvent.type(screen.getByLabelText("Workspace name"), "Personal");
    await userEvent.click(screen.getByRole("button", { name: "Choose folder" }));
    await waitFor(() => expect(screen.getByText("D:\\new-lab")).toBeTruthy());
    await userEvent.click(screen.getByRole("button", { name: "Create project" }));

    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(createWorkspace).toHaveBeenCalledWith({
      selectionId: "selection-1",
      title: "Personal",
    });
    // The workspace it just created is already the open one, so it is not reopened.
    expect(invoked.map((entry) => entry.command)).toEqual(["kiwi.project.create"]);
    expect(onCreated).toHaveBeenCalledWith({
      workspaceId: "workspace-2",
      root: "D:\\new-lab",
      projectId: "project-9",
    });
  });

  it("reports why the project was refused instead of appearing to work", async () => {
    const { onCreated } = mount({ createResult: failed("Name the project.") });
    await userEvent.type(screen.getByLabelText("Project name"), "X");
    await userEvent.click(screen.getByRole("button", { name: "Create project" }));

    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Name the project.");
    expect(onCreated).not.toHaveBeenCalled();
  });

  it("reports a workspace that will not open", async () => {
    const { onCreated } = mount({ openResult: failed("That folder is not a Kiwi workspace.") });
    await userEvent.type(screen.getByLabelText("Project name"), "X");
    await userEvent.click(screen.getByRole("button", { name: "Create project" }));

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(onCreated).not.toHaveBeenCalled();
  });

  it("says where invitations happen rather than pretending to send them", async () => {
    mount();
    await userEvent.click(screen.getByRole("radio", { name: /A team/u }));
    expect(screen.getByText(/Invitations are sent from the Members page/u)).toBeTruthy();
  });

  it("can be abandoned", async () => {
    const { onCancel } = mount();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalled();
  });
});
