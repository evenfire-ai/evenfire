import { describe, expect, it, vi } from 'vitest'
import {
  type GfscReadClient,
  type GfscWriteClient,
  buildGfsReadTools,
  buildGfsWriteTools,
} from './gfs'

/**
 * P3-S04 — agent gfs READ tools. Four read-only tools (list/read/stat/resolve)
 * over a gfsc client; results carry gfsUri. No write tool in P3.
 */

function client(overrides?: Partial<GfscReadClient>): GfscReadClient {
  return {
    accessible: vi.fn(async () => ({
      items: [{ gfsUri: 'gfs://main/abc', permissions: ['read', 'write'] }],
    })),
    list: vi.fn(async () => ({ entries: [{ gfsUri: 'gfs://main/abc' }] })),
    read: vi.fn(async () => ({ gfsUri: 'gfs://main/abc', bytes: 'hi' })),
    stat: vi.fn(async () => ({ gfsUri: 'gfs://main/abc', kind: 'file', version: 2 })),
    resolve: vi.fn(async () => ({ gfsUri: 'gfs://main/abc', pathCache: '/a' })),
    ...overrides,
  }
}

function toolMap(c: GfscReadClient) {
  return new Map(buildGfsReadTools(c).map(t => [t.name, t]))
}

describe('buildGfsReadTools', () => {
  it('exposes the read tools plus accessible-resource discovery', () => {
    const names = buildGfsReadTools(client())
      .map(t => t.name)
      .sort()
    expect(names).toEqual([
      'clerum__gfs_accessible',
      'clerum__gfs_list',
      'clerum__gfs_read',
      'clerum__gfs_resolve',
      'clerum__gfs_stat',
    ])
  })

  it('gfs_accessible returns resources and permissions the agent can use', async () => {
    const c = client()
    const r = await toolMap(c).get('clerum__gfs_accessible')!.execute({ drive: 'main' }, '')
    expect(r.success).toBe(true)
    expect(r.content).toContain('gfs://main/abc')
    expect(r.content).toContain('write')
    expect(c.accessible).toHaveBeenCalledWith({ drive: 'main' })
  })

  it('gfs_list returns the gfsc result on success', async () => {
    const c = client()
    const r = await toolMap(c)
      .get('clerum__gfs_list')!
      .execute({ drive: 'main', resourceId: 'abc' }, '')
    expect(r.success).toBe(true)
    expect(r.content).toContain('gfs://main/abc')
    expect(c.list).toHaveBeenCalledWith({ drive: 'main', resourceId: 'abc' })
  })

  it('gfs_resolve calls the resolver', async () => {
    const c = client()
    const r = await toolMap(c).get('clerum__gfs_resolve')!.execute({ uri: 'gfs://main/abc' }, '')
    expect(r.success).toBe(true)
    expect(c.resolve).toHaveBeenCalledWith({ uri: 'gfs://main/abc' })
  })

  it('surfaces a gfsc error as a failed result (fail-loud, e.g. a revoked grant)', async () => {
    const c = client({
      read: vi.fn(async () => {
        throw new Error('forbidden')
      }),
    })
    const r = await toolMap(c)
      .get('clerum__gfs_read')!
      .execute({ drive: 'main', resourceId: 'abc' }, '')
    expect(r.success).toBe(false)
    expect(r.error).toContain('forbidden')
  })
})

describe('buildGfsWriteTools (P4)', () => {
  function writeClient(overrides?: Partial<GfscWriteClient>): GfscWriteClient {
    return {
      list: vi.fn(),
      accessible: vi.fn(),
      read: vi.fn(),
      stat: vi.fn(),
      resolve: vi.fn(),
      write: vi.fn(async () => ({ gfsUri: 'gfs://main/abc', version: 4 })),
      ...overrides,
    } as GfscWriteClient
  }

  it('exposes clerum__gfs_write', () => {
    expect(buildGfsWriteTools(writeClient()).map(t => t.name)).toEqual(['clerum__gfs_write'])
  })

  it('writes with a numeric If-Match and returns the result', async () => {
    const c = writeClient()
    const tool = buildGfsWriteTools(c)[0]!
    const r = await tool.execute(
      { drive: 'main', resourceId: 'abc', content: 'hi', ifMatch: 3 },
      ''
    )
    expect(r.success).toBe(true)
    expect(c.write).toHaveBeenCalledWith({
      drive: 'main',
      resourceId: 'abc',
      content: 'hi',
      ifMatch: 3,
    })
  })

  it('rejects a write without If-Match (agent writes are writer-routed conditional)', async () => {
    const c = writeClient()
    const tool = buildGfsWriteTools(c)[0]!
    const r = await tool.execute({ drive: 'main', resourceId: 'abc', content: 'hi' }, '')
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/If-Match/i)
    expect(c.write).not.toHaveBeenCalled()
  })
})
