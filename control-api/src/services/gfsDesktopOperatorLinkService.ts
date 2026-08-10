import { type DbClient, pool } from '../db.js'
import {
  type ControlApiPermissionChange,
  appendControlApiPermissionEventsInTransaction,
} from './tracing/controlApiPermissionEvents.js'

export const GFS_DESKTOP_OPERATOR_LINK_SOURCES = ['initial_setup'] as const

export type GfsDesktopOperatorLinkSource = (typeof GFS_DESKTOP_OPERATOR_LINK_SOURCES)[number]

export type GfsDesktopOperatorLink = {
  desktopUserId: string
  controlAdminId: string
  source: GfsDesktopOperatorLinkSource
  createdAt: Date
}

export type GfsDesktopOperatorLinkErrorCode =
  | 'invalid_input'
  | 'desktop_user_not_found'
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
}

export type UnlinkGfsDesktopOperatorInput = {
  desktopUserId: string
  controlAdminId: string
  /** Authenticated Control Admin responsible for this lifecycle mutation. */
  operatorSub: string
}

export type LinkGfsDesktopOperatorResult = {
  created: boolean
  link: GfsDesktopOperatorLink
}

export type UnlinkGfsDesktopOperatorResult =
  | { unlinked: false; link: null }
  | { unlinked: true; link: GfsDesktopOperatorLink }

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

type GfsDesktopOperatorLinkServiceDependencies = {
  transaction: TransactionRunner
  readDb: Pick<DbClient, 'query'>
  appendPermissionEvents: typeof appendControlApiPermissionEventsInTransaction
}

type StoredLinkRow = {
  user_id: unknown
  control_admin_id: unknown
  source: unknown
  created_at: unknown
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
  return {
    desktopUserId,
    controlAdminId,
    source: stored.source,
    createdAt,
  }
}

function lifecycleChange(
  action: 'grant' | 'revoke',
  link: GfsDesktopOperatorLink
): ControlApiPermissionChange {
  return {
    action,
    resourceClass: 'gfs_desktop_operator_link',
    resourceRef: `gfs_desktop_operator_link:${link.desktopUserId}:${link.controlAdminId}`,
    subject: { kind: 'user', id: link.desktopUserId },
    sourceAuditRef: `gfs_desktop_operator_link_source:${link.source}`,
    status: action === 'grant' ? 'linked' : 'unlinked',
    detailRef: `desktop_user_id:${link.desktopUserId};control_admin_id:${link.controlAdminId};source:${link.source}`,
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
      readDb: dependencies.readDb ?? pool,
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
      `SELECT id::text AS id
         FROM users
        WHERE id = $1::uuid
        FOR UPDATE`,
      [desktopUserId]
    )
    if (user.rows.length !== 1) {
      throw new GfsDesktopOperatorLinkError('desktop_user_not_found', 'Desktop user does not exist')
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
      `SELECT user_id::text AS user_id,
              control_admin_id::text AS control_admin_id,
              source,
              created_at
         FROM gfs_desktop_operator_links
        WHERE user_id = $1::uuid
           OR control_admin_id = $2::uuid
        ORDER BY user_id::text, control_admin_id::text
        FOR UPDATE`,
      [desktopUserId, controlAdminId]
    )
    const links = current.rows.map(mapStoredLink)
    const exact = links.find(
      link => link.desktopUserId === desktopUserId && link.controlAdminId === controlAdminId
    )
    if (exact && links.length === 1) return { created: false, link: exact }
    if (exact || links.length > 2) {
      throw new GfsDesktopOperatorLinkError(
        'malformed_link',
        'operator-link uniqueness invariant is violated'
      )
    }

    const desktopUserConflict = links.some(link => link.desktopUserId === desktopUserId)
    const controlAdminConflict = links.some(link => link.controlAdminId === controlAdminId)
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

    const inserted = await db.query(
      `INSERT INTO gfs_desktop_operator_links(user_id, control_admin_id, source)
       VALUES($1::uuid, $2::uuid, $3)
       RETURNING user_id::text AS user_id,
                 control_admin_id::text AS control_admin_id,
                 source,
                 created_at`,
      [desktopUserId, controlAdminId, source]
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
      changes: [lifecycleChange('grant', link)],
    })
    return { created: true, link }
  }

  async unlink(input: UnlinkGfsDesktopOperatorInput): Promise<UnlinkGfsDesktopOperatorResult> {
    const desktopUserId = requireUuid(input.desktopUserId, 'desktopUserId')
    const controlAdminId = requireUuid(input.controlAdminId, 'controlAdminId')
    const operatorSub = requireUuid(input.operatorSub, 'operatorSub')

    return this.dependencies.transaction(async db => {
      const current = await db.query(
        `SELECT user_id::text AS user_id,
                control_admin_id::text AS control_admin_id,
                source,
                created_at
           FROM gfs_desktop_operator_links
          WHERE user_id = $1::uuid
             OR control_admin_id = $2::uuid
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

      // Evidence is appended before current state is removed. Both operations
      // still commit atomically because they share this transaction.
      await this.dependencies.appendPermissionEvents(db, {
        operatorSub,
        operatorKind: 'control_admin',
        changes: [lifecycleChange('revoke', exact)],
      })
      const removed = await db.query(
        `DELETE FROM gfs_desktop_operator_links
          WHERE user_id = $1::uuid
            AND control_admin_id = $2::uuid`,
        [desktopUserId, controlAdminId]
      )
      if (removed.rowCount !== 1) {
        throw new GfsDesktopOperatorLinkError(
          'malformed_link',
          'operator-link disappeared during unlink'
        )
      }
      return { unlinked: true as const, link: exact }
    })
  }

  async resolveActiveLink(desktopUserIdInput: string): Promise<GfsDesktopOperatorLink | null> {
    const desktopUserId = requireUuid(desktopUserIdInput, 'desktopUserId')
    try {
      const result = await this.dependencies.readDb.query(
        `SELECT links.user_id::text AS user_id,
                links.control_admin_id::text AS control_admin_id,
                links.source,
                links.created_at,
                users.id IS NOT NULL AS desktop_user_exists,
                admins.id IS NOT NULL AS control_admin_exists,
                admins.status AS control_admin_status
           FROM gfs_desktop_operator_links links
           LEFT JOIN users ON users.id = links.user_id
           LEFT JOIN control_admin_users admins ON admins.id = links.control_admin_id
          WHERE links.user_id = $1::uuid`,
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

  /** Read-only exact-pair seam for the authenticated Control UI revoke surface. */
  async getLinkForControlAdmin(
    controlAdminIdInput: string
  ): Promise<GfsDesktopOperatorLink | null> {
    const controlAdminId = requireUuid(controlAdminIdInput, 'controlAdminId')
    try {
      const result = await this.dependencies.readDb.query(
        `SELECT links.user_id::text AS user_id,
                links.control_admin_id::text AS control_admin_id,
                links.source,
                links.created_at,
                users.id IS NOT NULL AS desktop_user_exists,
                admins.id IS NOT NULL AS control_admin_exists,
                admins.status AS control_admin_status
           FROM gfs_desktop_operator_links links
           LEFT JOIN users ON users.id = links.user_id
           LEFT JOIN control_admin_users admins ON admins.id = links.control_admin_id
          WHERE links.control_admin_id = $1::uuid`,
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
      // Status reads deliberately preserve a structurally valid link for a
      // disabled admin so the authenticated revoke path can remove stale
      // current state. Request-time authority still uses resolveActiveLink(),
      // which rejects every non-active admin.
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
}

export const gfsDesktopOperatorLinkService = new GfsDesktopOperatorLinkService()
