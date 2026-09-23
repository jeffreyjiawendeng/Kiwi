import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TopBar } from "./TopBar.js";
import type { RendererBridge } from "./bridge.js";
import { announceCaret, forgetCaret } from "./caret.js";
import { readBridge } from "./bridge.js";
import { forgetUndo } from "./undo-stack.js";
import { PRESENCE_CHANNEL, forgetPresence, type PresenceAt } from "./remote-carets.js";

function renderBar(overrides: Partial<Parameters<typeof TopBar>[0]> = {}) {
  const onOpenQuickSwitch = vi.fn();
  const onWindowAction = vi.fn();
  render(
    <TopBar
      workspaceTitle={null}
      workspaceStatus={null}
      onOpenQuickSwitch={onOpenQuickSwitch}
      onWindowAction={onWindowAction}
      {...overrides}
    />,
  );
  return { onOpenQuickSwitch, onWindowAction };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  forgetCaret();
  delete window.kiwiDesktop;
});

describe("identity", () => {
  it("shows the product name once", () => {
    renderBar();
    expect(document.querySelectorAll(".topbar__brand")).toHaveLength(1);
  });

  it("names the open workspace", () => {
    renderBar({ workspaceTitle: "Trial workspace", workspaceStatus: "ready" });
    expect(screen.getByRole("button", { name: /Workspace Trial workspace/ })).toBeInTheDocument();
  });

  it("does not add redundant empty-workspace text to the title bar", () => {
    renderBar();
    expect(screen.queryByRole("button", { name: /workspace/i })).not.toBeInTheDocument();
  });

  it("badges a workspace that cannot be changed", () => {
    renderBar({ workspaceTitle: "Archive", workspaceStatus: "future_schema" });
    expect(screen.getByText("Read only")).toBeInTheDocument();
  });

  it("shows no badge for a ready workspace", () => {
    renderBar({ workspaceTitle: "Trial", workspaceStatus: "ready" });
    expect(document.querySelector(".topbar__badge")).toBeNull();
  });
});

describe("interaction", () => {
  it("shows durable account notifications and keeps read separate from dismissal", async () => {
    const listAccountNotifications = vi.fn(async () => ({
      status: "ok" as const,
      unread_count: 1,
      notifications: [
        {
          id: "notification-1",
          category: "workspace_invitations",
          title: "Workspace invitation",
          detail: "You were added to Shared research as editor.",
          created_at: "2026-08-24T12:00:00.000Z",
          read: false,
        },
      ],
    }));
    const markAccountNotificationRead = vi.fn(async () => ({ status: "updated" as const }));
    const dismissAccountNotification = vi.fn(async () => ({ status: "updated" as const }));
    window.kiwiDesktop = {
      listAccountNotifications,
      markAccountNotificationRead,
      dismissAccountNotification,
    } as unknown as RendererBridge;
    renderBar({
      workspaceTitle: "Shared research",
      workspaceStatus: "ready",
      accountEmail: "reader@example.test",
      accountConnection: "online",
    });

    // Folded into the account menu: one face in the bar rather than a face and a bell.
    await userEvent.click(screen.getByRole("button", { name: "Account reader@example.test" }));
    await userEvent.click(screen.getByRole("button", { name: /^Notifications/ }));
    expect(await screen.findByText("Workspace invitation")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Mark read" }));
    expect(markAccountNotificationRead).toHaveBeenCalledWith({
      notification_id: "notification-1",
    });
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(dismissAccountNotification).toHaveBeenCalledWith({
      notification_id: "notification-1",
    });
  });

  it("opens the account menu and signs out through a narrow callback", async () => {
    const onSignOut = vi.fn();
    renderBar({ accountEmail: "reader@example.test", onSignOut });
    await userEvent.click(screen.getByRole("button", { name: "Account reader@example.test" }));
    expect(screen.getByText("reader@example.test")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(onSignOut).toHaveBeenCalledOnce();
  });

  it("presents the profile name and avatar while retaining the account email", async () => {
    renderBar({
      accountEmail: "ada@example.test",
      accountName: "Ada Lovelace",
      accountAvatarUrl: "data:image/png;base64,cGljdHVyZQ==",
    });
    await userEvent.click(screen.getByRole("button", { name: "Account Ada Lovelace" }));
    expect(screen.getByText("Ada Lovelace")).toBeInTheDocument();
    expect(screen.getByText("ada@example.test")).toBeInTheDocument();
    expect(document.querySelector(".account-menu__avatar")).toHaveAttribute(
      "src",
      "data:image/png;base64,cGljdHVyZQ==",
    );
  });

  it("keeps a newly authenticated account menu closed until requested", () => {
    const { rerender } = render(
      <TopBar
        workspaceTitle={null}
        workspaceStatus={null}
        accountEmail={null}
        onOpenQuickSwitch={vi.fn()}
        onWindowAction={vi.fn()}
      />,
    );
    rerender(
      <TopBar
        workspaceTitle={null}
        workspaceStatus={null}
        accountEmail="researcher@example.test"
        onOpenQuickSwitch={vi.fn()}
        onWindowAction={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "Account researcher@example.test" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.queryByText("researcher@example.test")).not.toBeInTheDocument();
  });

  it("closes the account menu as it opens account settings", async () => {
    const onOpenAccountSettings = vi.fn();
    renderBar({ accountEmail: "reader@example.test", onOpenAccountSettings });
    const trigger = screen.getByRole("button", { name: "Account reader@example.test" });
    await userEvent.click(trigger);

    await userEvent.click(screen.getByRole("button", { name: "Account settings" }));

    // The settings window opens over the shell. Leaving the menu behind it meant the popover
    // was still there when the window closed, as though the click had not registered.
    expect(onOpenAccountSettings).toHaveBeenCalledOnce();
    expect(screen.queryByText("reader@example.test")).not.toBeInTheDocument();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("dismisses the account menu when clicking elsewhere", async () => {
    renderBar({ accountEmail: "researcher@example.test" });
    const trigger = screen.getByRole("button", { name: "Account researcher@example.test" });
    await userEvent.click(trigger);
    expect(screen.getByText("researcher@example.test")).toBeInTheDocument();

    await userEvent.click(document.body);
    expect(screen.queryByText("researcher@example.test")).not.toBeInTheDocument();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("marks an authenticated account as offline without exposing credentials", async () => {
    renderBar({ accountEmail: "reader@example.test", accountConnection: "offline" });
    await userEvent.click(screen.getByRole("button", { name: "Account reader@example.test" }));
    expect(screen.getByLabelText("Offline")).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/token|credential/i);
  });

  it("reaches quick switch through the project menu", async () => {
    const { onOpenQuickSwitch } = renderBar({ workspaceTitle: "Trial", workspaceStatus: "ready" });
    await userEvent.click(screen.getByRole("button", { name: /Workspace Trial/ }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Switch workspace or project…" }));
    expect(onOpenQuickSwitch).toHaveBeenCalledOnce();
  });

  it("leaves the project from the menu that names it, not from a status bar", async () => {
    const command = vi.fn();
    window.addEventListener("kiwi:workbench-command", command, { once: true });
    renderBar({ workspaceTitle: "Trial", workspaceStatus: "ready" });
    fireEvent(
      window,
      new CustomEvent("kiwi:breadcrumb", {
        detail: { workspace: "Trial", project: "Ribosome assembly", page: "Library" },
      }),
    );

    await userEvent.click(await screen.findByRole("button", { name: /Project Ribosome assembly/ }));
    await userEvent.click(screen.getByRole("menuitem", { name: "All projects" }));

    expect((command.mock.calls[0]?.[0] as CustomEvent).detail).toMatchObject({
      action: "all-projects",
    });
  });

  it("folds and unfolds the rail from the same menu, saying which it will do", async () => {
    const command = vi.fn();
    window.addEventListener("kiwi:workbench-command", command, { once: true });
    renderBar({ workspaceTitle: "Trial", workspaceStatus: "ready" });
    fireEvent(
      window,
      new CustomEvent("kiwi:breadcrumb", {
        detail: { workspace: "Trial", project: "Ribosome", page: "Library", railCollapsed: true },
      }),
    );

    await userEvent.click(await screen.findByRole("button", { name: /Project Ribosome/ }));
    // Folded already, so the thing on offer is unfolding it.
    await userEvent.click(screen.getByRole("menuitem", { name: "Expand the rail" }));

    expect((command.mock.calls[0]?.[0] as CustomEvent).detail).toMatchObject({
      action: "collapse-rail",
    });
  });

  it("badges a project whose workspace cannot be written to", async () => {
    renderBar({ workspaceTitle: "Trial", workspaceStatus: "ready" });
    fireEvent(
      window,
      new CustomEvent("kiwi:breadcrumb", {
        detail: { workspace: "Trial", project: "Ribosome", page: "Library", writable: false },
      }),
    );

    expect(await screen.findByText("Read only")).toBeInTheDocument();
  });

  it("quick-opens workspace surfaces and exposes command-prefixed entries", async () => {
    const command = vi.fn();
    window.addEventListener("kiwi:workbench-command", command, { once: true });
    renderBar({ workspaceTitle: "Trial", workspaceStatus: "ready" });
    await userEvent.keyboard("{Control>}p{/Control}");
    const input = screen.getByRole("textbox", { name: "Quick Open" });
    await userEvent.type(input, "notes");
    await userEvent.keyboard("{Enter}");
    expect(command).toHaveBeenCalledOnce();
    // The palette names pages now. "Live notes" was a surface in the stage-era shell.
    expect((command.mock.calls[0]?.[0] as CustomEvent).detail).toMatchObject({ page: "notes" });
  });

  it("projects active-object organization commands into the command center", async () => {
    const command = vi.fn();
    window.addEventListener("kiwi:workbench-command", command, { once: true });
    renderBar({ workspaceTitle: "Trial", workspaceStatus: "ready" });
    fireEvent(
      window,
      new CustomEvent("kiwi:object-context", {
        detail: { id: "object-1", title: "Field memo", type: "inbox_item" },
      }),
    );
    await userEvent.keyboard("{Control>}{Shift>}p{/Shift}{/Control}");

    await userEvent.click(screen.getByRole("button", { name: /Rename object/ }));
    expect((command.mock.calls[0]?.[0] as CustomEvent).detail).toMatchObject({
      page: "library",
      objectId: "object-1",
      objectAction: "rename",
    });
  });

  it("offers Quick Capture from the command-prefixed application surface", async () => {
    const command = vi.fn();
    window.addEventListener("kiwi:workbench-command", command, { once: true });
    renderBar({ workspaceTitle: "Trial", workspaceStatus: "ready" });
    await userEvent.keyboard("{Control>}{Shift>}p{/Shift}{/Control}");
    await userEvent.click(screen.getByRole("button", { name: /Quick Capture/ }));
    expect((command.mock.calls[0]?.[0] as CustomEvent).detail).toMatchObject({
      action: "quick-capture",
    });
  });

  it("offers managed file import from the command-prefixed application surface", async () => {
    const command = vi.fn();
    window.addEventListener("kiwi:workbench-command", command, { once: true });
    renderBar({ workspaceTitle: "Trial", workspaceStatus: "ready" });
    await userEvent.keyboard("{Control>}{Shift>}p{/Shift}{/Control}");
    await userEvent.click(screen.getByRole("button", { name: /Add managed file/ }));
    expect((command.mock.calls[0]?.[0] as CustomEvent).detail).toMatchObject({
      action: "add-managed-file",
    });
  });

  it.each([
    ["Minimize window", "minimize"],
    ["Maximize or restore window", "toggle-maximize"],
    ["Close window", "close"],
  ] as const)("runs %s through the narrow window-action callback", async (label, action) => {
    const { onWindowAction } = renderBar();
    await userEvent.click(screen.getByRole("button", { name: label }));
    expect(onWindowAction).toHaveBeenCalledWith(action);
  });
});

describe("window drag regions", () => {
  it("marks the bar draggable and its controls not draggable", () => {
    renderBar({ workspaceTitle: "Trial", workspaceStatus: "ready" });

    // The rule lives in shell.css, which jsdom does not load, so this asserts the
    // class contract the stylesheet targets rather than the computed value.
    expect(document.querySelector("header.topbar")).not.toBeNull();
    expect(document.querySelector(".topbar__workspace")).not.toBeNull();
    expect(document.querySelector(".command-center")).not.toBeNull();
    expect(document.querySelector(".window-controls")).not.toBeNull();
  });
});

describe("the breadcrumb", () => {
  it("shows nothing but the workspace until a project is open", () => {
    renderBar({ workspaceTitle: "Trial", workspaceStatus: "ready" });
    const trail = screen.getByRole("navigation", { name: "Where you are" });
    expect(trail.textContent).toContain("Trial");
  });

  it("names the project and the page, and puts the workspace in the menu", async () => {
    // The bar has room for where you are working, not for the whole path to it. The workspace is
    // one click away in the menu, which is also the only place it is ever acted on.
    renderBar({ workspaceTitle: "Trial", workspaceStatus: "ready" });
    fireEvent(
      window,
      new CustomEvent("kiwi:breadcrumb", {
        detail: { workspace: "Trial", project: "Ribosome assembly", page: "Library" },
      }),
    );
    const trail = await screen.findByRole("navigation", { name: "Where you are" });
    await waitFor(() => expect(trail.textContent).toContain("Ribosome assembly"));
    expect(trail.textContent).toContain("Library");
    expect(trail.textContent).not.toContain("Trial");

    await userEvent.click(screen.getByRole("button", { name: /Project Ribosome assembly/ }));
    expect(screen.getByText("Trial")).toBeInTheDocument();
  });
});

describe("global search", () => {
  it("opens the same list from Ctrl+K as from Ctrl+P", async () => {
    // Two palettes searching the same things, differing only in which key opened them, is a
    // thing to memorize for no gain.
    renderBar({ workspaceTitle: "Trial", workspaceStatus: "ready" });
    await userEvent.keyboard("{Control>}k{/Control}");
    expect(screen.getByRole("textbox", { name: "Quick Open" })).toBeInTheDocument();
  });

  it("opens searching rather than in command mode", async () => {
    renderBar({ workspaceTitle: "Trial", workspaceStatus: "ready" });
    await userEvent.keyboard("{Control>}{Shift>}k{/Shift}{/Control}");
    expect(screen.getByRole("textbox", { name: "Quick Open" })).toHaveValue("");
  });
});

describe("who else is here", () => {
  // The window controls are a group too, so the presence row is asked for by what it says.
  const PRESENCE = /this document open/;

  // jsdom has no window manager, and presence is only asked for by a window somebody is
  // looking at.
  const listeners: Array<() => void> = [];

  beforeEach(() => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
  });

  afterEach(() => {
    for (const stop of listeners.splice(0)) stop();
    forgetPresence();
  });

  function presenceBridge(collaborators: string[]) {
    const readWorkspacePresence = vi.fn(async () => ({
      status: "present" as const,
      collaborators: collaborators.map((actor) => ({
        actor_id: `account:${actor}`,
        sequence: 1,
        cursor: 0,
        expires_at: new Date(Date.now() + 30_000).toISOString(),
      })),
    }));
    window.kiwiDesktop = {
      readWorkspacePresence,
      listAccountNotifications: vi.fn(async () => ({ status: "ok" as const, notifications: [] })),
      manageWorkspaceCollaboration: vi.fn(async () => ({
        status: "ok" as const,
        settings: {
          workspace: { id: "workspace-1", title: "Trial", role: "owner" },
          members: [
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
          ],
          invitations: [],
          projects: [],
        },
      })),
    } as unknown as RendererBridge;
    return readWorkspacePresence;
  }

  /** Everything the bar has said about who is in a document, in the order it said it. */
  function heard(): PresenceAt[] {
    const said: PresenceAt[] = [];
    const listen = (event: Event): void => {
      said.push((event as CustomEvent<PresenceAt>).detail);
    };
    window.addEventListener(PRESENCE_CHANNEL, listen);
    listeners.push(() => window.removeEventListener(PRESENCE_CHANNEL, listen));
    return said;
  }

  function openObject(id: string): void {
    fireEvent(
      window,
      new CustomEvent("kiwi:object-context", {
        detail: { id, title: "Draft", type: "output" },
      }),
    );
  }

  it("shows nobody until an object is open", async () => {
    const asked = presenceBridge(["account-2"]);
    renderBar({ workspaceTitle: "Trial", workspaceId: "workspace-1", workspaceStatus: "ready" });

    await waitFor(() => expect(asked).not.toHaveBeenCalled());
    expect(screen.queryByRole("group", { name: PRESENCE })).not.toBeInTheDocument();
  });

  it("names the person who has the open object open as well", async () => {
    presenceBridge(["account-1", "account-2"]);
    renderBar({
      workspaceTitle: "Trial",
      workspaceId: "workspace-1",
      workspaceStatus: "ready",
      accountId: "account-1",
    });
    openObject("object-1");

    // Your own row comes back in the same answer. Only the other person is drawn.
    const row = await screen.findByRole("group", { name: PRESENCE });
    await waitFor(() => expect(row).toHaveAccessibleName("Sam Okoye also has this document open."));
  });

  it("tells everybody else where the caret is, not only which document is open", async () => {
    const asked = presenceBridge(["account-2"]);
    renderBar({
      workspaceTitle: "Trial",
      workspaceId: "workspace-1",
      workspaceStatus: "ready",
      accountId: "account-1",
    });

    // The editor announces on its way in and the bar hears about the document on its way in, and
    // nothing decides which of those happens first.
    announceCaret({ documentId: "object-1", offset: 412 });
    openObject("object-1");

    await waitFor(() =>
      expect(asked).toHaveBeenCalledWith({ documentId: "object-1", cursor: 412 }),
    );
  });

  it("does not ask anybody anything because a caret moved", async () => {
    const asked = presenceBridge(["account-2"]);
    renderBar({
      workspaceTitle: "Trial",
      workspaceId: "workspace-1",
      workspaceStatus: "ready",
      accountId: "account-1",
    });
    openObject("object-1");
    await screen.findByRole("group", { name: PRESENCE });
    const before = asked.mock.calls.length;

    act(() => {
      announceCaret({ documentId: "object-1", offset: 412 });
    });

    // Moving the caret changes what the next poll will say and does not bring one forward. That
    // is the whole of the debounce: a paragraph typed across leaves as one number, once.
    expect(asked.mock.calls.length).toBe(before);
  });

  it("stops reporting itself on an object somebody has navigated away from", async () => {
    const asked = presenceBridge(["account-2"]);
    renderBar({
      workspaceTitle: "Trial",
      workspaceId: "workspace-1",
      workspaceStatus: "ready",
      accountId: "account-1",
    });
    openObject("object-1");
    await screen.findByRole("group", { name: PRESENCE });
    const before = asked.mock.calls.length;

    // The object announcement never says "and now nothing", so the breadcrumb is what says so.
    fireEvent(
      window,
      new CustomEvent("kiwi:breadcrumb", {
        detail: { workspace: "Trial", project: null, page: "Home" },
      }),
    );

    await waitFor(() =>
      expect(screen.queryByRole("group", { name: PRESENCE })).not.toBeInTheDocument(),
    );
    expect(asked.mock.calls.length).toBe(before);
  });

  it("hands the answer on, so one poll draws the avatars and the carets both", async () => {
    const said = heard();
    presenceBridge(["account-2"]);
    renderBar({
      workspaceTitle: "Trial",
      workspaceId: "workspace-1",
      workspaceStatus: "ready",
      accountId: "account-1",
    });
    openObject("object-1");
    await screen.findByRole("group", { name: PRESENCE });

    await waitFor(() => {
      const latest = said[said.length - 1];
      expect(latest?.documentId).toBe("object-1");
      expect(latest?.people.map((person) => person.name)).toEqual(["Sam Okoye"]);
    });
  });

  it("says that nobody is in a document somebody has navigated away from", async () => {
    // The editor is torn down a moment later, but not before it has had time to go on drawing
    // carets in a document nobody is standing in.
    const said = heard();
    presenceBridge(["account-2"]);
    renderBar({
      workspaceTitle: "Trial",
      workspaceId: "workspace-1",
      workspaceStatus: "ready",
      accountId: "account-1",
    });
    openObject("object-1");
    await screen.findByRole("group", { name: PRESENCE });

    fireEvent(
      window,
      new CustomEvent("kiwi:breadcrumb", {
        detail: { workspace: "Trial", project: null, page: "Home" },
      }),
    );

    await waitFor(() => {
      const latest = said[said.length - 1];
      expect(latest?.documentId).toBe("object-1");
      expect(latest?.people).toEqual([]);
    });
  });
});

describe("whether this workspace is reaching anybody", () => {
  beforeEach(() => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
  });

  function syncBridge(over: Record<string, unknown> = {}) {
    const readWorkspaceSyncStatus = vi.fn(async () => ({
      status: "known" as const,
      connection: "online" as const,
      pending: { registrations: 0, structured_changes: 0, document_operations: 0, total: 0 },
      conflicts: 0,
      last_succeeded_at: new Date().toISOString(),
      last_failure: null,
      ...over,
    }));
    window.kiwiDesktop = {
      readWorkspaceSyncStatus,
      listAccountNotifications: vi.fn(async () => ({ status: "ok" as const, notifications: [] })),
    } as unknown as RendererBridge;
    return readWorkspaceSyncStatus;
  }

  it("says so in the bar once an answer arrives", async () => {
    syncBridge({
      connection: "offline",
      pending: { registrations: 0, structured_changes: 2, document_operations: 0, total: 2 },
    });
    renderBar({ workspaceTitle: "Trial", workspaceId: "workspace-1", workspaceStatus: "ready" });

    const trigger = await screen.findByRole("button", { name: /Synchronization: Offline/u });
    expect(trigger).toHaveAccessibleName(/Nothing is lost/u);
  });

  it("opens the detail on a click", async () => {
    syncBridge({
      pending: { registrations: 0, structured_changes: 3, document_operations: 0, total: 3 },
    });
    renderBar({ workspaceTitle: "Trial", workspaceId: "workspace-1", workspaceStatus: "ready" });

    fireEvent.click(await screen.findByRole("button", { name: /Synchronization: Syncing/u }));

    expect(screen.getByRole("region", { name: "Synchronization" }).textContent).toContain(
      "Saved changes",
    );
  });

  it("shows nothing at all until this window has a workspace open", async () => {
    const asked = syncBridge();
    renderBar();

    await waitFor(() => expect(asked).not.toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: /Synchronization/u })).not.toBeInTheDocument();
  });
});

describe("searching every project", () => {
  function installSearch(hits: Array<Record<string, unknown>>) {
    const searchEverywhere = vi.fn(async () => hits);
    const openWorkspaceById = vi.fn(async () => true);
    const invokeCommand = vi.fn(async () => ({
      protocol_version: "1.0.0",
      request_id: "r",
      status: "committed",
      data: { objects: [] },
    }));
    window.kiwiDesktop = {
      searchEverywhere,
      openWorkspaceById,
      invokeCommand,
    } as unknown as RendererBridge;
    return { searchEverywhere, openWorkspaceById };
  }

  function hit(over: Record<string, unknown> = {}) {
    return {
      workspaceId: "workspace-1",
      workspaceTitle: "Zhang Lab",
      objectId: "paper-1",
      objectType: "source",
      title: "Smith 2024",
      project: { id: "project-1", title: "Ribosome assembly" },
      rank: 1,
      ...over,
    };
  }

  it("searches only the open project until it is asked to go wider", async () => {
    const { searchEverywhere } = installSearch([hit()]);
    renderBar({ workspaceTitle: "Trial", workspaceStatus: "ready" });

    await userEvent.keyboard("{Control>}k{/Control}");
    await userEvent.type(screen.getByRole("textbox", { name: "Quick Open" }), "ribosome");

    expect(searchEverywhere).not.toHaveBeenCalled();
  });

  it("names the project and the workspace of every result", async () => {
    installSearch([hit(), hit({ objectId: "note-1", title: "Field notes", project: null })]);
    renderBar({ workspaceTitle: "Trial", workspaceStatus: "ready" });

    await userEvent.keyboard("{Control>}k{/Control}");
    await userEvent.click(screen.getByRole("checkbox", { name: "Search every project" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Quick Open" }), "ribosome");

    // The place is said once over the group, which is where every result gets placed.
    expect(await screen.findByRole("heading", { name: "Ribosome assembly · Zhang Lab" }));
    expect(screen.getByRole("heading", { name: "In no project · Zhang Lab" })).toBeInTheDocument();
  });

  it("opens a result in this workspace where it is", async () => {
    const command = vi.fn();
    window.addEventListener("kiwi:workbench-command", command, { once: true });
    installSearch([hit()]);
    renderBar({ workspaceId: "workspace-1", workspaceTitle: "Trial", workspaceStatus: "ready" });

    await userEvent.keyboard("{Control>}k{/Control}");
    await userEvent.click(screen.getByRole("checkbox", { name: "Search every project" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Quick Open" }), "smith");
    await userEvent.click(await screen.findByRole("button", { name: /Smith 2024/u }));

    expect((command.mock.calls[0]?.[0] as CustomEvent).detail).toMatchObject({
      objectId: "paper-1",
    });
  });

  it("opens another workspace in a window of its own", async () => {
    // Whatever is open here was not something they asked to leave.
    const { openWorkspaceById } = installSearch([
      hit({ workspaceId: "workspace-2", workspaceTitle: "Home" }),
    ]);
    renderBar({ workspaceId: "workspace-1", workspaceTitle: "Trial", workspaceStatus: "ready" });

    await userEvent.keyboard("{Control>}k{/Control}");
    await userEvent.click(screen.getByRole("checkbox", { name: "Search every project" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Quick Open" }), "smith");
    await userEvent.click(await screen.findByRole("button", { name: /Smith 2024/u }));

    await waitFor(() =>
      expect(openWorkspaceById).toHaveBeenCalledWith({ workspaceId: "workspace-2" }),
    );
  });

  it("says nothing matched anywhere rather than showing an empty list", async () => {
    installSearch([]);
    renderBar({ workspaceTitle: "Trial", workspaceStatus: "ready" });

    await userEvent.keyboard("{Control>}k{/Control}");
    await userEvent.click(screen.getByRole("checkbox", { name: "Search every project" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Quick Open" }), "zzz");

    expect(await screen.findByText("Nothing anywhere matches that.")).toBeInTheDocument();
  });
});

describe("the last thing you did", () => {
  it("offers it in the palette too, and runs it", async () => {
    // The bar is gone by the time somebody thinks to look for it, and the palette is where they
    // look next.
    const invokeCommand = vi.fn(async (raw: unknown) => {
      const command = (raw as { command: string }).command;
      if (command === "kiwi.object.trash")
        return {
          protocol_version: "1.0.0",
          request_id: "r",
          status: "committed",
          data: {
            undo: { command: "kiwi.object.restore-from-trash", args: { object_id: "object-1" } },
          },
        };
      return { protocol_version: "1.0.0", request_id: "r", status: "committed", data: {} };
    });
    window.kiwiDesktop = { invokeCommand } as unknown as RendererBridge;
    renderBar({ workspaceId: "workspace-1", workspaceTitle: "Trial", workspaceStatus: "ready" });

    await act(async () => {
      await readBridge()?.invokeCommand({
        protocol_version: "1.0.0",
        request_id: "r",
        workspace_id: "workspace-1",
        command: "kiwi.object.trash",
        args: { object_id: "object-1" },
      });
    });
    await userEvent.keyboard("{Control>}k{/Control}");
    await userEvent.click(
      await screen.findByRole("button", { name: /Undo moving that to the Trash/u }),
    );

    await waitFor(() => {
      const sent = invokeCommand.mock.calls
        .map(([raw]) => raw as { command: string })
        .find((call) => call.command === "kiwi.object.restore-from-trash");
      expect(sent).toBeDefined();
    });
    forgetUndo();
  });

  it("offers nothing when there is nothing to take back", async () => {
    window.kiwiDesktop = {
      invokeCommand: vi.fn(async () => ({
        protocol_version: "1.0.0",
        request_id: "r",
        status: "committed",
        data: { objects: [] },
      })),
    } as unknown as RendererBridge;
    renderBar({ workspaceTitle: "Trial", workspaceStatus: "ready" });

    await userEvent.keyboard("{Control>}k{/Control}");

    expect(screen.queryByRole("button", { name: /^> Undo/u })).toBeNull();
  });
});

describe("updates", () => {
  it("offers a restart only once an update is downloaded", async () => {
    const restartToUpdate = vi.fn(async () => true);
    window.kiwiDesktop = {
      getUpdateState: vi.fn(async () => ({ status: "ready" as const, version: "1.0.1" })),
      restartToUpdate,
    } as unknown as RendererBridge;
    renderBar();

    await userEvent.click(await screen.findByRole("button", { name: "Restart to update" }));

    expect(restartToUpdate).toHaveBeenCalledOnce();
  });

  it("shows nothing while an update is still downloading", async () => {
    const getUpdateState = vi.fn(async () => ({
      status: "downloading" as const,
      version: "1.0.1",
      percent: 10,
    }));
    window.kiwiDesktop = { getUpdateState } as unknown as RendererBridge;
    renderBar();

    await waitFor(() => expect(getUpdateState).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "Restart to update" })).not.toBeInTheDocument();
  });

  it("keeps working with a bridge that cannot answer", () => {
    renderBar();
    expect(screen.queryByRole("button", { name: "Restart to update" })).not.toBeInTheDocument();
  });

  it("opens About from the account menu", async () => {
    window.kiwiDesktop = {
      getAbout: vi.fn(async () => ({
        appVersion: "1.0.0",
        electronVersion: "43.4.1",
        chromiumVersion: "142.0.0.0",
        nodeVersion: "24.0.0",
        platform: "win32",
        architecture: "x64",
        installType: "installed",
        protocolVersion: "1.0.0",
        buildIdentifier: "local",
        signed: false,
      })),
      getUpdateState: vi.fn(async () => ({ status: "idle" as const, checked_at: null })),
    } as unknown as RendererBridge;
    renderBar({ accountEmail: "reader@example.test" });

    await userEvent.click(screen.getByRole("button", { name: "Account reader@example.test" }));
    await userEvent.click(screen.getByRole("button", { name: "About Kiwi" }));

    const dialog = await screen.findByRole("dialog", { name: "About Kiwi" });
    expect(dialog).toHaveTextContent("1.0.0");
    expect(screen.queryByText("reader@example.test")).not.toBeInTheDocument();
  });
});
