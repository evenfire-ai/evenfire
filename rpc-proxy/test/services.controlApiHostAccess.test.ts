import { describe, expect, it, vi } from 'vitest'
import {
  ControlApiHostAccessRejectedError,
  fetchHostConnectionFromControlApi,
} from '../src/services/controlApiRestService.js'

const BINDING = {
  runId: '00000000-0000-4000-8000-000000000123',
  sessionId: 'session-a',
  origin: 'direct_chat' as const,
}

describe('control-api canonical host access client', () => {
  it('resolves and binds with one POST to the existing host-access URL', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            userId: 'user-1',
            hostRef: 'host-a',
            url: 'http://host-a.mcp-host.svc.cluster.local:8080',
            bindingStatus: 'recorded',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
    )

    await expect(
      fetchHostConnectionFromControlApi('user-1', 'host-a', 'signed-rpc-token', {
        directRunBinding: BINDING,
        fetchImpl: fetchImpl as typeof fetch,
      })
    ).resolves.toEqual({
      name: 'host-a',
      url: 'http://host-a.mcp-host.svc.cluster.local:8080',
      headers: {},
      attributionBindingStatus: 'recorded',
    })

    expect(fetchImpl).toHaveBeenCalledOnce()
    const [url, init] = fetchImpl.mock.calls[0]!
    expect(String(url)).toMatch(/\/rpc\/access\/users\/user-1\/mcp-hosts\/host-a$/)
    expect(init).toMatchObject({ method: 'POST' })
    expect(JSON.parse(String(init?.body))).toEqual(BINDING)
  })

  it.each([401, 403, 409] as const)('preserves a Control API %s rejection', async status => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: 'redacted' }), {
          status,
          headers: { 'content-type': 'application/json' },
        })
    )

    const rejection = fetchHostConnectionFromControlApi('user-1', 'host-a', 'signed-rpc-token', {
      directRunBinding: BINDING,
      fetchImpl: fetchImpl as typeof fetch,
    })

    await expect(rejection).rejects.toBeInstanceOf(ControlApiHostAccessRejectedError)
    await expect(rejection).rejects.toMatchObject({ status })
  })
})
