import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ManagedAssetImport } from "./ManagedAssetImport.js";
import type { RendererBridge, RendererCommandResult } from "./bridge.js";

afterEach(() => {
  cleanup();
  delete window.kiwiDesktop;
});

const HASH = `sha256:${"a".repeat(64)}`;
const MANIFEST_HASH = `sha256:${"b".repeat(64)}`;

function committed(): RendererCommandResult {
  return {
    protocol_version: "1.0.0",
    request_id: "request-1",
    status: "committed",
    data: {
      asset: {
        id: "asset-1",
        title: "notes.txt",
        sha256: HASH,
        content_hash: MANIFEST_HASH,
        byte_size: 12,
        media_type: { determined: "text/plain" },
        storage: { relative_path: "assets/asset-1/notes.txt" },
      },
      duplicate_assets: [],
      copied_bytes: 12,
      manifest_hash: MANIFEST_HASH,
    },
  };
}

function installBridge(
  options: {
    invokeCommand?: RendererBridge["invokeCommand"];
    duplicate?: boolean;
  } = {},
) {
  const chooseManagedAsset = vi.fn(async () => ({
    id: "selection-1",
    name: "notes.txt",
    size: 12,
    modifiedAt: "2026-08-22T12:00:00.000Z",
    declaredMediaType: "text/plain",
  }));
  const registerDroppedManagedAsset = vi.fn(async () => ({
    id: "selection-drop",
    name: "dropped.txt",
    size: 8,
    modifiedAt: "2026-08-22T12:00:00.000Z",
    declaredMediaType: "text/plain",
  }));
  const invokeCommand = vi.fn(
    options.invokeCommand ??
      (async () => {
        const result = committed();
        if (options.duplicate)
          result.data!["duplicate_assets"] = [
            { asset_id: "asset-old", title: "prior.txt", sha256: HASH },
          ];
        return result;
      }),
  );
  const cancelCommand = vi.fn(async () => true);
  window.kiwiDesktop = {
    chooseManagedAsset,
    registerDroppedManagedAsset,
    invokeCommand,
    cancelCommand,
  } as unknown as RendererBridge;
  return { chooseManagedAsset, registerDroppedManagedAsset, invokeCommand, cancelCommand };
}

describe("managed asset import", () => {
  it("chooses one file, invokes the canonical command, and shows its durable receipt", async () => {
    const { invokeCommand } = installBridge({ duplicate: true });
    const onOpenAsset = vi.fn();
    render(
      <ManagedAssetImport
        workspaceId="workspace-1"
        writable
        onClose={vi.fn()}
        onOpenAsset={onOpenAsset}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Browse files…" }));
    expect(screen.getByRole("region", { name: "Selected file" })).toHaveTextContent("notes.txt");
    await userEvent.click(screen.getByRole("button", { name: "Add to workspace" }));

    expect(await screen.findByRole("heading", { name: "File added" })).toBeInTheDocument();
    expect(screen.getByText("assets/asset-1/notes.txt")).toBeInTheDocument();
    expect(screen.getByText("a".repeat(64))).toBeInTheDocument();
    expect(screen.getByText(/separate import with its own provenance/u)).toBeInTheDocument();
    expect(invokeCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        workspace_id: "workspace-1",
        command: "kiwi.asset.import-managed",
        args: { selection_id: "selection-1" },
      }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Reveal copied file" }));
    expect(invokeCommand).toHaveBeenLastCalledWith(
      expect.objectContaining({
        workspace_id: "workspace-1",
        command: "kiwi.asset.reveal-managed",
        args: { asset_id: "asset-1" },
      }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Open in Research items" }));
    expect(onOpenAsset).toHaveBeenCalledWith("asset-1");
  });

  it("registers an actual dropped File without exposing a path in component state", async () => {
    const { registerDroppedManagedAsset } = installBridge();
    render(
      <ManagedAssetImport
        workspaceId="workspace-1"
        writable
        onClose={vi.fn()}
        onOpenAsset={vi.fn()}
      />,
    );
    const file = new File(["dropped"], "dropped.txt", { type: "text/plain" });
    fireEvent.drop(screen.getByLabelText("Managed file drop target"), {
      dataTransfer: { files: [file] },
    });

    await waitFor(() => expect(registerDroppedManagedAsset).toHaveBeenCalledWith(file));
    expect(await screen.findByText("dropped.txt")).toBeInTheDocument();
  });

  it("cancels an in-flight copy through the same request and never reports success", async () => {
    let resolveResult!: (value: RendererCommandResult) => void;
    const pending = new Promise<RendererCommandResult>((resolve) => {
      resolveResult = resolve;
    });
    const { cancelCommand } = installBridge({ invokeCommand: () => pending });
    render(
      <ManagedAssetImport
        workspaceId="workspace-1"
        writable
        onClose={vi.fn()}
        onOpenAsset={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Browse files…" }));
    await userEvent.click(screen.getByRole("button", { name: "Add to workspace" }));
    expect(await screen.findByText("Copying and verifying…")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Cancel import" }));
    expect(cancelCommand).toHaveBeenCalledWith(expect.any(String));
    resolveResult({
      protocol_version: "1.0.0",
      request_id: "request-1",
      status: "canceled",
    });
    expect(await screen.findByRole("alert")).toHaveTextContent("Import canceled");
    expect(screen.queryByRole("heading", { name: "File added" })).not.toBeInTheDocument();
  });

  it("keeps cancellation mutation-free and explains read-only unavailability", async () => {
    const { invokeCommand } = installBridge();
    const onClose = vi.fn();
    const view = render(
      <ManagedAssetImport
        workspaceId="workspace-1"
        writable
        onClose={onClose}
        onOpenAsset={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(invokeCommand).not.toHaveBeenCalled();

    view.rerender(
      <ManagedAssetImport
        workspaceId="workspace-1"
        writable={false}
        onClose={vi.fn()}
        onOpenAsset={vi.fn()}
      />,
    );
    const dialog = screen.getByRole("dialog", { name: "Add a file" });
    expect(within(dialog).getByRole("button", { name: "Browse files…" })).toBeDisabled();
    expect(within(dialog).getByText(/workspace is read only/u)).toBeInTheDocument();
  });
});
