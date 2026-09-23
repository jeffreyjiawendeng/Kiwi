import { useState } from "react";
import { readBridge, type RendererWorkspaceCollaborationSnapshot } from "./bridge.js";
import {
  ASSIGNABLE_ROLES,
  checkInvite,
  describeInviteOutcome,
  type AssignableRole,
} from "./member-invites.js";
import { ROLE_LABELS, ROLE_POWERS } from "./members-roster.js";

/**
 * The form that asks somebody into this workspace.
 *
 * The roles are laid out with what each one can do beside it, rather than listed in a menu. Owner,
 * admin, editor, commenter and viewer are five words that mean nothing to somebody who has not read
 * the schema, and the moment they are being chosen is the moment the meaning is wanted.
 *
 * Nothing here is optimistic. The roster only changes once the service says it has changed, and a
 * refusal is shown with the words the service used: an invitation that fails quietly is an
 * invitation somebody believes they sent, and they will not find out otherwise for a week.
 */

export interface InviteMemberProps {
  workspaceId: string;
  snapshot: RendererWorkspaceCollaborationSnapshot;
  /** Set while nothing can be sent. The page says why, once, above this section. */
  blocked: string | null;
  onInvited(settings: RendererWorkspaceCollaborationSnapshot): void;
}

type Outcome =
  | { kind: "none" }
  /** Something Kiwi will not send, or something the service would not do. */
  | { kind: "problem"; message: string }
  | { kind: "done"; message: string };

export function InviteMember({
  workspaceId,
  snapshot,
  blocked,
  onInvited,
}: InviteMemberProps): React.JSX.Element {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<AssignableRole>("editor");
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>({ kind: "none" });
  const stopped = blocked !== null || busy;

  async function send(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (stopped) return;
    const checked = checkInvite(snapshot, email);
    if (!checked.ok) {
      setOutcome({ kind: "problem", message: checked.problem });
      return;
    }
    const bridge = readBridge();
    if (bridge === null) {
      setOutcome({ kind: "problem", message: unreachable });
      return;
    }
    setBusy(true);
    try {
      const result = await bridge.manageWorkspaceCollaboration({
        action: "invite",
        input: { workspace_id: workspaceId, email: checked.email, role },
      });
      if (result.status === "ok") {
        // The service answers a change with the workspace as it now stands, so the roster above can
        // be brought up to date from the same reply rather than asked for again.
        onInvited(result.settings);
        setOutcome({
          kind: "done",
          message: describeInviteOutcome(result.settings, checked.email, role),
        });
        setEmail("");
      } else if (result.status === "queued") {
        setOutcome({
          kind: "problem",
          message:
            "This workspace has not finished registering with the account service, so nobody can be invited to it yet.",
        });
      } else {
        setOutcome({
          kind: "problem",
          message: `The invitation was not sent. The account service said: ${result.message}`,
        });
      }
    } catch {
      setOutcome({ kind: "problem", message: unreachable });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      className="members-page__section members-invite"
      aria-labelledby="members-invite-title"
    >
      <h2 id="members-invite-title">Invite somebody</h2>
      {/* Kiwi says what is wrong with an address itself, in a sentence that names the workspace it
          is being invited to; the browser's own tooltip knows neither. */}
      <form noValidate onSubmit={(event) => void send(event)}>
        <label htmlFor="member-invite-email">Email address</label>
        <input
          id="member-invite-email"
          type="email"
          autoComplete="off"
          disabled={stopped}
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
        <fieldset className="members-invite__roles">
          <legend>Role</legend>
          {ASSIGNABLE_ROLES.map((value) => (
            <label key={value}>
              <input
                type="radio"
                name="member-invite-role"
                value={value}
                checked={role === value}
                disabled={stopped}
                onChange={() => setRole(value)}
              />
              <span className="members-invite__label">{ROLE_LABELS[value]}</span>
              <span className="members-invite__powers">{ROLE_POWERS[value]}</span>
            </label>
          ))}
        </fieldset>
        <button className="button button--primary" type="submit" disabled={stopped}>
          Send invitation
        </button>
      </form>
      <p className="members-page__empty">
        An invitation cannot make somebody an owner. An owner can change a role to owner on the
        roster once that person has joined.
      </p>
      {outcome.kind === "problem" ? (
        <p role="alert" className="members-invite__problem">
          {outcome.message}
        </p>
      ) : null}
      {outcome.kind === "done" ? (
        <p role="status" className="members-invite__done">
          {outcome.message}
        </p>
      ) : null}
    </section>
  );
}

const unreachable =
  "The invitation was not sent. Kiwi could not reach the account service, which is what sends it.";
