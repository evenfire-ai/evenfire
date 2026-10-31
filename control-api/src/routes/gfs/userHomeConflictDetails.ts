import type { DbClient } from '../../db.js'
import {
  type UserHomeConflictDetail,
  parseUserHomeConflictDetail,
} from '../../gfs/userHomeState.js'
import { UUID_RE } from './grants.js'

type AccessRow = {
  relation: 'grant' | 'share'
  resource_id: string
  path: string | null
  subject_type: string
  subject_id: string
  permissions: string[]
  inherit: boolean
}

async function currentAccess(
  db: DbClient,
  drive: string,
  detail: UserHomeConflictDetail,
  ancestorsOnly: boolean
) {
  const result = await db.query(
    `WITH access AS (
       SELECT 'grant'::text AS relation, g.id, g.resource_id, r.path_cache AS path,
              g.subject_type, g.subject_id, g.permissions, g.inherit
         FROM gfs_grants g JOIN gfs_resources r ON r.resource_id = g.resource_id AND r.drive = g.drive
        WHERE g.drive = $2 AND g.resource_id = ANY($1::uuid[]) AND r.deleted_at IS NULL
          AND (NOT $3::boolean OR (g.subject_type <> 'operator' AND g.inherit))
          AND (NOT $3::boolean OR $4::uuid[] IS NULL OR g.id = ANY($4::uuid[]))
       UNION ALL
       SELECT 'share'::text AS relation, s.id, s.resource_id, r.path_cache AS path,
              s.subject_type, s.subject_id, s.permissions, s.include_descendants AS inherit
         FROM gfs_shares s JOIN gfs_resources r ON r.resource_id = s.resource_id AND r.drive = s.drive
        WHERE s.drive = $2 AND s.resource_id = ANY($1::uuid[]) AND r.deleted_at IS NULL
          AND (NOT $3::boolean OR (s.subject_type <> 'operator' AND s.include_descendants))
          AND (NOT $3::boolean OR $5::uuid[] IS NULL OR s.id = ANY($5::uuid[]))
     )
     SELECT * FROM access ORDER BY relation, resource_id, subject_type, subject_id, id`,
    [detail.resourceIds, drive, ancestorsOnly, detail.grantIds ?? null, detail.shareIds ?? null]
  )
  const rows = result.rows as AccessRow[]
  const idsFor = (type: string) => [
    ...new Set(
      rows
        .filter(row => row.subject_type === type && UUID_RE.test(row.subject_id))
        .map(row => row.subject_id)
    ),
  ]
  const userIds = idsFor('user')
  const teamIds = idsFor('team')
  const [users, teams] = await Promise.all([
    userIds.length
      ? db.query('SELECT id::text, name, email FROM users WHERE id = ANY($1::uuid[])', [userIds])
      : Promise.resolve({ rows: [], rowCount: 0 }),
    teamIds.length
      ? db.query('SELECT id::text, name FROM teams WHERE id = ANY($1::uuid[])', [teamIds])
      : Promise.resolve({ rows: [], rowCount: 0 }),
  ])
  const userLabels = new Map(
    (users.rows as Array<{ id: string; name: string | null; email: string }>).map(user => [
      user.id,
      user.name?.trim() ? user.name : user.email,
    ])
  )
  const teamLabels = new Map(
    (teams.rows as Array<{ id: string; name: string }>).map(team => [team.id, team.name])
  )
  return rows.map(row => ({
    relation: row.relation,
    resourceId: row.resource_id,
    path: row.path,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    subjectLabel:
      row.subject_type === 'user'
        ? (userLabels.get(row.subject_id.toLowerCase()) ?? null)
        : row.subject_type === 'team'
          ? (teamLabels.get(row.subject_id.toLowerCase()) ?? null)
          : null,
    permissions: row.permissions,
    inherit: row.inherit,
  }))
}

/** Resolve operator-only conflict information from the stored identifiers. */
export async function resolveUserHomeConflictDetail(
  db: DbClient,
  home: {
    userId: string
    drive: string | null
    resourceId: string | null
    code: string | null
    detail: unknown
  }
): Promise<unknown> {
  const { code } = home
  if (
    code !== 'path_conflict' &&
    code !== 'ancestor_grant_conflict' &&
    code !== 'ownership_conflict'
  ) {
    throw new Error('home_conflict_code_invalid')
  }
  const detail = parseUserHomeConflictDetail(home.detail)
  if (!home.drive) throw new Error('home_conflict_drive_invalid')

  if (code === 'ownership_conflict') {
    if (!home.resourceId) return { code, ownerGrant: null }
    const result = await db.query(
      `SELECT permissions, inherit FROM gfs_grants
        WHERE drive = $1 AND resource_id = $2 AND subject_type = 'user' AND subject_id = $3`,
      [home.drive, home.resourceId, home.userId]
    )
    return { code, ownerGrant: result.rows[0] ?? null }
  }
  if (code === 'path_conflict') {
    if (
      detail.resourceIds.length < 1 ||
      detail.resourceIds.length > 2 ||
      (detail.resourceIds.length === 2 && detail.resourceIds[1] !== home.resourceId)
    ) {
      throw new Error('home_conflict_detail_invalid')
    }
    const result = await db.query(
      `SELECT resource_id, path_cache, kind, created_at FROM gfs_resources
        WHERE resource_id = $1 AND drive = $2 AND deleted_at IS NULL`,
      [detail.resourceIds[0], home.drive]
    )
    const resource = result.rows[0] as
      | { resource_id: string; path_cache: string | null; kind: string; created_at: Date }
      | undefined
    if (!resource) return { code, resource: null, access: [] }
    const access = await currentAccess(
      db,
      home.drive,
      { ...detail, resourceIds: [detail.resourceIds[0]!] },
      false
    )
    return {
      code,
      resource: {
        resourceId: resource.resource_id,
        path: resource.path_cache,
        kind: resource.kind,
        createdAt: resource.created_at,
      },
      access: access.map(({ resourceId: _resourceId, path: _path, ...item }) => item),
    }
  }
  return { code, entries: await currentAccess(db, home.drive, detail, true) }
}
