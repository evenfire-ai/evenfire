import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthClient } from '../authClient.js'

vi.mock('../config.js', () => ({
  config: { externalRestApiBaseUrl: 'http://rest', requestTimeoutMs: 60_000 },
}))

const CURSOR = 'd119f895-1ef8-4e73-8f08-f9754919682a'

function stream(lines: unknown[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`))
      controller.close()
    },
  })
}

describe('AuthClient.openEntityChangeStream', () => {
  beforeEach(() => vi.unstubAllGlobals())

  it('skips forward-compatible frames without interrupting later supported events', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        body: stream([
          { schemaVersion: 1, type: 'scope.invalidated', cursor: CURSOR, scopes: ['gfs'] },
          { schemaVersion: 1, type: 'scope.invalidated', cursor: CURSOR, scopes: ['future-scope'] },
          { schemaVersion: 1, type: 'stream.closing', cursor: CURSOR, reason: 'future-reason' },
          { schemaVersion: 1, type: 'future.event', cursor: CURSOR, entityId: 'private-id' },
          { schemaVersion: 1, type: 'heartbeat', cursor: CURSOR, observedAt: 'now' },
        ]),
      })
    )
    const events: Array<Record<string, unknown>> = []
    await new AuthClient().openEntityChangeStream(
      'session-token',
      CURSOR,
      event => events.push(event as unknown as Record<string, unknown>),
      new AbortController().signal
    )
    expect(events).toEqual([
      { type: 'open' },
      { schemaVersion: 1, type: 'scope.invalidated', cursor: CURSOR, scopes: ['gfs'] },
      { schemaVersion: 1, type: 'heartbeat', cursor: CURSOR, observedAt: 'now' },
    ])
    expect(JSON.stringify(events)).not.toContain('private-id')
    expect(fetch).toHaveBeenCalledWith(
      new URL('http://rest/api/v1/entity-changes/stream'),
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: 'Bearer session-token' }),
      })
    )
    const requestedUrl = new URL(String(vi.mocked(fetch).mock.calls[0]?.[0]))
    expect(requestedUrl.searchParams.has('cursor')).toBe(false)
  })

  it('rejects an unsupported schema without converting it into a destructive resync', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        body: stream([
          { schemaVersion: 1, type: 'scope.invalidated', cursor: CURSOR, scopes: ['gfs'] },
          { schemaVersion: 2, type: 'future.event', cursor: CURSOR, entityId: 'private-id' },
        ]),
      })
    )
    const events: Array<Record<string, unknown>> = []
    await expect(
      new AuthClient().openEntityChangeStream(
        'session-token',
        null,
        event => events.push(event as unknown as Record<string, unknown>),
        new AbortController().signal
      )
    ).rejects.toThrow('unsupported schema version')
    expect(events.map(event => event.type)).toEqual(['open', 'scope.invalidated'])
    expect(JSON.stringify(events)).not.toContain('private-id')
  })

  it('rejects malformed cursors rather than exposing arbitrary stream payloads', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        body: stream([
          { schemaVersion: 1, type: 'heartbeat', cursor: 'not-a-cursor', observedAt: 'now' },
        ]),
      })
    )
    await expect(
      new AuthClient().openEntityChangeStream(
        'session-token',
        null,
        () => undefined,
        new AbortController().signal
      )
    ).rejects.toThrow('invalid cursor')
  })

  it('preserves Retry-After on a rejected stream connection', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('stream not available yet', {
          status: 404,
          headers: { 'retry-after': '30' },
        })
      )
    )

    await expect(
      new AuthClient().openEntityChangeStream(
        'session-token',
        null,
        () => undefined,
        new AbortController().signal
      )
    ).rejects.toMatchObject({ status: 404, retryAfter: '30' })
  })

  it('bounds and defuses upstream error text before embedding it in the stream error', async () => {
    const body = `host_access_revoked ${'x'.repeat(600)}`
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { status: 503 })))

    let error: unknown
    try {
      await new AuthClient().openEntityChangeStream(
        'session-token',
        null,
        () => undefined,
        new AbortController().signal
      )
    } catch (caught) {
      error = caught
    }

    expect(error).toMatchObject({ status: 503 })
    expect((error as Error).message).toContain('host-access-revoked')
    expect((error as Error).message).not.toContain('host_access_revoked')
    expect((error as Error).message.length).toBeLessThan(560)
  })
})
