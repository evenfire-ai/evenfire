import type { GfsBrokeredAuthority } from "../auth/verify";
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
 *   - `<uuid>`               → a human. The signed `principalType` distinguishes
 *                             a Control Admin from a user; an omitted marker is
 *                             conservatively a user. Linked-admin metadata is
 *                             validated separately and rechecks active admin state.
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
const UUID_SUB = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type AdminSecurityRow = { id?: unknown; status?: unknown; session_version?: unknown };
type UserSecurityRow = { id?: unknown; lifecycle_state?: unknown; lifecycle_version?: unknown };

/**
 * A verified principal that is no longer entitled to use GFS. This is a
 * normal authorization refusal, not a permission-store outage: the serving
 * layer must return 403 rather than converting retirement/revocation into a
 * misleading 503 readiness failure.
 */
export class GfsSubjectResolutionDeniedError extends Error {
  readonly code = "subject_denied" as const;

  constructor(reason: string) {
    super(reason);
    this.name = "GfsSubjectResolutionDeniedError";
  }
}

function denySubject(reason: string): never {
  throw new GfsSubjectResolutionDeniedError(reason);
}

async function readActiveAdmin(db: SubjectsDb, adminId: string): Promise<AdminSecurityRow | null> {
  const res = await db.query(
    `SELECT id, status, session_version
       FROM control_admin_users
      WHERE id = $1
      LIMIT 1`,
    [adminId]
  );
  const row = res.rows[0] as AdminSecurityRow | undefined;
  return row && row.status === "active" ? row : null;
}

async function readActiveUser(db: SubjectsDb, userId: string): Promise<UserSecurityRow | null> {
  const res = await db.query(
    `SELECT id, lifecycle_state, lifecycle_version
       FROM users
      WHERE id = $1
      LIMIT 1`,
    [userId]
  );
  const row = res.rows[0] as UserSecurityRow | undefined;
  return row && row.lifecycle_state === "active" ? row : null;
}

function generationMatches(value: unknown, expected: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) > 0 && Number(value) === Number(expected);
}

/**
 * Resolve a verified token's principal into the AuthzContext gfsc authorizes
 * against. Any store error PROPAGATES (fail-closed) — the caller maps it to a
 * fail-loud response, never a silent allow.
 */
export async function resolveAuthzContext(
  db: SubjectsDb,
  claims: {
    sub: string;
    drive: string;
    brokeredAuthority?: GfsBrokeredAuthority;
    principalType?: "user" | "control-admin";
    authGeneration?: number;
  },
  requestId?: string
): Promise<AuthzContext> {
  const sub = claims.sub;
  // PostgreSQL UUIDs are canonicalized to lowercase. Keep non-UUID host
  // principals byte-for-byte stable, while making signed UUID subjects
  // independent of hex casing across verify and authorization resolution.
  const canonicalSub = UUID_SUB.test(sub) ? sub.toLowerCase() : sub;

  if (claims.brokeredAuthority) {
    const brokered = claims.brokeredAuthority;
    const canonicalBrokeredAdminId = brokered.controlAdminId.toLowerCase();
    const canonicalDesktopUserId = UUID_SUB.test(brokered.desktopUserId)
      ? brokered.desktopUserId.toLowerCase()
      : brokered.desktopUserId;
    if (
      canonicalBrokeredAdminId !== canonicalSub ||
      claims.authGeneration === undefined ||
      brokered.linkLineageId === undefined ||
      brokered.linkGeneration === undefined ||
      brokered.desktopUserGeneration === undefined
    ) {
      return denySubject("linked admin token is missing current generation metadata");
    }
    const admin = await readActiveAdmin(db, canonicalBrokeredAdminId);
    if (!admin || !generationMatches(admin.session_version, claims.authGeneration)) {
      return denySubject("linked admin is not active");
    }
    const user = await readActiveUser(db, canonicalDesktopUserId);
    if (!user || !generationMatches(user.lifecycle_version, brokered.desktopUserGeneration)) {
      return denySubject("linked Desktop user is retired or stale");
    }
    const link = await db.query(
      `SELECT lineage_id, generation
         FROM gfs_desktop_operator_links
        WHERE user_id = $1
          AND control_admin_id = $2
          AND state = 'active'
          AND source = 'initial_setup'
        LIMIT 1`,
      [canonicalDesktopUserId, canonicalBrokeredAdminId]
    );
    const currentLink = link.rows[0] as { lineage_id?: unknown; generation?: unknown } | undefined;
    if (
      !currentLink ||
      String(currentLink.lineage_id).toLowerCase() !== brokered.linkLineageId.toLowerCase() ||
      !generationMatches(currentLink.generation, brokered.linkGeneration)
    ) {
      return denySubject("linked Desktop operator generation is not active");
    }
    return {
      drive: claims.drive,
      subjects: ["operator:"],
      isOperator: true,
      primarySubject: canonicalSub,
      effectiveControlAdminId: canonicalBrokeredAdminId,
      desktopUserId: canonicalDesktopUserId,
      authoritySource: "linked-admin",
      requestId,
    };
  }

  // Host principal — the `sub` IS the canonical subject key; no group resolution
  // in v1 (the host→context binding is a P3+ follow-up, deny-by-default until
  // `context` is a first-class grantee).
  if (HOST_SUB.test(sub)) {
    return {
      drive: claims.drive,
      subjects: [sub],
      isOperator: false,
      primarySubject: sub,
      requestId,
    };
  }

  if (claims.principalType === "control-admin") {
    if (claims.authGeneration === undefined)
      return denySubject("control admin token is missing generation");
    const admin = await readActiveAdmin(db, canonicalSub);
    if (!admin || !generationMatches(admin.session_version, claims.authGeneration)) {
      return denySubject("control admin is not active");
    }
    return {
      drive: claims.drive,
      subjects: ["operator:"],
      isOperator: true,
      primarySubject: canonicalSub,
      requestId,
    };
  }

  // Rollout ordering: control-api must stamp principalType=control-admin before
  // gfsc is exposed to brokered operator tokens. Until then an omitted marker
  // deliberately remains an ordinary user, which is safe but temporarily
  // denies operator authority rather than elevating a bare UUID.

  // Every remaining bare principal is resolved conservatively as a user. An
  // omitted marker never probes the admin table: only an explicit signed
  // control-admin marker (or validated broker metadata above) can elevate.
  // This also keeps legacy/unmarked user tokens fail-closed during rollout.
  // A user resolves to itself plus every team it is an ACTIVE member of
  // (soft-deleted memberships excluded — deny-by-default).
  if (!UUID_SUB.test(canonicalSub)) {
    return denySubject("user principal must be a UUID");
  }
  if (claims.authGeneration === undefined) return denySubject("user token is missing generation");
  const user = await readActiveUser(db, canonicalSub);
  if (!user || !generationMatches(user.lifecycle_version, claims.authGeneration)) {
    return denySubject("user is retired or token generation is stale");
  }
  const subjects = new Set<string>([`user:${canonicalSub}`]);
  const res = await db.query(
    `SELECT team_id FROM team_members WHERE user_id = $1 AND status = 'active'`,
    [canonicalSub]
  );
  for (const row of res.rows) {
    subjects.add(`team:${String(row.team_id)}`);
  }
  return {
    drive: claims.drive,
    subjects: [...subjects],
    isOperator: false,
    primarySubject: canonicalSub,
    desktopUserId: canonicalSub,
    authoritySource: "user-session",
    requestId,
  };
}
