import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProjectHome, countsLabel, whenLabel } from "./ProjectHome.js";
import type { RendererBridge, RendererProjectDirectoryEntry } from "./bridge.js";

const NOW = Date.parse("2026-08-25T12:00:00.000Z");

function workspace(
  overrides: Partial<RendererProjectDirectoryEntry> = {},
): RendererProjectDirectoryEntry {
  return {
    workspaceId: "workspace-1",
    workspaceTitle: "Zhang Lab",
    displayPath: "C:\\Research\\zhang-lab",
    lastOpenedAt: "2026-08-25T09:00:00.000Z",
    projects: [
      {
        id: "project-1",
        title: "Ribosome assembly",
        description: "How the subunits come together",
        updatedAt: "2026-08-25T08:00:00.000Z",
        archived: false,
        sensitivity: "internal",
        counts: { source: 12, note: 3 },
      },
    ],
    ...overrides,
  };
}

function mount(entries: RendererProjectDirectoryEntry[], props: Record<string, unknown> = {}) {
  const listProjectDirectory = vi.fn(async () => entries);
  window.kiwiDesktop = { listProjectDirectory } as unknown as RendererBridge;
  const onOpenProject = vi.fn();
  const onCreateProject = vi.fn();
  const onOpenWorkspaceFolder = vi.fn();
  render(
    <ProjectHome
      now={NOW}
      onOpenProject={onOpenProject}
      onCreateProject={onCreateProject}
      onOpenWorkspaceFolder={onOpenWorkspaceFolder}
      {...props}
    />,
  );
  return { onOpenProject, onCreateProject, onOpenWorkspaceFolder, listProjectDirectory };
}

afterEach(() => {
  cleanup();
  delete window.kiwiDesktop;
});

describe("whenLabel", () => {
  it("says what someone would say", () => {
    expect(whenLabel("2026-08-25T08:00:00.000Z", NOW)).toBe("today");
    expect(whenLabel("2026-08-24T08:00:00.000Z", NOW)).toBe("yesterday");
    expect(whenLabel("2026-08-20T08:00:00.000Z", NOW)).toBe("5 days ago");
  });

  it("gives a date once counting days stops being an answer", () => {
    // "37 days ago" is arithmetic, not information.
    expect(whenLabel("2026-06-01T08:00:00.000Z", NOW)).toMatch(/2026/u);
  });

  it("returns nothing for a timestamp it cannot read", () => {
    expect(whenLabel("not a date", NOW)).toBe("");
  });
});

describe("countsLabel", () => {
  it("uses the words a researcher uses", () => {
    // Storage says "source"; the reader says "Papers".
    expect(countsLabel({ source: 12, note: 3 })).toBe("12 Papers · 3 Notes");
  });

  it("says Empty rather than nothing", () => {
    expect(countsLabel({})).toBe("Empty");
    expect(countsLabel({ source: 0 })).toBe("Empty");
  });

  it("uses the singular for one", () => {
    expect(countsLabel({ note: 1 })).toBe("1 Note");
  });
});

describe("Home", () => {
  it("lists a project and opens it by id, never by path", async () => {
    const { onOpenProject } = mount([workspace()]);
    // The same project appears twice on purpose: once under Recent and once under its
    // workspace. Either card opens it.
    const cards = await screen.findAllByRole("button", { name: /Ribosome assembly/u });
    expect(cards).toHaveLength(2);
    await userEvent.click(cards[0]!);
    expect(onOpenProject).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      root: "C:\\Research\\zhang-lab",
      projectId: "project-1",
    });
  });

  it("groups projects under the workspace holding them", async () => {
    mount([
      workspace(),
      workspace({
        workspaceId: "workspace-2",
        workspaceTitle: "Personal",
        displayPath: "D:\\personal",
        projects: [
          {
            id: "project-2",
            title: "Thesis chapter 3",
            description: "",
            updatedAt: "2026-08-24T08:00:00.000Z",
            archived: false,
            sensitivity: "internal",
            counts: {},
          },
        ],
      }),
    ]);
    expect(await screen.findByRole("region", { name: "Workspace Zhang Lab" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Workspace Personal" })).toBeTruthy();
  });

  it("instructs rather than showing an empty page to a new account", async () => {
    mount([]);
    expect(await screen.findByText("Start your first project")).toBeTruthy();
  });

  it("offers to create a project", async () => {
    const { onCreateProject } = mount([]);
    await userEvent.click(await screen.findByRole("button", { name: "New project" }));
    expect(onCreateProject).toHaveBeenCalled();
  });

  it("separates a folder it cannot read from one holding no projects", async () => {
    // These are different situations, and telling someone their work is gone when the drive is
    // merely unplugged is the worse of the two mistakes.
    mount([workspace({ projects: null })]);
    expect(await screen.findByText("Not reachable")).toBeTruthy();
    expect(screen.queryByText("Start your first project")).toBeNull();
  });

  it("filters by name, description, and workspace", async () => {
    mount([
      workspace(),
      workspace({
        workspaceId: "workspace-2",
        workspaceTitle: "Personal",
        projects: [
          {
            id: "project-2",
            title: "Thesis chapter 3",
            description: "",
            updatedAt: "2026-08-24T08:00:00.000Z",
            archived: false,
            sensitivity: "internal",
            counts: {},
          },
        ],
      }),
    ]);
    const filter = await screen.findByPlaceholderText("Filter projects");
    await userEvent.type(filter, "thesis");
    await waitFor(() => expect(screen.queryByText("Ribosome assembly")).toBeNull());
    expect(screen.getByText("Thesis chapter 3")).toBeTruthy();
  });

  it("keeps an archived project off the recent row but still reachable", async () => {
    mount([
      workspace({
        projects: [
          {
            id: "project-1",
            title: "Finished study",
            description: "",
            updatedAt: "2026-08-25T08:00:00.000Z",
            archived: true,
            sensitivity: "internal",
            counts: {},
          },
        ],
      }),
    ]);
    await screen.findByRole("region", { name: "Workspace Zhang Lab" });
    expect(screen.queryByRole("heading", { name: "Recent" })).toBeNull();
    expect(screen.getByRole("button", { name: /Finished study/u })).toBeTruthy();
  });

  it("survives a bridge that is not there", async () => {
    delete window.kiwiDesktop;
    render(
      <ProjectHome
        now={NOW}
        onOpenProject={vi.fn()}
        onCreateProject={vi.fn()}
        onOpenWorkspaceFolder={vi.fn()}
      />,
    );
    expect(await screen.findByText("Start your first project")).toBeTruthy();
  });
});

describe("a project marked as more than ordinary", () => {
  it("shows the marking on the card", async () => {
    mount([
      workspace({
        projects: [
          {
            id: "project-1",
            title: "Ribosome assembly",
            description: "",
            updatedAt: "2026-08-25T08:00:00.000Z",
            archived: false,
            sensitivity: "confidential",
            counts: {},
          },
        ],
      }),
    ]);

    expect((await screen.findAllByText("confidential")).length).toBeGreaterThan(0);
  });

  it("says nothing about a project that is the ordinary case", async () => {
    // A marking on every card is a marking nobody reads.
    mount([workspace()]);
    await screen.findAllByText("Ribosome assembly");

    expect(screen.queryAllByText("internal")).toEqual([]);
  });
});
