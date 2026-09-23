import { useEffect, useMemo, useRef, useState } from "react";
import { AboutDialog, useUpdateReady } from "./About.js";
import { readBridge } from "./bridge.js";
import type { RendererAccountNotification } from "./bridge.js";
import { useCaretFor } from "./caret.js";
import { useCollaborationSnapshot } from "./collaboration-snapshot.js";
import type { ObjectOrganizationAction } from "./ObjectOrganizationMenu.js";
import type { PresenceMember } from "./presence.js";
import { PresenceAvatars } from "./PresenceAvatars.js";
import { announcePresence } from "./remote-carets.js";
import { BrandMark } from "./BrandMark.js";
import { SyncStatus } from "./SyncStatus.js";
import { usePresence } from "./usePresence.js";
import { useSyncStatus } from "./useSyncStatus.js";
import { describeHits, groupHeading, groupHits, type GlobalHit } from "./global-search.js";
import { forgetUndo, lastUndo, subscribeUndo, type UndoableAction } from "./undo-stack.js";

export type WindowAction = "minimize" | "toggle-maximize" | "close";

/** What the shell announces about where the reader is. */
export interface BreadcrumbDetail {
  workspace: string;
  project: string | null;
  page: string;
  /**
   * Whether the workspace can be written to, and whether the rail is folded.
   *
   * Both belong to the shell and are shown in the bar: the read-only badge sits beside the name
   * it is true of, and the project menu is where the rail is folded and unfolded from. Optional,
   * because an older announcement -- or one from a window with no shell in it -- is still a
   * perfectly good breadcrumb.
   */
  writable?: boolean;
  railCollapsed?: boolean;
}

export interface TopBarProps {
  workspaceTitle: string | null;
  workspaceId?: string | null;
  workspaceStatus: string | null;
  onOpenQuickSwitch: () => void;
  onWindowAction: (action: WindowAction) => void;
  accountEmail?: string | null;
  accountId?: string | null;
  accountName?: string | null;
  accountAvatarUrl?: string | null;
  accountConnection?: "online" | "offline" | null;
  signingOut?: boolean;
  onSignOut?: () => void;
  onOpenAccountSettings?: () => void;
}

/** One array for every render with no roster, so that presence is not reshaped on each one. */
const NO_MEMBERS: readonly PresenceMember[] = [];

const STATUS_BADGE: Record<string, string> = {
  read_only: "Read only",
  future_schema: "Read only",
  migration_required: "Read only",
  repair_required: "Needs repair",
  workspace_missing: "Not a workspace",
};

/**
 * Occupies Kiwi's frameless title bar. Interactive descendants opt out of the drag region.
 *
 * It carries where you are as well as who you are. There used to be a second bar under it
 * repeating the page's name beside two buttons, and a row of eight menus that all opened the
 * same palette; both are gone. What is left is one line: the project, the page, and the one
 * search box that reaches everything.
 */
export function TopBar({
  workspaceTitle,
  workspaceId = null,
  workspaceStatus,
  onOpenQuickSwitch,
  onWindowAction,
  accountEmail = null,
  accountId = null,
  accountName = null,
  accountAvatarUrl = null,
  accountConnection = null,
  signingOut = false,
  onSignOut,
  onOpenAccountSettings,
}: TopBarProps): React.JSX.Element {
  const [accountOpen, setAccountOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [projectOpen, setProjectOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const updateReady = useUpdateReady();
  const [accountNotifications, setAccountNotifications] = useState<RendererAccountNotification[]>(
    [],
  );
  const [notificationError, setNotificationError] = useState<string | null>(null);
  const [commandOpen, setCommandOpen] = useState(false);
  const [trail, setTrail] = useState<BreadcrumbDetail | null>(null);
  const [commandQuery, setCommandQuery] = useState("");
  const [workspaceObjects, setWorkspaceObjects] = useState<
    Array<{ id: string; title: string; type: string }>
  >([]);
  const [activeObject, setActiveObject] = useState<{
    id: string;
    title: string;
    type: string;
  } | null>(null);
  const commandInput = useRef<HTMLInputElement>(null);
  const accountMenu = useRef<HTMLDivElement>(null);
  const projectMenu = useRef<HTMLDivElement>(null);
  /**
   * Said only when it is not the usual case.
   *
   * A badge reading "Writable" on every workspace anybody ever opens is a word taking up room to
   * say nothing. This appears beside the name it is true of, which is where somebody looks when
   * a Save button turns out to be greyed out.
   */
  const badge =
    (workspaceStatus === null ? undefined : STATUS_BADGE[workspaceStatus]) ??
    (trail?.writable === false ? "Read only" : undefined);
  const unreadNotifications = accountNotifications.filter(
    (notification) => !notification.read,
  ).length;
  const notificationBadge = unreadNotifications + (accountConnection === "offline" ? 1 : 0);
  const accountLabel = accountName?.trim() || accountEmail || "Account";

  async function refreshNotifications(): Promise<void> {
    if (accountEmail === null || accountConnection !== "online") return;
    const result = await readBridge()?.listAccountNotifications();
    if (result === undefined || result.status === "error") {
      setNotificationError(result?.message ?? "Notifications are unavailable.");
      return;
    }
    if (result.status === "ok") {
      setAccountNotifications(result.notifications);
      setNotificationError(null);
    }
  }

  async function updateNotification(id: string, action: "read" | "dismiss"): Promise<void> {
    const bridge = readBridge();
    if (bridge === null) return;
    const result =
      action === "read"
        ? await bridge.markAccountNotificationRead({ notification_id: id })
        : await bridge.dismissAccountNotification({ notification_id: id });
    if (result.status === "error") setNotificationError(result.message);
    else await refreshNotifications();
  }

  // The palette is the other place somebody looks for the last thing they did, and the bar is
  // gone by the time they think to look. One entry, only while the offer stands.
  const [undoable, setUndoable] = useState<UndoableAction | null>(null);

  const picks = useMemo(
    () =>
      [
        ...(commandQuery.trimStart().startsWith(">") && activeObject !== null
          ? (
              [
                ["Rename object…", "rename"],
                ["Move object to collection…", "move"],
                ["Add object to collection…", "collect"],
                ["Move object to project…", "project"],
                ["Add tag to object…", "tag"],
                ["Duplicate object…", "duplicate"],
                ["Reveal object in File Explorer", "reveal"],
                ["Move object to Trash…", "trash"],
              ] as Array<[string, ObjectOrganizationAction]>
            ).map(([title, objectAction]) => ({
              title: `> ${title}`,
              detail: activeObject.title,
              page: "library",
              objectId: activeObject.id,
              objectAction,
            }))
          : []),
        ...workspaceObjects.map((object) => ({
          title: object.title,
          detail: object.type.replaceAll("_", " "),
          page: "inbox",
          objectId: object.id,
        })),
        { title: "Inbox", detail: "Open the project Inbox", page: "inbox" },
        { title: "Library", detail: "Every paper in this project", page: "library" },
        { title: "Notes", detail: "Where reading turns into thinking", page: "notes" },
        { title: "Manuscript", detail: "Writing the paper", page: "manuscript" },
        { title: "Reader", detail: "Read and mark up a document", page: "reader" },
        { title: "Search & Import", detail: "Search local indexed text", page: "import" },
        { title: "Trash", detail: "Restore deleted items", page: "trash" },
        {
          title: "> Add managed file",
          detail: "Copy one file into this workspace",
          action: "add-managed-file",
        },
        {
          title: "> Import references",
          detail: "Read a BibTeX or RIS file into this library",
          action: "import-references",
        },
        {
          title: "> Quick Capture",
          detail: "Add a contextual Inbox item (Ctrl+Shift+I)",
          action: "quick-capture",
        },
        ...(undoable === null
          ? []
          : [
              {
                title: `> ${undoable.label}`,
                detail: "Take back the last thing you did",
                action: "undo-last",
              },
            ]),
        {
          title: "> Keyboard shortcuts",
          detail: "Every key and what it does (?)",
          action: "show-shortcuts",
        },
        { title: "> Focus mode", detail: "Hide supporting regions", action: "focus" },
        {
          title: "> Workspace settings",
          detail: "Open workspace and project settings",
          action: "settings",
        },
      ].filter((item) =>
        `${item.title} ${item.detail}`
          .toLocaleLowerCase("en-US")
          .includes(commandQuery.toLocaleLowerCase("en-US").replace(/^>\s*/u, "")),
      ),
    [activeObject, commandQuery, workspaceObjects, undoable],
  );

  useEffect(() => {
    if (accountEmail === null || accountConnection !== "online") {
      setAccountNotifications([]);
      return;
    }
    void refreshNotifications();
    const timer = setInterval(() => void refreshNotifications(), 30_000);
    return () => clearInterval(timer);
  }, [accountConnection, accountEmail]);

  useEffect(() => {
    function updateObject(event: Event): void {
      const detail = (event as CustomEvent<{ id: string; title: string; type: string }>).detail;
      setActiveObject(detail);
    }
    window.addEventListener("kiwi:object-context", updateObject);
    return () => window.removeEventListener("kiwi:object-context", updateObject);
  }, []);

  // Everywhere is asked for rather than assumed: the palette is opened many times an hour and
  // most of those are about the project in front of somebody. Searching every workspace on every
  // keystroke would spend a great deal of somebody else's disk to answer a question they did not
  // ask.
  const [everywhere, setEverywhere] = useState(false);
  const [globalHits, setGlobalHits] = useState<GlobalHit[]>([]);
  const [searchedEverywhere, setSearchedEverywhere] = useState(false);

  const snapshot = useCollaborationSnapshot(workspaceId ?? "");
  const sync = useSyncStatus(workspaceId);
  // The caret is carried, not asked for. Moving it changes what the next poll says and does not
  // start one, so a paragraph typed across is one number at the next tick rather than a request
  // per keystroke.
  const caret = useCaretFor(activeObject?.id ?? null);
  const presence = usePresence({
    documentId: activeObject?.id ?? null,
    members: snapshot?.members ?? NO_MEMBERS,
    selfUserId: accountId,
    cursor: caret,
  });

  // The answer goes on to the editor, which draws a caret for each person in it. The poll is here
  // and the drawing is there, and this is the only thing that crosses between them: one request
  // serves the row of avatars and the marks in the manuscript both.
  const openDocumentId = activeObject?.id ?? null;
  const announced = useRef<string | null>(null);
  useEffect(() => {
    // Leaving a document is worth announcing too. The editor is torn down a moment later, but not
    // before it has had time to draw carets nobody is standing at any more.
    const documentId = openDocumentId ?? announced.current;
    if (documentId === null) return;
    announced.current = openDocumentId;
    announcePresence({ documentId, people: presence.people });
  }, [openDocumentId, presence.people]);

  // The object announcement never says "and now nothing", so leaving a document has to be read
  // off the breadcrumb: a different page means what was open is not what is being looked at any
  // more. Presence is what makes this matter. Polling for a document somebody closed goes on
  // telling everybody else they are still sitting in it.
  const place = trail === null ? null : `${trail.project ?? ""} / ${trail.page}`;
  useEffect(() => {
    setActiveObject(null);
  }, [place]);

  useEffect(() => {
    setAccountOpen(false);
  }, [accountEmail]);

  useEffect(() => {
    if (!accountOpen) return;

    function dismissAccountMenu(event: PointerEvent): void {
      if (event.target instanceof Node && !accountMenu.current?.contains(event.target)) {
        setAccountOpen(false);
      }
    }

    function dismissAccountMenuWithKeyboard(event: KeyboardEvent): void {
      if (event.key === "Escape") setAccountOpen(false);
    }

    document.addEventListener("pointerdown", dismissAccountMenu);
    window.addEventListener("keydown", dismissAccountMenuWithKeyboard);
    return () => {
      document.removeEventListener("pointerdown", dismissAccountMenu);
      window.removeEventListener("keydown", dismissAccountMenuWithKeyboard);
    };
  }, [accountOpen]);

  useEffect(() => {
    if (!projectOpen) return;

    function dismiss(event: PointerEvent): void {
      if (event.target instanceof Node && !projectMenu.current?.contains(event.target))
        setProjectOpen(false);
    }

    function dismissWithKeyboard(event: KeyboardEvent): void {
      if (event.key === "Escape") setProjectOpen(false);
    }

    document.addEventListener("pointerdown", dismiss);
    window.addEventListener("keydown", dismissWithKeyboard);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      window.removeEventListener("keydown", dismissWithKeyboard);
    };
  }, [projectOpen]);

  async function openCommandCenter(initialQuery = ""): Promise<void> {
    setCommandQuery(initialQuery);
    setCommandOpen(true);
    window.setTimeout(() => commandInput.current?.focus(), 0);
    if (workspaceId === null) return;
    const bridge = readBridge();
    if (bridge === null) return;
    const requestId = crypto.randomUUID();
    const result = await bridge.invokeCommand({
      protocol_version: "1.0.0",
      request_id: requestId,
      idempotency_key: requestId,
      workspace_id: workspaceId,
      command: "kiwi.projection.list",
      args: {
        object_types: [],
        text: "",
        sort: { field: "updated_at", direction: "descending" },
        page: { offset: 0, limit: 200 },
      },
    });
    if (result.error !== undefined) return;
    setWorkspaceObjects(
      (
        ((result.data ?? {})["objects"] as
          Array<{ id: string; title: string; type: string }> | undefined) ?? []
      ).slice(0, 200),
    );
  }

  useEffect(() => {
    function keydown(event: KeyboardEvent): void {
      if (!event.ctrlKey) return;
      const key = event.key.toLocaleLowerCase("en-US");
      // Ctrl+P and Ctrl+K reach the same list. Two palettes that search the same things,
      // differing only in which key opened them, is a thing to memorize for no gain.
      if (key !== "p" && key !== "k") return;
      event.preventDefault();
      void openCommandCenter(event.shiftKey && key === "p" ? "> " : "");
    }
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, []);

  useEffect(() => {
    setUndoable(lastUndo());
    return subscribeUndo(setUndoable);
  }, []);

  useEffect(() => {
    function breadcrumb(event: Event): void {
      const detail = (event as CustomEvent<BreadcrumbDetail>).detail;
      if (typeof detail?.page === "string") setTrail(detail);
    }
    window.addEventListener("kiwi:breadcrumb", breadcrumb);
    return () => window.removeEventListener("kiwi:breadcrumb", breadcrumb);
  }, []);

  useEffect(() => {
    if (!everywhere || !commandOpen) return;
    const query = commandQuery.replace(/^>\s*/u, "").trim();
    if (query === "") {
      setGlobalHits([]);
      setSearchedEverywhere(false);
      return;
    }
    let live = true;
    // Debounced, because this one crosses process boundaries and reads several databases.
    const timer = setTimeout(() => {
      const bridge = readBridge();
      if (bridge === null) return;
      void bridge
        .searchEverywhere({ query })
        .then((hits) => {
          if (!live) return;
          setGlobalHits(hits);
          setSearchedEverywhere(true);
        })
        .catch(() => undefined);
    }, 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [everywhere, commandOpen, commandQuery]);

  function openHit(hit: GlobalHit): void {
    setCommandOpen(false);
    setCommandQuery("");
    if (hit.workspaceId === workspaceId) {
      window.dispatchEvent(
        new CustomEvent("kiwi:workbench-command", {
          detail: {
            title: hit.title,
            detail: hit.objectType,
            page: "inbox",
            objectId: hit.objectId,
          },
        }),
      );
      return;
    }
    // Somewhere else entirely. Whatever is open here was not something they asked to leave.
    void readBridge()?.openWorkspaceById({ workspaceId: hit.workspaceId });
  }

  function choosePick(item: (typeof picks)[number]): void {
    if ("action" in item && item.action === "show-shortcuts") {
      setCommandOpen(false);
      setCommandQuery("");
      window.dispatchEvent(new CustomEvent("kiwi:show-shortcuts"));
      return;
    }
    if ("action" in item && item.action === "undo-last" && undoable !== null) {
      setCommandOpen(false);
      setCommandQuery("");
      void runUndo(undoable);
      return;
    }
    window.dispatchEvent(new CustomEvent("kiwi:workbench-command", { detail: item }));
    setCommandOpen(false);
    setCommandQuery("");
  }

  async function runUndo(action: UndoableAction): Promise<void> {
    const bridge = readBridge();
    if (bridge === null || workspaceId === null) return;
    const requestId = crypto.randomUUID();
    const result = await bridge
      .invokeCommand({
        protocol_version: "1.0.0",
        request_id: requestId,
        idempotency_key: requestId,
        workspace_id: workspaceId,
        command: action.command,
        args: action.args,
      })
      .catch(() => null);
    if (result !== null && result.error === undefined) forgetUndo();
  }

  return (
    <header className="topbar">
      <span className="topbar__brand">
        <BrandMark />
        Kiwi
      </span>

      {workspaceTitle !== null ? (
        <nav className="topbar__breadcrumb" aria-label="Where you are">
          <div className="topbar__project" ref={projectMenu}>
            <button
              type="button"
              className="topbar__workspace"
              aria-haspopup="menu"
              aria-expanded={projectOpen}
              aria-label={
                trail === null || trail.project === null
                  ? `Workspace ${workspaceTitle}. Open the project menu`
                  : `Project ${trail.project}, in workspace ${workspaceTitle}. Open the project menu`
              }
              onClick={() => setProjectOpen((open) => !open)}
            >
              <span className="topbar__workspace-title">{trail?.project ?? workspaceTitle}</span>
              {badge !== undefined ? <span className="topbar__badge">{badge}</span> : null}
              <span aria-hidden="true" className="topbar__caret">
                ⌄
              </span>
            </button>
            {projectOpen ? (
              <div className="topbar__project-menu" role="menu" aria-label="Project">
                {/* The workspace's name left the bar when the project took its place. It is
                    still the thing everything here belongs to, so the menu opens by saying
                    which one you are in. */}
                <p className="topbar__project-where">{workspaceTitle}</p>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setProjectOpen(false);
                    window.dispatchEvent(
                      new CustomEvent("kiwi:workbench-command", {
                        detail: { action: "all-projects" },
                      }),
                    );
                  }}
                >
                  All projects
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setProjectOpen(false);
                    onOpenQuickSwitch();
                  }}
                >
                  Switch workspace or project…
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setProjectOpen(false);
                    window.dispatchEvent(
                      new CustomEvent("kiwi:workbench-command", {
                        detail: { action: "collapse-rail" },
                      }),
                    );
                  }}
                >
                  {trail?.railCollapsed === true ? "Expand the rail" : "Collapse the rail"}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setProjectOpen(false);
                    window.dispatchEvent(
                      new CustomEvent("kiwi:workbench-command", { detail: { action: "settings" } }),
                    );
                  }}
                >
                  Workspace settings
                </button>
              </div>
            ) : null}
          </div>
          {trail === null || trail.project === null ? null : (
            <>
              <span aria-hidden="true" className="topbar__slash">
                /
              </span>
              <span className="topbar__crumb topbar__crumb--page">{trail.page}</span>
            </>
          )}
        </nav>
      ) : null}

      <div className="topbar__spacer" />

      {workspaceTitle !== null ? (
        <div className="command-center">
          <button
            type="button"
            aria-haspopup="dialog"
            aria-expanded={commandOpen}
            aria-label="Search or run a command"
            onClick={() => void openCommandCenter()}
          >
            <span>Search or jump to…</span>
            <kbd>Ctrl+K</kbd>
          </button>
          {commandOpen ? (
            <div className="command-center__popover" role="dialog" aria-label="Quick Open">
              <input
                ref={commandInput}
                aria-label="Quick Open"
                value={commandQuery}
                placeholder="Search workspace or type > for commands"
                onChange={(event) => setCommandQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") setCommandOpen(false);
                  if (event.key === "Enter" && picks[0] !== undefined) choosePick(picks[0]);
                }}
              />
              <label className="command-center__everywhere">
                <input
                  type="checkbox"
                  checked={everywhere}
                  onChange={(event) => {
                    const chosen = event.currentTarget.checked;
                    setEverywhere(chosen);
                    if (!chosen) setSearchedEverywhere(false);
                  }}
                />
                Search every project
              </label>
              {everywhere ? (
                <>
                  <p role="status">{describeHits(globalHits, searchedEverywhere)}</p>
                  {groupHits(globalHits).map((group) => (
                    <div key={group.key} className="command-center__group">
                      <h4>{groupHeading(group)}</h4>
                      <ul>
                        {group.hits.map((hit) => (
                          <li key={`${hit.workspaceId}-${hit.objectId}`}>
                            <button type="button" onClick={() => openHit(hit)}>
                              <strong>{hit.title}</strong>
                              <span>{hit.objectType.replaceAll("_", " ")}</span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </>
              ) : (
                <>
                  <p role="status">{picks.length} results</p>
                  <ul>
                    {picks.map((item) => (
                      <li key={item.title}>
                        <button type="button" onClick={() => choosePick(item)}>
                          <strong>{item.title}</strong>
                          <span>{item.detail}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          ) : null}
        </div>
      ) : null}

      {updateReady === null ? null : (
        <button
          type="button"
          className="topbar__update"
          title={`Kiwi ${updateReady} is downloaded. It installs the next time Kiwi closes.`}
          onClick={() => void readBridge()?.restartToUpdate()}
        >
          Restart to update
        </button>
      )}

      <SyncStatus standing={sync} />

      <PresenceAvatars people={presence.people} />

      {accountEmail !== null ? (
        <div className="account-menu" ref={accountMenu}>
          <button
            type="button"
            className="account-menu__trigger"
            aria-label={`Account ${accountLabel}`}
            aria-expanded={accountOpen}
            onClick={() => setAccountOpen((open) => !open)}
          >
            {accountAvatarUrl === null ? (
              <span aria-hidden="true">{accountLabel.slice(0, 1).toLocaleUpperCase()}</span>
            ) : (
              <img className="account-menu__avatar" src={accountAvatarUrl} alt="" />
            )}
            {accountConnection === "offline" ? (
              <span className="account-menu__offline" aria-label="Offline" />
            ) : null}
            {notificationBadge > 0 ? (
              <b className="account-menu__unread" aria-label={`${notificationBadge} notifications`}>
                {notificationBadge > 99 ? "99+" : notificationBadge}
              </b>
            ) : null}
          </button>
          {accountOpen ? (
            <div className="account-menu__popover">
              {accountName === null || accountName.trim() === "" ? null : (
                <strong className="account-menu__name">{accountName}</strong>
              )}
              <p>{accountEmail}</p>
              {/*
                The bell is gone. It was a second icon for the same person, two pixels from the
                one with their face on it, and everything it announced was about their account.
                This is the first row of the menu they were already going to open.
              */}
              {workspaceTitle === null ? null : (
                <button
                  type="button"
                  aria-expanded={notificationsOpen}
                  onClick={() => {
                    setNotificationsOpen((value) => !value);
                    void refreshNotifications();
                  }}
                >
                  {notificationBadge > 0 ? `Notifications · ${notificationBadge}` : "Notifications"}
                </button>
              )}
              {notificationsOpen && workspaceTitle !== null ? (
                <section
                  className="notification-center__popover"
                  aria-labelledby="notifications-title"
                >
                  <header>
                    <strong id="notifications-title">Notifications</strong>
                  </header>
                  {accountConnection === "offline" ? (
                    <article className="notification-center__item">
                      <strong>Working offline</strong>
                      <p>
                        Downloaded workspaces remain available. Synchronization resumes after
                        reconnecting.
                      </p>
                    </article>
                  ) : null}
                  {accountNotifications.map((notification) => (
                    <article
                      className="notification-center__item"
                      data-unread={!notification.read || undefined}
                      key={notification.id}
                    >
                      <strong>{notification.title}</strong>
                      <p>{notification.detail}</p>
                      <div>
                        {!notification.read ? (
                          <button
                            type="button"
                            onClick={() => void updateNotification(notification.id, "read")}
                          >
                            Mark read
                          </button>
                        ) : null}
                        <button
                          type="button"
                          onClick={() => void updateNotification(notification.id, "dismiss")}
                        >
                          Dismiss
                        </button>
                      </div>
                    </article>
                  ))}
                  {notificationError !== null ? (
                    <p className="auth__error" role="status">
                      {notificationError}
                    </p>
                  ) : accountConnection !== "offline" && accountNotifications.length === 0 ? (
                    <p>No notifications need attention.</p>
                  ) : null}
                </section>
              ) : null}
              <button
                type="button"
                onClick={() => {
                  setAccountOpen(false);
                  onOpenAccountSettings?.();
                }}
              >
                Account settings
              </button>
              <button
                type="button"
                onClick={() => {
                  setAccountOpen(false);
                  setAboutOpen(true);
                }}
              >
                About Kiwi
              </button>
              <button
                type="button"
                disabled={signingOut}
                onClick={() => {
                  setAccountOpen(false);
                  onSignOut?.();
                }}
              >
                {signingOut ? "Signing out..." : "Sign out"}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      {aboutOpen ? <AboutDialog onClose={() => setAboutOpen(false)} /> : null}

      <div className="window-controls" role="group" aria-label="Window controls">
        <button
          type="button"
          className="window-control"
          aria-label="Minimize window"
          onClick={() => onWindowAction("minimize")}
        >
          <span
            className="window-control__icon window-control__icon--minimize"
            aria-hidden="true"
          />
        </button>
        <button
          type="button"
          className="window-control"
          aria-label="Maximize or restore window"
          onClick={() => onWindowAction("toggle-maximize")}
        >
          <span
            className="window-control__icon window-control__icon--maximize"
            aria-hidden="true"
          />
        </button>
        <button
          type="button"
          className="window-control window-control--close"
          aria-label="Close window"
          onClick={() => onWindowAction("close")}
        >
          <span className="window-control__icon window-control__icon--close" aria-hidden="true" />
        </button>
      </div>
    </header>
  );
}
