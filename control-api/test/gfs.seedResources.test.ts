import { describe, expect, it } from 'vitest'
import {
  DbSeedResourceStore,
  SeedDb,
  SeedResourceStore,
  seedRootDirectories,
} from '../src/gfs/seedResources.js'

interface Row {
  drive: string
  parentResourceId: string | null
  name: string
  pathCache: string
}

class FakeStore implements SeedResourceStore {
  rows = new Map<string, { id: string; row: Row }>()
  private seq = 0

  private key(drive: string, parent: string | null, name: string): string {
    return `${drive}|${parent ?? 'ROOT'}|${name}`
  }

  async ensureDirectory(input: Row): Promise<string> {
    const k = this.key(input.drive, input.parentResourceId, input.name)
    const existing = this.rows.get(k)
    if (existing) return existing.id // idempotent
    const id = `res-${++this.seq}`
    this.rows.set(k, { id, row: input })
    return id
  }
}

describe('seedRootDirectories (synthetic root model)', () => {
  it('creates exactly one synthetic root (parent=null, name="")', async () => {
    const store = new FakeStore()
    const { rootResourceId } = await seedRootDirectories(store, 'main', ['/org'])
    const roots = [...store.rows.values()].filter(r => r.row.parentResourceId === null)
    expect(roots).toHaveLength(1)
    expect(roots[0].row.name).toBe('')
    expect(roots[0].row.pathCache).toBe('/')
    expect(roots[0].id).toBe(rootResourceId)
  })

  it('hangs a single-segment rootDirectory off the root with the right path_cache', async () => {
    const store = new FakeStore()
    const { rootResourceId, byPath } = await seedRootDirectories(store, 'main', ['/org'])
    const org = [...store.rows.values()].find(r => r.row.name === 'org')!
    expect(org.row.parentResourceId).toBe(rootResourceId)
    expect(org.row.pathCache).toBe('/org')
    expect(byPath['/org']).toBe(org.id)
  })

  it('chains a multi-segment path, each parent linking to the previous', async () => {
    const store = new FakeStore()
    await seedRootDirectories(store, 'main', ['/system/published-workflow-artifacts'])
    const system = [...store.rows.values()].find(r => r.row.name === 'system')!
    const leaf = [...store.rows.values()].find(r => r.row.name === 'published-workflow-artifacts')!
    expect(leaf.row.parentResourceId).toBe(system.id)
    expect(leaf.row.pathCache).toBe('/system/published-workflow-artifacts')
    expect(system.row.pathCache).toBe('/system')
  })

  it('is idempotent — a second seed creates nothing new and returns the same ids', async () => {
    const store = new FakeStore()
    const first = await seedRootDirectories(store, 'main', ['/org', '/system/x'])
    const countAfterFirst = store.rows.size
    const second = await seedRootDirectories(store, 'main', ['/org', '/system/x'])
    expect(store.rows.size).toBe(countAfterFirst)
    expect(second.rootResourceId).toBe(first.rootResourceId)
    expect(second.byPath).toEqual(first.byPath)
  })

  it('treats "/" as the root itself (no extra resource)', async () => {
    const store = new FakeStore()
    await seedRootDirectories(store, 'main', ['/'])
    expect(store.rows.size).toBe(1) // only the root
  })

  it('reuses an already-seeded intermediate directory across sibling paths', async () => {
    const store = new FakeStore()
    await seedRootDirectories(store, 'main', ['/org/a', '/org/b'])
    const orgs = [...store.rows.values()].filter(r => r.row.name === 'org')
    expect(orgs).toHaveLength(1) // /org shared by both leaves
  })
})

class FakeDb implements SeedDb {
  queries: { text: string; values?: unknown[] }[] = []
  responses: { rows: unknown[] }[] = []
  async query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }> {
    this.queries.push({ text, values })
    return this.responses.shift() ?? { rows: [] }
  }
}

describe('DbSeedResourceStore.ensureDirectory (idempotent upsert)', () => {
  it('inserts the synthetic root with the root conflict target and returns its id', async () => {
    const db = new FakeDb()
    db.responses = [{ rows: [{ resource_id: 'root-1' }] }]
    const id = await new DbSeedResourceStore(db).ensureDirectory({
      drive: 'main',
      parentResourceId: null,
      name: '',
      pathCache: '/',
    })
    expect(id).toBe('root-1')
    expect(db.queries[0].text).toContain('ON CONFLICT (drive) WHERE parent_resource_id IS NULL')
    expect(db.queries[0].text).toContain('DO NOTHING')
  })

  it('falls back to SELECT when the root already exists (insert returns no row)', async () => {
    const db = new FakeDb()
    db.responses = [{ rows: [] }, { rows: [{ resource_id: 'root-existing' }] }]
    const id = await new DbSeedResourceStore(db).ensureDirectory({
      drive: 'main',
      parentResourceId: null,
      name: '',
      pathCache: '/',
    })
    expect(id).toBe('root-existing')
    expect(db.queries).toHaveLength(2)
    expect(db.queries[1].text).toContain('SELECT resource_id')
  })

  it('inserts a sub-directory with the sibling conflict target', async () => {
    const db = new FakeDb()
    db.responses = [{ rows: [{ resource_id: 'org-1' }] }]
    const id = await new DbSeedResourceStore(db).ensureDirectory({
      drive: 'main',
      parentResourceId: 'root-1',
      name: 'org',
      pathCache: '/org',
    })
    expect(id).toBe('org-1')
    expect(db.queries[0].text).toContain('ON CONFLICT (drive, parent_resource_id, name)')
    expect(db.queries[0].values).toEqual(['main', 'root-1', 'org', '/org'])
  })

  it('fails loud if neither insert nor select yields a row (no silent empty id)', async () => {
    const db = new FakeDb()
    db.responses = [{ rows: [] }, { rows: [] }]
    await expect(
      new DbSeedResourceStore(db).ensureDirectory({
        drive: 'main',
        parentResourceId: 'root-1',
        name: 'org',
        pathCache: '/org',
      })
    ).rejects.toThrow(/expected a resource_id/)
  })
})
