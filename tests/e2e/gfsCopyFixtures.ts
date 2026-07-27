import { seedGfsBlobWithKubectlCp } from './gfsBlobFixtureWriter'
import {
  GFS_E2E_DRIVE,
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
import { cleanupGfsFixture } from './gfsResourceFixtures'

export interface GfsCopyTreeFixture {
  sourceName: string
  destinationName: string
  sourceResourceId: string
  destinationResourceId: string
  standaloneFileName: string
  standaloneFileResourceId: string
  sourceUri: string
  destinationUri: string
}

export interface GfsTreeSnapshotNode {
  relativePath: string
  resourceId: string
  parentResourceId: string | null
  name: string
  kind: 'file' | 'directory'
  bytes: number
  version: number
  content: string | null
}

export interface GfsHostGrantRow {
  resourceId: string
  permissions: string[]
  inherit: boolean
}

export function cleanupGfsCopyTreeFixture(fixture: GfsCopyTreeFixture): void {
  const failures: string[] = []
  for (const name of [fixture.sourceName, fixture.destinationName]) {
    try {
      cleanupGfsFixture(name)
    } catch (error) {
      failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (failures.length > 0) throw new Error(`GFS Copy fixture cleanup failed: ${failures.join('; ')}`)
}

function driveRoot(): string {
  const row = firstDataLine(
    runControlPostgresSql(`
      INSERT INTO gfs_resources (drive, parent_resource_id, name, kind, path_cache)
      VALUES (${sqlLiteral(GFS_E2E_DRIVE)}, NULL, '', 'directory', '/')
      ON CONFLICT (drive) WHERE parent_resource_id IS NULL AND deleted_at IS NULL
      DO UPDATE SET updated_at = gfs_resources.updated_at
      RETURNING resource_id::text;
    `)
  )
  if (!UUID_RE.test(row)) throw new Error(`failed to resolve GFS drive root: ${row}`)
  return row
}

function insertResource(input: {
  parentId: string
  name: string
  kind: 'file' | 'directory'
  path: string
  content?: Buffer
}): string {
  const content = input.content ?? Buffer.alloc(0)
  const row = firstDataLine(
    runControlPostgresSql(`
      INSERT INTO gfs_resources (drive, parent_resource_id, name, kind, path_cache, bytes)
      VALUES (
        ${sqlLiteral(GFS_E2E_DRIVE)}, ${sqlLiteral(input.parentId)}::uuid,
        ${sqlLiteral(input.name)}, ${sqlLiteral(input.kind)}, ${sqlLiteral(input.path)},
        ${input.kind === 'file' ? content.byteLength : 0}
      ) RETURNING resource_id::text;
    `)
  )
  if (!UUID_RE.test(row)) throw new Error(`failed to seed GFS resource ${input.path}: ${row}`)
  if (input.kind === 'file') {
    seedGfsBlobWithKubectlCp({
      context: kubectlContext(),
      writerPod: gfsWriterPod(),
      blobKey: ridOf(row),
      content,
      timeoutMs: 20_000,
    })
  }
  return row
}

/** Named precondition only: Copy and Rename are always performed by the agent. */
export function seedGfsCopyTreeFixture(name: string): GfsCopyTreeFixture {
  assertFixtureName(name)
  const sourceName = `${name}-source`
  const destinationName = `${name}-destination`
  const standaloneFileName = 'standalone.txt'
  const seeded: string[] = []
  try {
    const rootId = driveRoot()
    const sourceResourceId = insertResource({
      parentId: rootId,
      name: sourceName,
      kind: 'directory',
      path: `/${sourceName}`,
    })
    seeded.push(sourceName)
    const destinationResourceId = insertResource({
      parentId: rootId,
      name: destinationName,
      kind: 'directory',
      path: `/${destinationName}`,
    })
    seeded.push(destinationName)
    const standaloneFileResourceId = insertResource({
      parentId: sourceResourceId,
      name: standaloneFileName,
      kind: 'file',
      path: `/${sourceName}/${standaloneFileName}`,
      content: Buffer.from(`issue-797 standalone ${name}\n`, 'utf8'),
    })
    const nestedId = insertResource({
      parentId: sourceResourceId,
      name: 'nested',
      kind: 'directory',
      path: `/${sourceName}/nested`,
    })
    insertResource({
      parentId: nestedId,
      name: 'empty',
      kind: 'directory',
      path: `/${sourceName}/nested/empty`,
    })
    insertResource({
      parentId: nestedId,
      name: 'alpha.txt',
      kind: 'file',
      path: `/${sourceName}/nested/alpha.txt`,
      content: Buffer.from(`issue-797 alpha ${name}\n`, 'utf8'),
    })
    const deeperId = insertResource({
      parentId: nestedId,
      name: 'deeper',
      kind: 'directory',
      path: `/${sourceName}/nested/deeper`,
    })
    insertResource({
      parentId: deeperId,
      name: 'beta.txt',
      kind: 'file',
      path: `/${sourceName}/nested/deeper/beta.txt`,
      content: Buffer.from(`issue-797 beta ${name}\n`, 'utf8'),
    })
    return {
      sourceName,
      destinationName,
      sourceResourceId,
      destinationResourceId,
      standaloneFileName,
      standaloneFileResourceId,
      sourceUri: `gfs://${GFS_E2E_DRIVE}/${ridOf(sourceResourceId)}`,
      destinationUri: `gfs://${GFS_E2E_DRIVE}/${ridOf(destinationResourceId)}`,
    }
  } catch (error) {
    const teardownFailures: string[] = []
    for (const fixtureName of seeded.reverse()) {
      try {
        cleanupGfsFixture(fixtureName)
      } catch (cleanupError) {
        teardownFailures.push(
          `${fixtureName}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`
        )
      }
    }
    if (teardownFailures.length > 0) {
      throw new Error(
        `GFS copy-tree seeding failed (${error instanceof Error ? error.message : String(error)}) ` +
          `AND teardown of partial state failed: ${teardownFailures.join('; ')}`
      )
    }
    throw error
  }
}

function readContent(resourceId: string, blobKey: string | null): string {
  const path = blobKey
    ? (() => {
        if (!/^[0-9a-f]{32}\/[0-9a-f-]{36}$/i.test(blobKey)) {
          throw new Error(`invalid GFS generation key in snapshot: ${blobKey}`)
        }
        return `/data/gfs/.generations/${blobKey}`
      })()
    : `/data/gfs/${ridOf(resourceId)}`
  return kubectlOut(['-n', 'gfs', 'exec', gfsWriterPod(), '--', 'cat', path], 20_000)
}

export function getGfsTreeSnapshot(rootId: string): GfsTreeSnapshotNode[] {
  if (!UUID_RE.test(rootId)) throw new Error(`invalid GFS root id: ${rootId}`)
  const rows = runControlPostgresSql(`
    WITH RECURSIVE tree AS (
      SELECT resource_id, parent_resource_id, name, kind, bytes, version, blob_key,
             '.'::text AS relative_path
        FROM gfs_resources
       WHERE drive = ${sqlLiteral(GFS_E2E_DRIVE)}
         AND resource_id = ${sqlLiteral(rootId)}::uuid AND deleted_at IS NULL
      UNION ALL
      SELECT child.resource_id, child.parent_resource_id, child.name, child.kind,
             child.bytes, child.version, child.blob_key, tree.relative_path || '/' || child.name
        FROM gfs_resources child JOIN tree ON child.parent_resource_id = tree.resource_id
       WHERE child.drive = ${sqlLiteral(GFS_E2E_DRIVE)} AND child.deleted_at IS NULL
    )
    SELECT relative_path || '|' || resource_id::text || '|' ||
           coalesce(parent_resource_id::text, '') || '|' || name || '|' || kind || '|' ||
           bytes::text || '|' || version::text || '|' || coalesce(blob_key, '')
      FROM tree ORDER BY relative_path;
  `)
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)

  return rows.map(row => {
    const parts = splitSqlRow(row)
    if (parts.length !== 8) throw new Error(`invalid GFS snapshot row shape: ${row}`)
    const [relativePath, resourceId, parentId, name, kind, bytes, version, blobKey] = parts as [
      string,
      string,
      string,
      string,
      string,
      string,
      string,
      string,
    ]
    if (!UUID_RE.test(resourceId) || (parentId && !UUID_RE.test(parentId))) {
      throw new Error(`invalid GFS snapshot row: ${row}`)
    }
    const normalizedKind = kind === 'directory' ? 'directory' : 'file'
    return {
      relativePath,
      resourceId,
      parentResourceId: parentId || null,
      name,
      kind: normalizedKind,
      bytes: Number(bytes),
      version: Number(version),
      content: normalizedKind === 'file' ? readContent(resourceId, blobKey || null) : null,
    }
  })
}

export function getGfsTreeAclShareCounts(rootId: string): { grants: number; shares: number } {
  if (!UUID_RE.test(rootId)) throw new Error(`invalid GFS root id: ${rootId}`)
  const row = firstDataLine(
    runControlPostgresSql(`
      WITH RECURSIVE tree AS (
        SELECT resource_id FROM gfs_resources
         WHERE drive = ${sqlLiteral(GFS_E2E_DRIVE)}
           AND resource_id = ${sqlLiteral(rootId)}::uuid AND deleted_at IS NULL
        UNION ALL
        SELECT child.resource_id FROM gfs_resources child
          JOIN tree ON child.parent_resource_id = tree.resource_id
         WHERE child.drive = ${sqlLiteral(GFS_E2E_DRIVE)} AND child.deleted_at IS NULL
      )
      SELECT (SELECT count(*) FROM gfs_grants WHERE resource_id IN (SELECT resource_id FROM tree))::text || '|' ||
             (SELECT count(*) FROM gfs_shares WHERE resource_id IN (SELECT resource_id FROM tree))::text;
    `)
  )
  const parts = splitSqlRow(row)
  if (parts.length !== 2) throw new Error(`invalid GFS ACL/share count row: ${row}`)
  const [grants, shares] = parts as [string, string]
  return { grants: Number(grants), shares: Number(shares) }
}

export function getGfsHostGrantsUnderTree(rootId: string, subjectId: string): GfsHostGrantRow[] {
  if (!UUID_RE.test(rootId) || !/^1st:[a-z0-9-]+\/[a-z0-9-]+$/.test(subjectId)) {
    throw new Error('invalid GFS host-grant tree query')
  }
  return runControlPostgresSql(`
    WITH RECURSIVE tree AS (
      SELECT resource_id FROM gfs_resources
       WHERE drive = ${sqlLiteral(GFS_E2E_DRIVE)}
         AND resource_id = ${sqlLiteral(rootId)}::uuid AND deleted_at IS NULL
      UNION ALL
      SELECT child.resource_id FROM gfs_resources child
        JOIN tree ON child.parent_resource_id = tree.resource_id
       WHERE child.drive = ${sqlLiteral(GFS_E2E_DRIVE)} AND child.deleted_at IS NULL
    )
    SELECT resource_id::text || '|' || array_to_string(permissions, ',') || '|' || inherit::text
      FROM gfs_grants WHERE resource_id IN (SELECT resource_id FROM tree)
       AND subject_type = 'host' AND subject_id = ${sqlLiteral(subjectId)} ORDER BY resource_id;
  `).split('\n').map(line => line.trim()).filter(Boolean).map(row => {
    const parts = splitSqlRow(row)
    if (parts.length !== 3 || !UUID_RE.test(parts[0] ?? '')) throw new Error(`invalid host grant row: ${row}`)
    return {
      resourceId: parts[0]!,
      permissions: parts[1] ? parts[1].split(',') : [],
      inherit: parts[2] === 't' || parts[2] === 'true',
    }
  })
}
