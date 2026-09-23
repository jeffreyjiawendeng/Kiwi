import { describe, expect, it, vi } from "vitest";
import {
  CHECK_INTERVAL_MS,
  createUpdateController,
  describeUpdateFailure,
  FIRST_CHECK_MS,
  updatesOffReason,
  type UpdateEvent,
  type UpdateFeed,
  type UpdateTimers,
} from "./updater.js";

const NOW = new Date("2026-09-18T12:00:00.000Z");

/** A feed that answers each check with the events it is given. */
function fakeFeed(script: Array<UpdateEvent[] | Error> = []): UpdateFeed & {
  install: ReturnType<typeof vi.fn>;
  checks: number;
  emit(event: UpdateEvent): void;
} {
  let listener: (event: UpdateEvent) => void = () => undefined;
  const feed = {
    checks: 0,
    install: vi.fn(),
    listen(next: (event: UpdateEvent) => void) {
      listener = next;
    },
    emit(event: UpdateEvent) {
      listener(event);
    },
    async check() {
      const answer = script[feed.checks] ?? [{ kind: "checking" }, { kind: "none" }];
      feed.checks += 1;
      if (answer instanceof Error) throw answer;
      for (const event of answer) listener(event);
    },
  };
  return feed;
}

/** Timers that run only when told to, so a test can say when six hours have passed. */
function manualTimers(): UpdateTimers & { pending: Array<{ ms: number; run: () => void }> } {
  const pending: Array<{ ms: number; run: () => void }> = [];
  return {
    pending,
    set(run, ms) {
      const entry = { ms, run };
      pending.push(entry);
      return entry;
    },
    clear(handle) {
      const index = pending.indexOf(handle as { ms: number; run: () => void });
      if (index >= 0) pending.splice(index, 1);
    },
  };
}

async function fire(timers: ReturnType<typeof manualTimers>): Promise<void> {
  const next = timers.pending.shift();
  if (next === undefined) throw new Error("nothing scheduled");
  next.run();
  // Let the check and the rescheduling that follows it settle.
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

describe("whether a copy of Kiwi updates itself", () => {
  it("does not in development, where there is no installer to replace", () => {
    expect(updatesOffReason({ isPackaged: false, env: {}, hasFeed: true })).toBe("development");
  });

  it("does not in the portable build, which cannot replace itself", () => {
    expect(
      updatesOffReason({
        isPackaged: true,
        env: { PORTABLE_EXECUTABLE_DIR: "C:\\Kiwi" },
        hasFeed: true,
      }),
    ).toBe("portable");
  });

  it("does not when it was packaged without a feed", () => {
    expect(updatesOffReason({ isPackaged: true, env: {}, hasFeed: false })).toBe("no_feed");
  });

  it("does when it is installed and knows where to look", () => {
    expect(updatesOffReason({ isPackaged: true, env: {}, hasFeed: true })).toBeNull();
  });
});

describe("the update controller", () => {
  it("reports updates as off and never checks when they are off", async () => {
    const feed = fakeFeed();
    const updates = createUpdateController({ feed, off: "portable", offline: () => false });

    updates.start();
    await expect(updates.checkNow()).resolves.toEqual({ status: "off", reason: "portable" });
    expect(feed.checks).toBe(0);
  });

  it("starts idle, having never checked", () => {
    const updates = createUpdateController({ feed: fakeFeed(), off: null, offline: () => false });

    expect(updates.state()).toEqual({ status: "idle", checked_at: null });
  });

  it("records when it last found nothing new", async () => {
    const updates = createUpdateController({
      feed: fakeFeed(),
      off: null,
      offline: () => false,
      now: () => NOW,
    });

    await expect(updates.checkNow()).resolves.toEqual({
      status: "idle",
      checked_at: NOW.toISOString(),
    });
  });

  it("follows a download through to ready", async () => {
    const feed = fakeFeed([
      [
        { kind: "checking" },
        { kind: "available", version: "1.0.1" },
        { kind: "progress", percent: 41.6 },
      ],
    ]);
    const updates = createUpdateController({ feed, off: null, offline: () => false });

    await updates.checkNow();
    expect(updates.state()).toEqual({ status: "downloading", version: "1.0.1", percent: 42 });

    feed.emit({ kind: "downloaded", version: "1.0.1" });
    expect(updates.state()).toEqual({ status: "ready", version: "1.0.1" });
  });

  it("keeps a downloaded update when a later check fails", async () => {
    const feed = fakeFeed([
      [{ kind: "downloaded", version: "1.0.1" }],
      [{ kind: "failed", message: "net::ERR_INTERNET_DISCONNECTED" }],
    ]);
    const updates = createUpdateController({ feed, off: null, offline: () => false });

    await updates.checkNow();
    await updates.checkNow();

    expect(updates.state()).toEqual({ status: "ready", version: "1.0.1" });
  });

  it("replaces a downloaded update with a newer one", async () => {
    const feed = fakeFeed([
      [{ kind: "downloaded", version: "1.0.1" }],
      [{ kind: "downloaded", version: "1.0.2" }],
    ]);
    const updates = createUpdateController({ feed, off: null, offline: () => false });

    await updates.checkNow();
    await updates.checkNow();

    expect(updates.state()).toEqual({ status: "ready", version: "1.0.2" });
  });

  it("reports a failure the feed announced", async () => {
    const feed = fakeFeed([
      [{ kind: "checking" }, { kind: "failed", message: "HttpError: 404 Not Found" }],
    ]);
    const warn = vi.fn();
    const updates = createUpdateController({
      feed,
      off: null,
      offline: () => false,
      now: () => NOW,
      logger: { info: vi.fn(), warn },
    });

    await expect(updates.checkNow()).resolves.toEqual({
      status: "failed",
      message: "HttpError: 404 Not Found",
      checked_at: NOW.toISOString(),
    });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("reports a failure the feed only threw, once", async () => {
    const warn = vi.fn();
    const updates = createUpdateController({
      feed: fakeFeed([new Error("ENOTFOUND updates.example.org\n    at lookup")]),
      off: null,
      offline: () => false,
      now: () => NOW,
      logger: { info: vi.fn(), warn },
    });

    await expect(updates.checkNow()).resolves.toMatchObject({
      status: "failed",
      message: "ENOTFOUND updates.example.org",
    });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("replaces an old failure when the next check fails too", async () => {
    let at = new Date("2026-09-18T00:00:00.000Z");
    const updates = createUpdateController({
      feed: fakeFeed([new Error("first"), new Error("second")]),
      off: null,
      offline: () => false,
      now: () => at,
    });

    await updates.checkNow();
    at = NOW;
    await expect(updates.checkNow()).resolves.toEqual({
      status: "failed",
      message: "second",
      checked_at: NOW.toISOString(),
    });
  });

  it("shares one check between callers who ask at the same time", async () => {
    const feed = fakeFeed();
    const updates = createUpdateController({ feed, off: null, offline: () => false });

    await Promise.all([updates.checkNow(), updates.checkNow(), updates.checkNow()]);

    expect(feed.checks).toBe(1);
  });

  it("does not start a second download while one is arriving", async () => {
    const feed = fakeFeed([[{ kind: "available", version: "1.0.1" }]]);
    const updates = createUpdateController({ feed, off: null, offline: () => false });

    await updates.checkNow();
    await updates.checkNow();

    expect(feed.checks).toBe(1);
    expect(updates.state()).toMatchObject({ status: "downloading" });
  });

  it("contacts nothing while somebody is working offline, and says so", async () => {
    let offline = true;
    const feed = fakeFeed();
    const updates = createUpdateController({
      feed,
      off: null,
      offline: () => offline,
      now: () => NOW,
    });

    await expect(updates.checkNow()).resolves.toEqual({ status: "paused" });
    expect(feed.checks).toBe(0);

    offline = false;
    expect(updates.state()).toEqual({ status: "idle", checked_at: null });
  });

  it("still offers a downloaded update while working offline, because installing it is local", async () => {
    let offline = false;
    const feed = fakeFeed([[{ kind: "downloaded", version: "1.0.1" }]]);
    const updates = createUpdateController({ feed, off: null, offline: () => offline });

    await updates.checkNow();
    offline = true;

    expect(updates.state()).toEqual({ status: "ready", version: "1.0.1" });
    expect(updates.restart()).toBe(true);
    expect(feed.install).toHaveBeenCalledTimes(1);
  });

  it("restarts into an update only when one is downloaded", async () => {
    const feed = fakeFeed();
    const updates = createUpdateController({ feed, off: null, offline: () => false });

    expect(updates.restart()).toBe(false);
    await updates.checkNow();
    expect(updates.restart()).toBe(false);
    expect(feed.install).not.toHaveBeenCalled();
  });

  it("checks a while after startup and then on an interval", async () => {
    const feed = fakeFeed();
    const timers = manualTimers();
    const updates = createUpdateController({ feed, off: null, offline: () => false, timers });

    updates.start();
    expect(timers.pending.map((entry) => entry.ms)).toEqual([FIRST_CHECK_MS]);

    await fire(timers);
    expect(feed.checks).toBe(1);
    expect(timers.pending.map((entry) => entry.ms)).toEqual([CHECK_INTERVAL_MS]);

    await fire(timers);
    expect(feed.checks).toBe(2);
  });

  it("schedules nothing twice and nothing after stopping", async () => {
    const feed = fakeFeed();
    const timers = manualTimers();
    const updates = createUpdateController({ feed, off: null, offline: () => false, timers });

    updates.start();
    updates.start();
    expect(timers.pending).toHaveLength(1);

    updates.stop();
    expect(timers.pending).toHaveLength(0);
  });

  it("keeps its schedule through a stretch of working offline", async () => {
    let offline = true;
    const feed = fakeFeed();
    const timers = manualTimers();
    const updates = createUpdateController({ feed, off: null, offline: () => offline, timers });

    updates.start();
    await fire(timers);
    expect(feed.checks).toBe(0);
    expect(timers.pending).toHaveLength(1);

    offline = false;
    await fire(timers);
    expect(feed.checks).toBe(1);
  });
});

describe("describing an update failure", () => {
  it("keeps the first line of a long message", () => {
    expect(describeUpdateFailure(new Error("HttpError: 403\nHeaders: {...}\nData: ..."))).toBe(
      "HttpError: 403",
    );
  });

  it("shortens a first line too long to read", () => {
    const described = describeUpdateFailure(new Error("x".repeat(500)));
    expect(described).toHaveLength(200);
    expect(described.endsWith("…")).toBe(true);
  });

  it("says something when the error says nothing", () => {
    expect(describeUpdateFailure(new Error(""))).toBe("The update feed did not answer.");
  });
});
