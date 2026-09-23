import { useCallback, useEffect, useState } from "react";
import { readBridge, type RendererWorkspaceCollaborationSnapshot } from "./bridge.js";
import {
  recallCollaborationSnapshot,
  rememberCollaborationSnapshot,
} from "./collaboration-snapshot.js";
import { InviteMember } from "./InviteMember.js";
import { describeRevoked, revokeRefusal } from "./member-invites.js";
import { confirmsRemoval, describeRemoved, removalRefusal, warnRemoval } from "./member-removal.js";
import {
  describeRoleChange,
  MANAGERS,
  roleOptions,
  roleRefusal,
  warnSelfChange,
} from "./member-roles.js";
import {
  candidateMembers,
  describeException,
  describeExceptionLifted,
  describeExceptionSet,
  exceptionRefusal,
  exceptionRoleOptions,
  exceptionsFrom,
  lesserRoles,
  projectPolicies,
  warnWidened,
  type ProjectException,
  type ProjectPolicy,
} from "./project-exceptions.js";
import {
  anArticle,
  describeAge,
  isRole,
  pendingInvitations,
  roleLabel,
  ROLE_POWERS,
  rosterFrom,
  type PendingInvitation,
  type RosterPerson,
} from "./members-roster.js";

/**
 * Who is in this workspace, and what they may do.
 *
 * Everything on this page comes from the account service and none of it from the workspace on
 * disk, which is why what it does when the service is unreachable is the design and not an edge
 * case. It shows what the service last said, with the hour it said it. Not an empty roster --
 * that reads as "you are alone here", which is a false statement about a workspace with four
 * people in it -- and not a spinner over nothing.
 *
 * The date is the whole of what makes that honest. A roster with no date on it passes for current,
 * and somebody removed an hour ago is still on this one. So every stale reading says so in a line
 * above the list, and anything that changes access has to be unavailable while it is stale: acting
 * on a roster that may be an hour old is how the wrong person gets removed.
 */

export interface MembersPageProps {
  workspaceId: string;
  account: { id: string; email: string };
}

type Loaded =
  | { state: "loading" }
  | { state: "ready"; snapshot: RendererWorkspaceCollaborationSnapshot; at: Date }
  /** What the service said last, and why this is not what it says now. */
  | { state: "stale"; snapshot: RendererWorkspaceCollaborationSnapshot; at: Date; message: string }
  | { state: "unavailable"; message: string };

/**
 * What to say about a refusal, in terms of this page rather than of the request.
 *
 * Whether anything is being shown changes what there is to say. "There is nothing to show" is the
 * news when the window has never heard from the service; when it has, the news is only that this
 * reading is old, and the line above the list goes on to say how old.
 */
function refusal(code: string, message: string, held: boolean): string {
  if (code === "service_unavailable")
    return held
      ? "Kiwi cannot reach the account service."
      : "Kiwi cannot reach the account service, which is where the roster is kept. This window has not heard from it since it opened, so there is nothing to show yet.";
  if (code === "queued")
    return "This workspace is still being registered with the account service. The roster will be here once that has gone through.";
  if (code === "not_found")
    return "This workspace has not been registered with the account service, so it has no roster yet. It is registered the first time you sign in with it open.";
  if (code === "forbidden")
    return "Your account is not a member of this workspace on the account service.";
  return message;
}

/**
 * Why nothing can be changed from a page that is showing an old reading.
 *
 * The service is what checks a role and what records the change, so with it unreachable there is
 * nothing to send the change to. The reason to say it rather than let the request fail is that the
 * roster itself may be wrong by now, and a change aimed at the wrong row is worth stopping early.
 */
const STALE =
  "Kiwi cannot reach the account service, so nothing can be sent from here until it can.";

export function MembersPage({ workspaceId, account }: MembersPageProps): React.JSX.Element {
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });
  const [reloads, setReloads] = useState(0);

  useEffect(() => {
    let active = true;
    // What the service last said, if it has said anything to this window. Falling back to it is
    // what makes a page that opens offline useful rather than only truthful.
    const failed = (code: string, said: string): void => {
      const held = recallCollaborationSnapshot(workspaceId);
      const message = refusal(code, said, held !== null);
      setLoaded(
        held === null
          ? { state: "unavailable", message }
          : { state: "stale", snapshot: held.snapshot, at: held.at, message },
      );
    };
    const bridge = readBridge();
    if (bridge === null) {
      failed("service_unavailable", "");
      return;
    }
    setLoaded({ state: "loading" });
    void (async () => {
      try {
        const result = await bridge.manageWorkspaceCollaboration({
          action: "snapshot",
          input: { workspace_id: workspaceId },
        });
        if (!active) return;
        if (result.status === "ok") {
          const at = new Date();
          rememberCollaborationSnapshot(workspaceId, result.settings, at);
          setLoaded({ state: "ready", snapshot: result.settings, at });
        } else if (result.status === "queued") failed("queued", "");
        else failed(result.code, result.message);
      } catch {
        if (active) failed("service_unavailable", "");
      }
    })();
    return () => {
      active = false;
    };
  }, [workspaceId, reloads]);

  const reload = useCallback(() => {
    setReloads((count) => count + 1);
  }, []);

  // A change is answered with the workspace as it now stands, which is a newer reading than the one
  // on screen and is treated as one: it is what the service says, said just now.
  const accepted = useCallback(
    (settings: RendererWorkspaceCollaborationSnapshot) => {
      const at = new Date();
      rememberCollaborationSnapshot(workspaceId, settings, at);
      setLoaded({ state: "ready", snapshot: settings, at });
    },
    [workspaceId],
  );

  const snapshot = loaded.state === "ready" || loaded.state === "stale" ? loaded.snapshot : null;
  const people = snapshot === null ? [] : rosterFrom(snapshot, account.id);
  const invitations = snapshot === null ? [] : pendingInvitations(snapshot, new Date());
  // The service checks this too, and refuses. Offering the form anyway would be a page that invites
  // somebody to do a thing it knows will not work.
  const manages = snapshot !== null && MANAGERS.includes(snapshot.workspace.role);

  return (
    <section className="members-page page-fields" aria-labelledby="members-title">
      <header>
        <span>Who is in this workspace, and what they may do</span>
        <h1 id="members-title">Members</h1>
        {snapshot === null ? null : (
          <p>
            {snapshot.workspace.title}. You are {anArticle(snapshot.workspace.role)}{" "}
            {roleLabel(snapshot.workspace.role).toLowerCase()} here.
          </p>
        )}
        <button className="button" type="button" onClick={reload}>
          Refresh
        </button>
      </header>

      {loaded.state === "loading" ? (
        <p role="status" className="members-page__status">
          Asking the account service who is here…
        </p>
      ) : null}

      {loaded.state === "unavailable" ? (
        <p role="status" className="members-page__status">
          {loaded.message}
        </p>
      ) : null}

      {loaded.state === "stale" ? (
        <p role="status" className="members-page__stale">
          {loaded.message} This is what it said {describeAge(loaded.at, new Date())}, and somebody
          may have been added or removed since.
        </p>
      ) : null}

      {/* Said once for the page rather than beside every control it disables. Somebody who can
          change nothing here is not told what they cannot do. */}
      {loaded.state === "stale" && manages ? (
        <p role="status" className="members-page__stale">
          {STALE}
        </p>
      ) : null}

      {snapshot === null ? null : (
        <Roster
          workspaceId={workspaceId}
          people={people}
          actorRole={snapshot.workspace.role}
          manages={manages}
          blocked={loaded.state === "stale" ? STALE : null}
          onChanged={accepted}
        />
      )}
      {snapshot === null ? null : (
        <Invitations
          workspaceId={workspaceId}
          invitations={invitations}
          manages={manages}
          blocked={loaded.state === "stale" ? STALE : null}
          onRevoked={accepted}
        />
      )}

      {snapshot === null ? null : manages ? (
        <InviteMember
          workspaceId={workspaceId}
          snapshot={snapshot}
          blocked={loaded.state === "stale" ? STALE : null}
          onInvited={accepted}
        />
      ) : (
        <p className="members-page__empty">
          Invitations are sent by an owner or an admin. Ask one of the people above to invite
          somebody.
        </p>
      )}

      {snapshot === null ? null : (
        <ProjectExceptions
          workspaceId={workspaceId}
          snapshot={snapshot}
          manages={manages}
          blocked={loaded.state === "stale" ? STALE : null}
          onChanged={accepted}
        />
      )}

      {snapshot === null ? null : (
        <p className="members-page__note">
          Owner and admin are the roles that are checked today: only they can invite somebody,
          change a role, or remove somebody. What an editor, a commenter, and a viewer may change
          inside a workspace is recorded here and is not yet enforced on this machine.
        </p>
      )}
    </section>
  );
}

/**
 * Everybody who is here, changing what one of them may do, and taking one of them out.
 *
 * The menu is not on the row until it is asked for. A role is read far more often than it is
 * changed -- this table is how somebody finds out who can do a thing -- and five menus down a
 * column bury the answer under the controls for changing it. Asking opens one row.
 *
 * One row at a time, and one thing at a time in it: opening either panel closes whatever else was
 * open. Two half-filled confirmations on two rows is exactly the state in which the wrong one gets
 * finished.
 */
function Roster({
  workspaceId,
  people,
  actorRole,
  manages,
  blocked,
  onChanged,
}: {
  workspaceId: string;
  people: readonly RosterPerson[];
  /** The reader's own role, which is what decides whether owner is on offer. */
  actorRole: string;
  /** Whether this account may change a role. The service checks it too, and refuses. */
  manages: boolean;
  /** Set while nothing can be changed. The page says why, once, above all of this. */
  blocked: string | null;
  onChanged(settings: RendererWorkspaceCollaborationSnapshot): void;
}): React.JSX.Element {
  /** The one row with something open on it, and which of the two things it is. */
  const [open, setOpen] = useState<{ id: string; panel: "role" | "removal" } | null>(null);
  const [chosen, setChosen] = useState("");
  /** What has been typed to confirm a removal. Kept here so that closing the row forgets it. */
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<{ kind: "problem" | "done"; message: string } | null>(
    null,
  );

  function reveal(person: RosterPerson, panel: "role" | "removal"): void {
    setOpen({ id: person.id, panel });
    setChosen(person.role);
    setTyped("");
    setOutcome(null);
  }

  function close(): void {
    setOpen(null);
    setTyped("");
  }

  async function change(person: RosterPerson): Promise<void> {
    const bridge = readBridge();
    if (bridge === null) {
      setOutcome({ kind: "problem", message: unchanged(person.name) });
      return;
    }
    setBusy(true);
    try {
      const result = await bridge.manageWorkspaceCollaboration({
        action: "update_member",
        input: { workspace_id: workspaceId, user_id: person.id, role: chosen },
      });
      if (result.status === "ok") {
        // The reply is the workspace as it now stands, so the row says the new role because the
        // service says it does, and not because this window assumed the change went through.
        onChanged(result.settings);
        close();
        setOutcome({
          kind: "done",
          message: describeRoleChange(person.name, chosen, person.isSelf),
        });
      } else if (result.status === "queued")
        setOutcome({
          kind: "problem",
          message: `${person.name}'s role was not changed. This workspace has not finished registering with the account service.`,
        });
      else
        setOutcome({
          kind: "problem",
          message: roleRefusal(result.code, result.message, person.name),
        });
    } catch {
      setOutcome({ kind: "problem", message: unchanged(person.name) });
    } finally {
      setBusy(false);
    }
  }

  async function remove(person: RosterPerson): Promise<void> {
    const bridge = readBridge();
    if (bridge === null) {
      setOutcome({ kind: "problem", message: unremoved(person.name) });
      return;
    }
    setBusy(true);
    try {
      const result = await bridge.manageWorkspaceCollaboration({
        action: "remove_member",
        input: { workspace_id: workspaceId, user_id: person.id },
      });
      if (result.status === "ok") {
        // The row leaves the table because the service's own answer no longer has them in it.
        onChanged(result.settings);
        close();
        setOutcome({ kind: "done", message: describeRemoved(person.name, person.isSelf) });
      } else if (result.status === "queued")
        setOutcome({
          kind: "problem",
          message: `${person.name} was not removed. This workspace has not finished registering with the account service.`,
        });
      else
        setOutcome({
          kind: "problem",
          message: removalRefusal(result.code, result.message, person.name),
        });
    } catch {
      setOutcome({ kind: "problem", message: unremoved(person.name) });
    } finally {
      setBusy(false);
    }
  }

  // The service will neither change the last owner's role nor remove them, so the row that cannot
  // be either says so instead of offering controls whose every answer is a refusal. It counts only
  // owners whose accounts are still active, which this roster does not know about, so both
  // refusals are translated as well.
  const owners = people.filter((person) => person.role === "owner").length;

  return (
    <section className="members-page__section" aria-labelledby="members-roster-title">
      <h2 id="members-roster-title">
        {people.length === 1 ? "1 person" : `${String(people.length)} people`}
      </h2>
      <table className="members-page__table">
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col">Role</th>
            <th scope="col">Contact</th>
            {manages ? <th scope="col">Manage</th> : null}
          </tr>
        </thead>
        <tbody>
          {people.map((person) => (
            <tr key={person.id}>
              <th scope="row">
                {person.name}
                {person.isSelf ? <span className="members-page__you"> (you)</span> : null}
              </th>
              <td>
                <span className="members-page__role">{roleLabel(person.role)}</span>
                {isRole(person.role) ? (
                  <span className="members-page__powers">{ROLE_POWERS[person.role]}</span>
                ) : null}
              </td>
              <td>
                <span>{person.email}</span>
                {person.phone === null ? null : <span>{person.phone}</span>}
              </td>
              {manages ? (
                <td>
                  {person.role === "owner" && owners === 1 ? (
                    <span className="members-page__powers">
                      The only owner. Make somebody else an owner before changing this role or
                      removing them.
                    </span>
                  ) : open?.id === person.id && open.panel === "role" ? (
                    <ChangeRole
                      person={person}
                      actorRole={actorRole}
                      chosen={chosen}
                      busy={busy}
                      blocked={blocked}
                      onChoose={setChosen}
                      onSave={() => void change(person)}
                      onCancel={close}
                    />
                  ) : open?.id === person.id && open.panel === "removal" ? (
                    <RemoveMember
                      person={person}
                      typed={typed}
                      busy={busy}
                      blocked={blocked}
                      onType={setTyped}
                      onRemove={() => void remove(person)}
                      onCancel={close}
                    />
                  ) : (
                    <div className="members-page__change-actions">
                      <button
                        className="button"
                        type="button"
                        // One word repeated down a column, so the button says which row it is in.
                        aria-label={`Change ${person.name}'s role`}
                        disabled={blocked !== null}
                        onClick={() => reveal(person, "role")}
                      >
                        Change role
                      </button>
                      <button
                        className="button"
                        type="button"
                        aria-label={`Remove ${person.name} from this workspace`}
                        disabled={blocked !== null}
                        onClick={() => reveal(person, "removal")}
                      >
                        Remove
                      </button>
                    </div>
                  )}
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
      {outcome?.kind === "problem" ? (
        <p role="alert" className="members-invite__problem">
          {outcome.message}
        </p>
      ) : null}
      {outcome?.kind === "done" ? (
        <p role="status" className="members-invite__done">
          {outcome.message}
        </p>
      ) : null}
    </section>
  );
}

/**
 * The menu on one row, and what choosing from it would mean.
 *
 * Nothing is sent by picking. Save stays out of reach until the choice is a different role from the
 * one on the row, so that opening the menu to read what is on it cannot end in a change, and so
 * that somebody who changes their mind can leave the row as they found it by cancelling.
 */
function ChangeRole({
  person,
  actorRole,
  chosen,
  busy,
  blocked,
  onChoose,
  onSave,
  onCancel,
}: {
  person: RosterPerson;
  actorRole: string;
  chosen: string;
  busy: boolean;
  blocked: string | null;
  onChoose(role: string): void;
  onSave(): void;
  onCancel(): void;
}): React.JSX.Element {
  const warning = warnSelfChange(person.isSelf, chosen);
  return (
    <div className="members-page__change">
      <select
        // Named by the row it is in, for the same reason the button it replaced was.
        aria-label={`New role for ${person.name}`}
        value={chosen}
        disabled={busy}
        onChange={(event) => onChoose(event.target.value)}
      >
        {roleOptions(actorRole, person.role).map((value) => (
          <option key={value} value={value}>
            {roleLabel(value)}
          </option>
        ))}
      </select>
      {warning === null ? null : <p className="members-page__warning">{warning}</p>}
      <div className="members-page__change-actions">
        <button
          className="button button--primary"
          type="button"
          disabled={busy || blocked !== null || chosen === person.role}
          onClick={onSave}
        >
          {busy ? "Changing…" : "Save"}
        </button>
        <button className="button" type="button" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/**
 * The confirmation on one row, which is the name being typed out.
 *
 * The name is on the row, so this is not a memory test; it is a reading test, and reading the row
 * is the thing somebody skipped if they are about to remove the wrong person. A second button
 * would be pressed by the same hand that pressed the first, in the same second, without the row
 * having been looked at again.
 *
 * Removing yourself is the same two buttons and a different outcome, so the line above the box
 * says which of the two this is.
 */
function RemoveMember({
  person,
  typed,
  busy,
  blocked,
  onType,
  onRemove,
  onCancel,
}: {
  person: RosterPerson;
  typed: string;
  busy: boolean;
  blocked: string | null;
  onType(value: string): void;
  onRemove(): void;
  onCancel(): void;
}): React.JSX.Element {
  const confirmed = confirmsRemoval(typed, person.name);
  return (
    <div className="members-page__change">
      <p className="members-page__warning">{warnRemoval(person.name, person.isSelf)}</p>
      <label className="members-page__confirm">
        <span>Type {person.name} to confirm</span>
        <input
          type="text"
          value={typed}
          disabled={busy}
          autoComplete="off"
          onChange={(event) => onType(event.target.value)}
        />
      </label>
      <div className="members-page__change-actions">
        <button
          className="button button--danger"
          type="button"
          disabled={busy || blocked !== null || !confirmed}
          onClick={onRemove}
        >
          {busy ? "Removing…" : "Remove"}
        </button>
        <button className="button" type="button" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function unchanged(name: string): string {
  return `${name}'s role was not changed. Kiwi could not reach the account service, which is where the roster is kept.`;
}

function unremoved(name: string): string {
  return `${name} was not removed. Kiwi could not reach the account service, which is where the roster is kept.`;
}

/**
 * Who has been asked in and has not answered, and taking one of those back.
 *
 * Revoking is asked for once and done, with nothing to confirm. It is the only change on this page
 * that costs nothing to undo -- the address can be invited again, and the wrong one revoked by
 * mistake is a second email rather than somebody locked out of their own work. The changes that are
 * not undoable are confirmed; making this one confirm too would teach the habit of clicking through
 * the confirmation, which is what makes those useless.
 */
function Invitations({
  workspaceId,
  invitations,
  manages,
  blocked,
  onRevoked,
}: {
  workspaceId: string;
  invitations: readonly PendingInvitation[];
  /** Whether this account may revoke. The service checks it too, and refuses. */
  manages: boolean;
  /** Set while nothing can be revoked. The page says why, once, above all of this. */
  blocked: string | null;
  onRevoked(settings: RendererWorkspaceCollaborationSnapshot): void;
}): React.JSX.Element {
  const [busy, setBusy] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<{ kind: "problem" | "done"; message: string } | null>(
    null,
  );

  async function revoke(invitation: PendingInvitation): Promise<void> {
    const bridge = readBridge();
    if (bridge === null) {
      setOutcome({ kind: "problem", message: unreachable(invitation.email) });
      return;
    }
    setBusy(invitation.id);
    try {
      const result = await bridge.manageWorkspaceCollaboration({
        action: "revoke_invitation",
        input: { workspace_id: workspaceId, invitation_id: invitation.id },
      });
      if (result.status === "ok") {
        // The reply is the workspace as it now stands, so the row leaves the list because the
        // service says it has, and not because this window assumed the click worked.
        onRevoked(result.settings);
        setOutcome({ kind: "done", message: describeRevoked(invitation.email) });
      } else if (result.status === "queued")
        setOutcome({
          kind: "problem",
          message: `${invitation.email} was not un-invited. This workspace has not finished registering with the account service.`,
        });
      else
        setOutcome({
          kind: "problem",
          message: revokeRefusal(result.code, result.message, invitation.email),
        });
    } catch {
      setOutcome({ kind: "problem", message: unreachable(invitation.email) });
    } finally {
      setBusy(null);
    }
  }

  // An invitation that ran out is already unacceptable, and the service sweeps it out of pending
  // before it looks for it, so there is nothing there to revoke. Saying so beats a button that
  // would only ever answer that it could not find the invitation it is sitting next to.
  const lapsed = invitations.some((invitation) => invitation.expired);

  return (
    <section className="members-page__section" aria-labelledby="members-invitations-title">
      <h2 id="members-invitations-title">Invitations</h2>
      {invitations.length === 0 ? (
        <p className="members-page__empty">
          Nobody is waiting on an invitation. An invitation lasts seven days.
        </p>
      ) : (
        <>
          <ul className="members-page__invitations">
            {invitations.map((invitation) => (
              <li key={invitation.id}>
                <span>{invitation.email}</span>
                <span className="members-page__role">{roleLabel(invitation.role)}</span>
                {invitation.expiry === "" ? null : (
                  <span
                    className={
                      invitation.expired
                        ? "members-page__expiry members-page__lapsed"
                        : "members-page__expiry"
                    }
                  >
                    {invitation.expiry}
                  </span>
                )}
                {manages && !invitation.expired ? (
                  <button
                    className="button"
                    type="button"
                    // The list repeats one word down a column, so the button says which row it is
                    // in. Somebody moving through it by keyboard hears an address, not "Revoke"
                    // four times.
                    aria-label={`Revoke the invitation to ${invitation.email}`}
                    disabled={blocked !== null || busy !== null}
                    onClick={() => void revoke(invitation)}
                  >
                    {busy === invitation.id ? "Revoking…" : "Revoke"}
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
          {lapsed ? (
            <p className="members-page__empty">
              An invitation that ran out cannot be accepted, so there is nothing to revoke. Invite
              the address again to send a new one.
            </p>
          ) : null}
        </>
      )}
      {outcome?.kind === "problem" ? (
        <p role="alert" className="members-invite__problem">
          {outcome.message}
        </p>
      ) : null}
      {outcome?.kind === "done" ? (
        <p role="status" className="members-invite__done">
          {outcome.message}
        </p>
      ) : null}
    </section>
  );
}

function unreachable(email: string): string {
  return `${email} was not un-invited. Kiwi could not reach the account service, which is where the invitation is kept.`;
}

/**
 * The places where somebody's access is not what the roster says.
 *
 * A list of the exceptions, and not everybody crossed against every project. The roster above is
 * the answer for almost every person on almost every project; a grid would say that same answer
 * dozens of times over and hide the handful of rows that say something else among them. Here a
 * project with nothing unusual about it does not appear at all, and every row that does appear is
 * a row worth reading.
 *
 * An exception can only take access away. The service refuses a project role above the workspace
 * role, so nothing here offers one, and ending an exception is choosing the workspace role: it puts
 * somebody back on the footing the roster already says they are on.
 */
function ProjectExceptions({
  workspaceId,
  snapshot,
  manages,
  blocked,
  onChanged,
}: {
  workspaceId: string;
  snapshot: RendererWorkspaceCollaborationSnapshot;
  /** Whether this account may change access. The service checks it too, and refuses. */
  manages: boolean;
  /** Set while nothing can be changed. The page says why, once, above all of this. */
  blocked: string | null;
  onChanged(settings: RendererWorkspaceCollaborationSnapshot): void;
}): React.JSX.Element {
  const groups = exceptionsFrom(snapshot);
  const projects = projectPolicies(snapshot);
  /** The one exception with its menu open, named by the pair it is about. */
  const [open, setOpen] = useState<{ projectId: string; userId: string } | null>(null);
  const [chosen, setChosen] = useState("");
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<{ kind: "problem" | "done"; message: string } | null>(
    null,
  );
  const [project, setProject] = useState("");
  const [person, setPerson] = useState("");
  const [role, setRole] = useState("");

  async function send(
    policy: ProjectPolicy,
    who: { userId: string; name: string },
    next: string,
    lifting: boolean,
  ): Promise<void> {
    const bridge = readBridge();
    if (bridge === null) {
      setOutcome({ kind: "problem", message: unexcepted(who.name, policy.name) });
      return;
    }
    setBusy(true);
    try {
      const result = await bridge.manageWorkspaceCollaboration({
        action: "update_project",
        input: {
          workspace_id: workspaceId,
          project_id: policy.id,
          // Sent back exactly as they were read. The service takes a project's policy and one
          // person's access in the same call, so leaving these out is not "no change to the
          // policy"; it is a change to it. That is also why none of this can be sent from a stale
          // reading: a policy carried over from an old one would quietly undo a newer one.
          sensitivity: policy.sensitivity,
          review_required: policy.reviewRequired,
          member_user_id: who.userId,
          member_role: next,
        },
      });
      if (result.status === "ok") {
        onChanged(result.settings);
        setOpen(null);
        setPerson("");
        setRole("");
        setOutcome({
          kind: "done",
          message: lifting
            ? describeExceptionLifted(who.name, policy.name, next)
            : describeExceptionSet(who.name, policy.name, next),
        });
      } else if (result.status === "queued")
        setOutcome({
          kind: "problem",
          message: `${who.name}'s access on ${policy.name} was not changed. This workspace has not finished registering with the account service.`,
        });
      else
        setOutcome({
          kind: "problem",
          message: exceptionRefusal(result.code, result.message, who.name, policy.name),
        });
    } catch {
      setOutcome({ kind: "problem", message: unexcepted(who.name, policy.name) });
    } finally {
      setBusy(false);
    }
  }

  const chosenProject = projects.find((entry) => entry.id === project) ?? null;
  const candidates = chosenProject === null ? [] : candidateMembers(snapshot, chosenProject.id);
  const chosenPerson = candidates.find((entry) => entry.userId === person) ?? null;

  return (
    <section className="members-page__section" aria-labelledby="members-projects-title">
      <h2 id="members-projects-title">Project exceptions</h2>
      {projects.length === 0 ? (
        <p className="members-page__empty">
          This workspace has no projects, so there is nowhere for access to differ. Projects are
          made in workspace settings.
        </p>
      ) : groups.length === 0 ? (
        <p className="members-page__empty">
          Everybody has their workspace role on every project here. This is where an exception to
          that would be listed.
        </p>
      ) : (
        groups.map((group) => (
          <div key={group.project.id} className="members-page__project">
            <h3>{group.project.name}</h3>
            <ul className="members-page__exceptions">
              {group.people.map((who) => (
                <li key={who.userId}>
                  <span className="members-page__role">{who.name}</span>
                  <span className="members-page__powers">{describeException(who)}</span>
                  {who.widens ? (
                    <span className="members-page__warning">{warnWidened(who.name)}</span>
                  ) : null}
                  {!manages ? null : open?.projectId === group.project.id &&
                    open.userId === who.userId ? (
                    <ChangeException
                      person={who}
                      project={group.project}
                      chosen={chosen}
                      busy={busy}
                      blocked={blocked}
                      onChoose={setChosen}
                      onSave={() =>
                        void send(group.project, who, chosen, chosen === who.workspaceRole)
                      }
                      onCancel={() => setOpen(null)}
                    />
                  ) : (
                    <button
                      className="button"
                      type="button"
                      // One word repeated down a list of people and projects, so the button says
                      // which of both it belongs to.
                      aria-label={`Change ${who.name}'s access on ${group.project.name}`}
                      disabled={blocked !== null}
                      onClick={() => {
                        setOpen({ projectId: group.project.id, userId: who.userId });
                        setChosen(who.projectRole);
                        setOutcome(null);
                      }}
                    >
                      Change
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))
      )}

      {manages && projects.length > 0 ? (
        <form
          className="members-page__except"
          onSubmit={(event) => {
            event.preventDefault();
            if (chosenProject === null || chosenPerson === null || role === "") return;
            void send(chosenProject, chosenPerson, role, false);
          }}
        >
          <h3>Give somebody less on one project</h3>
          <label className="members-page__confirm">
            <span>Project</span>
            <select
              value={project}
              disabled={busy}
              onChange={(event) => {
                // Who can be excepted and what they can be given both depend on the project, so
                // an answer given before it was chosen is not carried over to a different one.
                setProject(event.target.value);
                setPerson("");
                setRole("");
              }}
            >
              <option value="">Choose a project</option>
              {projects.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name}
                </option>
              ))}
            </select>
          </label>
          {chosenProject === null ? null : candidates.length === 0 ? (
            <p className="members-page__empty">
              Everybody here either already has an exception on {chosenProject.name} or is a viewer,
              which is the least there is to give.
            </p>
          ) : (
            <>
              <label className="members-page__confirm">
                <span>Person</span>
                <select
                  value={person}
                  disabled={busy}
                  onChange={(event) => {
                    setPerson(event.target.value);
                    setRole("");
                  }}
                >
                  <option value="">Choose somebody</option>
                  {candidates.map((entry) => (
                    <option key={entry.userId} value={entry.userId}>
                      {entry.name} ({roleLabel(entry.workspaceRole)} here)
                    </option>
                  ))}
                </select>
              </label>
              {chosenPerson === null ? null : (
                <label className="members-page__confirm">
                  <span>Access on {chosenProject.name}</span>
                  <select
                    value={role}
                    disabled={busy}
                    onChange={(event) => setRole(event.target.value)}
                  >
                    <option value="">Choose a role</option>
                    {lesserRoles(chosenPerson.workspaceRole).map((value) => (
                      <option key={value} value={value}>
                        {roleLabel(value)}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </>
          )}
          <button
            className="button button--primary"
            type="submit"
            disabled={busy || blocked !== null || chosenPerson === null || role === ""}
          >
            {busy ? "Saving…" : "Add exception"}
          </button>
        </form>
      ) : null}

      {outcome?.kind === "problem" ? (
        <p role="alert" className="members-invite__problem">
          {outcome.message}
        </p>
      ) : null}
      {outcome?.kind === "done" ? (
        <p role="status" className="members-invite__done">
          {outcome.message}
        </p>
      ) : null}
    </section>
  );
}

/**
 * The menu on one exception.
 *
 * The workspace role is at the top of it and marked as such, because choosing it is how the
 * exception ends and that is not something somebody would think to look for under a list of roles.
 * Save is out of reach until the choice is different from what is recorded, so that opening the
 * menu to read what somebody has cannot end in changing it.
 */
function ChangeException({
  person,
  project,
  chosen,
  busy,
  blocked,
  onChoose,
  onSave,
  onCancel,
}: {
  person: ProjectException;
  project: ProjectPolicy;
  chosen: string;
  busy: boolean;
  blocked: string | null;
  onChoose(role: string): void;
  onSave(): void;
  onCancel(): void;
}): React.JSX.Element {
  return (
    <div className="members-page__change">
      <select
        aria-label={`New access for ${person.name} on ${project.name}`}
        value={chosen}
        disabled={busy}
        onChange={(event) => onChoose(event.target.value)}
      >
        {exceptionRoleOptions(person.workspaceRole, person.projectRole).map((value) => (
          <option key={value} value={value}>
            {value === person.workspaceRole
              ? `${roleLabel(value)} (their workspace role)`
              : roleLabel(value)}
          </option>
        ))}
      </select>
      <p className="members-page__powers">
        Choosing their workspace role ends the exception and leaves them on the same footing here as
        everywhere else.
      </p>
      <div className="members-page__change-actions">
        <button
          className="button button--primary"
          type="button"
          disabled={busy || blocked !== null || chosen === person.projectRole}
          onClick={onSave}
        >
          {busy ? "Saving…" : "Save"}
        </button>
        <button className="button" type="button" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function unexcepted(name: string, project: string): string {
  return `${name}'s access on ${project} was not changed. Kiwi could not reach the account service, which is where project access is kept.`;
}
