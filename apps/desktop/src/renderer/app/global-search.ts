/**
 * Searching every project, not only the one that is open.
 *
 * The rule this whole feature turns on is in the plan in one line: *a result you cannot place is a
 * result you cannot use*. Somebody with four projects across two workspaces who searches for
 * "ribosome" and gets eleven rows of titles has been told less than nothing -- they now have to
 * open each one to find out which is the paper they meant. So every row names its project and its
 * workspace, and a row that belongs to no project says so rather than leaving the space blank,
 * because "not in a project" is an answer and an empty column is not.
 */

export interface GlobalHit {
  workspaceId: string;
  workspaceTitle: string;
  objectId: string;
  objectType: string;
  title: string;
  /** The project it is filed in, or null when it is in none. */
  project: { id: string; title: string } | null;
  /** Lower is better, as the projection scores it. */
  rank: number;
}

export interface GlobalSearchGroup {
  /** What the group is: a project, or the unfiled objects of one workspace. */
  key: string;
  workspaceId: string;
  workspaceTitle: string;
  projectTitle: string | null;
  hits: GlobalHit[];
}

/**
 * The hits grouped by where they are.
 *
 * Grouped rather than flat because the question behind a search across everything is usually
 * "which of my projects has this in it", and a flat list sorted by score answers that by making
 * somebody read the place column of eleven rows. Groups keep their best hit's rank, so the
 * project with the strongest match is still first.
 */
export function groupHits(hits: readonly GlobalHit[]): GlobalSearchGroup[] {
  const groups = new Map<string, GlobalSearchGroup>();
  for (const hit of hits) {
    const key = `${hit.workspaceId}/${hit.project?.id ?? ""}`;
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, {
        key,
        workspaceId: hit.workspaceId,
        workspaceTitle: hit.workspaceTitle,
        projectTitle: hit.project?.title ?? null,
        hits: [hit],
      });
      continue;
    }
    existing.hits.push(hit);
  }
  return [...groups.values()].sort((left, right) => {
    const best = (group: GlobalSearchGroup): number =>
      group.hits.reduce((lowest, hit) => Math.min(lowest, hit.rank), Number.POSITIVE_INFINITY);
    return (
      best(left) - best(right) || (left.projectTitle ?? "").localeCompare(right.projectTitle ?? "")
    );
  });
}

/**
 * The heading over a group, which is where every result gets placed.
 *
 * The place is said once over the group rather than on every row: repeating it under each title
 * would put the same sentence four times on a screen and make the rows harder to read, not
 * easier. A group of things in no project says so, because "not in a project" is an answer and a
 * blank heading is not.
 */
export function groupHeading(group: GlobalSearchGroup): string {
  return group.projectTitle === null
    ? `In no project · ${group.workspaceTitle}`
    : `${group.projectTitle} · ${group.workspaceTitle}`;
}

/** What the panel says above the results. */
export function describeHits(hits: readonly GlobalHit[], searched: boolean): string {
  if (!searched) return "Search every project in every workspace Kiwi has opened.";
  if (hits.length === 0) return "Nothing anywhere matches that.";
  const workspaces = new Set(hits.map((hit) => hit.workspaceId)).size;
  const where = workspaces === 1 ? "one workspace" : `${String(workspaces)} workspaces`;
  return hits.length === 1
    ? `One result, in ${where}.`
    : `${String(hits.length)} results, across ${where}.`;
}
