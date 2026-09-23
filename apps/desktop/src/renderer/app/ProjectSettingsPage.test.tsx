import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { defaultProjectSettings } from "@kiwi/contracts";
import { ProjectSettingsPage } from "./ProjectSettingsPage.js";
import type { RendererBridge, RendererCommandResult } from "./bridge.js";

const HASH = `sha256:${"0".repeat(64)}`;

afterEach(() => {
  cleanup();
  delete window.kiwiDesktop;
});

function ok(data: Record<string, unknown> = {}): RendererCommandResult {
  return { protocol_version: "1.0.0", request_id: crypto.randomUUID(), status: "committed", data };
}

function failed(code: string, message: string): RendererCommandResult {
  return {
    protocol_version: "1.0.0",
    request_id: crypto.randomUUID(),
    status: "failed",
    error: {
      code,
      message,
      details: {},
      retryable: false,
      recovery_actions: [],
      correlation_id: "corr-test",
    },
  };
}

function mount(props: Record<string, unknown> = {}, result: RendererCommandResult = ok()) {
  const invokeCommand = vi.fn(async () => result);
  window.kiwiDesktop = { invokeCommand } as unknown as RendererBridge;
  const onSaved = vi.fn();
  const onOpenWorkspaceSettings = vi.fn();
  render(
    <ProjectSettingsPage
      projectId="project-1"
      projectTitle="Ribosome assembly"
      settings={defaultProjectSettings()}
      version={3}
      contentHash={HASH}
      writable
      onSaved={onSaved}
      onOpenWorkspaceSettings={onOpenWorkspaceSettings}
      {...props}
    />,
  );
  return { invokeCommand, onSaved, onOpenWorkspaceSettings };
}

function sentArgs(invokeCommand: ReturnType<typeof vi.fn>): Record<string, unknown> {
  return (invokeCommand.mock.calls[0]?.[0] as { args: Record<string, unknown> }).args;
}

describe("turning a page on", () => {
  it("lists every optional page with what it is for", () => {
    mount();
    expect(screen.getByRole("checkbox", { name: /Screening/u })).toBeInTheDocument();
    expect(screen.getByText("The codes applied to qualitative material")).toBeInTheDocument();
  });

  it("does not offer to switch off a page the loop needs", () => {
    // Library is not a choice. Offering it would imply a project could exist without one.
    mount();
    expect(screen.queryByRole("checkbox", { name: /Library/u })).not.toBeInTheDocument();
  });

  it("promises that nothing behind a page is lost", () => {
    mount();
    expect(screen.getByText(/Nothing behind it is deleted/u)).toBeInTheDocument();
  });

  it("sends the pages in rail order, not the order they were clicked", async () => {
    const { invokeCommand } = mount();
    await userEvent.click(screen.getByRole("checkbox", { name: /Results/u }));
    await userEvent.click(screen.getByRole("checkbox", { name: /Screening/u }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(invokeCommand).toHaveBeenCalled());
    expect((sentArgs(invokeCommand)["settings"] as { pages: string[] }).pages).toEqual([
      "screening",
      "results",
    ]);
  });

  it("warns about Results with no Analysis behind it, without blocking the save", async () => {
    const { invokeCommand } = mount();
    await userEvent.click(screen.getByRole("checkbox", { name: /Results/u }));
    expect(await screen.findByText(/nothing will appear there/u)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(invokeCommand).toHaveBeenCalled());
  });
});

describe("saving", () => {
  it("has nothing to save until something changes", async () => {
    mount();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    await userEvent.type(screen.getByLabelText("Name"), "!");
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  });

  it("sends the version it read, so a concurrent change is caught", async () => {
    const { invokeCommand } = mount();
    await userEvent.type(screen.getByLabelText("Name"), "!");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(invokeCommand).toHaveBeenCalled());
    expect(sentArgs(invokeCommand)).toMatchObject({
      project_id: "project-1",
      expected_version: 3,
      expected_hash: HASH,
      title: "Ribosome assembly!",
    });
  });

  it("explains a concurrent change rather than showing the raw error", async () => {
    const { onSaved } = mount({}, failed("KIWI_CONFLICT_VERSION", "The object changed."));
    await userEvent.type(screen.getByLabelText("Name"), "!");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Somebody else changed/u);
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("refuses a project with no name, and says why", async () => {
    mount();
    await userEvent.clear(screen.getByLabelText("Name"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Name the project.");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("tells the shell to reread the project", async () => {
    const { onSaved } = mount();
    await userEvent.type(screen.getByLabelText("Name"), "!");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(await screen.findByText("Saved")).toBeInTheDocument();
  });

  it("shows a warning the command returned", async () => {
    const { invokeCommand } = mount(
      {},
      ok({ warnings: [{ field: "pages", severity: "warning", message: "Analysis has no Data." }] }),
    );
    await userEvent.type(screen.getByLabelText("Name"), "!");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(invokeCommand).toHaveBeenCalled());
    expect(await screen.findByText("Analysis has no Data.")).toBeInTheDocument();
  });
});

describe("a read-only workspace", () => {
  it("shows the settings and lets none of them be changed", () => {
    mount({ writable: false });
    expect(screen.getByLabelText("Name")).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: /Screening/u })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });
});

describe("the rest of the settings", () => {
  it("changes the citation style", async () => {
    const { invokeCommand } = mount();
    await userEvent.selectOptions(screen.getByLabelText("Citation style"), "ieee");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(invokeCommand).toHaveBeenCalled());
    expect(sentArgs(invokeCommand)["settings"]).toMatchObject({ citation_style: "ieee" });
  });

  it("says what archiving does before doing it", async () => {
    mount();
    expect(screen.getByText(/everything in it stays readable and editable/u)).toBeInTheDocument();
  });

  it("offers the workspace settings from here", async () => {
    const { onOpenWorkspaceSettings } = mount();
    await userEvent.click(screen.getByRole("button", { name: "Workspace settings" }));
    expect(onOpenWorkspaceSettings).toHaveBeenCalled();
  });
});

describe("how sensitive the project is", () => {
  it("saves the level that was chosen", async () => {
    const { invokeCommand } = mount();

    await userEvent.selectOptions(screen.getByLabelText("Sensitivity"), "confidential");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(invokeCommand).toHaveBeenCalled());
    expect(sentArgs(invokeCommand)["settings"]).toMatchObject({ sensitivity: "confidential" });
  });

  it("says what each level means where it is chosen", () => {
    mount();

    expect(
      screen.getByRole("option", { name: "confidential: For named people only." }),
    ).toBeInTheDocument();
  });

  it("does not claim to lock anything", () => {
    // Nothing on somebody's own disk could, and a setting that implied otherwise would be worse
    // than no setting at all.
    mount();

    expect(screen.getByText(/A marking, not a lock/u)).toBeInTheDocument();
  });

  it("cannot be changed in a read-only workspace", () => {
    mount({ writable: false });

    expect(screen.getByLabelText("Sensitivity")).toBeDisabled();
  });
});

describe("deleting the project", () => {
  function mountWithDelete(counts: Record<string, number> = { source: 12, note: 3 }) {
    const invokeCommand = vi.fn(async (raw: unknown) => {
      const envelope = raw as { command: string };
      if (envelope.command === "kiwi.project.validate-delete")
        return ok({ counts, object_count: Object.values(counts).reduce((a, b) => a + b, 0) });
      return ok();
    });
    window.kiwiDesktop = { invokeCommand } as unknown as RendererBridge;
    const onDeleted = vi.fn();
    render(
      <ProjectSettingsPage
        projectId="project-1"
        projectTitle="Ribosome assembly"
        settings={defaultProjectSettings()}
        version={3}
        contentHash={HASH}
        writable
        onSaved={vi.fn()}
        onDeleted={onDeleted}
      />,
    );
    return { invokeCommand, onDeleted };
  }

  it("offers archiving first, because that is usually what somebody wants", () => {
    mountWithDelete();

    expect(screen.getByText(/Archiving is usually what somebody wants/u)).toBeInTheDocument();
  });

  it("says what happens to the objects in it before asking", async () => {
    mountWithDelete();

    await userEvent.click(screen.getByRole("button", { name: "Delete this project" }));

    expect(await screen.findByText(/takes 12 Papers and 3 Notes out of it/u)).toBeInTheDocument();
    expect(screen.getByText("Nothing you wrote is deleted.")).toBeInTheDocument();
  });

  it("will not delete until the name is typed", async () => {
    mountWithDelete();
    await userEvent.click(screen.getByRole("button", { name: "Delete this project" }));

    const button = await screen.findByRole("button", { name: "Delete Ribosome assembly" });
    expect(button).toBeDisabled();
    await userEvent.type(screen.getByLabelText("Type Ribosome assembly to confirm"), "Ribosome");
    expect(button).toBeDisabled();
  });

  it("deletes it once the name matches, and leaves the page", async () => {
    const { invokeCommand, onDeleted } = mountWithDelete();
    await userEvent.click(screen.getByRole("button", { name: "Delete this project" }));

    await userEvent.type(
      await screen.findByLabelText("Type Ribosome assembly to confirm"),
      "Ribosome assembly",
    );
    await userEvent.click(screen.getByRole("button", { name: "Delete Ribosome assembly" }));

    await waitFor(() => expect(onDeleted).toHaveBeenCalled());
    const sent = invokeCommand.mock.calls
      .map(([envelope]) => envelope as { command: string; args: Record<string, unknown> })
      .find((envelope) => envelope.command === "kiwi.project.delete");
    expect(sent?.args).toMatchObject({
      project_id: "project-1",
      confirmation: "Ribosome assembly",
    });
  });

  it("backs out without deleting anything", async () => {
    const { invokeCommand } = mountWithDelete();
    await userEvent.click(screen.getByRole("button", { name: "Delete this project" }));

    await userEvent.click(await screen.findByRole("button", { name: "Keep it" }));

    expect(screen.getByRole("button", { name: "Delete this project" })).toBeInTheDocument();
    expect(
      invokeCommand.mock.calls.some(
        ([envelope]) => (envelope as { command: string }).command === "kiwi.project.delete",
      ),
    ).toBe(false);
  });

  it("says an empty project is empty rather than saying nothing", async () => {
    mountWithDelete({});

    await userEvent.click(screen.getByRole("button", { name: "Delete this project" }));

    expect(await screen.findByText(/takes nothing out of it/u)).toBeInTheDocument();
  });
});
