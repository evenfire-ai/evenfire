import { seedGfsBlobWithKubectlCp } from './gfsBlobFixtureWriter'
import {
  GFS_E2E_DRIVE,
  type GfsDirectoryFixture,
  type GfsFileFixture,
  type GfsGrantSummary,
  type GfsPermission,
  type GfsResourceSummary,
  type GfsShareSummary,
  UUID_RE,
  assertFixtureName,
  firstDataLine,
  gfsWriterPod,
  kubectlContext,
  kubectlOut,
  ridOf,
  runControlPostgresSql,
  splitSqlRow,
  sqlLiteral,
} from './gfsFixtureCore'

function seedGfsBlob(resourceId: string, content: Buffer): void {
  const blobKey = ridOf(resourceId)
  const writerPod = gfsWriterPod()
  seedGfsBlobWithKubectlCp({
    context: kubectlContext(),
    writerPod,
    blobKey,
    content,
    timeoutMs: 20_000,
  })
  const byteCount = Number(
    kubectlOut(['-n', 'gfs', 'exec', writerPod, '--', 'wc', '-c', `/data/gfs/${blobKey}`])
      .trim()
      .split(/\s+/)[0]
  )
  if (byteCount !== content.byteLength) {
    throw new Error(
      `failed to seed GFS blob ${blobKey}: wrote ${byteCount} bytes, expected ${content.byteLength}`
    )
  }
}

function cleanupGfsBlob(resourceId: string): void {
  const blobKey = ridOf(resourceId)
  kubectlOut(
    ['-n', 'gfs', 'exec', gfsWriterPod(), '--', 'rm', '-f', `/data/gfs/${blobKey}`],
    20_000
  )
}

export function seedGfsDirectoryFixture(name: string): GfsDirectoryFixture {
  assertFixtureName(name)
  const childName = `${name}-child`
  const row = firstDataLine(
    runControlPostgresSql(`
      WITH root_insert AS (
        INSERT INTO gfs_resources (drive, parent_resource_id, name, kind, path_cache)
        VALUES (${sqlLiteral(GFS_E2E_DRIVE)}, NULL, '', 'directory', '/')
        ON CONFLICT (drive) WHERE parent_resource_id IS NULL AND deleted_at IS NULL
        DO NOTHING
        RETURNING resource_id
      ),
      root_row AS (
        SELECT resource_id FROM root_insert
        UNION ALL
        SELECT resource_id
          FROM gfs_resources
         WHERE drive = ${sqlLiteral(GFS_E2E_DRIVE)}
           AND parent_resource_id IS NULL
           AND deleted_at IS NULL
        LIMIT 1
      ),
      folder AS (
        INSERT INTO gfs_resources (drive, parent_resource_id, name, kind, path_cache)
        SELECT ${sqlLiteral(GFS_E2E_DRIVE)}, resource_id, ${sqlLiteral(name)}, 'directory', ${sqlLiteral(`/${name}`)}
          FROM root_row
        ON CONFLICT (drive, parent_resource_id, name) WHERE deleted_at IS NULL
        DO UPDATE SET updated_at = now()
        RETURNING resource_id
      ),
      child AS (
        INSERT INTO gfs_resources (drive, parent_resource_id, name, kind, path_cache)
        SELECT ${sqlLiteral(GFS_E2E_DRIVE)}, resource_id, ${sqlLiteral(childName)}, 'directory', ${sqlLiteral(`/${name}/${childName}`)}
          FROM folder
        ON CONFLICT (drive, parent_resource_id, name) WHERE deleted_at IS NULL
        DO UPDATE SET updated_at = now()
        RETURNING resource_id
      )
      SELECT folder.resource_id::text, child.resource_id::text
        FROM folder CROSS JOIN child;
    `)
  )
  const [resourceId, childResourceId] = splitSqlRow(row)
  if (!UUID_RE.test(resourceId) || !UUID_RE.test(childResourceId)) {
    throw new Error(`failed to seed GFS fixture ${name}: ${row}`)
  }
  return {
    name,
    childName,
    resourceId,
    childResourceId,
    uri: `gfs://${GFS_E2E_DRIVE}/${ridOf(resourceId)}`,
    childUri: `gfs://${GFS_E2E_DRIVE}/${ridOf(childResourceId)}`,
  }
}

export function seedGfsFileFixture(name: string): GfsFileFixture {
  assertFixtureName(name)
  const fileName = `${name}-report.pdf`
  const fileContent = Buffer.from(`E2E GFS file fixture: ${name}\n`, 'utf8')
  const row = firstDataLine(
    runControlPostgresSql(`
      WITH root_insert AS (
        INSERT INTO gfs_resources (drive, parent_resource_id, name, kind, path_cache)
        VALUES (${sqlLiteral(GFS_E2E_DRIVE)}, NULL, '', 'directory', '/')
        ON CONFLICT (drive) WHERE parent_resource_id IS NULL AND deleted_at IS NULL
        DO NOTHING
        RETURNING resource_id
      ),
      root_row AS (
        SELECT resource_id FROM root_insert
        UNION ALL
        SELECT resource_id
          FROM gfs_resources
         WHERE drive = ${sqlLiteral(GFS_E2E_DRIVE)}
           AND parent_resource_id IS NULL
           AND deleted_at IS NULL
        LIMIT 1
      ),
      folder AS (
        INSERT INTO gfs_resources (drive, parent_resource_id, name, kind, path_cache)
        SELECT ${sqlLiteral(GFS_E2E_DRIVE)}, resource_id, ${sqlLiteral(name)}, 'directory', ${sqlLiteral(`/${name}`)}
          FROM root_row
        ON CONFLICT (drive, parent_resource_id, name) WHERE deleted_at IS NULL
        DO UPDATE SET updated_at = now()
        RETURNING resource_id
      ),
      file_row AS (
        INSERT INTO gfs_resources (drive, parent_resource_id, name, kind, path_cache, bytes)
        SELECT ${sqlLiteral(GFS_E2E_DRIVE)}, resource_id, ${sqlLiteral(fileName)}, 'file', ${sqlLiteral(`/${name}/${fileName}`)}, ${fileContent.byteLength}
          FROM folder
        ON CONFLICT (drive, parent_resource_id, name) WHERE deleted_at IS NULL
        DO UPDATE SET updated_at = now(), version = gfs_resources.version + 1, bytes = EXCLUDED.bytes
        RETURNING resource_id
      )
      SELECT folder.resource_id::text, file_row.resource_id::text
        FROM folder CROSS JOIN file_row;
    `)
  )
  const [resourceId, fileResourceId] = splitSqlRow(row)
  if (!UUID_RE.test(resourceId) || !UUID_RE.test(fileResourceId)) {
    throw new Error(`failed to seed GFS file fixture ${name}: ${row}`)
  }
  seedGfsBlob(fileResourceId, fileContent)
  return {
    name,
    fileName,
    resourceId,
    fileResourceId,
    uri: `gfs://${GFS_E2E_DRIVE}/${ridOf(resourceId)}`,
    fileUri: `gfs://${GFS_E2E_DRIVE}/${ridOf(fileResourceId)}`,
  }
}

export function seedGfsGrant(input: {
  resourceId: string
  subjectType: 'user' | 'team' | 'host' | 'context' | 'operator'
  subjectId?: string
  permissions: GfsPermission[]
  inherit?: boolean
  grantedBy?: string
}): void {
  const subjectId = input.subjectType === 'operator' ? '' : (input.subjectId ?? '')
  if (input.subjectType !== 'operator' && subjectId.length === 0) {
    throw new Error(`subjectId is required for ${input.subjectType} GFS grants`)
  }
  const permissions = `ARRAY[${input.permissions.map(sqlLiteral).join(', ')}]::text[]`
  runControlPostgresSql(`
    INSERT INTO gfs_grants (
      drive, resource_id, subject_type, subject_id, permissions, inherit, granted_by
    )
    VALUES (
      ${sqlLiteral(GFS_E2E_DRIVE)},
      ${sqlLiteral(input.resourceId)}::uuid,
      ${sqlLiteral(input.subjectType)},
      ${sqlLiteral(subjectId)},
      ${permissions},
      ${input.inherit ? 'true' : 'false'},
      ${sqlLiteral(input.grantedBy ?? 'e2e:setup')}
    )
    ON CONFLICT (drive, resource_id, subject_type, subject_id)
    DO UPDATE SET
      permissions = EXCLUDED.permissions,
      inherit = EXCLUDED.inherit,
      granted_by = EXCLUDED.granted_by,
      updated_at = now();
  `)
}

export function getGfsGrantSummary(input: {
  resourceId: string
  subjectType: 'user' | 'team' | 'host' | 'context' | 'operator'
  subjectId?: string
}): GfsGrantSummary | null {
  const subjectId = input.subjectType === 'operator' ? '' : (input.subjectId ?? '')
  const row = firstDataLine(
    runControlPostgresSql(`
      SELECT array_to_string(permissions, ',') || '|' || inherit::text || '|' || coalesce(granted_by, '')
        FROM gfs_grants
       WHERE drive = ${sqlLiteral(GFS_E2E_DRIVE)}
         AND resource_id = ${sqlLiteral(input.resourceId)}::uuid
         AND subject_type = ${sqlLiteral(input.subjectType)}
         AND subject_id = ${sqlLiteral(subjectId)}
       LIMIT 1;
    `)
  )
  if (!row) return null
  const [permissions, inherit, grantedBy] = splitSqlRow(row)
  return {
    permissions: (permissions ? permissions.split(',') : []) as GfsPermission[],
    inherit: inherit === 't' || inherit === 'true',
    grantedBy,
  }
}

export function getGfsShareSummary(input: {
  resourceId: string
  subjectType: 'user' | 'team'
  subjectId: string
}): GfsShareSummary | null {
  const row = firstDataLine(
    runControlPostgresSql(`
      SELECT array_to_string(permissions, ',') || '|' || include_descendants::text || '|' || coalesce(created_by, '')
        FROM gfs_shares
       WHERE drive = ${sqlLiteral(GFS_E2E_DRIVE)}
         AND resource_id = ${sqlLiteral(input.resourceId)}::uuid
         AND subject_type = ${sqlLiteral(input.subjectType)}
         AND subject_id = ${sqlLiteral(input.subjectId)}
       LIMIT 1;
    `)
  )
  if (!row) return null
  const [permissions, includeDescendants, createdBy] = splitSqlRow(row)
  return {
    permissions: (permissions ? permissions.split(',') : []) as GfsPermission[],
    includeDescendants: includeDescendants === 't' || includeDescendants === 'true',
    createdBy,
  }
}

export function getGfsChildResourceSummary(input: {
  parentResourceId: string
  name: string
}): GfsResourceSummary | null {
  if (!UUID_RE.test(input.parentResourceId)) {
    throw new Error(`invalid parent resource id: ${input.parentResourceId}`)
  }
  const row = firstDataLine(
    runControlPostgresSql(`
      SELECT resource_id::text || '|' || name || '|' || kind || '|' || bytes::text || '|' || version::text || '|' || (deleted_at IS NOT NULL)::text
        FROM gfs_resources
       WHERE drive = ${sqlLiteral(GFS_E2E_DRIVE)}
         AND parent_resource_id = ${sqlLiteral(input.parentResourceId)}::uuid
         AND name = ${sqlLiteral(input.name)}
       ORDER BY updated_at DESC
       LIMIT 1;
    `)
  )
  if (!row) return null
  const [resourceId, name, kind, bytes, version, deleted] = splitSqlRow(row)
  if (!UUID_RE.test(resourceId)) return null
  return {
    resourceId,
    name,
    kind: kind === 'directory' ? 'directory' : 'file',
    bytes: Number(bytes),
    version: Number(version),
    deleted: deleted === 't' || deleted === 'true',
  }
}

export function cleanupGfsFixture(name: string): void {
  assertFixtureName(name)
  const resourceIds = runControlPostgresSql(`
    SELECT resource_id::text
      FROM gfs_resources
     WHERE drive = ${sqlLiteral(GFS_E2E_DRIVE)}
       AND kind = 'file'
       AND (path_cache = ${sqlLiteral(`/${name}`)} OR path_cache LIKE ${sqlLiteral(`/${name}/%`)});
  `)
    .split('\n')
    .map(line => line.trim())
    .filter(line => UUID_RE.test(line))
  for (const resourceId of resourceIds) {
    cleanupGfsBlob(resourceId)
  }
  runControlPostgresSql(`
    WITH fixture_resources AS (
      SELECT resource_id
        FROM gfs_resources
       WHERE drive = ${sqlLiteral(GFS_E2E_DRIVE)}
         AND (path_cache = ${sqlLiteral(`/${name}`)} OR path_cache LIKE ${sqlLiteral(`/${name}/%`)})
    )
    DELETE FROM gfs_grants WHERE resource_id IN (SELECT resource_id FROM fixture_resources);

    WITH fixture_resources AS (
      SELECT resource_id
        FROM gfs_resources
       WHERE drive = ${sqlLiteral(GFS_E2E_DRIVE)}
         AND (path_cache = ${sqlLiteral(`/${name}`)} OR path_cache LIKE ${sqlLiteral(`/${name}/%`)})
    )
    DELETE FROM gfs_shares WHERE resource_id IN (SELECT resource_id FROM fixture_resources);

    UPDATE gfs_resources
       SET deleted_at = now(), updated_at = now()
     WHERE drive = ${sqlLiteral(GFS_E2E_DRIVE)}
       AND (path_cache = ${sqlLiteral(`/${name}`)} OR path_cache LIKE ${sqlLiteral(`/${name}/%`)});
  `)
}
