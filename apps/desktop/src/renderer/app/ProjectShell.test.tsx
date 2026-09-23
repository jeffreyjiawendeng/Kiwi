import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProjectShell, pinKey, shellKey } from "./ProjectShell.js";
import type { RendererBridge } from "./bridge.js";

const WORKSPACE = "workspace-1";
const PROJECT = "project-1";
const COMMENT_THREAD = {
  id: "thread-1",
  version: 1,
  content_hash: `sha256:${"2".repeat(64)}`,
  title: "Is this the right cohort?",
  created_at: "2026-08-26T12:00:00.000Z",
  updated_at: "2026-08-26T12:00:00.000Z",
  thread: {
    anchor: { object_id: "object-1", kind: "object" },
    status: "open",
    resolved_by: null,
    resolved_at: null,
    messages: [
      {
        id: "message-1",
        author_id: "account:ada",
        author_name: "Ada",
        body: "Is this the right cohort?",
        created_at: "2026-08-26T12:00:00.000Z",
        edited_at: null,
      },
    ],
    participants: ["account:ada"],
    mentions: [],
  },
};

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  delete window.kiwiDesktop;
});

function installBridge(settings: Record<string, unknown> = {}): void {
  window.kiwiDesktop = {
    invokeCommand: vi.fn(async (raw: unknown) => {
      const command = (raw as { command: string }).command;
      const data =
        command === "kiwi.project.list"
          ? {
              projects: [
                {
                  id: PROJECT,
                  title: "Ribosome assembly",
                  version: 1,
                  content_hash: `sha256:${"0".repeat(64)}`,
                  updated_at: "2026-08-25T08:00:00.000Z",
                  created_at: "2026-08-01T08:00:00.000Z",
                  settings: { description: "How the subunits come together", ...settings },
                  counts: { source: 4, note: 2 },
                },
              ],
            }
          : command === "kiwi.project.members"
            ? { objects: [], total: 0 }
            : command === "kiwi.projection.list"
              ? { objects: [] }
              : command === "kiwi.thread.list"
                ? { threads: [COMMENT_THREAD] }
                : command === "kiwi.object.create"
                  ? {
                      object: {
                        id: "note-1",
                        type: "note",
                        title: "Untitled note",
                        version: 1,
                        content_hash: `sha256:${"3".repeat(64)}`,
                      },
                    }
                  : { relations: [], history: [], conflicts: [] };
      return {
        protocol_version: "1.0.0",
        request_id: crypto.randomUUID(),
        status: "committed",
        data,
      };
    }),
    registerDroppedManagedAsset: vi.fn(async () => ({
      id: "selection-drop",
      name: "dropped",
      size: 4,
      modifiedAt: "2026-08-26T12:00:00.000Z",
      declaredMediaType: null,
    })),
    // Offline, which is the state a comment has to be writable in: the name it is filed under
    // is the address, because the display name cannot be read without the service.
    getAccountAuthState: async () => ({
      status: "authenticated",
      account: { id: "ada", email: "ada@example.org", email_verified: true },
      connection: "offline",
    }),
  } as unknown as RendererBridge;
}

/**
 * The page currently in the centre.
 *
 * Read from the rail rather than from the page, because the rail is the one place that names
 * every page the same way. There is no page bar any more: the page's name is in the top bar,
 * which is a component above this one.
 */
async function currentPage(): Promise<string> {
  const rail = await screen.findByRole("navigation", { name: "Project pages" });
  const here = within(rail).getByRole("button", { current: "page" });
  return here.getAttribute("aria-label") ?? "";
}

/** Opens the rail's one New menu, which is where the three import buttons went. */
async function openNewMenu(): Promise<HTMLElement> {
  await userEvent.click(screen.getByRole("button", { name: "New" }));
  return screen.getByRole("menu", { name: "New" });
}

function mount(props: Record<string, unknown> = {}) {
  const onLeaveProject = vi.fn();
  const onOpenSettings = vi.fn();
  render(
    <ProjectShell
      workspaceId={WORKSPACE}
      workspaceTitle="Zhang Lab"
      writable
      projectId={PROJECT}
      onLeaveProject={onLeaveProject}
      onOpenSettings={onOpenSettings}
      {...props}
    />,
  );
  return { onLeaveProject, onOpenSettings };
}

describe("the rail", () => {
  it("lists the pages somebody opens daily, flat and in research order", async () => {
    installBridge();
    mount();
    const rail = screen.getByRole("navigation", { name: "Project pages" });
    for (const label of ["Dashboard", "Inbox", "Library", "Reader", "Notes", "Manuscript"])
      expect(within(rail).getByRole("button", { name: label })).toBeInTheDocument();
    // The six phase headings are gone. They were a table of contents for a rail of eight.
    expect(within(rail).queryByRole("region", { name: "Gather" })).not.toBeInTheDocument();
  });

  it("counts what is on a page, and says nothing where the number would say nothing", async () => {
    installBridge();
    mount();
    const rail = screen.getByRole("navigation", { name: "Project pages" });
    const library = within(rail).getByRole("button", { name: "Library" });
    await waitFor(() => expect(library.textContent).toBe("Library4"));
    // Nothing in the Inbox, so no zero telling somebody off for not having started.
    expect(within(rail).getByRole("button", { name: "Inbox" }).textContent).toBe("Inbox");
  });

  it("folds everything else behind More", async () => {
    installBridge();
    mount();
    const rail = screen.getByRole("navigation", { name: "Project pages" });
    expect(within(rail).queryByRole("button", { name: "Trash" })).not.toBeInTheDocument();

    await userEvent.click(within(rail).getByRole("button", { name: "More pages" }));

    expect(within(rail).getByRole("button", { name: "Trash" })).toBeInTheDocument();
  });

  it("unfolds More by itself when the open page is inside it", () => {
    // Otherwise the rail would deny the page somebody is standing on.
    installBridge();
    window.localStorage.setItem(
      shellKey(WORKSPACE, PROJECT),
      JSON.stringify({ version: 3, page: "trash" }),
    );
    mount();
    const rail = screen.getByRole("navigation", { name: "Project pages" });
    expect(within(rail).getByRole("button", { name: "Trash" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("hides a page the project has not turned on", async () => {
    installBridge();
    mount();
    const rail = screen.getByRole("navigation", { name: "Project pages" });
    await userEvent.click(within(rail).getByRole("button", { name: "More pages" }));
    await waitFor(() =>
      expect(within(rail).queryByRole("button", { name: "Analysis" })).not.toBeInTheDocument(),
    );
  });

  it("shows a page once the project turns it on", async () => {
    installBridge({ pages: ["data", "analysis", "results"] });
    mount();
    const rail = screen.getByRole("navigation", { name: "Project pages" });
    await userEvent.click(within(rail).getByRole("button", { name: "More pages" }));
    expect(await within(rail).findByRole("button", { name: "Analysis" })).toBeInTheDocument();
  });

  it("navigates to a page rather than opening it in a tab", async () => {
    installBridge();
    mount();
    const rail = screen.getByRole("navigation", { name: "Project pages" });
    await userEvent.click(within(rail).getByRole("button", { name: "More pages" }));
    await userEvent.click(within(rail).getByRole("button", { name: "Search & Import" }));
    expect(await screen.findByRole("searchbox")).toBeInTheDocument();
    // The page replaced the centre; it did not join a tab strip.
    expect(screen.queryByRole("tablist", { name: "Open documents" })).not.toBeInTheDocument();
  });

  it("collapses without losing the name of any page", async () => {
    installBridge();
    mount();
    fireEvent(
      window,
      new CustomEvent("kiwi:workbench-command", { detail: { action: "collapse-rail" } }),
    );
    const rail = screen.getByRole("navigation", { name: "Project pages" });
    // The button reads "Li" once collapsed; its accessible name must not shrink with it.
    const library = within(rail).getByRole("button", { name: "Library" });
    await waitFor(() => expect(library.textContent).toBe("Li"));
  });

  it("returns to Home when the project menu in the top bar asks it to", async () => {
    installBridge();
    const { onLeaveProject } = mount();
    fireEvent(
      window,
      new CustomEvent("kiwi:workbench-command", { detail: { action: "all-projects" } }),
    );
    await waitFor(() => expect(onLeaveProject).toHaveBeenCalled());
  });
});

describe("remembering where you were", () => {
  it("reopens the page that was open", async () => {
    installBridge();
    window.localStorage.setItem(
      shellKey(WORKSPACE, PROJECT),
      JSON.stringify({ version: 3, page: "trash" }),
    );
    mount();
    await waitFor(async () => expect(await currentPage()).toBe("Trash"));
  });

  it("falls back to the Dashboard when the stored state is unreadable", () => {
    installBridge();
    window.localStorage.setItem(shellKey(WORKSPACE, PROJECT), "not json");
    mount();
    expect(screen.getByRole("navigation", { name: "Project pages" })).toBeInTheDocument();
  });

  it("ignores a page name this build does not have", async () => {
    // A workspace written by a later Kiwi would otherwise leave the centre blank.
    installBridge();
    window.localStorage.setItem(
      shellKey(WORKSPACE, PROJECT),
      JSON.stringify({ version: 3, page: "telepathy" }),
    );
    mount();
    expect(await currentPage()).toBe("Dashboard");
  });

  it("reads a layout written before the dock lost its two halves", async () => {
    // Version 2 knew four dock tools and two visibility flags. What it says about the page is
    // still true, and discarding the whole thing over the fields that went would forget it.
    installBridge();
    window.localStorage.setItem(
      shellKey(WORKSPACE, PROJECT),
      JSON.stringify({ version: 2, page: "notes", dockTool: "links" }),
    );
    mount();
    expect(await currentPage()).toBe("Notes");
    fireEvent(
      window,
      new CustomEvent("kiwi:object-context", {
        detail: {
          id: "object-1",
          type: "note",
          title: "Reading log",
          version: 1,
          content_hash: `sha256:${"1".repeat(64)}`,
        },
      }),
    );
    const dock = await screen.findByRole("complementary", { name: "Details" });
    expect(within(dock).getByRole("tab", { name: "Details" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("leaves a page that has since been switched off", async () => {
    installBridge();
    window.localStorage.setItem(
      shellKey(WORKSPACE, PROJECT),
      JSON.stringify({ version: 3, page: "analysis" }),
    );
    mount();
    // Analysis is off for this project, so staying there would show a page the rail denies.
    await waitFor(async () => expect(await currentPage()).toBe("Dashboard"));
  });

  it("keeps each project's layout apart", () => {
    expect(shellKey(WORKSPACE, PROJECT)).not.toBe(shellKey(WORKSPACE, "project-2"));
  });
});

describe("the dock", () => {
  const SELECTION = {
    id: "object-1",
    type: "source",
    title: "Smith 2024",
    version: 3,
    content_hash: `sha256:${"1".repeat(64)}`,
  };

  it("stays out of the window until something is selected", () => {
    // A third of the window spent saying "Nothing selected" is a third of the window spent
    // telling somebody what they can already see.
    installBridge();
    mount();
    expect(screen.queryByRole("complementary", { name: "Details" })).not.toBeInTheDocument();
  });

  it("appears when something is selected, and goes away on Escape", async () => {
    installBridge();
    mount();
    fireEvent(window, new CustomEvent("kiwi:object-context", { detail: SELECTION }));

    const dock = await screen.findByRole("complementary", { name: "Details" });
    fireEvent.keyDown(dock, { key: "Escape" });

    await waitFor(() =>
      expect(screen.queryByRole("complementary", { name: "Details" })).not.toBeInTheDocument(),
    );
  });

  it("comes back for the next thing selected", async () => {
    installBridge();
    mount();
    fireEvent(window, new CustomEvent("kiwi:object-context", { detail: SELECTION }));
    fireEvent.keyDown(await screen.findByRole("complementary", { name: "Details" }), {
      key: "Escape",
    });

    fireEvent(
      window,
      new CustomEvent("kiwi:object-context", {
        detail: { ...SELECTION, id: "object-2", title: "Lee 2023" },
      }),
    );

    expect(await screen.findByRole("complementary", { name: "Details" })).toBeInTheDocument();
  });

  it("follows the selection, and stops when held", async () => {
    installBridge();
    mount();
    fireEvent(window, new CustomEvent("kiwi:object-context", { detail: SELECTION }));
    const dock = await screen.findByRole("complementary", { name: "Details" });
    expect(await within(dock).findByText("Smith 2024")).toBeInTheDocument();

    await userEvent.click(within(dock).getByRole("button", { name: "More actions" }));
    await userEvent.click(within(dock).getByRole("menuitem", { name: "Keep these details" }));
    fireEvent(
      window,
      new CustomEvent("kiwi:object-context", {
        detail: { ...SELECTION, id: "object-2", title: "Lee 2023" },
      }),
    );
    // Holding is what makes the dock usable for comparison: it keeps one object while the
    // selection moves on.
    await waitFor(() => expect(within(dock).getByText("Smith 2024")).toBeInTheDocument());
    expect(within(dock).queryByText("Lee 2023")).not.toBeInTheDocument();
  });

  it("shows a Paper as a Paper rather than as a kind and a version", async () => {
    installBridge();
    mount();
    fireEvent(window, new CustomEvent("kiwi:object-context", { detail: SELECTION }));

    const dock = await screen.findByRole("complementary", { name: "Details" });
    // The panel that used to take a second column of the Library.
    expect(await within(dock).findByLabelText("Details for Smith 2024")).toBeInTheDocument();
    expect(within(dock).getByRole("heading", { name: "Smith 2024" })).toBeInTheDocument();
  });

  it("shows the comment threads on the selected object", async () => {
    installBridge();
    mount();
    fireEvent(window, new CustomEvent("kiwi:object-context", { detail: SELECTION }));
    const dock = await screen.findByRole("complementary", { name: "Details" });
    await userEvent.click(within(dock).getByRole("tab", { name: "Comments" }));
    expect(await within(dock).findByText("Is this the right cohort?")).toBeInTheDocument();
    expect(within(dock).getByRole("textbox", { name: "Start a comment" })).toBeInTheDocument();
  });

  it("is three tools, not four", async () => {
    installBridge();
    mount();
    fireEvent(window, new CustomEvent("kiwi:object-context", { detail: SELECTION }));
    const dock = await screen.findByRole("complementary", { name: "Details" });
    const tools = within(dock)
      .getAllByRole("tab")
      .map((tab) => tab.textContent);
    expect(tools).toEqual(["Details", "Comments", "History"]);
  });
});

describe("focus mode", () => {
  it("hides the rail and the dock, reversibly", async () => {
    // Reached from the palette rather than from a bar of its own. The bar it used to sit on said
    // the name of the page beside two buttons, and the page says its own name now.
    installBridge();
    mount();
    fireEvent(window, new CustomEvent("kiwi:workbench-command", { detail: { action: "focus" } }));
    await waitFor(() =>
      expect(screen.queryByRole("navigation", { name: "Project pages" })).not.toBeInTheDocument(),
    );
    fireEvent(window, new CustomEvent("kiwi:workbench-command", { detail: { action: "focus" } }));
    expect(await screen.findByRole("navigation", { name: "Project pages" })).toBeInTheDocument();
  });
});

describe("the Tasks page", () => {
  it("opens the board for whoever is signed in", async () => {
    installBridge();
    mount({ account: { id: "account-1", email: "wren@example.test" } });
    const rail = screen.getByRole("navigation", { name: "Project pages" });
    await userEvent.click(within(rail).getByRole("button", { name: "Tasks" }));
    expect(await screen.findByRole("toolbar", { name: "Task controls" })).toBeInTheDocument();
  });

  it("says so rather than showing a board nobody can be assigned on", async () => {
    // Assigning work needs to know who is doing the assigning; every card would otherwise be
    // anonymous, and "Only mine" would be a question about nobody.
    installBridge();
    mount();
    const rail = screen.getByRole("navigation", { name: "Project pages" });
    await userEvent.click(within(rail).getByRole("button", { name: "Tasks" }));
    expect(await screen.findByText("Not signed in")).toBeInTheDocument();
  });
});

describe("Question & Protocol", () => {
  it("opens the protocol rather than an empty page", async () => {
    installBridge();
    mount();
    const rail = screen.getByRole("navigation", { name: "Project pages" });
    await userEvent.click(within(rail).getByRole("button", { name: "More pages" }));
    await userEvent.click(within(rail).getByRole("button", { name: "Question & Protocol" }));
    expect(await screen.findByLabelText("The primary question")).toBeInTheDocument();
  });
});

describe("pages that are not built", () => {
  it("says what the page is for and that it is not built", async () => {
    installBridge({ pages: ["data", "analysis", "results"] });
    mount();
    const rail = screen.getByRole("navigation", { name: "Project pages" });
    await userEvent.click(within(rail).getByRole("button", { name: "More pages" }));
    await userEvent.click(await within(rail).findByRole("button", { name: "Analysis" }));
    expect(
      await screen.findByText("Scripts and notebooks, and the runs of them"),
    ).toBeInTheDocument();
    expect(screen.getByText(/Not built yet/u)).toBeInTheDocument();
  });
});

describe("the Reader", () => {
  it("instructs when nothing is open", async () => {
    installBridge();
    mount();
    const rail = screen.getByRole("navigation", { name: "Project pages" });
    await userEvent.click(within(rail).getByRole("button", { name: "Reader" }));
    expect(await screen.findByRole("heading", { name: "No document open" })).toBeInTheDocument();
  });
});

describe("carried over from the workbench", () => {
  it("opens contextual Quick Capture from its global shortcut", async () => {
    installBridge();
    mount();
    const passage = document.createElement("p");
    passage.textContent = "selected passage";
    document.body.append(passage);
    const returnTarget = screen.getByRole("button", { name: "New" });
    returnTarget.focus();
    const range = document.createRange();
    range.selectNodeContents(passage);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    fireEvent.keyDown(window, { key: "i", ctrlKey: true, shiftKey: true });

    const dialog = await screen.findByRole("dialog", { name: "Quick Capture" });
    expect(within(dialog).getByRole("textbox", { name: "Note" })).toHaveValue("selected passage");
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(returnTarget).toHaveFocus());
    passage.remove();
  });

  it("opens Quick Capture from the rail's one New button", async () => {
    installBridge();
    mount();
    const menu = await openNewMenu();
    await userEvent.click(within(menu).getByRole("menuitem", { name: "Capture" }));
    expect(await screen.findByRole("dialog", { name: "Quick Capture" })).toBeInTheDocument();
  });

  it("opens the managed-file picker and returns focus", async () => {
    installBridge();
    mount();
    const newButton = screen.getByRole("button", { name: "New" });
    newButton.focus();
    const menu = await openNewMenu();
    await userEvent.click(within(menu).getByRole("menuitem", { name: "Paper (PDF)" }));
    const dialog = await screen.findByRole("dialog", { name: "Add a file" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(newButton).toHaveFocus());
  });

  it("imports a reference library from the same menu", async () => {
    installBridge();
    mount();
    const menu = await openNewMenu();
    await userEvent.click(within(menu).getByRole("menuitem", { name: "References (.bib / .ris)" }));
    expect(await screen.findByRole("dialog", { name: "Import references" })).toBeInTheDocument();
  });

  it("makes a note and files it in the open project", async () => {
    installBridge();
    mount();
    const menu = await openNewMenu();
    await userEvent.click(within(menu).getByRole("menuitem", { name: "Note" }));

    const calls = (window.kiwiDesktop?.invokeCommand as ReturnType<typeof vi.fn>).mock.calls.map(
      (call) => call[0] as { command: string; args?: Record<string, unknown> },
    );
    await waitFor(() =>
      expect(calls.some((call) => call.command === "kiwi.object.create")).toBe(true),
    );
    // A note made inside a project and left outside it is a note somebody will look for on the
    // page they made it from and not find.
    await waitFor(() =>
      expect(
        (window.kiwiDesktop?.invokeCommand as ReturnType<typeof vi.fn>).mock.calls.some(
          (call) => (call[0] as { command: string }).command === "kiwi.project.assign",
        ),
      ).toBe(true),
    );
  });

  it("sends a reference library dropped on the window to the review, not to the asset copier", async () => {
    installBridge();
    mount();
    const file = new File(["@article{a,}"], "zotero.bib");
    fireEvent.drop(screen.getByRole("navigation", { name: "Project pages" }), {
      dataTransfer: { types: ["Files"], files: [file] },
    });

    expect(await screen.findByRole("dialog", { name: "Import references" })).toBeInTheDocument();
    expect(window.kiwiDesktop?.registerDroppedManagedAsset).toHaveBeenCalledWith(file);
  });

  it("sends anything else dropped on the window to the asset copier", async () => {
    installBridge();
    mount();
    const file = new File(["%PDF"], "paper.pdf");
    fireEvent.drop(screen.getByRole("navigation", { name: "Project pages" }), {
      dataTransfer: { types: ["Files"], files: [file] },
    });

    expect(await screen.findByRole("dialog", { name: "Add a file" })).toBeInTheDocument();
    expect(window.kiwiDesktop?.registerDroppedManagedAsset).toHaveBeenCalledWith(file);
  });

  it("leaves a drag that is moving something inside the window alone", async () => {
    installBridge();
    mount();
    fireEvent.drop(screen.getByRole("navigation", { name: "Project pages" }), {
      dataTransfer: { types: ["text/plain"], files: [] },
    });

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(window.kiwiDesktop?.registerDroppedManagedAsset).not.toHaveBeenCalled();
  });

  it("routes a command-palette pick to its page", async () => {
    installBridge();
    mount();
    fireEvent(window, new CustomEvent("kiwi:workbench-command", { detail: { page: "trash" } }));
    await waitFor(async () => expect(await currentPage()).toBe("Trash"));
  });
});

describe("pinned objects", () => {
  const context = {
    id: "object-1",
    type: "source",
    title: "Smith 2024",
    version: 1,
    content_hash: `sha256:${"1".repeat(64)}`,
  };

  it("pins the selected object into the rail and takes it out again", async () => {
    installBridge();
    mount();
    fireEvent(window, new CustomEvent("kiwi:object-context", { detail: context }));

    await userEvent.click(
      await screen.findByRole("button", { name: /Pin Smith 2024 to the rail/u }),
    );
    const rail = screen.getByRole("navigation", { name: "Project pages" });
    expect(within(rail).getByRole("button", { name: "Smith 2024" })).toBeInTheDocument();

    await userEvent.click(within(rail).getByRole("button", { name: "Unpin Smith 2024" }));
    expect(within(rail).queryByRole("button", { name: "Smith 2024" })).not.toBeInTheDocument();
  });

  it("keeps a pin across a reload, on this machine only", async () => {
    // A pin is a personal shortcut, so it lives in browser storage rather than in the
    // canonical files everybody shares.
    installBridge();
    window.localStorage.setItem(
      pinKey(WORKSPACE, PROJECT),
      JSON.stringify([{ id: "object-9", type: "note", title: "Reading log" }]),
    );
    mount();
    const rail = screen.getByRole("navigation", { name: "Project pages" });
    expect(within(rail).getByRole("button", { name: "Reading log" })).toBeInTheDocument();
  });

  it("ignores stored pins that are not pins", () => {
    installBridge();
    window.localStorage.setItem(pinKey(WORKSPACE, PROJECT), JSON.stringify([{ id: 7 }, "nope"]));
    mount();
    const rail = screen.getByRole("navigation", { name: "Project pages" });
    expect(within(rail).queryByRole("region", { name: "Pinned" })).not.toBeInTheDocument();
  });

  it("gives the pins a heading once there are any", () => {
    installBridge();
    window.localStorage.setItem(
      pinKey(WORKSPACE, PROJECT),
      JSON.stringify([{ id: "object-9", type: "note", title: "Reading log" }]),
    );
    mount();
    const rail = screen.getByRole("navigation", { name: "Project pages" });
    expect(within(rail).getByRole("region", { name: "Pinned" })).toBeInTheDocument();
  });

  it("opens the page a pinned object lives on", async () => {
    installBridge();
    window.localStorage.setItem(
      pinKey(WORKSPACE, PROJECT),
      JSON.stringify([{ id: "object-9", type: "note", title: "Reading log" }]),
    );
    mount();
    const rail = screen.getByRole("navigation", { name: "Project pages" });
    await userEvent.click(within(rail).getByRole("button", { name: "Reading log" }));
    await waitFor(async () => expect(await currentPage()).toBe("Notes"));
  });
});

describe("the breadcrumb", () => {
  it("announces where the reader is, for the top bar to show", async () => {
    installBridge();
    const seen: unknown[] = [];
    const listener = (event: Event): void => {
      seen.push((event as CustomEvent).detail);
    };
    window.addEventListener("kiwi:breadcrumb", listener);
    mount();
    await waitFor(() =>
      expect(seen.at(-1)).toMatchObject({
        workspace: "Zhang Lab",
        project: "Ribosome assembly",
        page: "Dashboard",
      }),
    );
    window.removeEventListener("kiwi:breadcrumb", listener);
  });

  it("follows the page", async () => {
    installBridge();
    const seen: unknown[] = [];
    const listener = (event: Event): void => {
      seen.push((event as CustomEvent).detail);
    };
    window.addEventListener("kiwi:breadcrumb", listener);
    mount();
    const rail = screen.getByRole("navigation", { name: "Project pages" });
    await userEvent.click(within(rail).getByRole("button", { name: "More pages" }));
    await userEvent.click(within(rail).getByRole("button", { name: "Trash" }));
    await waitFor(() => expect(seen.at(-1)).toMatchObject({ page: "Trash" }));
    window.removeEventListener("kiwi:breadcrumb", listener);
  });
});

describe("project settings", () => {
  it("opens the switch that turns a page on", async () => {
    installBridge();
    mount();
    const rail = screen.getByRole("navigation", { name: "Project pages" });
    await userEvent.click(within(rail).getByRole("button", { name: "More pages" }));
    await userEvent.click(within(rail).getByRole("button", { name: "Settings" }));
    expect(await screen.findByRole("checkbox", { name: /Screening/u })).toBeInTheDocument();
  });
});

describe("following a quotation out of a note", () => {
  const QUOTING_NOTE = {
    id: "note-1",
    type: "note",
    title: "Reading group, week three",
    content: [
      "> machines can think",
      "",
      "— Computing Machinery and Intelligence, p. 434 [[kiwi:annotation/annotation-1]]",
    ].join("\n"),
    version: 1,
    content_hash: `sha256:${"c".repeat(64)}`,
    updated_at: "2026-08-26T12:00:00.000Z",
    updated_by: "account:ada",
    generation: 4,
  };

  const LOCATION = {
    annotation_id: "annotation-1",
    object_id: "paper-1",
    object_title: "Computing Machinery and Intelligence",
    asset_id: "asset-1",
    file_title: "turing-1950.pdf",
    page: 4,
    page_label: "434",
  };

  /** A workspace holding one note, and a mark the quotation in it points at. */
  function bridgeWith(location: unknown, note: Record<string, unknown> = {}): void {
    window.kiwiDesktop = {
      invokeCommand: vi.fn(async (raw: unknown) => {
        const command = (raw as { command: string }).command;
        const data =
          command === "kiwi.projection.list"
            ? {
                generation: 4,
                total: 1,
                offset: 0,
                limit: 50,
                objects: [{ ...QUOTING_NOTE, ...note }],
              }
            : command === "kiwi.object.read"
              ? { object: { ...QUOTING_NOTE, ...note } }
              : command === "kiwi.annotation.locate"
                ? { location }
                : { relations: [], history: [], conflicts: [], threads: [], objects: [], total: 0 };
        return {
          protocol_version: "1.0.0",
          request_id: crypto.randomUUID(),
          status: "committed",
          data,
        };
      }),
      getAccountAuthState: async () => ({
        status: "authenticated",
        account: { id: "ada", email: "ada@example.org", email_verified: true },
        connection: "offline",
      }),
    } as unknown as RendererBridge;
  }

  it("opens the file the passage was read on", async () => {
    // The whole point of storing the mark rather than the page number: one click from the
    // sentence in the note to the page it rests on, with the file already open.
    bridgeWith(LOCATION);
    mount();
    await userEvent.click(
      within(screen.getByRole("navigation", { name: "Project pages" })).getByRole("button", {
        name: "Notes",
      }),
    );

    await userEvent.click(await screen.findByRole("button", { name: "Open the page" }));

    const tabs = await screen.findByRole("tablist", { name: "Open documents" });
    expect(within(tabs).getByRole("tab", { name: "turing-1950.pdf" })).toBeInTheDocument();
    expect(await currentPage()).toContain("Reader");
  });

  it("goes to the paper when the mark has been deleted since", async () => {
    // Nothing to select on the page any more, so there is nothing to open the Reader on. The
    // paper the passage was read in travels with the quotation for exactly this, and going
    // there is a better answer than a click that does nothing.
    bridgeWith(null, {
      document_mode: "rich",
      document: {
        type: "doc",
        content: [
          {
            type: "blockquote",
            content: [
              { type: "paragraph", content: [{ type: "text", text: "machines can think" }] },
            ],
          },
          {
            type: "paragraph",
            content: [
              {
                type: "quotation",
                attrs: {
                  annotation: "annotation-1",
                  target: "paper-1",
                  source: "Computing Machinery and Intelligence",
                  page_label: "434",
                },
              },
            ],
          },
        ],
      },
    });
    mount();
    await userEvent.click(
      within(screen.getByRole("navigation", { name: "Project pages" })).getByRole("button", {
        name: "Notes",
      }),
    );

    // The attribution line inside the editor, rather than the one the read view renders from
    // the same note's plain text: this is the case where the paper travels with the mark.
    await waitFor(() => expect(window.document.querySelector("[data-quotation]")).not.toBeNull());
    fireEvent.mouseDown(window.document.querySelector("[data-quotation]") as Element);

    await waitFor(async () => expect(await currentPage()).toContain("Library"));
    expect(screen.queryByRole("tablist", { name: "Open documents" })).not.toBeInTheDocument();
  });
});

describe("the shortcut reference", () => {
  it("opens on a bare question mark", async () => {
    installBridge();
    mount();

    await userEvent.keyboard("?");

    expect(screen.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeInTheDocument();
  });

  it("stays shut while somebody is typing one", async () => {
    installBridge();
    mount();
    const field = document.createElement("input");
    document.body.append(field);
    field.focus();

    await userEvent.keyboard("?");

    expect(screen.queryByRole("dialog", { name: "Keyboard shortcuts" })).toBeNull();
    field.remove();
  });

  it("opens when the palette asks for it, so it is not reachable only by a key", async () => {
    installBridge();
    mount();

    fireEvent(window, new CustomEvent("kiwi:show-shortcuts"));

    expect(screen.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeInTheDocument();
  });

  it("closes again", async () => {
    installBridge();
    mount();
    await userEvent.keyboard("?");

    await userEvent.click(screen.getByRole("button", { name: "Close" }));

    expect(screen.queryByRole("dialog", { name: "Keyboard shortcuts" })).toBeNull();
  });
});

/** The family each list so far asked the projection for, in the order it asked. */
function familiesListed(): string[] {
  const calls = (window.kiwiDesktop?.invokeCommand as ReturnType<typeof vi.fn>).mock.calls;
  return calls
    .map(([raw]) => raw as { command: string; args: { object_types?: string[] } })
    .filter((envelope) => envelope.command === "kiwi.projection.list")
    .map((envelope) => envelope.args.object_types?.[0] ?? "");
}

describe("moving between collection pages", () => {
  it("leaves the Library listing papers after a note was opened from elsewhere", async () => {
    installBridge();
    mount();
    // Making a note opens it, the way opening one from the Dashboard or a pin does.
    const menu = await openNewMenu();
    await userEvent.click(within(menu).getByRole("menuitem", { name: "Note" }));
    await waitFor(async () => expect(await currentPage()).toBe("Notes"));

    const rail = screen.getByRole("navigation", { name: "Project pages" });
    await userEvent.click(within(rail).getByRole("button", { name: "Library" }));
    await waitFor(async () => expect(await currentPage()).toBe("Library"));
    // The Library remembered the note's family and listed notes under its own name.
    await waitFor(() => expect(familiesListed().at(-1)).toBe("source"));
  });

  it("does not trust a remembered layout that tells the Library to list something else", async () => {
    installBridge();
    window.localStorage.setItem(
      shellKey(WORKSPACE, PROJECT),
      JSON.stringify({ version: 3, page: "library", collectionFamily: "output" }),
    );
    mount();
    await waitFor(() => expect(familiesListed()).toContain("source"));
    expect(familiesListed()).not.toContain("output");
  });

  it("lists the family of the page it is on, not the one it came from", async () => {
    installBridge();
    mount();
    const rail = screen.getByRole("navigation", { name: "Project pages" });
    await userEvent.click(within(rail).getByRole("button", { name: "Library" }));
    await waitFor(() => expect(familiesListed()).toContain("source"));

    await userEvent.click(within(rail).getByRole("button", { name: "Notes" }));
    // One instance carried from the Library kept the Library's view, and listed papers under a
    // heading that said notes.
    await waitFor(() => expect(familiesListed()).toContain("note"));
    expect(await currentPage()).toBe("Notes");
  });
});
