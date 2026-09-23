import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QuickCapture, readQuickCaptureSelection } from "./QuickCapture.js";
import type { RendererBridge } from "./bridge.js";

afterEach(() => {
  cleanup();
  delete window.kiwiDesktop;
});

describe("Quick Capture", () => {
  it("prefills selected text and submits exact active context through the registered command", async () => {
    const invokeCommand = vi.fn(async () => ({
      protocol_version: "1.0.0",
      request_id: "capture-request",
      status: "committed",
      data: { object: { id: "capture-1", title: "Selected passage" } },
    }));
    window.kiwiDesktop = { invokeCommand } as unknown as RendererBridge;
    const onCaptured = vi.fn();
    render(
      <QuickCapture
        workspaceId="workspace-1"
        writable
        launch={{
          surface: "collection",
          projectId: null,
          object: {
            id: "source-1",
            title: "Field source",
            type: "source",
            version: 4,
            content_hash: `sha256:${"a".repeat(64)}`,
          },
          selection: {
            text: "Selected passage",
            prefix: "Before ",
            suffix: " after",
          },
        }}
        onClose={vi.fn()}
        onCaptured={onCaptured}
      />,
    );

    expect(screen.getByRole("textbox", { name: "Title" })).toHaveValue("Selected passage");
    expect(screen.getByRole("textbox", { name: "Note" })).toHaveValue("Selected passage");
    expect(screen.getByText("Field source (version 4)")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Add to Inbox" }));

    expect(invokeCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "kiwi.object.quick-capture",
        args: {
          title: "Selected passage",
          content: "Selected passage",
          context: {
            surface: "collection",
            project_id: null,
            object: {
              object_id: "source-1",
              version: 4,
              content_hash: `sha256:${"a".repeat(64)}`,
            },
            source: {
              object_id: "source-1",
              version: 4,
              content_hash: `sha256:${"a".repeat(64)}`,
              representation_id: null,
            },
            selection: { text: "Selected passage", prefix: "Before ", suffix: " after" },
          },
        },
      }),
    );
    expect(onCaptured).toHaveBeenCalledWith("capture-1");
  });

  it("retains typed content after a command failure and allows cancellation without mutation", async () => {
    const invokeCommand = vi.fn(async () => ({
      protocol_version: "1.0.0",
      request_id: "capture-request",
      status: "failed",
      error: { message: "The selected context changed." },
    }));
    window.kiwiDesktop = { invokeCommand } as unknown as RendererBridge;
    const onClose = vi.fn();
    render(
      <QuickCapture
        workspaceId="workspace-1"
        writable
        launch={{ surface: "workbench", projectId: null, object: null, selection: null }}
        onClose={onClose}
        onCaptured={vi.fn()}
      />,
    );
    const note = screen.getByRole("textbox", { name: "Note" });
    await userEvent.type(note, "A thought that must remain visible.");
    await userEvent.click(screen.getByRole("button", { name: "Add to Inbox" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Your capture is still here.");
    expect(note).toHaveValue("A thought that must remain visible.");
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("reads the exact selection and bounded surrounding text from a focused editor", () => {
    render(<textarea aria-label="Source editor" defaultValue="Before selected text after" />);
    const editor = screen.getByRole("textbox", {
      name: "Source editor",
    }) as HTMLTextAreaElement;
    editor.focus();
    editor.setSelectionRange(7, 20);
    expect(readQuickCaptureSelection()).toEqual({
      text: "selected text",
      prefix: "Before ",
      suffix: " after",
    });
  });

  it("keeps a read-only draft visible but cannot submit it", async () => {
    const invokeCommand = vi.fn();
    window.kiwiDesktop = { invokeCommand } as unknown as RendererBridge;
    render(
      <QuickCapture
        workspaceId="workspace-1"
        writable={false}
        launch={{
          surface: "inbox",
          projectId: null,
          object: null,
          selection: { text: "Preserved selection", prefix: null, suffix: null },
        }}
        onClose={vi.fn()}
        onCaptured={vi.fn()}
      />,
    );
    expect(screen.getByRole("textbox", { name: "Note" })).toHaveValue("Preserved selection");
    expect(screen.getByRole("button", { name: "Add to Inbox" })).toBeDisabled();
    expect(screen.getByText(/workspace is read only/u)).toBeInTheDocument();
    expect(invokeCommand).not.toHaveBeenCalled();
  });
});
