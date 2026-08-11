import type { DbClient } from '../db.js'
import {
  type ControlApiPermissionChange,
  appendControlApiPermissionEventsInTransaction,
} from './tracing/controlApiPermissionEvents.js'

export const GFS_DESKTOP_OPERATOR_LINK_SOURCES = ['initial_setup'] as const

export type GfsDesktopOperatorLinkSource = (typeof GFS_DESKTOP_OPERATOR_LINK_SOURCES)[number]

export type GfsDesktopOperatorLink = {
  id?: string
  lineageId?: string
  generation?: number
  predecessorId?: string | null
  desktopUserId: string
  controlAdminId: string
  source: GfsDesktopOperatorLinkSource
  state?: 'active' | 'revoked'
  rowVersion?: number
  createdAt: Date
  revokedAt?: Date | null
  revocationReason?: string | null
}

export type GfsDesktopOperatorLinkErrorCode =
  | 'invalid_input'
  | 'desktop_user_not_found'
  | 'desktop_user_retired'
  | 'control_admin_not_found'
  | 'control_admin_inactive'
  | 'link_conflict'
  | 'malformed_link'
  | 'resolution_failed'

export type GfsDesktopOperatorLinkConflictIdentity = 'desktop_user' | 'control_admin' | 'both'

export class GfsDesktopOperatorLinkError extends Error {
  readonly code: GfsDesktopOperatorLinkErrorCode
  readonly conflictIdentity: GfsDesktopOperatorLinkConflictIdentity | null

  constructor(
    code: GfsDesktopOperatorLinkErrorCode,
    message: string,
    options?: {
      cause?: unknown
      conflictIdentity?: GfsDesktopOperatorLinkConflictIdentity
    }
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'GfsDesktopOperatorLinkError'
    this.code = code
    this.conflictIdentity = options?.conflictIdentity ?? null
  }
}

export type LinkGfsDesktopOperatorInput = {
  desktopUserId: string
  controlAdminId: string
  source: GfsDesktopOperatorLinkSource
  /** Authenticated Control Admin responsible for this lifecycle mutation. */
  operatorSub: string
  /** Request correlation for the governed lifecycle event. */
  requestId?: string | null
}

export type UnlinkGfsDesktopOperatorInput = {
  desktopUserId: string
  controlAdminId: string
  /** Authenticated Control Admin responsible for this lifecycle mutation. */
  operatorSub: string
  /** Optimistic-concurrency token returned by the Control UI read surface. */
  rowVersion?: number
  reason?: string
  /** Request correlation for the governed lifecycle event. */
  requestId?: string | null
}

export type ReactivateGfsDesktopOperatorInput = {
  controlAdminId: string
  operatorSub: string
  /** The revoked generation being reactivated; prevents stale UI writes. */
  rowVersion: number
  reason: string
  /** Request correlation for the governed lifecycle event. */
  requestId?: string | null
}

export type LinkGfsDesktopOperatorResult = {
  created: boolean
  link: GfsDesktopOperatorLink
}

export type UnlinkGfsDesktopOperatorResult =
  | { unlinked: false; link: null }
  | { unlinked: true; link: GfsDesktopOperatorLink }

export type ReactivateGfsDesktopOperatorResult = {
  reactivated: boolean
  link: GfsDesktopOperatorLink | null
}
export type GfsDesktopOperatorParentKind = 'desktop_user' | 'control_admin'

/**
 * Lifecycle callers name their principal explicitly.  The two actor IDs are
 * deliberately separate so a UUID is never reinterpreted as another kind.
 */
export type GfsDesktopOperatorLifecycleActor =
  | { kind: 'control_admin'; controlAdminId: string }
  | { kind: 'platform_user'; desktopUserId: string }

type TransactionRunner = <T>(work: (db: DbClient) => Promise<T>) => Promise<T>

/**
 * Keep the singleton import-safe for callers that mock only the read-side DB
 * pool. The production transaction primitive remains `db.withTransaction`;
 * resolving it only when a link mutation is actually requested avoids making
 * unrelated route modules provide a transaction mock merely by importing the
 * directory barrel.
 */
const defaultTransaction: TransactionRunner = async work => {
  const { withTransaction } = await import('../db.js')
  return withTransaction(work)
}

const defaultReadDb: Pick<DbClient, 'query'> = {
  query: (text, values) => import('../db.js').then(({ pool }) => pool.query(text, values)),
}

type GfsDesktopOperatorLinkServiceDependencies = {
  transaction: TransactionRunner
  readDb: Pick<DbClient, 'query'>
  appendPermissionEvents: typeof appendControlApiPermissionEventsInTransaction
}

type StoredLinkRow = {
  id?: unknown
  lineage_id?: unknown
  generation?: unknown
  predecessor_id?: unknown
  row_version?: unknown
  state?: unknown
  revoked_at?: unknown
  revocation_reason?: unknown
  user_id: unknown
  control_admin_id: unknown
  source: unknown
  created_at: unknown
}

function requireRowVersion(value: unknown): number {
  const normalized =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\d+$/.test(value.trim())
        ? Number(value)
        : Number.NaN
  if (!Number.isSafeInteger(normalized) || normalized < 1) {
    throw new GfsDesktopOperatorLinkError('invalid_input', 'rowVersion must be a positive integer')
  }
  return normalized
}

function requireReason(value: unknown): string {
  const reason = String(value || '').trim()
  if (!reason || reason.length > 512) {
    throw new GfsDesktopOperatorLinkError(
      'invalid_input',
      'reason is required and must be at most 512 characters'
    )
  }
  return reason
}

type ResolvedLinkRow = StoredLinkRow & {
  desktop_user_exists?: unknown
  control_admin_exists?: unknown
  control_admin_status?: unknown
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function requireUuid(value: string, field: string): string {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
  if (!UUID_PATTERN.test(normalized)) {
    throw new GfsDesktopOperatorLinkError('invalid_input', `${field} must be a UUID`)
  }
  return normalized
}

function requireLifecycleActor(
  input: GfsDesktopOperatorLifecycleActor
): GfsDesktopOperatorLifecycleActor {
  if (!input || typeof input !== 'object') {
    throw new GfsDesktopOperatorLinkError('invalid_input', 'actor is required')
  }
  if (input.kind === 'control_admin') {
    return {
      kind: 'control_admin',
      controlAdminId: requireUuid(input.controlAdminId, 'actor.controlAdminId'),
    }
  }
  if (input.kind === 'platform_user') {
    return {
      kind: 'platform_user',
      desktopUserId: requireUuid(input.desktopUserId, 'actor.desktopUserId'),
    }
  }
  throw new GfsDesktopOperatorLinkError('invalid_input', 'actor kind is not supported')
}

function lifecycleActorId(actor: GfsDesktopOperatorLifecycleActor): string {
  return actor.kind === 'control_admin' ? actor.controlAdminId : actor.desktopUserId
}

function isLinkSource(value: unknown): value is GfsDesktopOperatorLinkSource {
  return (
    typeof value === 'string' &&
    (GFS_DESKTOP_OPERATOR_LINK_SOURCES as readonly string[]).includes(value)
  )
}

function requireSource(value: unknown): GfsDesktopOperatorLinkSource {
  if (!isLinkSource(value)) {
    throw new GfsDesktopOperatorLinkError(
      'invalid_input',
      'source is not a supported GFS Desktop operator-link source'
    )
  }
  return value
}

function mapStoredLink(row: unknown): GfsDesktopOperatorLink {
  if (!row || typeof row !== 'object') {
    throw new GfsDesktopOperatorLinkError('malformed_link', 'operator-link row is malformed')
  }
  const stored = row as StoredLinkRow
  const desktopUserId =
    typeof stored.user_id === 'string' && UUID_PATTERN.test(stored.user_id)
      ? stored.user_id.toLowerCase()
      : null
  const controlAdminId =
    typeof stored.control_admin_id === 'string' && UUID_PATTERN.test(stored.control_admin_id)
      ? stored.control_admin_id.toLowerCase()
      : null
  const createdAt = stored.created_at instanceof Date ? stored.created_at : null
  if (
    !desktopUserId ||
    !controlAdminId ||
    !isLinkSource(stored.source) ||
    !createdAt ||
    !Number.isFinite(createdAt.getTime())
  ) {
    throw new GfsDesktopOperatorLinkError('malformed_link', 'operator-link row is malformed')
  }
  const id =
    stored.id === undefined || stored.id === null ? undefined : requireUuid(String(stored.id), 'id')
  const lineageId =
    stored.lineage_id === undefined || stored.lineage_id === null
      ? undefined
      : requireUuid(String(stored.lineage_id), 'lineageId')
  const predecessorId =
    stored.predecessor_id === undefined || stored.predecessor_id === null
      ? null
      : requireUuid(String(stored.predecessor_id), 'predecessorId')
  const generation =
    stored.generation === undefined || stored.generation === null
      ? undefined
      : requireRowVersion(stored.generation)
  const rowVersion =
    stored.row_version === undefined || stored.row_version === null
      ? undefined
      : requireRowVersion(stored.row_version)
  const state = stored.state === undefined || stored.state === null ? undefined : stored.state
  if (state !== undefined && state !== 'active' && state !== 'revoked') {
    throw new GfsDesktopOperatorLinkError('malformed_link', 'operator-link state is malformed')
  }
  const revokedAt =
    stored.revoked_at === undefined || stored.revoked_at === null
      ? null
      : stored.revoked_at instanceof Date
        ? stored.revoked_at
        : null
  if (stored.revoked_at !== undefined && stored.revoked_at !== null && !revokedAt) {
    throw new GfsDesktopOperatorLinkError(
      'malformed_link',
      'operator-link revocation timestamp is malformed'
    )
  }
  return {
    ...(id ? { id } : {}),
    ...(lineageId ? { lineageId } : {}),
    ...(generation === undefined ? {} : { generation }),
    ...(stored.predecessor_id === undefined ? {} : { predecessorId }),
    desktopUserId,
    controlAdminId,
    source: stored.source,
    ...(state === undefined ? {} : { state }),
    ...(rowVersion === undefined ? {} : { rowVersion }),
    createdAt,
    ...(stored.revoked_at === undefined ? {} : { revokedAt }),
    ...(stored.revocation_reason === undefined
      ? {}
      : { revocationReason: stored.revocation_reason as string | null }),
  }
}

function lifecycleChange(
  action: 'grant' | 'revoke',
  link: GfsDesktopOperatorLink,
  reason?: string,
  lifecycleEvent?: 'link.created' | 'link.revoked' | 'link.reactivated' | 'parent.retired',
  actor?: GfsDesktopOperatorLifecycleActor
): ControlApiPermissionChange {
  return {
    action,
    resourceClass: 'gfs_desktop_operator_link',
    resourceRef: `gfs_desktop_operator_link:${link.desktopUserId}:${link.controlAdminId}`,
    subject: { kind: 'user', id: link.desktopUserId },
    sourceAuditRef: `gfs_desktop_operator_link_source:${link.source}`,
    status: action === 'grant' ? 'linked' : 'unlinked',
    detailRef: [
      lifecycleEvent ? `event:${lifecycleEvent}` : null,
      `desktop_user_id:${link.desktopUserId}`,
      `control_admin_id:${link.controlAdminId}`,
      `source:${link.source}`,
      link.lineageId ? `lineage_id:${link.lineageId}` : null,
      link.generation === undefined ? null : `generation:${link.generation}`,
      link.predecessorId ? `predecessor_id:${link.predecessorId}` : null,
      actor ? `actor_type:${actor.kind}` : null,
      actor?.kind === 'control_admin' ? `actor_control_admin_id:${actor.controlAdminId}` : null,
      actor?.kind === 'platform_user' ? `actor_desktop_user_id:${actor.desktopUserId}` : null,
      reason ? `reason:${reason}` : null,
    ]
      .filter(Boolean)
      .join(';'),
  }
}

function mapActiveResolvedLink(
  row: ResolvedLinkRow,
  expected: { desktopUserId?: string; controlAdminId?: string }
): GfsDesktopOperatorLink {
  const link = mapStoredLink(row)
  if (
    (expected.desktopUserId && link.desktopUserId !== expected.desktopUserId) ||
    (expected.controlAdminId && link.controlAdminId !== expected.controlAdminId)
  ) {
    throw new GfsDesktopOperatorLinkError(
      'malformed_link',
      'operator-link lookup returned a different identity'
    )
  }
  if (row.desktop_user_exists !== true) {
    throw new GfsDesktopOperatorLinkError(
      'malformed_link',
      'operator link references a missing Desktop user'
    )
  }
  if (row.control_admin_exists !== true) {
    throw new GfsDesktopOperatorLinkError(
      'control_admin_not_found',
      'operator link references a missing Control Admin'
    )
  }
  if (row.control_admin_status !== 'active') {
    throw new GfsDesktopOperatorLinkError(
      'control_admin_inactive',
      'linked Control Admin is not active'
    )
  }
  return link
}

/**
 * Owns the persisted one-to-one GFS Desktop operator-link lifecycle.
 *
 * Link mutations are serialized by locking both exact identity rows before the
 * relationship is rechecked. Lifecycle events share the caller's transaction,
 * so a missing event can never leave behind a committed current-state link.
 */
export class GfsDesktopOperatorLinkService {
  private readonly dependencies: GfsDesktopOperatorLinkServiceDependencies

  constructor(dependencies: Partial<GfsDesktopOperatorLinkServiceDependencies> = {}) {
    this.dependencies = {
      transaction: dependencies.transaction ?? defaultTransaction,
      readDb: dependencies.readDb ?? defaultReadDb,
      appendPermissionEvents:
        dependencies.appendPermissionEvents ?? appendControlApiPermissionEventsInTransaction,
    }
  }

  async link(input: LinkGfsDesktopOperatorInput): Promise<LinkGfsDesktopOperatorResult> {
    return this.dependencies.transaction(db => this.linkInTransaction(db, input))
  }

  /** Caller-owned transaction seam used by initial Desktop provisioning. */
  async linkInTransaction(
    db: DbClient,
    input: LinkGfsDesktopOperatorInput
  ): Promise<LinkGfsDesktopOperatorResult> {
    const desktopUserId = requireUuid(input.desktopUserId, 'desktopUserId')
    const controlAdminId = requireUuid(input.controlAdminId, 'controlAdminId')
    const operatorSub = requireUuid(input.operatorSub, 'operatorSub')
    const source = requireSource(input.source)

    const user = await db.query(
      `SELECT id::text AS id, lifecycle_state
         FROM users
        WHERE id = $1::uuid
        FOR UPDATE`,
      [desktopUserId]
    )
    if (user.rows.length !== 1) {
      throw new GfsDesktopOperatorLinkError('desktop_user_not_found', 'Desktop user does not exist')
    }
    if ((user.rows[0] as { lifecycle_state?: unknown }).lifecycle_state === 'retired') {
      throw new GfsDesktopOperatorLinkError(
        'desktop_user_retired',
        'retired Desktop users cannot receive an operator link'
      )
    }

    const admin = await db.query(
      `SELECT id::text AS id, status
         FROM control_admin_users
        WHERE id = $1::uuid
        FOR UPDATE`,
      [controlAdminId]
    )
    if (admin.rows.length !== 1) {
      throw new GfsDesktopOperatorLinkError(
        'control_admin_not_found',
        'Control Admin does not exist'
      )
    }
    const adminStatus = (admin.rows[0] as { status?: unknown }).status
    if (adminStatus !== 'active') {
      throw new GfsDesktopOperatorLinkError('control_admin_inactive', 'Control Admin is not active')
    }

    const current = await db.query(
      `SELECT id::text AS id, lineage_id::text AS lineage_id, generation,
              predecessor_id::text AS predecessor_id, state, row_version,
              revoked_at, revocation_reason,
              user_id::text AS user_id,
              control_admin_id::text AS control_admin_id,
              source,
              created_at
        FROM gfs_desktop_operator_links
        WHERE (user_id = $1::uuid
           OR control_admin_id = $2::uuid)
        ORDER BY user_id::text, control_admin_id::text
        FOR UPDATE`,
      [desktopUserId, controlAdminId]
    )
    const links = current.rows.map(mapStoredLink)
    const activeLinks = links.filter(link => link.state === undefined || link.state === 'active')
    const revokedLinks = links.filter(link => link.state === 'revoked')
    const exact = activeLinks.find(
      link => link.desktopUserId === desktopUserId && link.controlAdminId === controlAdminId
    )
    if (exact && activeLinks.length === 1) return { created: false, link: exact }
    if (exact || activeLinks.length > 2) {
      throw new GfsDesktopOperatorLinkError(
        'malformed_link',
        'operator-link uniqueness invariant is violated'
      )
    }

    const desktopUserConflict = activeLinks.some(link => link.desktopUserId === desktopUserId)
    const controlAdminConflict = activeLinks.some(link => link.controlAdminId === controlAdminId)
    if (desktopUserConflict || controlAdminConflict) {
      const conflictIdentity: GfsDesktopOperatorLinkConflictIdentity =
        desktopUserConflict && controlAdminConflict
          ? 'both'
          : desktopUserConflict
            ? 'desktop_user'
            : 'control_admin'
      throw new GfsDesktopOperatorLinkError(
        'link_conflict',
        'GFS Desktop operator link conflicts with an existing identity assignment',
        { conflictIdentity }
      )
    }
    if (revokedLinks.length > 0) {
      throw new GfsDesktopOperatorLinkError(
        'link_conflict',
        'GFS Desktop operator-link history already exists; use explicit reactivation'
      )
    }

    const inserted = await db.query(
      `INSERT INTO gfs_desktop_operator_links(id, lineage_id, generation, user_id, control_admin_id, state, source, created_by, row_version)
       VALUES(gen_random_uuid(), gen_random_uuid(), 1, $1::uuid, $2::uuid, 'active', $3, $4::uuid, 1)
       RETURNING id::text AS id, lineage_id::text AS lineage_id, generation,
                 state, row_version,
                 user_id::text AS user_id,
                 control_admin_id::text AS control_admin_id,
                 source,
                 created_at`,
      [desktopUserId, controlAdminId, source, operatorSub]
    )
    if (inserted.rows.length !== 1) {
      throw new GfsDesktopOperatorLinkError(
        'malformed_link',
        'operator-link insert did not return exactly one row'
      )
    }
    const link = mapStoredLink(inserted.rows[0])
    await this.dependencies.appendPermissionEvents(db, {
      operatorSub,
      operatorKind: 'control_admin',
      requestId: input.requestId,
      changes: [lifecycleChange('grant', link, undefined, 'link.created')],
    })
    return { created: true, link }
  }

  async unlink(input: UnlinkGfsDesktopOperatorInput): Promise<UnlinkGfsDesktopOperatorResult> {
    const desktopUserId = requireUuid(input.desktopUserId, 'desktopUserId')
    const controlAdminId = requireUuid(input.controlAdminId, 'controlAdminId')
    const operatorSub = requireUuid(input.operatorSub, 'operatorSub')

    return this.dependencies.transaction(async db => {
      const current = await db.query(
        `SELECT id::text AS id, lineage_id::text AS lineage_id, generation,
                predecessor_id::text AS predecessor_id, state, row_version,
                revoked_at, revocation_reason,
                user_id::text AS user_id,
                control_admin_id::text AS control_admin_id,
                source,
                created_at
           FROM gfs_desktop_operator_links
          WHERE (user_id = $1::uuid
             OR control_admin_id = $2::uuid)
            AND state = 'active'
          ORDER BY user_id::text, control_admin_id::text
          FOR UPDATE`,
        [desktopUserId, controlAdminId]
      )
      if (current.rows.length === 0) return { unlinked: false as const, link: null }

      const links = current.rows.map(mapStoredLink)
      const exact = links.find(
        link => link.desktopUserId === desktopUserId && link.controlAdminId === controlAdminId
      )
      if (!exact || links.length !== 1) {
        throw new GfsDesktopOperatorLinkError(
          'link_conflict',
          'requested GFS Desktop operator pair does not match current linkage',
          {
            conflictIdentity:
              links.some(link => link.desktopUserId === desktopUserId) &&
              links.some(link => link.controlAdminId === controlAdminId)
                ? 'both'
                : links.some(link => link.desktopUserId === desktopUserId)
                  ? 'desktop_user'
                  : 'control_admin',
          }
        )
      }

      const rowVersion =
        input.rowVersion === undefined
          ? exact.rowVersion === undefined
            ? 1
            : exact.rowVersion
          : requireRowVersion(input.rowVersion)
      const reason = input.reason === undefined ? 'operator_revoked' : requireReason(input.reason)
      // Evidence is appended before the immutable generation is revoked. Both
      // operations still commit atomically because they share this transaction.
      await this.dependencies.appendPermissionEvents(db, {
        operatorSub,
        operatorKind: 'control_admin',
        requestId: input.requestId,
        changes: [lifecycleChange('revoke', exact, reason, 'link.revoked')],
      })
      const removed = await db.query(
        `UPDATE gfs_desktop_operator_links
            SET state = 'revoked',
                revoked_at = NOW(),
                revoked_by_type = 'control_admin',
                revoked_by_id = $3::uuid,
                revoked_by_control_admin_id = $3::uuid,
                revoked_by_desktop_user_id = NULL,
                revocation_reason = $4,
                row_version = row_version + 1
          WHERE user_id = $1::uuid
            AND control_admin_id = $2::uuid
            AND state = 'active'
            AND row_version = $5`,
        [desktopUserId, controlAdminId, operatorSub, reason, rowVersion]
      )
      if (removed.rowCount !== 1) {
        throw new GfsDesktopOperatorLinkError(
          'malformed_link',
          'operator-link was changed by another request'
        )
      }
      return {
        unlinked: true as const,
        link: {
          ...exact,
          state: 'revoked' as const,
          rowVersion: rowVersion + 1,
          revokedAt: new Date(),
          revocationReason: reason,
        },
      }
    })
  }

  /**
   * Reactivation always creates a successor generation; the revoked row is
   * retained as the predecessor and is never modified again.
   */
  async reactivate(
    input: ReactivateGfsDesktopOperatorInput
  ): Promise<ReactivateGfsDesktopOperatorResult> {
    const controlAdminId = requireUuid(input.controlAdminId, 'controlAdminId')
    const operatorSub = requireUuid(input.operatorSub, 'operatorSub')
    const rowVersion = requireRowVersion(input.rowVersion)
    const reason = requireReason(input.reason)
    return this.dependencies.transaction(async db => {
      // A replay after a committed reactivation is idempotent. Lock the active
      // row before reading the tombstone so no second successor can be made.
      const active = await db.query(
        `SELECT id::text AS id, lineage_id::text AS lineage_id, generation,
                predecessor_id::text AS predecessor_id, state, row_version,
                user_id::text AS user_id, control_admin_id::text AS control_admin_id,
                source, created_at
           FROM gfs_desktop_operator_links
          WHERE control_admin_id = $1::uuid AND state = 'active'
          LIMIT 1 FOR UPDATE`,
        [controlAdminId]
      )
      if (active.rows.length === 1) {
        const activeLink = mapStoredLink(active.rows[0])
        // A replay is idempotent only when it names the tombstone that
        // produced the currently active successor. A stale request for a
        // different generation must not be silently accepted.
        if (!activeLink.predecessorId) {
          return { reactivated: false, link: activeLink }
        }
        const predecessor = await db.query(
          `SELECT state, row_version
             FROM gfs_desktop_operator_links
            WHERE id = $1::uuid
            FOR UPDATE`,
          [activeLink.predecessorId]
        )
        const predecessorRow = predecessor.rows[0] as
          | { state?: unknown; row_version?: unknown }
          | undefined
        if (
          predecessorRow?.state !== 'revoked' ||
          requireRowVersion(predecessorRow.row_version) !== rowVersion
        ) {
          throw new GfsDesktopOperatorLinkError(
            'link_conflict',
            'operator-link reactivation replay is stale'
          )
        }
        return { reactivated: true, link: activeLink }
      }
      const prior = await db.query(
        `SELECT id::text AS id, lineage_id::text AS lineage_id, generation,
                predecessor_id::text AS predecessor_id, state, row_version, revoked_at,
                revocation_reason, user_id::text AS user_id, control_admin_id::text AS control_admin_id,
                source, created_at
           FROM gfs_desktop_operator_links
          WHERE control_admin_id = $1::uuid AND state = 'revoked'
          ORDER BY generation DESC
          LIMIT 1 FOR UPDATE`,
        [controlAdminId]
      )
      if (prior.rows.length === 0) return { reactivated: false, link: null }
      const previous = prior.rows[0] as StoredLinkRow
      const link = mapStoredLink(previous)
      if (requireRowVersion(previous.row_version) !== rowVersion) {
        throw new GfsDesktopOperatorLinkError(
          'link_conflict',
          'operator-link was changed by another request'
        )
      }
      const predecessorId = requireUuid(String(previous.id || ''), 'predecessorId')
      const lineageId = requireUuid(String(previous.lineage_id || ''), 'lineageId')
      const generation = requireRowVersion(previous.generation) + 1
      const parents = await db.query(
        `SELECT u.id IS NOT NULL AS desktop_user_exists,
                u.lifecycle_state AS desktop_user_lifecycle_state,
                a.status AS control_admin_status
           FROM users u CROSS JOIN control_admin_users a
          WHERE u.id = $1::uuid AND a.id = $2::uuid
          FOR UPDATE`,
        [link.desktopUserId, controlAdminId]
      )
      const parentState = parents.rows[0] as
        | {
            desktop_user_exists?: unknown
            desktop_user_lifecycle_state?: unknown
            control_admin_status?: unknown
          }
        | undefined
      if (parentState?.desktop_user_exists !== true) {
        throw new GfsDesktopOperatorLinkError(
          'desktop_user_not_found',
          'Desktop user does not exist'
        )
      }
      if (parentState.desktop_user_lifecycle_state === 'retired') {
        throw new GfsDesktopOperatorLinkError(
          'desktop_user_retired',
          'retired Desktop users cannot receive an operator link'
        )
      }
      if (parentState.control_admin_status !== 'active') {
        throw new GfsDesktopOperatorLinkError(
          'control_admin_inactive',
          'Control Admin is not active'
        )
      }
      const inserted = await db.query(
        `INSERT INTO gfs_desktop_operator_links
           (id, lineage_id, generation, predecessor_id, user_id, control_admin_id, state, source, created_by, row_version)
         VALUES (gen_random_uuid(), $1::uuid, $2, $3::uuid, $4::uuid, $5::uuid, 'active', 'initial_setup', $6::uuid, 1)
         RETURNING id::text AS id, lineage_id::text AS lineage_id, generation,
                   predecessor_id::text AS predecessor_id, state, row_version,
                   user_id::text AS user_id, control_admin_id::text AS control_admin_id,
                   source, created_at`,
        [lineageId, generation, predecessorId, link.desktopUserId, controlAdminId, operatorSub]
      )
      const successor = mapStoredLink(inserted.rows[0])
      await this.dependencies.appendPermissionEvents(db, {
        operatorSub,
        operatorKind: 'control_admin',
        requestId: input.requestId,
        changes: [lifecycleChange('grant', successor, reason, 'link.reactivated')],
      })
      return { reactivated: true, link: successor }
    })
  }

  /** Shared parent-retirement seam: evidence precedes every tombstone update. */
  async retireParentInTransaction(
    db: DbClient,
    input: {
      kind: GfsDesktopOperatorParentKind
      parentId: string
      actor: GfsDesktopOperatorLifecycleActor
      reason: string
      requestId?: string | null
      /** Reuses the retirement-operation id as the governed audit operation. */
      operationId?: string
    }
  ): Promise<boolean> {
    const parentId = requireUuid(input.parentId, 'parentId')
    const actor = requireLifecycleActor(input.actor)
    const operatorSub = lifecycleActorId(actor)
    const reason = requireReason(input.reason)
    const column = input.kind === 'desktop_user' ? 'user_id' : 'control_admin_id'
    const rows = await db.query(
      `SELECT id::text AS id, lineage_id::text AS lineage_id, generation,
              predecessor_id::text AS predecessor_id, state, row_version,
              user_id::text AS user_id, control_admin_id::text AS control_admin_id,
              source, created_at
         FROM gfs_desktop_operator_links
        WHERE ${column} = $1::uuid AND state = 'active'
        LIMIT 1 FOR UPDATE`,
      [parentId]
    )
    if (rows.rows.length === 0) return false
    const link = mapStoredLink(rows.rows[0])
    await this.dependencies.appendPermissionEvents(db, {
      operatorSub,
      operatorKind: actor.kind,
      requestId: input.requestId,
      operationId: input.operationId,
      changes: [
        lifecycleChange('revoke', link, reason, 'link.revoked', actor),
        {
          action: 'revoke',
          resourceClass: `gfs_desktop_operator_${input.kind}`,
          resourceRef: `${input.kind}:${parentId}`,
          subject:
            input.kind === 'desktop_user'
              ? { kind: 'user', id: parentId }
              : { kind: 'service', id: `control_admin:${parentId}`, principalKind: 'operator' },
          sourceAuditRef: `gfs_desktop_operator_link_source:${link.source}`,
          status: 'retired',
          detailRef: [
            'event:parent.retired',
            `desktop_user_id:${link.desktopUserId}`,
            `control_admin_id:${link.controlAdminId}`,
            `source:${link.source}`,
            `actor_type:${actor.kind}`,
            actor.kind === 'control_admin'
              ? `actor_control_admin_id:${actor.controlAdminId}`
              : `actor_desktop_user_id:${actor.desktopUserId}`,
            `reason:${reason}`,
          ].join(';'),
        },
      ],
    })
    const updated = await db.query(
      `UPDATE gfs_desktop_operator_links
          SET state = 'revoked',
              revoked_at = NOW(),
              revoked_by_type = $2,
              revoked_by_id = $3::uuid,
              revoked_by_control_admin_id = $4::uuid,
              revoked_by_desktop_user_id = $5::uuid,
              revocation_reason = $6,
              row_version = row_version + 1
        WHERE ${column} = $1::uuid AND state = 'active' AND row_version = $7`,
      [
        parentId,
        actor.kind,
        actor.kind === 'control_admin' ? actor.controlAdminId : null,
        actor.kind === 'control_admin' ? actor.controlAdminId : null,
        actor.kind === 'platform_user' ? actor.desktopUserId : null,
        reason,
        link.rowVersion ?? 1,
      ]
    )
    if (updated.rowCount !== 1)
      throw new GfsDesktopOperatorLinkError(
        'link_conflict',
        'parent link changed during retirement'
      )
    return true
  }

  async resolveActiveLink(desktopUserIdInput: string): Promise<GfsDesktopOperatorLink | null> {
    const desktopUserId = requireUuid(desktopUserIdInput, 'desktopUserId')
    try {
      const result = await this.dependencies.readDb.query(
        `SELECT links.id::text AS id, links.lineage_id::text AS lineage_id,
                links.generation, links.predecessor_id::text AS predecessor_id,
                links.state, links.row_version, links.revoked_at, links.revocation_reason,
                links.user_id::text AS user_id,
                links.control_admin_id::text AS control_admin_id,
                links.source,
                links.created_at,
                users.id IS NOT NULL AS desktop_user_exists,
                admins.id IS NOT NULL AS control_admin_exists,
                admins.status AS control_admin_status
           FROM gfs_desktop_operator_links links
           LEFT JOIN users ON users.id = links.user_id
           LEFT JOIN control_admin_users admins ON admins.id = links.control_admin_id
          WHERE links.user_id = $1::uuid
            AND links.state = 'active'`,
        [desktopUserId]
      )
      if (result.rows.length === 0) return null
      if (result.rows.length !== 1) {
        throw new GfsDesktopOperatorLinkError(
          'malformed_link',
          'operator-link uniqueness invariant is violated'
        )
      }

      return mapActiveResolvedLink(result.rows[0] as ResolvedLinkRow, { desktopUserId })
    } catch (error) {
      if (error instanceof GfsDesktopOperatorLinkError) throw error
      throw new GfsDesktopOperatorLinkError(
        'resolution_failed',
        'failed to resolve GFS Desktop operator link',
        { cause: error }
      )
    }
  }

  /**
   * The external-authority boundary checks lifecycle before it can fall back
   * to ordinary user-session authority after a link is revoked.
   */
  async isDesktopUserActive(desktopUserIdInput: string): Promise<boolean> {
    const desktopUserId = requireUuid(desktopUserIdInput, 'desktopUserId')
    try {
      const result = await this.dependencies.readDb.query(
        `SELECT lifecycle_state
           FROM users
          WHERE id = $1::uuid
          LIMIT 1`,
        [desktopUserId]
      )
      return (
        (result.rows[0] as { lifecycle_state?: unknown } | undefined)?.lifecycle_state === 'active'
      )
    } catch (error) {
      if (error instanceof GfsDesktopOperatorLinkError) throw error
      throw new GfsDesktopOperatorLinkError(
        'resolution_failed',
        'failed to resolve Desktop user lifecycle state',
        { cause: error }
      )
    }
  }

  /** Read-only exact-pair seam for the authenticated Control UI revoke surface. */
  async getLinkForControlAdmin(
    controlAdminIdInput: string
  ): Promise<GfsDesktopOperatorLink | null> {
    const controlAdminId = requireUuid(controlAdminIdInput, 'controlAdminId')
    try {
      const result = await this.dependencies.readDb.query(
        `SELECT links.id::text AS id,
                links.lineage_id::text AS lineage_id,
                links.generation,
                links.predecessor_id::text AS predecessor_id,
                links.state,
                links.row_version,
                links.revoked_at,
                links.revocation_reason,
                links.user_id::text AS user_id,
                links.control_admin_id::text AS control_admin_id,
                links.source,
                links.created_at,
                users.id IS NOT NULL AS desktop_user_exists,
                admins.id IS NOT NULL AS control_admin_exists,
                admins.status AS control_admin_status
           FROM gfs_desktop_operator_links links
          LEFT JOIN users ON users.id = links.user_id
          LEFT JOIN control_admin_users admins ON admins.id = links.control_admin_id
          WHERE links.control_admin_id = $1::uuid
          ORDER BY links.generation DESC
          LIMIT 1`,
        [controlAdminId]
      )
      if (result.rows.length === 0) return null
      if (result.rows.length !== 1) {
        throw new GfsDesktopOperatorLinkError(
          'malformed_link',
          'operator-link uniqueness invariant is violated'
        )
      }
      const row = result.rows[0] as ResolvedLinkRow
      const link = mapStoredLink(row)
      if (link.controlAdminId !== controlAdminId || row.desktop_user_exists !== true) {
        throw new GfsDesktopOperatorLinkError(
          'malformed_link',
          'operator-link lookup returned a malformed identity pair'
        )
      }
      if (row.control_admin_exists !== true) {
        throw new GfsDesktopOperatorLinkError(
          'control_admin_not_found',
          'operator link references a missing Control Admin'
        )
      }
      // Status reads deliberately preserve a structurally valid tombstone for
      // the Control UI. Request-time authority still uses resolveActiveLink(),
      // which rejects every non-active generation or admin.
      return link
    } catch (error) {
      if (error instanceof GfsDesktopOperatorLinkError) throw error
      throw new GfsDesktopOperatorLinkError(
        'resolution_failed',
        'failed to read GFS Desktop operator link for Control Admin',
        { cause: error }
      )
    }
  }

  async getActiveRowVersionForControlAdmin(controlAdminIdInput: string): Promise<number | null> {
    const controlAdminId = requireUuid(controlAdminIdInput, 'controlAdminId')
    const result = await this.dependencies.readDb.query(
      `SELECT row_version
         FROM gfs_desktop_operator_links
        WHERE control_admin_id = $1::uuid AND state = 'active'
        LIMIT 1`,
      [controlAdminId]
    )
    if (result.rows.length === 0) return null
    return requireRowVersion((result.rows[0] as { row_version?: unknown }).row_version)
  }
}

export const gfsDesktopOperatorLinkService = new GfsDesktopOperatorLinkService()
