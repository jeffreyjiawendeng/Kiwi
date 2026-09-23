import { useEffect, useState } from "react";
import { readBridge } from "./bridge.js";
import type { RendererAbout, RendererUpdateState } from "./bridge.js";

const INSTALL_LABELS: Record<string, string> = {
  installed: "Installed",
  portable: "Portable",
  development: "Development",
};

function checkedAt(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** One sentence for each state an update can be in, and what, if anything, can be done about it. */
function describeUpdate(update: RendererUpdateState): {
  text: string;
  action: "check" | "restart" | null;
} {
  switch (update.status) {
    case "off":
      if (update.reason === "portable") {
        return {
          text: "The portable build does not update itself. Download the new version from the Kiwi website.",
          action: null,
        };
      }
      if (update.reason === "no_feed") {
        return {
          text: "This build was packaged without an update feed, so it does not check for updates.",
          action: null,
        };
      }
      return { text: "Development builds do not check for updates.", action: null };
    case "paused":
      return { text: "Kiwi is working offline, so it is not checking for updates.", action: null };
    case "idle":
      return update.checked_at === null
        ? { text: "Kiwi checks for updates in the background.", action: "check" }
        : {
            text: `Kiwi is up to date. Last checked ${checkedAt(update.checked_at)}.`,
            action: "check",
          };
    case "checking":
      return { text: "Checking for updates…", action: null };
    case "downloading":
      return { text: `Downloading Kiwi ${update.version} (${update.percent}%)…`, action: null };
    case "ready":
      return {
        text: `Kiwi ${update.version} is downloaded. It installs the next time Kiwi closes.`,
        action: "restart",
      };
    case "failed":
      return { text: `Could not check for updates: ${update.message}`, action: "check" };
  }
}

export interface AboutProps {
  about: RendererAbout;
  update?: RendererUpdateState | null;
  onCheck?: () => void;
  onRestart?: () => void;
}

export function About({ about, update = null, onCheck, onRestart }: AboutProps): React.JSX.Element {
  const described = update === null ? null : describeUpdate(update);

  return (
    <section className="about" aria-labelledby="about-title">
      <h2 className="about__title" id="about-title">
        About Kiwi
      </h2>

      <dl className="about__facts">
        <dt>Kiwi</dt>
        <dd>{about.appVersion}</dd>
        <dt>Electron</dt>
        <dd>{about.electronVersion}</dd>
        <dt>Chromium</dt>
        <dd>{about.chromiumVersion}</dd>
        <dt>Node</dt>
        <dd>{about.nodeVersion}</dd>
        <dt>Platform</dt>
        <dd>
          {about.platform} {about.architecture}
        </dd>
        <dt>Install</dt>
        <dd>{INSTALL_LABELS[about.installType] ?? about.installType}</dd>
        <dt>Command protocol</dt>
        <dd>{about.protocolVersion}</dd>
        <dt>Build</dt>
        <dd>{about.buildIdentifier}</dd>
      </dl>

      {described === null ? null : (
        <div className="about__update" role="status">
          <p>{described.text}</p>
          {described.action === "check" && onCheck !== undefined ? (
            <button type="button" onClick={onCheck}>
              {update?.status === "failed" ? "Try again" : "Check now"}
            </button>
          ) : null}
          {described.action === "restart" && onRestart !== undefined ? (
            <button type="button" onClick={onRestart}>
              Restart now
            </button>
          ) : null}
        </div>
      )}

      {about.signed ? null : (
        <p className="about__unsigned">
          This build is not code signed, so Windows warns before installing it. Download Kiwi only
          from its website, which publishes a checksum for every release.
        </p>
      )}
    </section>
  );
}

/**
 * About, over whatever is open, with what the updater is doing.
 *
 * Asked for once on opening and again after a check, rather than kept live: a box somebody opens
 * to read a version number does not need a subscription.
 */
export function AboutDialog({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [about, setAbout] = useState<RendererAbout | null>(null);
  const [update, setUpdate] = useState<RendererUpdateState | null>(null);

  useEffect(() => {
    let live = true;
    const bridge = readBridge();
    void bridge
      ?.getAbout()
      .then((next) => {
        if (live) setAbout(next);
      })
      .catch(() => undefined);
    void bridge
      ?.getUpdateState()
      .then((next) => {
        if (live) setUpdate(next);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    function dismiss(event: KeyboardEvent): void {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", dismiss);
    return () => window.removeEventListener("keydown", dismiss);
  }, [onClose]);

  async function check(): Promise<void> {
    setUpdate({ status: "checking" });
    const next = await readBridge()
      ?.checkForUpdates()
      .catch(() => null);
    setUpdate(next ?? null);
  }

  return (
    <div className="about-dialog" role="dialog" aria-label="About Kiwi">
      <header>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </header>
      {about === null ? (
        <p>Reading version details…</p>
      ) : (
        <About
          about={about}
          update={update}
          onCheck={() => void check()}
          onRestart={() => void readBridge()?.restartToUpdate()}
        />
      )}
    </div>
  );
}

/**
 * The top bar's offer to restart into a downloaded update.
 *
 * Nothing at all until there is something to install: an update that is downloading, or a check
 * that found nothing, is not news anybody has to act on. Asked every ten minutes, because the
 * download itself takes minutes and nothing about it is urgent.
 */
export function useUpdateReady(): string | null {
  const [ready, setReady] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    async function read(): Promise<void> {
      try {
        const state = await readBridge()?.getUpdateState();
        if (live) setReady(state?.status === "ready" ? state.version : null);
      } catch {
        // An answer that did not arrive is the same as nothing to install.
      }
    }
    const onFocus = (): void => void read();
    void read();
    const timer = window.setInterval(onFocus, 10 * 60 * 1_000);
    window.addEventListener("focus", onFocus);
    return () => {
      live = false;
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  return ready;
}
