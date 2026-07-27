import { describe, expect, it, vi } from 'vitest'
import {
  type GfscReadClient,
  type GfscWriteClient,
  buildGfsCopyTools,
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

  it('surfaces a gfsc error as a redacted failed result (fail-loud, e.g. a revoked grant)', async () => {
    const c = client({
      read: vi.fn(async () => {
        throw new Error('gfsc 403: grant revoked for /internal/server/path with blob blob/key')
      }),
    })
    const r = await toolMap(c)
      .get('clerum__gfs_read')!
      .execute({ drive: 'main', resourceId: 'abc' }, '')
    expect(r.success).toBe(false)
    expect(r.error).toBe('GFS read failed (gfsc 403: forbidden)')
    expect(r.error).not.toContain('/internal/server/path')
    expect(r.error).not.toContain('blob/key')
  })

  it('strips a non-gfsc-shaped read error down to the generic label', async () => {
    const c = client({
      read: vi.fn(async () => {
        throw new Error('connect ECONNREFUSED 10.96.0.7:8087')
      }),
    })
    const r = await toolMap(c)
      .get('clerum__gfs_read')!
      .execute({ drive: 'main', resourceId: 'abc' }, '')
    expect(r.success).toBe(false)
    expect(r.error).toBe('GFS read failed')
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
      createFile: vi.fn(async () => ({ resourceId: 'file' })),
      createFolder: vi.fn(async () => ({ resourceId: 'folder' })),
      rename: vi.fn(async () => ({ resourceId: 'abc', version: 5 })),
      copy: vi.fn(async () => ({
        resourceId: 'copy',
        gfsUri: 'gfs://main/copy',
        objectCount: 3,
        fileCount: 2,
        folderCount: 1,
        totalBytes: 8,
        requestId: 'request-1',
      })),
      ...overrides,
    } as GfscWriteClient
  }

  it('exposes only the narrowly named non-destructive write tools', () => {
    expect(buildGfsWriteTools(writeClient()).map(t => t.name)).toEqual([
      'clerum__gfs_write',
      'clerum__gfs_create_file',
      'clerum__gfs_create_folder',
      'clerum__gfs_rename',
    ])
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

  it.each([
    [
      'clerum__gfs_write',
      { drive: 'main', resourceId: 'abc', content: 'hi' },
    ],
    [
      'clerum__gfs_rename',
      { drive: 'main', resourceId: 'abc', newName: 'renamed.txt' },
    ],
    [
      'clerum__gfs_copy',
      { drive: 'main', sourceResourceId: 'source', destinationParentId: 'destination' },
    ],
  ])('rejects invalid If-Match values before %s reaches gfsc', async (name, baseArgs) => {
    for (const ifMatch of [Number.NaN, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      const c = writeClient()
      const tools = new Map(
        [...buildGfsWriteTools(c), ...buildGfsCopyTools(c)].map(tool => [tool.name, tool])
      )
      const result = await tools.get(name)!.execute({ ...baseArgs, ifMatch }, '')
      expect(result.success).toBe(false)
      expect(result.error).toMatch(/non-negative safe-integer If-Match/)
      expect(c.write).not.toHaveBeenCalled()
      expect(c.rename).not.toHaveBeenCalled()
      expect(c.copy).not.toHaveBeenCalled()
    }
  })

  it('passes create and rename payloads without exposing move fields', async () => {
    const c = writeClient()
    const tools = new Map(buildGfsWriteTools(c).map(tool => [tool.name, tool]))
    await tools.get('clerum__gfs_create_file')!.execute(
      { drive: 'main', parentResourceId: 'parent', name: 'note.txt', content: 'hello' },
      ''
    )
    await tools.get('clerum__gfs_create_folder')!.execute(
      { drive: 'main', parentResourceId: 'parent', name: 'docs' },
      ''
    )
    await tools.get('clerum__gfs_rename')!.execute(
      { drive: 'main', resourceId: 'abc', newName: 'renamed.txt', ifMatch: 4 },
      ''
    )
    expect(c.createFile).toHaveBeenCalledWith({
      drive: 'main', parentResourceId: 'parent', name: 'note.txt', content: 'hello',
    })
    expect(c.createFolder).toHaveBeenCalledWith({
      drive: 'main', parentResourceId: 'parent', name: 'docs',
    })
    expect(c.rename).toHaveBeenCalledWith({
      drive: 'main', resourceId: 'abc', newName: 'renamed.txt', ifMatch: 4,
    })
    expect(tools.has('clerum__gfs_move')).toBe(false)
    expect(tools.has('clerum__gfs_delete')).toBe(false)
  })

  it('copies through one server-side call with the exact root contract', async () => {
    const c = writeClient()
    const tool = buildGfsCopyTools(c)[0]!
    expect(tool.description).toContain('The original remains at the source')
    expect(tool.description).toContain('never deletes it')
    const args = {
      drive: 'main', sourceResourceId: 'source', destinationParentId: 'destination',
      newName: 'source-copy', ifMatch: 7,
    }
    const result = await tool.execute(args, '')
    expect(result.success).toBe(true)
    expect(c.copy).toHaveBeenCalledTimes(1)
    expect(c.copy).toHaveBeenCalledWith(args)
    expect(c.read).not.toHaveBeenCalled()
    expect(c.write).not.toHaveBeenCalled()
  })

  it('does not expose backend paths or keys in mutation failures', async () => {
    const c = writeClient({
      copy: vi.fn(async () => { throw new Error('failed at /mnt/gfs/private/blob-key') }),
    })
    const result = await buildGfsCopyTools(c)[0]!.execute(
      { drive: 'main', sourceResourceId: 'source', destinationParentId: 'destination', ifMatch: 7 },
      ''
    )
    expect(result).toEqual({ success: false, error: 'GFS mutation failed' })
  })

  it.each([
    [403, 'forbidden'],
    [409, 'conflict'],
    [412, 'precondition_failed'],
    [413, 'limit_exceeded'],
    [503, 'unavailable'],
  ])('preserves safe gfsc status/category for mutation failure %s', async (status, category) => {
    const c = writeClient({
      copy: vi.fn(async () => {
        throw new Error(
          `gfsc ${status}: private path=/data/gfs/.generations/secret sql=do-not-expose`
        )
      }),
    })
    const result = await buildGfsCopyTools(c)[0]!.execute(
      { drive: 'main', sourceResourceId: 'source', destinationParentId: 'destination', ifMatch: 7 },
      ''
    )
    expect(result).toEqual({
      success: false,
      error: `GFS mutation failed (gfsc ${status}: ${category})`,
    })
    expect(result.error).not.toContain('/data/')
    expect(result.error).not.toContain('sql=')
  })
})
