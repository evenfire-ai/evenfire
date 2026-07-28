/**
 * Materializes a GlobalFileSystem's `layout.rootDirectories` as `gfs_resources`
 * rows. Control API owns this root bootstrap; governed runtime mutations are
 * applied by the GFSC writer. HCC triggers seeding after the drive reaches Ready.
 *
 * Drive-root model (operator decision): each drive has ONE synthetic root
 * resource (parentResourceId = null, name = '', kind = directory). Every
 * rootDirectory ('/org', '/system/published-workflow-artifacts') hangs off the
 * root, segment by segment, so the ancestor chain always terminates at the
 * synthetic root.
 *
 * Seeding is idempotent: re-running it creates nothing new (each ensureDirectory
 * is an upsert keyed by the sibling-uniqueness invariant). The pure walk here is
 * unit-testable against a fake store; the DB-backed store applies the upserts.
 */

export const GFS_ROOT_NAME = ''
const NAME_MAX = 255
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x1f\x7f]/

export class InvalidRootDirectoriesError extends Error {
  constructor() {
    super('invalid_rootDirectories')
    this.name = 'InvalidRootDirectoriesError'
  }
}

export interface SeedResourceStore {
  acquireStructureLock(drive: string): Promise<void>
  /**
   * Ensure a directory resource exists at (drive, parentResourceId, name) and
   * return its resourceId. parentResourceId is null ONLY for the synthetic
   * root. Idempotent: returns the existing row's id when already present.
   */
  ensureDirectory(input: {
    drive: string
    parentResourceId: string | null
    name: string
    pathCache: string
  }): Promise<string>
}

function normalizeSegments(path: string): string[] {
  if (path === '/') return []
  if (
    path.length === 0 ||
    !path.startsWith('/') ||
    path.endsWith('/') ||
    path.includes('//') ||
    path !== path.normalize('NFC')
  ) {
    throw new InvalidRootDirectoriesError()
  }
  const segments = path.slice(1).split('/')
  if (
    segments.some(
      segment =>
        segment.length === 0 ||
        segment.length > NAME_MAX ||
        segment === '.' ||
        segment === '..' ||
        CONTROL_CHARS.test(segment)
    )
  ) {
    throw new InvalidRootDirectoriesError()
  }
  return segments
}

/**
 * Ensure the synthetic root and every rootDirectory path exist. Returns the
 * resourceId of each leaf directory keyed by its input path (useful for tests
 * and callers that want to bind a Context/recipe to a seeded folder).
 */
export async function seedRootDirectories(
  store: SeedResourceStore,
  drive: string,
  rootDirectories: string[]
): Promise<{ rootResourceId: string; byPath: Record<string, string> }> {
  const normalizedPaths = rootDirectories.map(path => ({ path, segments: normalizeSegments(path) }))
  await store.acquireStructureLock(drive)
  const rootResourceId = await store.ensureDirectory({
    drive,
    parentResourceId: null,
    name: GFS_ROOT_NAME,
    pathCache: '/',
  })

  // Null-prototype lookup: the keys are caller-supplied paths, so removing the
  // prototype makes property injection structurally impossible instead of
  // resting on the leading-slash invariant alone (defence in depth, and it
  // clears CodeQL js/remote-property-injection). Serialization is unaffected —
  // JSON.stringify, Object.keys and spread all behave identically.
  const byPath: Record<string, string> = Object.create(null)
  for (const { path, segments } of normalizedPaths) {
    if (segments.length === 0) continue // '/' is the root itself, already ensured
    let parentResourceId = rootResourceId
    let accumulated = ''
    for (const segment of segments) {
      accumulated = `${accumulated}/${segment}`
      parentResourceId = await store.ensureDirectory({
        drive,
        parentResourceId,
        name: segment,
        pathCache: accumulated,
      })
    }
    byPath[path] = parentResourceId
  }

  return { rootResourceId, byPath }
}

/** Minimal query surface — a pg client/pool satisfies this; tests inject a fake. */
export interface SeedDb {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>
}

/**
 * DB-backed seed store. ensureDirectory is idempotent via INSERT ... ON CONFLICT
 * DO NOTHING against the matching partial unique index, falling back to a SELECT
 * of the existing row. The synthetic root (parent IS NULL) uses the root index;
 * every other directory uses the sibling index.
 */
export class DbSeedResourceStore implements SeedResourceStore {
  constructor(private readonly db: SeedDb) {}

  async acquireStructureLock(drive: string): Promise<void> {
    await this.db.query(
      `SELECT pg_advisory_xact_lock(hashtext('gfs:structure:' || $1)::bigint)`,
      [drive]
    )
  }

  async ensureDirectory(input: {
    drive: string
    parentResourceId: string | null
    name: string
    pathCache: string
  }): Promise<string> {
    const { drive, parentResourceId, name, pathCache } = input

    if (parentResourceId === null) {
      const locked = await this.db.query(
        `SELECT resource_id, drive, parent_resource_id, name, kind, path_cache, deleted_at
           FROM gfs_resources
          WHERE drive = $1 AND parent_resource_id IS NULL AND deleted_at IS NULL
          ORDER BY resource_id FOR UPDATE`,
        [drive]
      )
      if (locked.rows.length > 0) {
        const root = directoryRowOf(locked.rows[0])
        if (root.name !== GFS_ROOT_NAME || root.kind !== 'directory' || root.path_cache !== '/') {
          throw new Error('[gfs] seed: existing drive root is not canonical')
        }
        return root.resource_id
      }
      const inserted = await this.db.query(
        `INSERT INTO gfs_resources (drive, parent_resource_id, name, kind, path_cache)
         VALUES ($1, NULL, $2, 'directory', $3)
         ON CONFLICT (drive) WHERE parent_resource_id IS NULL AND deleted_at IS NULL DO NOTHING
         RETURNING resource_id`,
        [drive, name, pathCache]
      )
      if (inserted.rows.length > 0) return resourceIdOf(inserted.rows[0])
      const existing = await this.db.query(
        `SELECT resource_id, name, kind, path_cache FROM gfs_resources
         WHERE drive = $1 AND parent_resource_id IS NULL AND deleted_at IS NULL FOR UPDATE`,
        [drive]
      )
      const root = directoryRowOf(existing.rows[0])
      if (root.name !== GFS_ROOT_NAME || root.kind !== 'directory' || root.path_cache !== '/') {
        throw new Error('[gfs] seed: existing drive root is not canonical')
      }
      return root.resource_id
    }

    const observedChain = await this.loadDirectoryChain(parentResourceId)
    const observedPath = canonicalDirectoryPath(observedChain, drive)
    const locked = await this.db.query(
      `SELECT resource_id, drive, parent_resource_id, name, kind, path_cache, deleted_at
         FROM gfs_resources
        WHERE resource_id = ANY($1::uuid[])
           OR (drive = $2 AND parent_resource_id = $3::uuid AND name = $4 AND deleted_at IS NULL)
        ORDER BY resource_id FOR UPDATE`,
      [observedChain.map(row => row.resource_id).sort(), drive, parentResourceId, name]
    )
    const chain = await this.loadDirectoryChain(parentResourceId)
    const canonicalParentPath = canonicalDirectoryPath(chain, drive)
    if (canonicalParentPath !== observedPath) {
      throw new Error('[gfs] seed: parent changed while acquiring row locks')
    }
    const expectedPath = canonicalParentPath === '/' ? `/${name}` : `${canonicalParentPath}/${name}`
    if (pathCache !== expectedPath) {
      throw new Error('[gfs] seed: requested path does not match the canonical parent tree')
    }
    const sibling = locked.rows
      .map(directoryRowOf)
      .find(row => row.parent_resource_id === parentResourceId && row.name === name)
    if (sibling) {
      if (sibling.kind !== 'directory' || sibling.path_cache !== expectedPath) {
        throw new Error('[gfs] seed: existing directory is not canonical')
      }
      return sibling.resource_id
    }

    const inserted = await this.db.query(
      `INSERT INTO gfs_resources (drive, parent_resource_id, name, kind, path_cache)
       VALUES ($1, $2, $3, 'directory', $4)
       ON CONFLICT (drive, parent_resource_id, name) WHERE deleted_at IS NULL DO NOTHING
       RETURNING resource_id`,
      [drive, parentResourceId, name, pathCache]
    )
    if (inserted.rows.length > 0) return resourceIdOf(inserted.rows[0])
    const existing = await this.db.query(
      `SELECT resource_id, drive, parent_resource_id, name, kind, path_cache, deleted_at
       FROM gfs_resources
       WHERE drive = $1 AND parent_resource_id = $2 AND name = $3 AND deleted_at IS NULL`,
      [drive, parentResourceId, name]
    )
    const racedSibling = directoryRowOf(existing.rows[0])
    if (racedSibling.kind !== 'directory' || racedSibling.path_cache !== expectedPath) {
      throw new Error('[gfs] seed: concurrently inserted directory is not canonical')
    }
    return racedSibling.resource_id
  }

  private async loadDirectoryChain(resourceId: string): Promise<DirectoryChainRow[]> {
    const result = await this.db.query(
      `WITH RECURSIVE chain AS (
         SELECT r.resource_id, r.drive, r.parent_resource_id, r.name, r.kind, r.path_cache,
                r.deleted_at, ARRAY[r.resource_id]::uuid[] visited, false cycle
           FROM gfs_resources r WHERE r.resource_id = $1::uuid
         UNION ALL
         SELECT p.resource_id, p.drive, p.parent_resource_id, p.name, p.kind, p.path_cache,
                p.deleted_at, c.visited || p.resource_id, p.resource_id = ANY(c.visited)
           FROM chain c JOIN gfs_resources p ON p.resource_id = c.parent_resource_id
          WHERE NOT c.cycle
       ) SELECT resource_id, drive, parent_resource_id, name, kind, path_cache, deleted_at, cycle
           FROM chain`,
      [resourceId]
    )
    return result.rows as DirectoryChainRow[]
  }
}

interface DirectoryChainRow {
  resource_id: string
  drive: string
  parent_resource_id: string | null
  name: string
  kind: string
  path_cache: string | null
  deleted_at: string | null
  cycle?: boolean
}

function directoryRowOf(row: unknown): DirectoryChainRow {
  const value = row as DirectoryChainRow | undefined
  if (!value || typeof value.resource_id !== 'string') {
    throw new Error('[gfs] seed: expected a resource_id row but got none')
  }
  return value
}

function canonicalDirectoryPath(rows: DirectoryChainRow[], drive: string): string {
  if (
    rows.length === 0 ||
    rows.some(row => row.cycle || row.deleted_at !== null || row.drive !== drive || row.kind !== 'directory') ||
    rows.at(-1)?.parent_resource_id !== null ||
    rows.at(-1)?.name !== GFS_ROOT_NAME
  ) {
    throw new Error('[gfs] seed: parent ancestry is not a live same-drive directory chain')
  }
  const segments = rows
    .slice(0, -1)
    .map(row => row.name)
    .reverse()
  return segments.length === 0 ? '/' : `/${segments.join('/')}`
}

function resourceIdOf(row: unknown): string {
  const id = (row as { resource_id?: unknown } | undefined)?.resource_id
  if (typeof id !== 'string') {
    throw new Error('[gfs] seed: expected a resource_id row but got none')
  }
  return id
}
