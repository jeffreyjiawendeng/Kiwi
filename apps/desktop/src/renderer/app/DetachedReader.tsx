import { useEffect, useState } from "react";
import { PdfReader } from "./PdfReader.js";
import { readSelectedProject } from "./selected-project.js";
import { useWindowTitle } from "./window-title.js";
import { readBridge } from "./bridge.js";
import type { PdfLoader } from "./pdf-document.js";

/**
 * One document, in a window of its own, open at the Reader.
 *
 * A paper on the second monitor while the manuscript is written on the first is the arrangement
 * most people reach for, and no split inside one window gives it to them. So the Reader detaches:
 * the same Reader the project shell shows, with its marks, its search and its zoom, without the
 * rail and the tab strip that only make sense where there is a project around it.
 *
 * The window is opened on its parent's workspace root, so it reads the same file through the same
 * session, and the marks it makes are the marks the project shell shows. It is a second view of
 * one document, not a second copy of it.
 */

export interface DetachedReaderProps {
  objectId: string;
  assetId: string;
  /** Injected by tests. PDF.js needs a canvas, which the test environment does not have. */
  loader?: PdfLoader;
}

interface AttachedFile {
  id: string;
  title: string;
  original_filename?: string;
}

type LoadState =
  | { status: "loading" }
  | { status: "failed"; message: string }
  | { status: "ready"; workspaceId: string; writable: boolean; title: string };

export function DetachedReader({
  objectId,
  assetId,
  loader,
}: DetachedReaderProps): React.JSX.Element {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  useWindowTitle(state.status === "ready" ? state.title : null);

  useEffect(() => {
    let active = true;
    async function load(): Promise<void> {
      const bridge = readBridge();
      if (bridge === null) {
        setState({ status: "failed", message: "The desktop bridge is unavailable." });
        return;
      }
      // The window was opened on its parent's workspace root, so a session is already bound by
      // the time this runs. Asking for it is how the renderer learns the workspace id without
      // ever being told a folder.
      const session = await bridge.getWorkspaceSession().catch(() => null);
      if (session === null) {
        setState({ status: "failed", message: "This window has no workspace open." });
        return;
      }
      const result = await bridge
        .invokeCommand({
          protocol_version: "1.0.0",
          request_id: crypto.randomUUID(),
          command: "kiwi.object.files",
          args: { object_id: objectId },
        })
        .catch(() => null);
      if (!active) return;
      if (result === null || result.error !== undefined) {
        setState({
          status: "failed",
          message: result?.error?.message ?? "That document could not be opened.",
        });
        return;
      }
      const files = ((result.data ?? {})["files"] ?? []) as AttachedFile[];
      const file = files.find((entry) => entry.id === assetId);
      if (file === undefined) {
        // Detached, then removed from the Paper in the window it was detached from. Saying so
        // beats a Reader sitting over a blank page.
        setState({ status: "failed", message: "That file is no longer part of this paper." });
        return;
      }
      setState({
        status: "ready",
        workspaceId: session.summary.workspaceId,
        writable: session.summary.writable,
        title: file.original_filename ?? file.title,
      });
    }
    void load();
    return () => {
      active = false;
    };
  }, [objectId, assetId]);

  if (state.status === "loading") return <p className="shell__status">Opening</p>;
  if (state.status === "failed") {
    return (
      <p className="shell__status" role="alert">
        {state.message}
      </p>
    );
  }

  return (
    <section className="detached-reader" aria-label={state.title}>
      <PdfReader
        workspaceId={state.workspaceId}
        assetId={assetId}
        title={state.title}
        objectId={objectId}
        // The project a claim made while reading is filed in. The window shares its parent's
        // browser storage, so this is the project the parent has open.
        projectId={readSelectedProject()?.projectId ?? null}
        writable={state.writable}
        {...(loader === undefined ? {} : { loader })}
      />
    </section>
  );
}
