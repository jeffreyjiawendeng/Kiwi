/**
 * Keeping an installed Kiwi current.
 *
 * A while after startup, and every six hours after that, Kiwi asks its release feed whether there
 * is a newer version. What it finds is downloaded in the background and installed the next time
 * Kiwi quits, so nobody has to do anything to stay current. The top bar offers a restart only for
 * whoever wants the new version now rather than tomorrow.
 *
 * It does nothing in three cases: in development, where there is no installer to replace; in the
 * portable build, which is a folder somebody unzipped and cannot replace itself; and in a build
 * packaged without a feed. It also does not check while somebody has chosen to work offline. That
 * switch means Kiwi contacts nothing, and asking a server for a version number is contact.
 *
 * The feed itself sits behind `UpdateFeed` so that everything here can be tested without
 * Electron. `electron-updater` supplies the real one in `index.ts`.
 */

import type { Logger } from "@kiwi/diagnostics";

export type UpdateOffReason = "development" | "portable" | "no_feed";

export type UpdateState =
  | { status: "off"; reason: UpdateOffReason }
  /** Working offline. Nothing is checked until the switch is turned back. */
  | { status: "paused" }
  | { status: "idle"; checked_at: string | null }
  | { status: "checking" }
  | { status: "downloading"; version: string; percent: number }
  /** Downloaded. It installs when Kiwi quits, or now if somebody restarts. */
  | { status: "ready"; version: string }
  | { status: "failed"; message: string; checked_at: string };

export type UpdateEvent =
  | { kind: "checking" }
  | { kind: "available"; version: string }
  | { kind: "none" }
  | { kind: "progress"; percent: number }
  | { kind: "downloaded"; version: string }
  | { kind: "failed"; message: string };

export interface UpdateFeed {
  /** Asks the feed. Resolves once the answer has been announced through the listener. */
  check(): Promise<void>;
  /** Quits and runs the downloaded installer. */
  install(): void;
  listen(listener: (event: UpdateEvent) => void): void;
}

export interface UpdateController {
  state(): UpdateState;
  /** Schedules the first check and the ones after it. */
  start(): void;
  stop(): void;
  /** Checks now, unless a check is already running, in which case it waits for that one. */
  checkNow(): Promise<UpdateState>;
  /** Installs what has been downloaded. Answers false when there is nothing to install. */
  restart(): boolean;
}

export interface UpdateTimers {
  set(run: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface UpdateControllerOptions {
  feed: UpdateFeed | null;
  off: UpdateOffReason | null;
  offline: () => boolean;
  logger?: Pick<Logger, "info" | "warn">;
  now?: () => Date;
  timers?: UpdateTimers;
  /** Long enough that the check does not compete with opening a workspace. */
  firstCheckMs?: number;
  intervalMs?: number;
}

export const FIRST_CHECK_MS = 30_000;
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1_000;

/** Why updates are off for this copy of Kiwi, or `null` when they are on. */
export function updatesOffReason(sources: {
  isPackaged: boolean;
  env: NodeJS.ProcessEnv;
  hasFeed: boolean;
}): UpdateOffReason | null {
  if (!sources.isPackaged) return "development";
  // electron-builder sets this for the portable target only.
  if (sources.env["PORTABLE_EXECUTABLE_DIR"] !== undefined) return "portable";
  if (!sources.hasFeed) return "no_feed";
  return null;
}

/**
 * What an updater error says, cut to something that fits in a sentence.
 *
 * `electron-updater` puts the whole HTTP response, headers and all, into some of its messages.
 * The first line says what went wrong; the rest belongs in nobody's About box.
 */
export function describeUpdateFailure(cause: unknown): string {
  const raw = cause instanceof Error ? cause.message : String(cause);
  const first = raw.split(/\r?\n/, 1)[0]?.trim() ?? "";
  if (first === "") return "The update feed did not answer.";
  return first.length > 200 ? `${first.slice(0, 199)}…` : first;
}

const defaultTimers: UpdateTimers = {
  set: (run, ms) => setTimeout(run, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function createUpdateController(options: UpdateControllerOptions): UpdateController {
  const { feed, off, offline, logger } = options;
  const now = options.now ?? (() => new Date());
  const timers = options.timers ?? defaultTimers;
  const firstCheckMs = options.firstCheckMs ?? FIRST_CHECK_MS;
  const intervalMs = options.intervalMs ?? CHECK_INTERVAL_MS;

  let current: UpdateState =
    off !== null || feed === null
      ? { status: "off", reason: off ?? "no_feed" }
      : { status: "idle", checked_at: null };
  let running: Promise<UpdateState> | null = null;
  let timer: unknown = null;

  function apply(event: UpdateEvent): void {
    // Once something is downloaded, only a newer download replaces it. A later check that fails
    // or finds nothing does not take back an update that is sitting on disk ready to install.
    if (current.status === "ready" && event.kind !== "downloaded") return;

    switch (event.kind) {
      case "checking":
        current = { status: "checking" };
        return;
      case "available":
        current = { status: "downloading", version: event.version, percent: 0 };
        logger?.info("update.available", { version: event.version });
        return;
      case "progress":
        if (current.status === "downloading") {
          current = { ...current, percent: Math.max(0, Math.min(100, Math.round(event.percent))) };
        }
        return;
      case "none":
        current = { status: "idle", checked_at: now().toISOString() };
        return;
      case "downloaded":
        current = { status: "ready", version: event.version };
        logger?.info("update.downloaded", { version: event.version });
        return;
      case "failed":
        current = { status: "failed", message: event.message, checked_at: now().toISOString() };
        logger?.warn("update.failed", { message: event.message });
        return;
    }
  }

  feed?.listen(apply);

  function state(): UpdateState {
    // Worked out when asked rather than stored, so that turning the switch back shows the real
    // state straight away instead of "paused" until the next check six hours later.
    if (offline() && (current.status === "idle" || current.status === "failed")) {
      return { status: "paused" };
    }
    return current;
  }

  function checkNow(): Promise<UpdateState> {
    if (feed === null || current.status === "off") return Promise.resolve(state());
    if (offline()) return Promise.resolve(state());
    if (running !== null) return running;
    // A download is the answer to the last check still arriving. Asking again would restart it.
    if (current.status === "downloading") return Promise.resolve(state());
    if (current.status !== "ready") current = { status: "checking" };

    running = feed
      .check()
      .catch((cause: unknown) => {
        // The feed reports most failures as an event as well as a rejection. Recording it twice
        // would log it twice, so the rejection counts only when no event already did.
        if (current.status === "checking") {
          apply({ kind: "failed", message: describeUpdateFailure(cause) });
        }
      })
      .then(() => {
        if (current.status === "checking") apply({ kind: "none" });
        return state();
      })
      .finally(() => {
        running = null;
      });
    return running;
  }

  function schedule(ms: number): void {
    timer = timers.set(() => {
      void checkNow().finally(() => {
        if (timer !== null) schedule(intervalMs);
      });
    }, ms);
  }

  return {
    state,
    start() {
      if (feed === null || current.status === "off" || timer !== null) return;
      schedule(firstCheckMs);
    },
    stop() {
      if (timer !== null) timers.clear(timer);
      timer = null;
    },
    checkNow,
    restart() {
      if (feed === null || current.status !== "ready") return false;
      logger?.info("update.installing", { version: current.version });
      feed.install();
      return true;
    },
  };
}
