import { AuthzContext } from "./permissionClient";

/**
 * Check-time subject resolution for gfsc (spec community.md §Subjects, §Auth).
 *
 * A verified gfs token carries ONE `sub` — the PRINCIPAL. gfsc must turn it into
 * the AuthzContext the permission store is matched against: the canonical
 * subject-key SET the principal satisfies (itself + the groups it belongs to)
 * and whether the principal has intrinsic operator authority. Per spec, "groups
 * & roles resolve to principals at check time" — and gfsc IS the check point (it
 * queries the store directly), so the resolution happens here, not in the token.
 *
 * Principal grammar (spec §gfs access token `sub`):
 *   - `<uuid>`               → a human. Two DISJOINT pools: an operator mints with
 *                             `sub = control_admin_users.id`; a user with
 *                             `sub = users.id`. gfsc probes control_admin_users to
 *                             distinguish — an operator gets intrinsic authority +
 *                             `operator:`; a user gets `user:<id>` plus its active
 *                             `team:` memberships.
 *   - `host:1st:<ns>/<name>` → 1st-party Host (HCC).            subjects = { sub }
 *   - `host:3rd:<ns>/<name>` → 3rd-party recipe mcp-host (WRC). subjects = { sub }
 *
 * This MIRRORS control-api/src/gfs/subjects.ts (the canonical resolver, P2-S02);
 * gfsc cannot import across the service boundary, so the logic is duplicated and
 * converges via the @clerum/gfs-core extraction (documented follow-up) — exactly
 * like the desktop/profile-ui delegation affordance libs.
 *
 * A host's context-group resolution (host → the Contexts bound to it) is a P3+
 * follow-up, gated on `context` becoming a first-class grantee; until then a host
 * resolves to only its own subject key (deny-by-default for unbuilt groups).
 */

/** Minimal query surface — a pg Pool satisfies this; tests inject a fake. */
export interface SubjectsDb {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

const K8S_NAME = "[a-z0-9](?:[-a-z0-9]*[a-z0-9])?";

/** A host principal's `sub` is already the canonical subject key. */
const HOST_SUB = new RegExp(`^host:(1st|3rd):${K8S_NAME}\\/${K8S_NAME}$`);

/** True iff `adminId` is an active cluster operator (`control_admin_users`). */
async function isOperatorId(db: SubjectsDb, adminId: string): Promise<boolean> {
  const res = await db.query(
    `SELECT 1 FROM control_admin_users WHERE id = $1 AND status = 'active' LIMIT 1`,
    [adminId]
  );
  return res.rows.length > 0;
}

/**
 * Resolve a verified token's principal into the AuthzContext gfsc authorizes
 * against. Any store error PROPAGATES (fail-closed) — the caller maps it to a
 * fail-loud response, never a silent allow.
 */
export async function resolveAuthzContext(
  db: SubjectsDb,
  claims: { sub: string; drive: string },
  requestId?: string
): Promise<AuthzContext> {
  const sub = claims.sub;

  // Host principal — the `sub` IS the canonical subject key; no group resolution
  // in v1 (the host→context binding is a P3+ follow-up, deny-by-default until
  // `context` is a first-class grantee).
  if (HOST_SUB.test(sub)) {
    return { drive: claims.drive, subjects: [sub], isOperator: false, primarySubject: sub, requestId };
  }

  // Human principal — a bare id. The operator pool and the user pool are disjoint
  // UUID spaces, so a single probe of control_admin_users distinguishes them.
  if (await isOperatorId(db, sub)) {
    // Intrinsic authority; `authorize()` short-circuits on isOperator so the
    // subject set is only recorded, but resolving to `operator:` keeps it honest.
    return { drive: claims.drive, subjects: ["operator:"], isOperator: true, primarySubject: sub, requestId };
  }

  // Otherwise a user: itself plus every team it is an ACTIVE member of
  // (soft-deleted memberships excluded — deny-by-default).
  const subjects = new Set<string>([`user:${sub}`]);
  const res = await db.query(
    `SELECT team_id FROM team_members WHERE user_id = $1 AND status = 'active'`,
    [sub]
  );
  for (const row of res.rows) {
    subjects.add(`team:${String(row.team_id)}`);
  }
  return { drive: claims.drive, subjects: [...subjects], isOperator: false, primarySubject: sub, requestId };
}
