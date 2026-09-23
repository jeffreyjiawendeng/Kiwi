import { useCallback, useEffect, useMemo, useState } from "react";
import { objectEventLabel } from "@kiwi/contracts";
import { readBridge, type RendererCommandResult } from "./bridge.js";
import { describeCount, nameActor, readLog, type RawEvent } from "./history-log.js";

const LIMIT = 200;
/** The most the projection hands over in one page. */
const TITLE_PAGE = 200;
/** How many pages of titles are read for one log, which bounds a very large workspace. */
const TITLE_PAGES = 5;
const NOBODY: ReadonlyMap<string, string> = new Map();

async function invoke(
  workspaceId: string,
  command: string,
  args: Record<string, unknown>,
): Promise<RendererCommandResult> {
  const bridge = readBridge();
  if (bridge === null) throw new Error("The desktop bridge is unavailable.");
  const requestId = crypto.randomUUID();
  return bridge.invokeCommand({
    protocol_version: "1.0.0",
    request_id: requestId,
    workspace_id: workspaceId,
    command,
    args,
  });
}

/**
 * What every object is called now, read a page at a time.
 *
 * The projection hands over two hundred at most, and a workspace of a few hundred papers is
 * ordinary. Asking for more in one request is refused outright, and a refusal that was answered
 * with an empty map made a log in which nothing had a name.
 */
async function readTitles(workspaceId: string): Promise<ReadonlyMap<string, string>> {
  const titles = new Map<string, string>();
  for (let page = 0; page < TITLE_PAGES; page += 1) {
    const listed = await invoke(workspaceId, "kiwi.projection.list", {
      page: { offset: page * TITLE_PAGE, limit: TITLE_PAGE },
    });
    if (listed.error !== undefined) throw new Error(listed.error.message);
    const data = listed.data ?? {};
    const objects = (data["objects"] as Array<{ id: string; title: string }> | undefined) ?? [];
    for (const object of objects) titles.set(object.id, object.title);
    const total = Number(data["total"] ?? objects.length);
    if (objects.length < TITLE_PAGE || titles.size >= total) break;
  }
  return titles;
}

interface Filters {
  actor: string;
  objectId: string;
  eventType: string;
}

const NOTHING: Filters = { actor: "", objectId: "", eventType: "" };

/**
 * Everything that has happened in this workspace.
 *
 * The events have been on disk since the first version of Kiwi and nothing read them into a page.
 * This is that page: the journal, newest first, grouped by day, with the three filters somebody
 * actually reaches for -- who, what, and which object.
 *
 * **Restoring is not done here.** A version is restored from the object's own history in the dock,
 * where the comparison, the impact, and the reason field already are; a second restore button with
 * none of that around it would be the same action offered with less to go on. So a row that
 * produced a version opens the object instead, and the dock takes it from there.
 */
export function HistoryPage({
  workspaceId,
  people = NOBODY,
  onOpenObject,
}: {
  workspaceId: string;
  /** What each account is called, so a row can say who rather than which identifier. */
  people?: ReadonlyMap<string, string> | undefined;
  onOpenObject?: ((objectId: string, type: string) => void) | undefined;
}): React.JSX.Element {
  const [events, setEvents] = useState<RawEvent[]>([]);
  const [matched, setMatched] = useState(0);
  const [actors, setActors] = useState<string[]>([]);
  const [eventTypes, setEventTypes] = useState<string[]>([]);
  const [titles, setTitles] = useState<ReadonlyMap<string, string>>(new Map());
  const [filters, setFilters] = useState<Filters>(NOTHING);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [log, titled] = await Promise.all([
        invoke(workspaceId, "kiwi.event.list", {
          limit: LIMIT,
          ...(filters.actor === "" ? {} : { actor: filters.actor }),
          ...(filters.objectId === "" ? {} : { object_id: filters.objectId }),
          ...(filters.eventType === "" ? {} : { event_type: filters.eventType }),
        }),
        // What each object is called now, so a row can name what it was about. The log holds
        // identifiers; only the library knows the titles.
        readTitles(workspaceId),
      ]);
      if (log.error !== undefined) throw new Error(log.error.message);
      const data = log.data ?? {};
      setEvents((data["entries"] as RawEvent[] | undefined) ?? []);
      setMatched(Number(data["matched"] ?? 0));
      setActors((data["actors"] as string[] | undefined) ?? []);
      setEventTypes((data["event_types"] as string[] | undefined) ?? []);
      setTitles(titled);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Kiwi could not read the event log.");
    } finally {
      setLoading(false);
    }
  }, [workspaceId, filters]);

  useEffect(() => {
    void load();
  }, [load]);

  const days = useMemo(() => readLog(events, titles, new Date(), people), [events, titles, people]);
  const objectChoices = useMemo(
    () =>
      [...titles.entries()]
        .map(([id, title]) => ({ id, title }))
        .sort((left, right) => left.title.localeCompare(right.title)),
    [titles],
  );

  return (
    <section className="history-page" aria-label="History">
      <header className="page-head">
        <h2>History</h2>
        <p className="page-head__count">{describeCount(events.length, matched)}</p>
      </header>

      <div className="history-page__filters" role="group" aria-label="Filters">
        <label>
          Member
          <select
            value={filters.actor}
            onChange={(event) => {
              // Read before the updater runs: by then React has recycled the event.
              const chosen = event.currentTarget.value;
              setFilters((current) => ({ ...current, actor: chosen }));
            }}
          >
            <option value="">Anybody</option>
            {actors.map((actor) => (
              <option key={actor} value={actor}>
                {nameActor(actor, people)}
              </option>
            ))}
          </select>
        </label>
        <label>
          Action
          <select
            value={filters.eventType}
            onChange={(event) => {
              // Read before the updater runs: by then React has recycled the event.
              const chosen = event.currentTarget.value;
              setFilters((current) => ({ ...current, eventType: chosen }));
            }}
          >
            <option value="">Anything</option>
            {eventTypes.map((type) => (
              <option key={type} value={type}>
                {objectEventLabel(type)}
              </option>
            ))}
          </select>
        </label>
        <label>
          Object
          <select
            value={filters.objectId}
            onChange={(event) => {
              // Read before the updater runs: by then React has recycled the event.
              const chosen = event.currentTarget.value;
              setFilters((current) => ({ ...current, objectId: chosen }));
            }}
          >
            <option value="">Anything</option>
            {objectChoices.map((choice) => (
              <option key={choice.id} value={choice.id}>
                {choice.title}
              </option>
            ))}
          </select>
        </label>
        {filters === NOTHING ? null : (
          <button type="button" onClick={() => setFilters(NOTHING)}>
            Clear filters
          </button>
        )}
      </div>

      {error !== null ? (
        <p className="history-page__error" role="alert">
          {error}
        </p>
      ) : null}

      {loading ? (
        <p className="history-page__status">Reading the event log.</p>
      ) : days.length === 0 ? (
        <p className="history-page__status">
          {matched === 0 && filters === NOTHING
            ? "Nothing has happened in this workspace yet."
            : "Nothing matches those filters."}
        </p>
      ) : (
        days.map((day) => (
          <section key={day.heading} className="history-page__day" aria-label={day.heading}>
            <h3>{day.heading}</h3>
            <ol className="history-page__rows">
              {day.rows.map((row) => (
                <li key={row.id}>
                  <span className="history-page__time" title={row.ago}>
                    {row.at}
                  </span>
                  <span className="history-page__action">{row.action}</span>
                  <span className="history-page__who" title={row.who}>
                    {row.who}
                  </span>
                  {row.subject === null ? (
                    <span className="history-page__subject">None</span>
                  ) : onOpenObject === undefined ? (
                    <span className="history-page__subject">{row.subject.title}</span>
                  ) : (
                    <button
                      type="button"
                      className="history-page__subject history-page__open"
                      onClick={() => onOpenObject(row.subject?.objectId ?? "", "")}
                    >
                      {row.subject.title}
                    </button>
                  )}
                  {/* One cell for whatever else the row has to say, so a row with a reason and
                      a row without one are the same shape. */}
                  <span className="history-page__meta">
                    {row.version === null ? null : (
                      <span className="history-page__version">version {row.version}</span>
                    )}
                    {row.alsoTouched === 0 ? null : (
                      <span className="history-page__also">
                        and {row.alsoTouched} {row.alsoTouched === 1 ? "other" : "others"}
                      </span>
                    )}
                    {row.reason === null ? null : (
                      <span className="history-page__reason">{row.reason}</span>
                    )}
                  </span>
                </li>
              ))}
            </ol>
          </section>
        ))
      )}
    </section>
  );
}
