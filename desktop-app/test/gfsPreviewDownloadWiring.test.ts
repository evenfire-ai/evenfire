import { describe, expect, it, vi } from 'vitest'
import { GfsClient, type GfsTransport, type ResolvedGfsResource } from '../src/gfs/uriHandler.js'
import { ApiError } from '../src/httpClient.js'

/**
 * R1-H4 Part B — the PREVIEW download path must be bounded. This is the
 * regression fixture: it drives `GfsClient.download` and proves the bound is
 * threaded through to the transport (the ceiling reaches `fetchBytes`), while
 * the save-to-disk path stays uncapped.
 *
 * It fails against the pre-fix head because there `download` had no `maxBytes`
 * option: the preview call materialized the full (oversized) payload and
 * resolved instead of rejecting. The bound mechanics themselves (up-front
 * Content-Length reject + mid-stream abort) are unit-tested in
 * `gfsBoundedDownload.test.ts` against the real producer.
 */

const RID = '0123456789abcdef0123456789abcdef'

const RESOURCE: ResolvedGfsResource = {
  drive: 'main',
  resourceId: RID,
  parentResourceId: null,
  rid: RID,
  gfsUri: `gfs://main/${RID}`,
  name: 'huge.png',
  kind: 'file',
  pathCache: '/huge.png',
  version: 1,
  bytes: 5,
}

// Stand-in for the real bounded transport: it honors `opts.maxBytes` exactly as
// production `fetchBoundedBytes` does — an over-ceiling payload is rejected
// rather than returned. (The real bound's stream/Content-Length mechanics are
// covered in gfsBoundedDownload.test.ts; here we assert `download` WIRES it.)
const OVERSIZED = new Uint8Array(50).fill(7).buffer

function boundedTransport(): GfsTransport {
  return {
    baseUrl: 'https://api.example/',
    requestJson: vi.fn(async () => ({ ok: true, data: RESOURCE })) as GfsTransport['requestJson'],
    fetchBytes: vi.fn(async (_url: string, _token: string, opts?: { maxBytes?: number }) => {
      if (opts?.maxBytes !== undefined && OVERSIZED.byteLength > opts.maxBytes) {
        throw new ApiError(`gfs preview download exceeds the ${opts.maxBytes}-byte limit`, 413, '')
      }
      return OVERSIZED
    }) as GfsTransport['fetchBytes'],
  }
}

describe('GfsClient.download — preview bound wiring (R1-H4 Part B)', () => {
  it('rejects an oversized preview download before returning the full payload', async () => {
    const t = boundedTransport()
    await expect(
      new GfsClient(t).download(`gfs://main/${RID}`, 'tok', { maxBytes: 10 })
    ).rejects.toThrow(/exceeds the 10-byte limit/)
    // The ceiling must reach the transport — this is what the pre-fix head omits.
    expect(t.fetchBytes).toHaveBeenCalledWith(
      `https://api.example/api/v1/me/gfs/proxy/${RID}?drive=main`,
      'tok',
      { maxBytes: 10 }
    )
  })

  it('leaves the save-to-disk path uncapped (no bound forwarded, full payload returned)', async () => {
    const t = boundedTransport()
    const { bytes } = await new GfsClient(t).download(`gfs://main/${RID}`, 'tok')
    expect(bytes.byteLength).toBe(OVERSIZED.byteLength)
    // Unbounded call keeps the exact 2-arg signature (no third opts arg).
    expect(t.fetchBytes).toHaveBeenCalledWith(
      `https://api.example/api/v1/me/gfs/proxy/${RID}?drive=main`,
      'tok'
    )
  })
})
