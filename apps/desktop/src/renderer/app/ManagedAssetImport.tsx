import { useEffect, useRef, useState } from "react";
import { readBridge, type RendererManagedAssetSelection } from "./bridge.js";

interface ManagedAssetReceipt {
  asset: {
    id: string;
    title: string;
    sha256: string;
    content_hash: string;
    byte_size: number;
    media_type: { determined: string };
    storage: { relative_path: string };
  };
  duplicate_assets: Array<{ asset_id: string; title: string; sha256: string }>;
  copied_bytes: number;
  manifest_hash: string;
}

function readReceipt(value: Record<string, unknown> | undefined): ManagedAssetReceipt | null {
  const asset = value?.["asset"];
  const duplicates = value?.["duplicate_assets"];
  if (asset === null || typeof asset !== "object" || Array.isArray(asset)) return null;
  const record = asset as Record<string, unknown>;
  const media = record["media_type"];
  const storage = record["storage"];
  if (
    typeof record["id"] !== "string" ||
    typeof record["title"] !== "string" ||
    typeof record["sha256"] !== "string" ||
    typeof record["content_hash"] !== "string" ||
    typeof record["byte_size"] !== "number" ||
    media === null ||
    typeof media !== "object" ||
    Array.isArray(media) ||
    typeof (media as Record<string, unknown>)["determined"] !== "string" ||
    storage === null ||
    typeof storage !== "object" ||
    Array.isArray(storage) ||
    typeof (storage as Record<string, unknown>)["relative_path"] !== "string" ||
    !Array.isArray(duplicates) ||
    typeof value?.["copied_bytes"] !== "number" ||
    typeof value["manifest_hash"] !== "string"
  )
    return null;
  const duplicateAssets = duplicates.filter(
    (item): item is { asset_id: string; title: string; sha256: string } =>
      item !== null &&
      typeof item === "object" &&
      !Array.isArray(item) &&
      typeof (item as Record<string, unknown>)["asset_id"] === "string" &&
      typeof (item as Record<string, unknown>)["title"] === "string" &&
      typeof (item as Record<string, unknown>)["sha256"] === "string",
  );
  if (duplicateAssets.length !== duplicates.length) return null;
  return {
    asset: {
      id: record["id"],
      title: record["title"],
      sha256: record["sha256"],
      content_hash: record["content_hash"],
      byte_size: record["byte_size"],
      media_type: { determined: (media as Record<string, string>)["determined"]! },
      storage: { relative_path: (storage as Record<string, string>)["relative_path"]! },
    },
    duplicate_assets: duplicateAssets,
    copied_bytes: value["copied_bytes"],
    manifest_hash: value["manifest_hash"],
  };
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value.toLocaleString()} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

export function ManagedAssetImport({
  workspaceId,
  writable,
  dropped = null,
  onClose,
  onOpenAsset,
}: {
  workspaceId: string;
  writable: boolean;
  /** A file dropped on the window, registered on arrival rather than asked for a second time. */
  dropped?: File | null;
  onClose(): void;
  onOpenAsset(assetId: string): void;
}): React.JSX.Element {
  const [selection, setSelection] = useState<RendererManagedAssetSelection | null>(null);
  const [receipt, setReceipt] = useState<ManagedAssetReceipt | null>(null);
  const [busy, setBusy] = useState<"selecting" | "importing" | "canceling" | "revealing" | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const requestId = useRef<string | null>(null);
  const arrived = useRef(false);
  const browse = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const doneButton = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLElement>(null);

  useEffect(() => {
    (writable ? browse.current : closeButton.current)?.focus();
  }, [writable]);

  useEffect(() => {
    if (receipt !== null) doneButton.current?.focus();
  }, [receipt]);

  // A file dropped on the window opens this dialog already holding it. The guard is what keeps it
  // to one registration: a re-render while the first is in flight must not start a second.
  useEffect(() => {
    if (dropped === null || arrived.current) return;
    arrived.current = true;
    void take(dropped);
  }, [dropped]);

  useEffect(() => {
    function keydown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        event.preventDefault();
        if (busy === "importing") void cancelImport();
        else if (busy === null) onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [
        ...(dialog.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? []),
      ];
      const first = focusable[0];
      const last = focusable.at(-1);
      if (first === undefined || last === undefined) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  });

  async function choose(): Promise<void> {
    const bridge = readBridge();
    if (bridge === null || !writable || busy !== null) return;
    setBusy("selecting");
    setError(null);
    try {
      const chosen = await bridge.chooseManagedAsset();
      if (chosen !== null) {
        setSelection(chosen);
        setReceipt(null);
      }
    } catch {
      setError("Kiwi could not open the file picker. Try again.");
    } finally {
      setBusy(null);
    }
  }

  /**
   * Registers a file that arrived by being dropped rather than picked.
   *
   * A drop hands the renderer a File, which knows its own name and nothing about where it sits on
   * disk. The main process turns it into the same kind of selection the picker issues, so nothing
   * below this line can tell the two apart and the renderer has still never held a path.
   */
  async function take(file: File): Promise<void> {
    const bridge = readBridge();
    if (bridge === null || !writable || busy !== null) return;
    setBusy("selecting");
    setError(null);
    try {
      const chosen = await bridge.registerDroppedManagedAsset(file);
      if (chosen === null)
        setError("Kiwi could not use that dropped file. Choose it with Browse instead.");
      else {
        setSelection(chosen);
        setReceipt(null);
      }
    } catch {
      setError("Kiwi could not use that dropped file. Choose it with Browse instead.");
    } finally {
      setBusy(null);
      setDragging(false);
    }
  }

  function takeDropped(files: FileList): void {
    const file = files[0];
    if (files.length !== 1 || file === undefined) {
      setDragging(false);
      setError("Drop one file at a time.");
      return;
    }
    void take(file);
  }

  async function importFile(): Promise<void> {
    const bridge = readBridge();
    if (bridge === null || selection === null || !writable || busy !== null) return;
    const id = crypto.randomUUID();
    requestId.current = id;
    setBusy("importing");
    setError(null);
    let result;
    try {
      result = await bridge.invokeCommand({
        protocol_version: "1.0.0",
        request_id: id,
        idempotency_key: id,
        workspace_id: workspaceId,
        command: "kiwi.asset.import-managed",
        args: { selection_id: selection.id },
      });
    } catch {
      requestId.current = null;
      setBusy(null);
      setSelection(null);
      setError("Kiwi could not add the file. Choose it again to retry.");
      return;
    }
    requestId.current = null;
    setBusy(null);
    if (result.status === "canceled") {
      setSelection(null);
      setError("Import canceled. Choose the file again when you are ready.");
      return;
    }
    if (result.error !== undefined) {
      setSelection(null);
      setError(`${result.error.message} Choose the file again to retry.`);
      return;
    }
    const parsed = readReceipt(result.data);
    if (parsed === null) {
      setSelection(null);
      setError("Kiwi committed the file but could not read its receipt. Reopen Research items.");
      return;
    }
    setReceipt(parsed);
  }

  async function cancelImport(): Promise<void> {
    const bridge = readBridge();
    if (bridge === null || requestId.current === null || busy !== "importing") return;
    setBusy("canceling");
    await bridge.cancelCommand(requestId.current);
  }

  async function revealManagedFile(): Promise<void> {
    const bridge = readBridge();
    if (bridge === null || receipt === null || busy !== null) return;
    const id = crypto.randomUUID();
    setBusy("revealing");
    setError(null);
    try {
      const result = await bridge.invokeCommand({
        protocol_version: "1.0.0",
        request_id: id,
        idempotency_key: id,
        workspace_id: workspaceId,
        command: "kiwi.asset.reveal-managed",
        args: { asset_id: receipt.asset.id },
      });
      if (result.error !== undefined) setError(result.error.message);
    } catch {
      setError("Kiwi could not reveal the copied file. Try again.");
    } finally {
      setBusy(null);
    }
  }

  const unavailable = !writable;
  return (
    <div className="managed-asset__backdrop">
      <section
        ref={dialog}
        className="managed-asset"
        role="dialog"
        aria-modal="true"
        aria-labelledby="managed-asset-title"
        aria-describedby="managed-asset-description"
      >
        <header>
          <div>
            <span>Managed asset</span>
            <h2 id="managed-asset-title">Add a file</h2>
          </div>
          <button
            ref={closeButton}
            type="button"
            aria-label="Close Add a file"
            disabled={busy !== null}
            onClick={onClose}
          >
            ×
          </button>
        </header>
        <p id="managed-asset-description">
          Kiwi copies the original bytes into this workspace and records an integrity hash.
        </p>

        {receipt === null ? (
          <>
            <div
              className={`managed-asset__drop${dragging ? " managed-asset__drop--active" : ""}`}
              aria-label="Managed file drop target"
              onDragEnter={(event) => {
                event.preventDefault();
                if (!unavailable) setDragging(true);
              }}
              onDragOver={(event) => event.preventDefault()}
              onDragLeave={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null))
                  setDragging(false);
              }}
              onDrop={(event) => {
                event.preventDefault();
                takeDropped(event.dataTransfer.files);
              }}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                <path d="M5 3h9l5 5v13H5V3Zm8 2v4h4l-4-4Zm-2 7v3H8l4 4 4-4h-3v-3h-2Z" />
              </svg>
              <strong>{dragging ? "Drop the file here" : "Drop one file here"}</strong>
              <span>or</span>
              <button
                ref={browse}
                type="button"
                disabled={unavailable || busy !== null}
                onClick={choose}
              >
                {busy === "selecting" ? "Opening…" : "Browse files…"}
              </button>
            </div>
            {selection === null ? null : (
              <section className="managed-asset__selection" aria-label="Selected file">
                <div>
                  <strong>{selection.name}</strong>
                  <span>
                    {formatBytes(selection.size)}
                    {selection.declaredMediaType === null
                      ? ""
                      : ` · ${selection.declaredMediaType}`}
                  </span>
                </div>
                <button type="button" disabled={busy !== null} onClick={() => setSelection(null)}>
                  Remove
                </button>
              </section>
            )}
            {unavailable ? (
              <p className="managed-asset__notice">
                This workspace is read only. Open a writable copy to add files.
              </p>
            ) : null}
            {busy === "importing" || busy === "canceling" ? (
              <div className="managed-asset__progress" role="status" aria-live="polite">
                <progress aria-label="Managed file import progress" />
                <span>{busy === "canceling" ? "Canceling safely…" : "Copying and verifying…"}</span>
              </div>
            ) : null}
          </>
        ) : (
          <section className="managed-asset__receipt" aria-labelledby="managed-asset-receipt-title">
            <span aria-hidden="true">✓</span>
            <h3 id="managed-asset-receipt-title">File added</h3>
            <p>{receipt.asset.title}</p>
            <dl>
              <dt>Copied</dt>
              <dd>{formatBytes(receipt.copied_bytes)}</dd>
              <dt>Type</dt>
              <dd>{receipt.asset.media_type.determined}</dd>
              <dt>Workspace path</dt>
              <dd>{receipt.asset.storage.relative_path}</dd>
              <dt>SHA-256</dt>
              <dd>{receipt.asset.sha256.replace("sha256:", "")}</dd>
              <dt>Manifest hash</dt>
              <dd>{receipt.manifest_hash.replace("sha256:", "")}</dd>
            </dl>
            {receipt.duplicate_assets.length === 0 ? null : (
              <p className="managed-asset__notice">
                Identical bytes already exist in {receipt.duplicate_assets.length} other logical
                {receipt.duplicate_assets.length === 1 ? " asset" : " assets"}. Kiwi preserved this
                file as a separate import with its own provenance.
              </p>
            )}
          </section>
        )}
        {error === null ? null : (
          <p className="managed-asset__error" role="alert">
            {error}
          </p>
        )}
        <footer>
          {receipt === null ? (
            <>
              <button
                type="button"
                className="button button--secondary"
                disabled={busy === "selecting" || busy === "canceling"}
                onClick={busy === "importing" ? cancelImport : onClose}
              >
                {busy === "importing" ? "Cancel import" : "Cancel"}
              </button>
              <button
                type="button"
                className="button button--primary"
                disabled={selection === null || unavailable || busy !== null}
                onClick={importFile}
              >
                Add to workspace
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="button button--secondary"
                disabled={busy !== null}
                onClick={revealManagedFile}
              >
                {busy === "revealing" ? "Revealing…" : "Reveal copied file"}
              </button>
              <button
                ref={doneButton}
                type="button"
                className="button button--primary"
                disabled={busy !== null}
                onClick={() => onOpenAsset(receipt.asset.id)}
              >
                Open in Research items
              </button>
            </>
          )}
        </footer>
      </section>
    </div>
  );
}
