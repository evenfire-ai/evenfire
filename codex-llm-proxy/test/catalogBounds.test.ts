import { describe, expect, it } from 'vitest'
import { CATALOG_LIMITS, listCodexModels, testCodexConnection } from '../src/codexTransport.js'

const lookup = async () => [{ address: '1.2.3.4', family: 4 }]

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

/** Rejects when the request has no deadline signal; otherwise hangs until it aborts. */
const stalledFetch = (async (_url: unknown, init?: RequestInit) =>
  new Promise<Response>((_, reject) => {
    const signal = init?.signal
    if (!signal) {
      reject(new Error('catalog fetch carries no deadline signal'))
      return
    }
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })) as typeof fetch

describe('Codex catalog upstream bounds', () => {
  it('uses a 15s deadline, an 8 MiB body cap, and the control-api model caps', () => {
    expect(CATALOG_LIMITS).toEqual({
      timeoutMs: 15_000,
      maxBodyBytes: 8 * 1_048_576,
      maxModels: 256,
      maxModelIdLength: 128,
      maxDisplayNameLength: 256,
      maxContextWindowTokens: 2_147_483_647,
    })
  })

  it('lists a normal catalog', async () => {
    const listed = await listCodexModels({
      accessToken: 'tok',
      fetchFn: (async () =>
        jsonResponse({ data: [{ id: 'gpt-5.1', title: 'GPT 5.1' }] })) as typeof fetch,
      lookup,
    })
    expect(listed).toEqual({
      outcome: 'ready',
      models: [{ model: 'gpt-5.1', displayName: 'GPT 5.1' }],
    })
  })

  it('fails a stalled catalog request at the deadline instead of hanging', async () => {
    await expect(
      listCodexModels({ accessToken: 'tok', fetchFn: stalledFetch, lookup, timeoutMs: 50 })
    ).rejects.toMatchObject({ code: 'provider_unavailable' })
    await expect(
      testCodexConnection({ accessToken: 'tok', fetchFn: stalledFetch, lookup, timeoutMs: 50 })
    ).rejects.toMatchObject({ code: 'provider_unavailable' })
  })

  it('fails a catalog body that stalls after headers at the deadline', async () => {
    const fetchFn = (async () =>
      new Response(new ReadableStream<Uint8Array>({ pull: () => new Promise(() => {}) }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch
    const started = Date.now()
    await expect(
      listCodexModels({ accessToken: 'tok', fetchFn, lookup, timeoutMs: 50 })
    ).rejects.toMatchObject({ code: 'provider_unavailable' })
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it('stops reading and fails a catalog body larger than the cap', async () => {
    const chunk = new TextEncoder().encode(' '.repeat(64 * 1024))
    let pulledBytes = 0
    const fetchFn = (async () =>
      new Response(
        new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              // Finite (3x the cap) so a missing cap fails on the assertion, not OOM.
              if (pulledBytes >= 3 * CATALOG_LIMITS.maxBodyBytes) {
                controller.close()
                return
              }
              pulledBytes += chunk.byteLength
              controller.enqueue(chunk)
            },
          },
          { highWaterMark: 0 }
        ),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )) as typeof fetch
    await expect(listCodexModels({ accessToken: 'tok', fetchFn, lookup })).rejects.toMatchObject({
      code: 'provider_unavailable',
    })
    expect(pulledBytes).toBeLessThanOrEqual(CATALOG_LIMITS.maxBodyBytes + 2 * chunk.byteLength)
  })

  it('caps the normalized catalog at 256 models and drops ids longer than 128 chars', async () => {
    const overlong = 'm'.repeat(129)
    const rows = [
      { id: overlong },
      { id: 'm'.repeat(128) },
      ...Array.from({ length: 300 }, (_, index) => ({ id: `model-${index}` })),
    ]
    const listed = await listCodexModels({
      accessToken: 'tok',
      fetchFn: (async () => jsonResponse({ data: rows })) as typeof fetch,
      lookup,
    })
    expect(listed.outcome).toBe('ready')
    expect(listed.models).toHaveLength(256)
    expect(listed.models.some(row => row.model === overlong)).toBe(false)
    expect(listed.models[0]).toEqual({ model: 'm'.repeat(128) })
    expect(listed.models.every(row => row.model.length <= 128)).toBe(true)
  })
})
