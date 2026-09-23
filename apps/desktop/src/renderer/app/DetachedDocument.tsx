import { useEffect, useState } from "react";
import { defaultProjectSettings, readProjectSettings, type CitationStyle } from "@kiwi/contracts";
import { DocumentEditor, type DocumentRecord } from "./DocumentEditor.js";
import { readSelectedProject } from "./selected-project.js";
import { useWindowTitle } from "./window-title.js";
import { readBridge } from "./bridge.js";

/**
 * One document, in a window of its own.
 *
 * A manuscript beside the papers it cites, on a second monitor, is how most people write. Doing
 * that inside one window means splitting the shell in half; doing it with a second window means
 * the shell stays whole in both. So this is the whole of a detached window: the same editor the
 * workbench shows, without the rail and the collection beside it.
 *
 * It is not a copy of the document. Both windows read and write the same canonical file through
 * the same workspace session, and both quote a version on every save, so the second one to save
 * an untouched document is refused and says so rather than overwriting the first.
 *
 * A Note comes here too, on the same terms and through the same editor, which brings its links
 * with it. They read as names rather than as buttons: this window holds one document and has
 * nowhere to put a second, which is the same reason an `@` mention here is a name.
 */

export interface DetachedDocumentProps {
  objectId: string;
}

type LoadState =
  | { status: "loading" }
  | { status: "failed"; message: string }
  | { status: "ready"; workspaceId: string; writable: boolean; record: DocumentRecord };

/** The style the project is written in, so two windows on one paper agree about a citation. */
async function readCitationStyle(): Promise<CitationStyle> {
  const bridge = readBridge();
  const projectId = readSelectedProject()?.projectId ?? null;
  if (bridge === null || projectId === null) return defaultProjectSettings().citation_style;
  const result = await bridge
    .invokeCommand({
      protocol_version: "1.0.0",
      request_id: crypto.randomUUID(),
      command: "kiwi.project.list",
      args: {},
    })
    .catch(() => null);
  const projects = ((result?.data ?? {})["projects"] ?? []) as Array<{
    id: string;
    settings: unknown;
  }>;
  const found = projects.find((entry) => entry.id === projectId);
  if (found === undefined) return defaultProjectSettings().citation_style;
  return readProjectSettings(found.settings).citation_style;
}

export function DetachedDocument({ objectId }: DetachedDocumentProps): React.JSX.Element {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [style, setStyle] = useState<CitationStyle>(defaultProjectSettings().citation_style);
  useWindowTitle(state.status === "ready" ? state.record.title : null);

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
          command: "kiwi.object.read",
          args: { object_id: objectId },
        })
        .catch(() => null);
      if (!active) return;
      const record = ((result?.data ?? {})["object"] ?? null) as DocumentRecord | null;
      if (result === null || result.error !== undefined || record === null) {
        setState({
          status: "failed",
          message: result?.error?.message ?? "That document could not be opened.",
        });
        return;
      }
      setState({
        status: "ready",
        workspaceId: session.summary.workspaceId,
        writable: session.summary.writable,
        record,
      });
      const found = await readCitationStyle();
      if (active) setStyle(found);
    }
    void load();
    return () => {
      active = false;
    };
  }, [objectId]);

  if (state.status === "loading") return <p className="shell__status">Opening</p>;
  if (state.status === "failed") {
    return (
      <p className="shell__status" role="alert">
        {state.message}
      </p>
    );
  }

  return (
    <section className="detached-document" aria-label={state.record.title}>
      <DocumentEditor
        workspaceId={state.workspaceId}
        record={state.record}
        writable={state.writable}
        citationStyle={style}
        detachable={false}
      />
    </section>
  );
}
