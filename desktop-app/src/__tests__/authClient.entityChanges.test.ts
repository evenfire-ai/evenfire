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

  it('validates coarse feed frames and turns unknown versions into full resync', async () => {
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
    await new AuthClient().openEntityChangeStream(
      'session-token',
      null,
      event => events.push(event as unknown as Record<string, unknown>),
      new AbortController().signal
    )
    expect(events).toEqual([
      { type: 'open' },
      { schemaVersion: 1, type: 'scope.invalidated', cursor: CURSOR, scopes: ['gfs'] },
      {
        schemaVersion: 1,
        type: 'resync_required',
        cursor: CURSOR,
        scopes: ['gfs', 'authorization'],
      },
    ])
    expect(JSON.stringify(events)).not.toContain('private-id')
    expect(fetch).toHaveBeenCalledWith(
      new URL('http://rest/api/v1/entity-changes/stream'),
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: 'Bearer session-token' }),
      })
    )
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
    ).rejects.toThrow('unsupported frame')
  })
})
