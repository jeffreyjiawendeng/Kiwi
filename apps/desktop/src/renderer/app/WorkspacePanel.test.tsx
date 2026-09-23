import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkspacePanel } from "./WorkspacePanel.js";
import type { RendererBridge, RendererCommandResult } from "./bridge.js";

const ROOT = "C:\\Research\\trial";

function summary(overrides: Record<string, unknown> = {}) {
  return {
    workspaceId: "0198c7c1-4e7d-7e31-a23a-824269ac23d0",
    title: "Trial workspace",
    root: ROOT,
    formatVersion: "1.0.0",
    status: "ready",
    trust: "trusted",
    writable: true,
    problems: [],
    ...overrides,
  };
}

function ok(data: Record<string, unknown>): RendererCommandResult {
  return { protocol_version: "1.0.0", request_id: "r", status: "committed", data };
}

function installBridge(
  responses: Record<string, RendererCommandResult>,
  folderSelection: Awaited<ReturnType<RendererBridge["chooseWorkspaceFolder"]>> = null,
) {
  const invokeCommand = vi.fn(async (envelope: unknown) => {
    const command = (envelope as { command: string }).command;
    return (
      responses[command] ?? {
        protocol_version: "1.0.0",
        request_id: "r",
        status: "committed",
        data: {},
      }
    );
  });
  const chooseWorkspaceFolder = vi.fn(async () => folderSelection);
  const openWorkspaceFolder = vi.fn(async () => responses["kiwi.workspace.open"] ?? null);
  const openWorkspaceInNewWindow = vi.fn(async () => null);
  const getWorkspaceSession = vi.fn(async () => null);
  const createWorkspace = vi.fn(async () => {
    return responses["kiwi.workspace.create"] ?? ok({});
  });
  window.kiwiDesktop = {
    invokeCommand,
    chooseWorkspaceFolder,
    openWorkspaceFolder,
    openWorkspaceInNewWindow,
    getWorkspaceSession,
    createWorkspace,
  } as unknown as RendererBridge;
  return {
    invokeCommand,
    chooseWorkspaceFolder,
    createWorkspace,
    openWorkspaceFolder,
    openWorkspaceInNewWindow,
    getWorkspaceSession,
  };
}

afterEach(() => {
  cleanup();
  delete window.kiwiDesktop;
});

async function revealExistingWorkspaceTools(): Promise<void> {
  await userEvent.click(screen.getByText("Open an existing workspace"));
}

describe("empty state", () => {
  it("leads with the single first-run task", async () => {
    installBridge({ "kiwi.workspace.recent": ok({ recent: [] }) });
    render(<WorkspacePanel />);

    expect(screen.getByText("Create your first workspace")).toBeInTheDocument();
    expect(screen.getByText("Choose a folder to continue.")).toBeInTheDocument();
    await revealExistingWorkspaceTools();
    await waitFor(() =>
      expect(screen.getByText("Kiwi has not opened a workspace yet.")).toBeInTheDocument(),
    );
  });

  it("explains local files without making an account claim", () => {
    installBridge({ "kiwi.workspace.recent": ok({ recent: [] }) });
    render(<WorkspacePanel />);
    expect(screen.getByText(/readable local files/)).toBeInTheDocument();
    expect(screen.queryByText(/account/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Network access, AI, and Git actions/)).not.toBeInTheDocument();
  });
});

describe("create", () => {
  const selection = {
    id: "selection-1",
    displayPath: ROOT,
    suggestedTitle: "trial",
    hasExistingContents: false,
  };

  it("creates from a brokered folder selection, then shows the workspace and receipt", async () => {
    const bridge = installBridge(
      {
        "kiwi.workspace.recent": ok({ recent: [] }),
        "kiwi.workspace.create": ok({ workspace: summary(), syncHint: null }),
      },
      selection,
    );
    render(<WorkspacePanel />);

    await userEvent.click(screen.getByRole("button", { name: "Choose folder" }));
    await userEvent.clear(screen.getByLabelText("Workspace name"));
    await userEvent.type(screen.getByLabelText("Workspace name"), "Trial workspace");
    await userEvent.click(screen.getByRole("button", { name: "Create workspace" }));

    expect(await screen.findByRole("heading", { name: "Trial workspace" })).toBeInTheDocument();
    expect(bridge.createWorkspace).toHaveBeenCalledWith({
      selectionId: "selection-1",
      title: "Trial workspace",
    });
    expect(bridge.invokeCommand).not.toHaveBeenCalledWith(
      expect.objectContaining({ command: "kiwi.workspace.create" }),
    );
    expect(screen.getByRole("status")).toHaveTextContent("Workspace created");
  });

  it("keeps create disabled until a name and folder are given", async () => {
    installBridge({ "kiwi.workspace.recent": ok({ recent: [] }) });
    render(<WorkspacePanel />);
    expect(screen.getByRole("button", { name: "Create workspace" })).toBeDisabled();
    await userEvent.type(screen.getByLabelText("Workspace name"), "Trial");
    expect(screen.getByRole("button", { name: "Create workspace" })).toBeDisabled();
  });

  it("leaves the form unchanged when folder choice is canceled", async () => {
    const bridge = installBridge({ "kiwi.workspace.recent": ok({ recent: [] }) });
    render(<WorkspacePanel />);
    await userEvent.type(screen.getByLabelText("Workspace name"), "Trial");

    await userEvent.click(screen.getByRole("button", { name: "Choose folder" }));

    expect(screen.getByText("Choose a folder to continue.")).toBeInTheDocument();
    expect(screen.getByLabelText("Workspace name")).toHaveValue("Trial");
    expect(bridge.createWorkspace).not.toHaveBeenCalled();
  });

  it("shows a specific error when the folder already holds a workspace", async () => {
    installBridge(
      {
        "kiwi.workspace.recent": ok({ recent: [] }),
        "kiwi.workspace.create": {
          protocol_version: "1.0.0",
          request_id: "r",
          status: "failed",
          error: {
            code: "KIWI_WORKSPACE_EXISTS",
            message: "That folder already holds a Kiwi workspace.",
            details: {},
            retryable: false,
            recovery_actions: ["correct_input"],
            correlation_id: "corr-3",
          },
        },
      },
      selection,
    );
    render(<WorkspacePanel />);

    await userEvent.click(screen.getByRole("button", { name: "Choose folder" }));
    await userEvent.click(screen.getByRole("button", { name: "Create workspace" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("already holds a Kiwi workspace");
    expect(within(alert).getByText("KIWI_WORKSPACE_EXISTS")).toBeInTheDocument();
    expect(within(alert).getByText("corr-3")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Choose folder" })).toBeInTheDocument();
  });

  it("warns before creating in a folder that already contains files", async () => {
    installBridge(
      { "kiwi.workspace.recent": ok({ recent: [] }) },
      { ...selection, hasExistingContents: true },
    );
    render(<WorkspacePanel />);

    await userEvent.click(screen.getByRole("button", { name: "Choose folder" }));

    expect(screen.getByText(/contains other files/)).toBeInTheDocument();
    expect(screen.getByText(/without changing the existing files/)).toBeInTheDocument();
  });
});

describe("unsupported and damaged workspaces", () => {
  it("explains a future format and shows changes are not allowed", async () => {
    installBridge({
      "kiwi.workspace.recent": ok({ recent: [] }),
      "kiwi.workspace.open": ok({
        workspace: summary({
          status: "future_schema",
          writable: false,
          problems: [
            {
              rule: "manifest.future_major",
              path: "/format_version",
              detail: "This workspace uses format 2.0.0. This build writes 1.0.0.",
              severity: "error",
            },
          ],
        }),
        syncHint: null,
        trustDecided: true,
      }),
    });
    render(<WorkspacePanel />);

    await revealExistingWorkspaceTools();
    await userEvent.click(screen.getByRole("button", { name: "Choose workspace folder" }));

    await waitFor(() =>
      expect(screen.getByText(/opens read only so nothing is lost/)).toBeInTheDocument(),
    );
    expect(screen.queryByLabelText("Inbox note editor")).not.toBeInTheDocument();
  });

  it("reassures the user that records are untouched when the manifest is damaged", async () => {
    installBridge({
      "kiwi.workspace.recent": ok({ recent: [] }),
      "kiwi.workspace.open": ok({
        workspace: summary({ status: "repair_required", writable: false, title: "" }),
        syncHint: null,
        trustDecided: true,
      }),
    });
    render(<WorkspacePanel />);

    await revealExistingWorkspaceTools();
    await userEvent.click(screen.getByRole("button", { name: "Choose workspace folder" }));

    expect(await screen.findByText(/Your records are untouched/)).toBeInTheDocument();
  });
});

describe("trust", () => {
  it("prompts only for a folder Kiwi has not seen", async () => {
    installBridge({
      "kiwi.workspace.recent": ok({ recent: [] }),
      "kiwi.workspace.open": ok({
        workspace: summary({ trust: "restricted", writable: false }),
        syncHint: null,
        trustDecided: false,
      }),
    });
    render(<WorkspacePanel />);

    await revealExistingWorkspaceTools();
    await userEvent.click(screen.getByRole("button", { name: "Choose workspace folder" }));

    expect(await screen.findByText("Do you trust this folder?")).toBeInTheDocument();
    expect(screen.getByText(/does not run anything from a workspace/)).toBeInTheDocument();
  });

  it("does not prompt for a folder already decided", async () => {
    installBridge({
      "kiwi.workspace.recent": ok({ recent: [] }),
      "kiwi.workspace.open": ok({ workspace: summary(), syncHint: null, trustDecided: true }),
    });
    render(<WorkspacePanel />);

    await revealExistingWorkspaceTools();
    await userEvent.click(screen.getByRole("button", { name: "Choose workspace folder" }));

    expect(await screen.findByRole("heading", { name: "Trial workspace" })).toBeInTheDocument();
    expect(screen.queryByText("Do you trust this folder?")).not.toBeInTheDocument();
  });

  it("records the decision and makes the workspace writable", async () => {
    const { invokeCommand } = installBridge({
      "kiwi.workspace.recent": ok({ recent: [] }),
      "kiwi.workspace.open": ok({
        workspace: summary({ trust: "restricted", writable: false }),
        syncHint: null,
        trustDecided: false,
      }),
      "kiwi.workspace.set-trust": ok({ workspace: summary(), syncHint: null }),
    });
    render(<WorkspacePanel />);

    await revealExistingWorkspaceTools();
    await userEvent.click(screen.getByRole("button", { name: "Choose workspace folder" }));
    await userEvent.click(await screen.findByRole("button", { name: "Trust this folder" }));

    // The shell opens on the Dashboard rather than on the Inbox, so what this test is really
    // about, that trusting the folder made it writable, is read from the one control in the
    // rail that a read-only workspace switches off.
    await waitFor(() =>
      expect(screen.getByRole("navigation", { name: "Project pages" })).toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: "New" })).toBeEnabled();
    const call = invokeCommand.mock.calls.find(
      ([envelope]) => (envelope as { command: string }).command === "kiwi.workspace.set-trust",
    );
    expect((call?.[0] as { args: unknown }).args).toEqual({ root: ROOT, trust: "trusted" });
  });

  it("warns about a synchronizing folder", async () => {
    installBridge({
      "kiwi.workspace.recent": ok({ recent: [] }),
      "kiwi.workspace.open": ok({
        workspace: summary(),
        syncHint: "onedrive",
        trustDecided: true,
      }),
    });
    render(<WorkspacePanel />);

    await revealExistingWorkspaceTools();
    await userEvent.click(screen.getByRole("button", { name: "Choose workspace folder" }));

    expect(await screen.findByText(/synchronizing folder \(onedrive\)/)).toBeInTheDocument();
  });
});

describe("health", () => {
  const health = {
    root: ROOT,
    status: "ready",
    manifestPresent: true,
    rootWritable: true,
    missingDirectories: ["views"],
    pendingTransactions: 0,
    problems: [
      {
        rule: "layout.missing_directories",
        path: "/",
        detail: "1 expected folders are missing. Repair recreates them empty.",
        severity: "warning",
      },
    ],
  };

  async function openThenCheck() {
    const { invokeCommand } = installBridge({
      "kiwi.workspace.recent": ok({ recent: [] }),
      "kiwi.workspace.open": ok({ workspace: summary(), syncHint: null, trustDecided: true }),
      "kiwi.workspace.health": ok({ health, syncHint: null }),
      "kiwi.workspace.repair-layout": ok({ repaired: ["views"] }),
    });
    render(<WorkspacePanel />);
    await revealExistingWorkspaceTools();
    await userEvent.click(screen.getByRole("button", { name: "Choose workspace folder" }));
    expect(await screen.findByRole("heading", { name: "Trial workspace" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Check health" }));
    return invokeCommand;
  }

  it("reports layout and permission facts", async () => {
    await openThenCheck();
    expect(await screen.findByText("Workspace health")).toBeInTheDocument();
    expect(screen.getByText("Present")).toBeInTheDocument();
    expect(screen.getByText("Writable")).toBeInTheDocument();
  });

  it("offers repair only when something is missing", async () => {
    await openThenCheck();
    expect(
      await screen.findByRole("button", { name: "Recreate missing folders" }),
    ).toBeInTheDocument();
  });

  it("runs repair and then rechecks", async () => {
    const invoke = await openThenCheck();
    await userEvent.click(await screen.findByRole("button", { name: "Recreate missing folders" }));

    await waitFor(() => {
      const commands = invoke.mock.calls.map(([e]) => (e as { command: string }).command);
      expect(commands).toContain("kiwi.workspace.repair-layout");
      expect(commands.filter((c) => c === "kiwi.workspace.health").length).toBeGreaterThan(1);
    });
  });
});

describe("recent workspaces", () => {
  it("lists them and opens one on click", async () => {
    const { invokeCommand } = installBridge({
      "kiwi.workspace.recent": ok({
        recent: [
          {
            workspaceId: "id-1",
            title: "Earlier workspace",
            root: "C:\\Research\\earlier",
            lastOpenedAt: "2026-08-22T09:00:00.000Z",
          },
        ],
      }),
      "kiwi.workspace.open": ok({ workspace: summary(), syncHint: null, trustDecided: true }),
    });
    render(<WorkspacePanel />);

    await revealExistingWorkspaceTools();
    const list = await screen.findByRole("list", { name: "Recent workspaces" });
    await userEvent.click(within(list).getByRole("button", { name: "Earlier workspace" }));

    await waitFor(() => {
      const call = invokeCommand.mock.calls.find(
        ([envelope]) => (envelope as { command: string }).command === "kiwi.workspace.open",
      );
      expect((call?.[0] as { args: unknown }).args).toEqual({ root: "C:\\Research\\earlier" });
    });
  });

  function twoRecent() {
    return installBridge({
      "kiwi.workspace.recent": ok({
        recent: [
          {
            workspaceId: "id-1",
            title: "Earlier workspace",
            root: "C:\\Research\\earlier",
            lastOpenedAt: "2026-08-22T09:00:00.000Z",
          },
          {
            workspaceId: "id-2",
            title: "Older workspace",
            root: "C:\\Research\\older",
            lastOpenedAt: "2026-08-21T09:00:00.000Z",
          },
        ],
      }),
      "kiwi.workspace.forget": ok({
        forgotten: "Older workspace",
        recent: [
          {
            workspaceId: "id-1",
            title: "Earlier workspace",
            root: "C:\\Research\\earlier",
            lastOpenedAt: "2026-08-22T09:00:00.000Z",
          },
        ],
      }),
    });
  }

  it("says what forgetting one does before it does it", async () => {
    const { invokeCommand } = twoRecent();
    render(<WorkspacePanel />);
    await revealExistingWorkspaceTools();

    await userEvent.click(await screen.findByRole("button", { name: "Forget Older workspace" }));

    expect(
      screen.getByText(/The folder and everything in it stays exactly where it is/),
    ).toBeInTheDocument();
    expect(
      invokeCommand.mock.calls.some(
        ([envelope]) => (envelope as { command: string }).command === "kiwi.workspace.forget",
      ),
    ).toBe(false);
  });

  it("forgets it by identity, never by folder, and drops it from the list", async () => {
    const { invokeCommand } = twoRecent();
    render(<WorkspacePanel />);
    await revealExistingWorkspaceTools();

    await userEvent.click(await screen.findByRole("button", { name: "Forget Older workspace" }));
    await userEvent.click(screen.getByRole("button", { name: "Forget it" }));

    await waitFor(() => {
      const call = invokeCommand.mock.calls.find(
        ([envelope]) => (envelope as { command: string }).command === "kiwi.workspace.forget",
      );
      expect((call?.[0] as { args: unknown }).args).toEqual({ workspace_id: "id-2" });
    });
    const list = await screen.findByRole("list", { name: "Recent workspaces" });
    expect(within(list).queryByRole("button", { name: "Older workspace" })).toBeNull();
  });

  it("leaves it listed when the confirmation is declined", async () => {
    const { invokeCommand } = twoRecent();
    render(<WorkspacePanel />);
    await revealExistingWorkspaceTools();

    await userEvent.click(await screen.findByRole("button", { name: "Forget Older workspace" }));
    await userEvent.click(screen.getByRole("button", { name: "Keep it listed" }));

    expect(screen.getByRole("button", { name: "Older workspace" })).toBeInTheDocument();
    expect(
      invokeCommand.mock.calls.some(
        ([envelope]) => (envelope as { command: string }).command === "kiwi.workspace.forget",
      ),
    ).toBe(false);
  });
});
