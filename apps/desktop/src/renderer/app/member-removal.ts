/**
 * Taking somebody out of this workspace.
 *
 * The one change on this page that cannot be taken back from inside the application. A role put
 * back wrongly is a second menu; somebody removed by mistake is out until they are invited again
 * and accept, which is somebody else's mailbox and somebody else's afternoon. So this is the thing
 * that is confirmed, and the confirmation is typing the name rather than pressing a second button:
 * a second button is answered by the same hand that pressed the first one, and the whole question
 * being asked is whether the row under the pointer is the row that was meant.
 */

/**
 * Whether what was typed is the name on the row.
 *
 * Case and surrounding space are not the point -- reading the row and typing what is on it is --
 * so neither is held against somebody who has plainly done it. What is held against them is
 * typing a different person's name, which is the mistake this exists to catch.
 */
export function confirmsRemoval(typed: string, name: string): boolean {
  const wanted = name.trim().toLocaleLowerCase();
  return wanted !== "" && typed.trim().toLocaleLowerCase() === wanted;
}

/**
 * What removing somebody costs, said before it happens.
 *
 * Removing yourself is the same button on the same row and does something else entirely: it ends
 * your own access, and the people who could give it back are the ones still here.
 */
export function warnRemoval(name: string, isSelf: boolean): string {
  if (isSelf)
    return "This removes your own access to this workspace. Only somebody who is still an owner or an admin here can invite you back.";
  return `${name} loses access to this workspace. They can be invited back, but the invitation has to be sent again and accepted.`;
}

export function describeRemoved(name: string, isSelf: boolean): string {
  if (isSelf)
    return "You are no longer a member of this workspace. Somebody who is still an owner or an admin here has to invite you back.";
  return `${name} is no longer a member of this workspace. They can be invited back at any time.`;
}

/**
 * Why somebody could not be removed.
 *
 * The service checks the last owner and the missing member on the same branch as a role change, so
 * these are the same two refusals said the other way round. Both mean the workspace has moved since
 * this roster was read, which is the reason worth saying; the rest is passed on in the service's
 * own words.
 */
export function removalRefusal(code: string, message: string, name: string): string {
  const failed = `${name} was not removed.`;
  if (code === "last_owner")
    return `${failed} A workspace has to keep an owner. Make somebody else an owner first, and then they can be removed.`;
  if (code === "not_found")
    return `${failed} They are no longer a member of this workspace. Refresh to see who is here now.`;
  if (code === "forbidden") return `${failed} ${message}`;
  return `${failed} The account service said: ${message}`;
}
