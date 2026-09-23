/**
 * Working offline on purpose.
 *
 * Kiwi is local-first, so a workspace with no connection already works: the files on disk are the
 * real ones and nothing about editing them needs the service. What this adds is the difference
 * between a connection that is not there and a decision not to use one -- somebody on a metered
 * connection, on somebody else's network, or working on something they are not ready to send.
 *
 * The flag is read on the synchronization path, which runs after every save, so it is held in
 * memory and the file is only how it survives a restart. A read that has not happened yet answers
 * `false`: the safe default when the answer is unknown is the one the application had before this
 * existed, and a save that goes out when it did not have to is a smaller failure than one that
 * quietly does not.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface OfflineModeStore {
  /** What is in force now, without waiting. */
  offline(): boolean;
  /** Reads what a previous run decided. Called once at startup. */
  load(): Promise<boolean>;
  /** Records the decision and returns it. */
  set(offline: boolean): Promise<boolean>;
}

export function createOfflineMode(file: string): OfflineModeStore {
  let current = false;

  return {
    offline: () => current,

    async load() {
      const raw = await readFile(file, "utf8").catch(() => null);
      if (raw === null) return current;
      try {
        const parsed: unknown = JSON.parse(raw);
        const value =
          parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)["offline"]
            : null;
        current = value === true;
      } catch {
        // A file this small that cannot be read is a file worth ignoring. The consequence is
        // being online when somebody asked not to be, which the switch on Home shows and fixes.
        current = false;
      }
      return current;
    },

    async set(offline) {
      current = offline;
      await mkdir(dirname(file), { recursive: true });
      // Written beside and renamed over, like the other small stores here: a half-written flag
      // read at the next launch would be a decision nobody made.
      const pending = `${file}.tmp`;
      await writeFile(pending, `${JSON.stringify({ offline }, null, 2)}\n`, "utf8");
      await rename(pending, file);
      return current;
    },
  };
}
