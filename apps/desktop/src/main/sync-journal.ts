/**
 * What synchronization last did with each workspace.
 *
 * The queues on disk say what is still waiting. They cannot say whether the last attempt worked,
 * and that is the difference between "there is nothing to send" and "nothing has got through since
 * this morning" -- two states that look identical from the outbox and mean opposite things to
 * somebody deciding whether to trust what is on their screen.
 *
 * Kept in memory, for as long as the window is open. Writing it down would mean deciding when to
 * clear it, what it means across accounts, and whether a success recorded before a restore still
 * counts, and none of those are decided here. The cost is that a window which has just started has
 * nothing to report yet, and says so rather than showing a time from the last session.
 */

/** What is known about one workspace's synchronization. */
export interface SyncHistory {
  /** When it last got through, or null if it has not since this window opened. */
  last_succeeded_at: string | null;
  /** The last attempt that did not, cleared by the next one that does. */
  last_failure: { at: string; reason: string } | null;
}

const NOTHING: SyncHistory = { last_succeeded_at: null, last_failure: null };

export interface SyncJournal {
  succeeded(workspaceId: string, at: Date): void;
  failed(workspaceId: string, reason: string, at: Date): void;
  read(workspaceId: string): SyncHistory;
  /** For signing out, and for tests. */
  forget(): void;
}

export function createSyncJournal(): SyncJournal {
  const history = new Map<string, SyncHistory>();
  return {
    succeeded(workspaceId, at) {
      // The failure is cleared: something has got through since, so there is nothing left of it to
      // report. The time is not, because it is still the moment it last worked.
      history.set(workspaceId, { last_succeeded_at: at.toISOString(), last_failure: null });
    },
    failed(workspaceId, reason, at) {
      // The last success is kept. A run that fails does not make it untrue that the one before it
      // worked, and how long ago that was is the thing somebody actually wants to know.
      const before = history.get(workspaceId) ?? NOTHING;
      history.set(workspaceId, {
        last_succeeded_at: before.last_succeeded_at,
        last_failure: { at: at.toISOString(), reason },
      });
    },
    read(workspaceId) {
      return history.get(workspaceId) ?? NOTHING;
    },
    forget() {
      history.clear();
    },
  };
}
