import { describe, expect, it } from 'vitest'
import {
  DbResolveStore,
  GfsUriError,
  parseGfsUri,
  ResolveDb,
  ResolvedResource,
  ResolveStore,
  resolveGfsUri,
} from '../src/gfs/resolve.js'

const RID = '8f3c2e1a4b5d4c6a9e7f1a2b3c4d5e6f'

describe('parseGfsUri', () => {
  it('identity form: a single 32-hex segment is ALWAYS the rid (no by-path)', () => {
    expect(parseGfsUri(`gfs://main/${RID}`)).toEqual({ drive: 'main', rid: RID, byPath: null })
  })

  it('human form: extracts the trailing rid but keeps the full by-path for fallback', () => {
    expect(parseGfsUri(`gfs://main/org/engineering/reports/q2-summary-${RID}`)).toEqual({
      drive: 'main',
      rid: RID,
      byPath: `/org/engineering/reports/q2-summary-${RID}`,
    })
  })

  it('pure by-path form: no trailing rid → rid null', () => {
    expect(parseGfsUri('gfs://main/org/eng')).toEqual({
      drive: 'main',
      rid: null,
      byPath: '/org/eng',
    })
  })

  it('rejects malformed URIs (not gfs://, missing drive/resource)', () => {
    expect(() => parseGfsUri('https://main/x')).toThrow(GfsUriError)
    expect(() => parseGfsUri('gfs://main')).toThrow(GfsUriError)
    expect(() => parseGfsUri('gfs://')).toThrow(GfsUriError)
    expect(() => parseGfsUri(42 as unknown as string)).toThrow(GfsUriError)
  })
})

function res(partial: Partial<ResolvedResource> & { resourceId: string }): ResolvedResource {
  return { drive: 'main', name: 'n', kind: 'directory', pathCache: null, ...partial }
}

class FakeStore implements ResolveStore {
  byRid = new Map<string, ResolvedResource>()
  byPath = new Map<string, ResolvedResource>()
  ridCalls = 0
  pathCalls = 0
  async getByRid(_drive: string, rid: string): Promise<ResolvedResource | null> {
    this.ridCalls++
    return this.byRid.get(rid) ?? null
  }
  async getByPath(_drive: string, path: string): Promise<ResolvedResource | null> {
    this.pathCalls++
    return this.byPath.get(path) ?? null
  }
}

describe('resolveGfsUri (rid always wins)', () => {
  it('returns the rid hit even when a by-path would also resolve', async () => {
    const store = new FakeStore()
    store.byRid.set(RID, res({ resourceId: 'by-rid' }))
    store.byPath.set(`/org/x-${RID}`, res({ resourceId: 'by-path' }))
    const out = await resolveGfsUri(store, `gfs://main/org/x-${RID}`)
    expect(out?.resourceId).toBe('by-rid')
    expect(store.pathCalls).toBe(0) // rid resolved, by-path never consulted
  })

  it('falls back to by-path when the parsed rid has no row', async () => {
    const store = new FakeStore()
    // No rid row; a file legitimately named with a trailing hex resolves by path.
    store.byPath.set(`/org/realfile-${RID}`, res({ resourceId: 'real-file' }))
    const out = await resolveGfsUri(store, `gfs://main/org/realfile-${RID}`)
    expect(out?.resourceId).toBe('real-file')
    expect(store.ridCalls).toBe(1) // tried rid first
  })

  it('resolves a pure by-path URI', async () => {
    const store = new FakeStore()
    store.byPath.set('/org/eng', res({ resourceId: 'eng-dir' }))
    const out = await resolveGfsUri(store, 'gfs://main/org/eng')
    expect(out?.resourceId).toBe('eng-dir')
    expect(store.ridCalls).toBe(0) // no rid candidate
  })

  it('returns null when nothing resolves (route maps to 404)', async () => {
    const store = new FakeStore()
    expect(await resolveGfsUri(store, `gfs://main/${RID}`)).toBeNull()
  })
})

class FakeDb implements ResolveDb {
  queries: { text: string; values?: unknown[] }[] = []
  responses: { rows: unknown[] }[] = []
  async query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }> {
    this.queries.push({ text, values })
    return this.responses.shift() ?? { rows: [] }
  }
}

const row = (resourceId: string, name = 'n', kind = 'directory') => ({
  resource_id: resourceId,
  drive: 'main',
  name,
  kind,
  path_cache: null,
})

describe('DbResolveStore', () => {
  it('getByRid does a uuid-keyed live lookup', async () => {
    const db = new FakeDb()
    db.responses = [{ rows: [row('r1')] }]
    const out = await new DbResolveStore(db).getByRid('main', RID)
    expect(out?.resourceId).toBe('r1')
    expect(db.queries[0].text).toContain('resource_id = $2::uuid')
    expect(db.queries[0].text).toContain('deleted_at IS NULL')
  })

  it('getByRid returns null when there is no live row', async () => {
    const db = new FakeDb()
    db.responses = [{ rows: [] }]
    expect(await new DbResolveStore(db).getByRid('main', RID)).toBeNull()
  })

  it('getByPath walks from the synthetic root, one hop per segment', async () => {
    const db = new FakeDb()
    db.responses = [
      { rows: [row('root')] }, // root (parent IS NULL)
      { rows: [row('org', 'org')] }, // /org
      { rows: [row('eng', 'eng')] }, // /org/eng
    ]
    const out = await new DbResolveStore(db).getByPath('main', '/org/eng')
    expect(out?.resourceId).toBe('eng')
    expect(db.queries[0].text).toContain('parent_resource_id IS NULL')
    expect(db.queries[1].values).toEqual(['main', 'root', 'org'])
  })

  it('getByPath returns null when a segment is missing', async () => {
    const db = new FakeDb()
    db.responses = [{ rows: [row('root')] }, { rows: [] }] // /org missing
    expect(await new DbResolveStore(db).getByPath('main', '/org/eng')).toBeNull()
  })

  it('getByPath of "/" returns the root itself', async () => {
    const db = new FakeDb()
    db.responses = [{ rows: [row('root')] }]
    const out = await new DbResolveStore(db).getByPath('main', '/')
    expect(out?.resourceId).toBe('root')
    expect(db.queries).toHaveLength(1)
  })
})
