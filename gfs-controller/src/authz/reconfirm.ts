import { GfsError } from "../api/errors";
import type { Queryable } from "./audit";
import type { PermissionEpoch } from "./cache";
import type { AuthorizationRequest, AuthzContext } from "./permissionClient";

/**
 * In-transaction authority re-check for upload finalization.
 *
 * A finalization is decided before its publication transaction takes the drive
 * structure lock or the row lock. While it waits, the principal can be retired,
 * lose a team, or have a grant revoked. Inside the transaction, on the
 * transaction's own client (never a second pool client, issue #1398), the
 * finalizer re-resolves the principal, so a denied principal fails, and then:
 *
 * 1. the decision stands when the permission epoch did not move and the
 *    subject set did not change in a way that could change it;
 * 2. otherwise the requests are re-decided on that client, and the write is
 *    blocked only when no authority remains.
 */

/** Re-decides `requests` for `ctx` on an explicit transaction client. */
export type AuthorizeWithin = (
  db: Queryable,
  ctx: AuthzContext,
  requests: readonly AuthorizationRequest[]
) => Promise<ReadonlyArray<{ allowed: boolean }>>;

/**
 * True when every subject key in `decided` is still in `current`. Grants and
 * shares only allow (see resolve.ts), so a key the principal gained cannot
 * revoke an allow, and a key it lost cannot turn a deny into an allow.
 */
export function subjectsStillHeld(decided: readonly string[], current: readonly string[]): boolean {
  const held = new Set(current);
  return decided.every(subject => held.has(subject));
}

/** True when the permission epoch moved, or either snapshot cannot hear invalidations. */
export function permissionEpochMoved(captured: PermissionEpoch, now: PermissionEpoch): boolean {
  return captured.bypassed || now.bypassed || now.generation !== captured.generation;
}

/**
 * Decide whether `current` still has authority for `requests`.
 *
 * The decision made for `decided` stands, with no store read, when the epoch did
 * not move and either it allowed and every subject it used is still held, or it
 * denied and no subject was gained. Otherwise the requests are re-decided with
 * `current` on `client`.
 */
export async function stillAuthorized(
  client: Queryable,
  input: {
    decided: { subjects: readonly string[]; allowed: boolean };
    current: AuthzContext;
    requests: readonly AuthorizationRequest[];
    epochMoved: boolean;
    authorizeWithin: AuthorizeWithin;
  }
): Promise<{ allowed: true } | { allowed: false; denied: AuthorizationRequest }> {
  const [first] = input.requests;
  if (first === undefined) {
    throw new GfsError("internal", "authority re-check has no requests to decide");
  }
  if (!input.epochMoved) {
    if (input.decided.allowed && subjectsStillHeld(input.decided.subjects, input.current.subjects)) {
      return { allowed: true };
    }
    if (!input.decided.allowed && subjectsStillHeld(input.current.subjects, input.decided.subjects)) {
      return { allowed: false, denied: first };
    }
  }
  const decisions = await input.authorizeWithin(client, input.current, input.requests);
  const deniedIndex = input.requests.findIndex((_, index) => decisions[index]?.allowed !== true);
  return deniedIndex === -1
    ? { allowed: true }
    : { allowed: false, denied: input.requests[deniedIndex] };
}
