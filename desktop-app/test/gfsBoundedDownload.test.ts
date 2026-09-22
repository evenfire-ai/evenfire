import { describe, expect, it } from 'vitest'
import { fetchBoundedBytes } from '../src/gfs/boundedDownload.js'
import { ApiError } from '../src/httpClient.js'

/**
 * R1-H4 Part B — bound mechanics. A fabricated oversized stream is the STIMULUS
 * for the abort path (allowed by T1: it is not a cross-layer contract fixture).
 * The observable being asserted is that an over-ceiling payload is rejected
 * WITHOUT fully materializing — the stream is not drained to completion.
 */

interface FakeResponseSpec {
  ok?: boolean
  status?: number
  contentLength?: string | null
  chunks: Uint8Array[]
}

function fakeFetch(spec: FakeResponseSpec): {
  fetch: typeof fetch
  pulledChunks: () => number
  aborted: () => boolean
} {
  let index = 0
  let pulled = 0
  let seenAbort = false
  const chunks = spec.chunks
  const body = {
    getReader() {
      return {
        read: async () => {
          if (index >= chunks.length) return { done: true, value: undefined }
          const value = chunks[index++]!
          pulled += 1
          return { done: false, value }
        },
        releaseLock() {},
      }
    },
  } as unknown as ReadableStream<Uint8Array>
  const headers = {
    get: (name: string) =>
      name.toLowerCase() === 'content-length' ? (spec.contentLength ?? null) : null,
  }
  const arrayBuffer = async () => {
    const total = chunks.reduce((n, c) => n + c.byteLength, 0)
    const out = new Uint8Array(total)
    let off = 0
    for (const c of chunks) {
      out.set(c, off)
      off += c.byteLength
    }
    return out.buffer
  }
  const fetchImpl = (async (_url: string, init?: { signal?: AbortSignal }) => {
    init?.signal?.addEventListener('abort', () => {
      seenAbort = true
    })
    return {
      ok: spec.ok ?? true,
      status: spec.status ?? 200,
      headers,
      body: spec.ok === false ? null : body,
      arrayBuffer,
    }
  }) as unknown as typeof fetch
  return { fetch: fetchImpl, pulledChunks: () => pulled, aborted: () => seenAbort }
}

const chunk = (n: number) => new Uint8Array(n).fill(1)

describe('fetchBoundedBytes', () => {
  it('reads the whole body when no ceiling is given (save-to-disk path)', async () => {
    const f = fakeFetch({ chunks: [chunk(8), chunk(8), chunk(8)] })
    const bytes = await fetchBoundedBytes('u', 't', undefined, { fetch: f.fetch })
    expect(bytes.byteLength).toBe(24)
  })

  it('returns the payload when it is within the ceiling', async () => {
    const f = fakeFetch({ contentLength: '16', chunks: [chunk(8), chunk(8)] })
    const bytes = await fetchBoundedBytes('u', 't', { maxBytes: 16 }, { fetch: f.fetch })
    expect(bytes.byteLength).toBe(16)
    expect(f.pulledChunks()).toBe(2)
  })

  it('rejects up front on a truthful over-ceiling Content-Length WITHOUT reading the body', async () => {
    const f = fakeFetch({ contentLength: '999999', chunks: [chunk(8), chunk(8), chunk(8)] })
    await expect(
      fetchBoundedBytes('u', 't', { maxBytes: 10 }, { fetch: f.fetch })
    ).rejects.toBeInstanceOf(ApiError)
    // Observable: the body was never streamed (no chunk pulled) and the request
    // was aborted — the full buffer is never allocated.
    expect(f.pulledChunks()).toBe(0)
    expect(f.aborted()).toBe(true)
  })

  it('aborts mid-stream when a lying/absent Content-Length hides an over-ceiling body', async () => {
    // Content-Length claims tiny (or is absent); the real body is 80 bytes.
    const chunks = Array.from({ length: 10 }, () => chunk(8))
    const f = fakeFetch({ contentLength: '4', chunks })
    await expect(fetchBoundedBytes('u', 't', { maxBytes: 10 }, { fetch: f.fetch })).rejects.toThrow(
      /exceeds the 10-byte limit/
    )
    // Observable: it stopped early — it did NOT drain all 10 chunks — and aborted.
    expect(f.pulledChunks()).toBeLessThan(chunks.length)
    expect(f.aborted()).toBe(true)
  })

  it('also aborts when Content-Length is absent entirely', async () => {
    const chunks = Array.from({ length: 10 }, () => chunk(8))
    const f = fakeFetch({ contentLength: null, chunks })
    await expect(fetchBoundedBytes('u', 't', { maxBytes: 10 }, { fetch: f.fetch })).rejects.toThrow(
      /exceeds the 10-byte limit/
    )
    expect(f.pulledChunks()).toBeLessThan(chunks.length)
  })

  it('throws an ApiError with the upstream status on a non-ok response', async () => {
    const f = fakeFetch({ ok: false, status: 403, chunks: [] })
    await expect(
      fetchBoundedBytes('u', 't', { maxBytes: 10 }, { fetch: f.fetch })
    ).rejects.toMatchObject({ status: 403 })
  })
})
