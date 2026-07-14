/**
 * Materializes a GlobalFileSystem's `layout.rootDirectories` as `gfs_resources`
 * rows. The governance plane (control-api) is the ONLY writer of resource rows
 * (CC6); HCC's gfsReconciler triggers this after the drive reaches Ready.
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

export interface SeedResourceStore {
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
  // rootDirectories are absolute ('/org', '/system/published-workflow-artifacts').
  return path.split('/').filter(segment => segment.length > 0)
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
  const rootResourceId = await store.ensureDirectory({
    drive,
    parentResourceId: null,
    name: GFS_ROOT_NAME,
    pathCache: '/',
  })

  const byPath: Record<string, string> = {}
  for (const path of rootDirectories) {
    const segments = normalizeSegments(path)
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

  async ensureDirectory(input: {
    drive: string
    parentResourceId: string | null
    name: string
    pathCache: string
  }): Promise<string> {
    const { drive, parentResourceId, name, pathCache } = input

    if (parentResourceId === null) {
      const inserted = await this.db.query(
        `INSERT INTO gfs_resources (drive, parent_resource_id, name, kind, path_cache)
         VALUES ($1, NULL, $2, 'directory', $3)
         ON CONFLICT (drive) WHERE parent_resource_id IS NULL AND deleted_at IS NULL DO NOTHING
         RETURNING resource_id`,
        [drive, name, pathCache]
      )
      if (inserted.rows.length > 0) return resourceIdOf(inserted.rows[0])
      const existing = await this.db.query(
        `SELECT resource_id FROM gfs_resources
         WHERE drive = $1 AND parent_resource_id IS NULL AND deleted_at IS NULL`,
        [drive]
      )
      return resourceIdOf(existing.rows[0])
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
      `SELECT resource_id FROM gfs_resources
       WHERE drive = $1 AND parent_resource_id = $2 AND name = $3 AND deleted_at IS NULL`,
      [drive, parentResourceId, name]
    )
    return resourceIdOf(existing.rows[0])
  }
}

function resourceIdOf(row: unknown): string {
  const id = (row as { resource_id?: unknown } | undefined)?.resource_id
  if (typeof id !== 'string') {
    throw new Error('[gfs] seed: expected a resource_id row but got none')
  }
  return id
}
