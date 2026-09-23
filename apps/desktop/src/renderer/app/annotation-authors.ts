/**
 * Whose marks are on the document, and whose are being shown.
 *
 * A paper a group is reading carries everybody's marks in one list. That is the point — the
 * argument in the margin is why the paper is worth reading twice, but it is also how a page
 * becomes unreadable, and how you lose your own highlights among forty of somebody else's. So
 * every person whose marks are here can be turned off and on again, and while they are off
 * their marks are neither drawn on the page nor listed beside it.
 *
 * Nothing here is stored. Whose a mark is was decided when it was written and is the id it was
 * written under; who is looking at it, and which layers they have turned off this afternoon, is
 * a fact about one window and belongs in one window.
 */

import { useEffect, useState } from "react";
import { assigneeId, assigneesFrom } from "./assignees.js";
import { readBridge, type RendererWorkspaceCollaborationSnapshot } from "./bridge.js";

/** As little of a mark as this file needs: the id it was written under. */
export interface AuthoredMark {
  author: string;
}

/** One person whose marks are on this document. */
export interface MarkAuthor {
  /** The id their marks carry. */
  id: string;
  /** What to call them in a list of people. */
  name: string;
  /** How many marks here are theirs. */
  count: number;
  /** Whether this is the person reading. */
  isSelf: boolean;
  /** Which of the layer colours is theirs, from 1. */
  slot: number;
}

/** What the Reader knows about the people whose ids its marks carry. */
export interface AuthorDirectory {
  /** The reader's own id, and null before the account has been read. */
  self: string | null;
  /** A name per id, for everybody the workspace could name. */
  names: ReadonlyMap<string, string>;
}

/** Nobody named yet: the honest answer for the moment before the account answers. */
export const EMPTY_DIRECTORY: AuthorDirectory = { self: null, names: new Map() };

/**
 * How many colours the layers are told apart by.
 *
 * Six, because a paper being read by more than six people at once is a seminar rather than a
 * project, and a palette long enough for a hundred is a palette of colours nobody can tell
 * apart. Past six the colours repeat; the name beside the mark is what actually says whose it is.
 */
export const AUTHOR_SLOTS = 6;

/**
 * The colour a person's layer is drawn in.
 *
 * Worked out from the id, so somebody is the same colour on every document, on every machine,
 * and after a reload, which is what makes the colour worth learning. Storing an assignment
 * instead would give the same person a different colour on each of their colleagues' screens.
 */
export function authorSlot(id: string): number {
  let hash = 0;
  for (const character of id) hash = (hash * 31 + (character.codePointAt(0) ?? 0)) % 100003;
  return (hash % AUTHOR_SLOTS) + 1;
}

/**
 * What to call somebody whose name the workspace could not give us.
 *
 * Offline, and for a member who has since left, there is no name to be had. A short piece of the
 * id is not a name, but it is true, and it tells two unnamed people apart, which "Someone else"
 * twice over would not.
 */
export function shortAuthorName(id: string): string {
  const bare = id.startsWith("account:") ? id.slice("account:".length) : id;
  return `Member ${bare.slice(0, 8)}`;
}

/**
 * Everybody whose marks are on this document, named and counted.
 *
 * A mark with no maker recorded is left out rather than filed under a person who does not exist.
 * It is never hidden either: only the people listed here can be turned off, so a mark nobody is
 * offered stays on the page.
 *
 * You come first, your own marks are the ones you are looking for, and everybody else follows
 * by name, so a list of six people is somewhere to look rather than somewhere to search.
 */
export function authorsOnMarks(
  marks: readonly AuthoredMark[],
  directory: AuthorDirectory,
): MarkAuthor[] {
  const counts = new Map<string, number>();
  for (const mark of marks) {
    if (mark.author === "") continue;
    counts.set(mark.author, (counts.get(mark.author) ?? 0) + 1);
  }
  const authors = [...counts].map(([id, count]) => {
    const isSelf = id === directory.self;
    return {
      id,
      name: isSelf ? "You" : (directory.names.get(id) ?? shortAuthorName(id)),
      count,
      isSelf,
      slot: authorSlot(id),
    };
  });
  authors.sort((left, right) => {
    if (left.isSelf !== right.isSelf) return left.isSelf ? -1 : 1;
    return (
      left.name.localeCompare(right.name, undefined, { sensitivity: "base" }) ||
      left.id.localeCompare(right.id)
    );
  });
  return authors;
}

/**
 * The marks left showing once some people's layers are off.
 *
 * Hiding nobody shows everything, so a document read alone never has anything taken off it.
 */
export function marksByShownAuthors<Mark extends AuthoredMark>(
  marks: readonly Mark[],
  hidden: ReadonlySet<string>,
): Mark[] {
  if (hidden.size === 0) return [...marks];
  return marks.filter((mark) => !hidden.has(mark.author));
}

/**
 * The hidden people who still have marks here.
 *
 * Somebody's last mark on a document can be deleted while their layer is off. Keeping them
 * hidden would leave a switch nobody can see turned off for a person nobody can find.
 */
export function stillHidden(
  hidden: ReadonlySet<string>,
  authors: readonly MarkAuthor[],
): Set<string> {
  const present = new Set(authors.map((author) => author.id));
  return new Set([...hidden].filter((id) => present.has(id)));
}

async function readSnapshot(
  workspaceId: string,
): Promise<RendererWorkspaceCollaborationSnapshot | null> {
  const bridge = readBridge();
  if (bridge === null || typeof bridge.manageWorkspaceCollaboration !== "function") return null;
  const result = await bridge
    .manageWorkspaceCollaboration({ action: "snapshot", input: { workspace_id: workspaceId } })
    .catch(() => null);
  return result !== null && result.status === "ok" ? result.settings : null;
}

/**
 * Who the reader is, and what everybody else is called.
 *
 * Asked for here rather than passed in, the way the comment threads ask: a Reader has no
 * business being told who is signed in, and every surface that had to be told would be another
 * place to forget. An unreachable account service is not a failure, it is a shorter list of
 * names, with the ids still telling the layers apart.
 */
export function useAuthorDirectory(workspaceId: string): AuthorDirectory {
  const [directory, setDirectory] = useState<AuthorDirectory>(EMPTY_DIRECTORY);

  useEffect(() => {
    const bridge = readBridge();
    if (bridge === null || typeof bridge.getAccountAuthState !== "function") return;
    let active = true;
    void (async () => {
      const auth = await bridge.getAccountAuthState().catch(() => null);
      if (!active || auth === null || auth.status !== "authenticated") return;
      const account = { id: auth.account.id, email: auth.account.email };
      const snapshot = await readSnapshot(workspaceId);
      if (!active) return;
      const names = new Map<string, string>();
      for (const person of assigneesFrom(account, snapshot)) names.set(person.id, person.name);
      setDirectory({ self: assigneeId(account.id), names });
    })();
    return () => {
      active = false;
    };
  }, [workspaceId]);

  return directory;
}
