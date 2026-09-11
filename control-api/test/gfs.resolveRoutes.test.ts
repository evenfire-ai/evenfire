import { describe, expect, it } from 'vitest'
import { ResolveStore, ResolvedResource } from '../src/gfs/resolve.js'
import { byPathToHttp, resolveUriToHttp, toResolveView } from '../src/routes/gfs/resolve.js'

const RID = '8f3c2e1a4b5d4c6a9e7f1a2b3c4d5e6f'
const UUID = '8f3c2e1a-4b5d-4c6a-9e7f-1a2b3c4d5e6f'

function res(partial: Partial<ResolvedResource> & { resourceId: string }): ResolvedResource {
  return {
    drive: 'main',
    name: 'n',
    kind: 'directory',
    pathCache: null,
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...partial,
  }
}

class FakeStore implements ResolveStore {
  byRid = new Map<string, ResolvedResource>()
  byPath = new Map<string, ResolvedResource>()
  async getByRid(_d: string, rid: string): Promise<ResolvedResource | null> {
    return this.byRid.get(rid) ?? null
  }
  async getByPath(_d: string, path: string): Promise<ResolvedResource | null> {
    return this.byPath.get(path) ?? null
  }
}

describe('toResolveView', () => {
  it('strips dashes to the canonical 32-hex rid and builds the gfs:// URI', () => {
    const view = toResolveView(res({ resourceId: UUID, drive: 'main', pathCache: '/org' }))
    expect(view.rid).toBe(RID)
    expect(view.gfsUri).toBe(`gfs://main/${RID}`)
    expect(view.path).toBe('/org')
    expect(view.updatedAt).toBe('2026-01-01T00:00:00.000Z')
    expect(view.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/)
  })
})

describe('resolveUriToHttp', () => {
  it('400 on missing/non-string uri', async () => {
    expect((await resolveUriToHttp(new FakeStore(), undefined)).status).toBe(400)
    expect((await resolveUriToHttp(new FakeStore(), '')).status).toBe(400)
  })

  it('400 path_invalid on a malformed gfs URI', async () => {
    const out = await resolveUriToHttp(new FakeStore(), 'not-a-gfs-uri')
    expect(out.status).toBe(400)
    expect(out.body).toMatchObject({ error: 'path_invalid' })
  })

  it('404 when nothing resolves', async () => {
    const out = await resolveUriToHttp(new FakeStore(), `gfs://main/${RID}`)
    expect(out.status).toBe(404)
  })

  it('200 + canonical view when the rid resolves', async () => {
    const store = new FakeStore()
    store.byRid.set(RID, res({ resourceId: UUID, drive: 'main', name: 'org', pathCache: '/org' }))
    const out = await resolveUriToHttp(store, `gfs://main/${RID}`)
    expect(out.status).toBe(200)
    expect(out.body).toMatchObject({
      gfsUri: `gfs://main/${RID}`,
      path: '/org',
      updatedAt: '2026-01-01T00:00:00.000Z',
    })
  })
})

describe('byPathToHttp', () => {
  it('400 when drive or path is missing', async () => {
    expect((await byPathToHttp(new FakeStore(), undefined, '/org')).status).toBe(400)
    expect((await byPathToHttp(new FakeStore(), 'main', undefined)).status).toBe(400)
  })

  it('404 when the path does not resolve', async () => {
    expect((await byPathToHttp(new FakeStore(), 'main', '/missing')).status).toBe(404)
  })

  it('200 + view when the path resolves', async () => {
    const store = new FakeStore()
    store.byPath.set(
      '/org/eng',
      res({ resourceId: UUID, drive: 'main', name: 'eng', pathCache: '/org/eng' })
    )
    const out = await byPathToHttp(store, 'main', '/org/eng')
    expect(out.status).toBe(200)
    expect(out.body).toMatchObject({ name: 'eng', gfsUri: `gfs://main/${RID}` })
  })
})
