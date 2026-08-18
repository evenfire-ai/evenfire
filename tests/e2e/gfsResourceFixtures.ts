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

function normalizedGenerationBlobKey(resourceId: string, blobKey: string): string {
  const match =
    /^([0-9a-f]{32})\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(
      blobKey
    )
  if (!match) throw new Error(`refusing to clean invalid GFS generation key: ${blobKey}`)
  const ownerRid = match[1]!.toLowerCase()
  const expectedRid = ridOf(resourceId)
  if (ownerRid !== expectedRid) {
    throw new Error(`GFS generation key ${blobKey} does not belong to resource ${resourceId}`)
  }
  return `${ownerRid}/${match[2]!.toLowerCase()}`
}

function cleanupGfsBlob(resourceId: string, blobKey?: string | null): void {
  const physicalPath = blobKey
    ? `/data/gfs/.generations/${normalizedGenerationBlobKey(resourceId, blobKey)}`
    : `/data/gfs/${ridOf(resourceId)}`
  kubectlOut(['-n', 'gfs', 'exec', gfsWriterPod(), '--', 'rm', '-f', physicalPath], 20_000)
}

function cleanupGfsGenerationDirectory(resourceId: string): void {
  const directory = `/data/gfs/.generations/${ridOf(resourceId)}`
  kubectlOut(
    [
      '-n',
      'gfs',
      'exec',
      gfsWriterPod(),
      '--',
      'sh',
      '-c',
      `rmdir ${directory} 2>/dev/null || true`,
    ],
    20_000
  )
}

interface GfsFixtureBlobInventoryRow {
  resourceId: string
  currentBlobKey: string | null
  manifestBlobKey: string | null
  manifestKind: 'generation' | 'legacy_flat' | null
  manifestState: 'deleting' | null
}

function fixtureBlobInventory(name: string): GfsFixtureBlobInventoryRow[] {
  const output = runControlPostgresSql(`
    SELECT resource.resource_id::text,
           coalesce(resource.blob_key, ''),
           coalesce(manifest.blob_key, ''),
           coalesce(manifest.candidate_kind, ''),
           coalesce(manifest.state, '')
      FROM gfs_resources AS resource
      LEFT JOIN gfs_blob_manifests AS manifest
        ON manifest.resource_id = resource.resource_id
     WHERE resource.drive = ${sqlLiteral(GFS_E2E_DRIVE)}
       AND resource.kind = 'file'
       AND (
         resource.path_cache = ${sqlLiteral(`/${name}`)}
         OR resource.path_cache LIKE ${sqlLiteral(`/${name}/%`)}
       )
     ORDER BY resource.resource_id, manifest.blob_key;
  `)
  return output
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const parts = splitSqlRow(line)
      if (parts.length !== 5 || !UUID_RE.test(parts[0] ?? '')) {
        throw new Error(`invalid GFS fixture blob inventory row: ${line}`)
      }
      const [resourceId, rawCurrent = '', rawManifest = '', rawKind = '', rawState = ''] = parts
      const currentBlobKey = rawCurrent ? normalizedGenerationBlobKey(resourceId, rawCurrent) : null
      let manifestBlobKey: string | null = null
      let manifestKind: GfsFixtureBlobInventoryRow['manifestKind'] = null
      let manifestState: GfsFixtureBlobInventoryRow['manifestState'] = null
      if (rawManifest || rawKind || rawState) {
        if (
          !rawManifest ||
          (rawKind !== 'generation' && rawKind !== 'legacy_flat') ||
          rawState !== 'deleting'
        ) {
          throw new Error(`invalid GFS fixture blob manifest row: ${line}`)
        }
        manifestKind = rawKind
        manifestState = rawState
        if (manifestKind === 'generation') {
          manifestBlobKey = normalizedGenerationBlobKey(resourceId, rawManifest)
        } else {
          const expectedLegacyKey = ridOf(resourceId)
          if (rawManifest.toLowerCase() !== expectedLegacyKey) {
            throw new Error(
              `GFS legacy blob key ${rawManifest} does not belong to resource ${resourceId}`
            )
          }
          manifestBlobKey = expectedLegacyKey
        }
      }
      return { resourceId, currentBlobKey, manifestBlobKey, manifestKind, manifestState }
    })
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
  try {
    seedGfsBlob(fileResourceId, fileContent)
  } catch (error) {
    try {
      cleanupGfsFixture(name)
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `failed to seed and roll back GFS file fixture ${name}`
      )
    }
    throw error
  }
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
}): string {
  const subjectId = input.subjectType === 'operator' ? '' : (input.subjectId ?? '')
  if (input.subjectType !== 'operator' && subjectId.length === 0) {
    throw new Error(`subjectId is required for ${input.subjectType} GFS grants`)
  }
  const permissions = `ARRAY[${input.permissions.map(sqlLiteral).join(', ')}]::text[]`
  const grantId = firstDataLine(
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
      updated_at = now()
    RETURNING id::text;
  `)
  )
  if (!UUID_RE.test(grantId)) throw new Error(`failed to seed GFS grant: ${grantId}`)
  return grantId
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

/**
 * Count LIVE (non-tombstoned) direct children of a parent that carry an exact
 * name. Used to prove a rejected copy left the existing child intact. The
 * partial unique index gfs_resources_sibling_uniq (control-api/src/db.ts) makes
 * two LIVE same-name siblings physically impossible, so this returns 0 or 1;
 * its value over getGfsChildResourceSummary is the deleted_at filter — that
 * helper does not exclude tombstones and would still return non-null after a
 * destructive delete, whereas `count === 1` proves a live row still exists.
 */
export function countGfsLiveChildrenByName(input: {
  parentResourceId: string
  name: string
}): number {
  if (!UUID_RE.test(input.parentResourceId)) {
    throw new Error(`invalid parent resource id: ${input.parentResourceId}`)
  }
  const row = firstDataLine(
    runControlPostgresSql(`
      SELECT count(*)::text
        FROM gfs_resources
       WHERE drive = ${sqlLiteral(GFS_E2E_DRIVE)}
         AND parent_resource_id = ${sqlLiteral(input.parentResourceId)}::uuid
         AND name = ${sqlLiteral(input.name)}
         AND deleted_at IS NULL;
    `)
  )
  if (!row) throw new Error('count query returned no row')
  const count = Number(row.trim())
  if (!Number.isInteger(count)) throw new Error(`unexpected count result: ${row}`)
  return count
}

export function cleanupGfsFixture(name: string): void {
  assertFixtureName(name)
  const inventory = fixtureBlobInventory(name)
  const blobTargets = new Map<string, { resourceId: string; blobKey: string | null }>()
  const deletingManifestKeys = new Set<string>()
  const resourceIds = new Set<string>()
  for (const row of inventory) {
    resourceIds.add(row.resourceId)
    // A fixture may start as a directly seeded legacy-flat blob and later
    // publish an immutable generation. Once blob_key points at the generation,
    // the original flat bytes are no longer visible through GFS but remain
    // protected by the production cleanup safety window. The fixture owns both
    // exact paths and must remove both instead of lowering that safety window.
    blobTargets.set(`${row.resourceId}|legacy_flat`, {
      resourceId: row.resourceId,
      blobKey: null,
    })
    if (row.currentBlobKey) {
      blobTargets.set(`${row.resourceId}|${row.currentBlobKey}`, {
        resourceId: row.resourceId,
        blobKey: row.currentBlobKey,
      })
    }
    if (row.manifestKind === 'generation' && row.manifestBlobKey) {
      blobTargets.set(`${row.resourceId}|${row.manifestBlobKey}`, {
        resourceId: row.resourceId,
        blobKey: row.manifestBlobKey,
      })
    }
    if (row.manifestState === 'deleting' && row.manifestBlobKey) {
      deletingManifestKeys.add(row.manifestBlobKey)
    }
  }
  const cleanupErrors: unknown[] = []
  for (const { resourceId, blobKey } of blobTargets.values()) {
    try {
      cleanupGfsBlob(resourceId, blobKey || null)
    } catch (error) {
      cleanupErrors.push(error)
    }
  }
  for (const resourceId of resourceIds) {
    try {
      cleanupGfsGenerationDirectory(resourceId)
    } catch (error) {
      cleanupErrors.push(error)
    }
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, `failed to fully clean GFS fixture ${name}`)
  }
  try {
    const manifestKeys = [...deletingManifestKeys]
    const manifestCleanup = manifestKeys.length
      ? `DELETE FROM gfs_blob_manifests
           WHERE state = 'deleting'
             AND blob_key IN (${manifestKeys.map(sqlLiteral).join(', ')});`
      : ''
    runControlPostgresSql(`
      BEGIN;

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

      ${manifestCleanup}

      UPDATE gfs_resources
         SET deleted_at = now(), updated_at = now()
       WHERE drive = ${sqlLiteral(GFS_E2E_DRIVE)}
         AND (path_cache = ${sqlLiteral(`/${name}`)} OR path_cache LIKE ${sqlLiteral(`/${name}/%`)});

      COMMIT;
    `)
  } catch (error) {
    cleanupErrors.push(error)
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, `failed to fully clean GFS fixture ${name}`)
  }
}
