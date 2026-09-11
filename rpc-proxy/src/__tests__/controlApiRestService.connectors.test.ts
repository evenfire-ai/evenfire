import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ControlApiConnectorsRejectedError,
  fetchUserConnectorsFromControlApi,
} from '../services/controlApiRestService.js'

// spec 11 U1 — unit test for the connectors SANEADOR. Unlike the route test
// (rpc-connectors-route.test.ts) which mocks this function whole, here we stub
// only global `fetch` so `sanitizeConnector`/`sanitizeAgentConnectors` actually
// run. The invariant under test: the read-model projects the control-api payload
// down to the NON-SECRET allowlist ({name, provider?, authKind?, grantScope?,
// status}) and NEVER transports `auth`/`secretRef`/tokens, whatever the upstream
// sends. A change that let a spurious field through must turn this red.

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('fetchUserConnectorsFromControlApi — non-secret projection', () => {
  it('strips secret/spurious fields and returns only the allowlisted shape', async () => {
    const serverPayload = {
      // The server echoes a DIFFERENT userId — it must be ignored in favor of
      // the local (param) subject; the panel identity is never the server's echo.
      userId: 'server-echoed-other-user',
      agents: [
        {
          name: 'agent-a',
          contextRef: 'ctx-1',
          // Spurious agent-level fields must not survive.
          secretRef: { name: 'agent-secret', key: 'k' },
          bogus: true,
          connectors: [
            {
              name: 'gdrive',
              provider: 'google',
              authKind: 'oauth-user',
              grantScope: 'user',
              status: 'requires_setup',
              // Secret / spurious fields the saneador MUST drop:
              auth: { type: 'oauth', accessToken: 'sekret' },
              secretRef: { name: 'gdrive-secret', key: 'client-secret' },
              token: 'upstream-token-must-not-leak',
              clientSecret: 'cs',
            },
            {
              // Invalid status → the whole connector is dropped.
              name: 'bad-status',
              status: 'totally-not-valid',
              token: 'leak-me',
            },
            // A connector that is not an object → dropped.
            'not-an-object',
            null,
            {
              // Invalid authKind/grantScope → those OPTIONALS are dropped, but
              // the connector itself stays (name + valid status).
              name: 'slack',
              provider: 'slack',
              authKind: 'nope',
              grantScope: 'galaxy',
              status: 'authorized',
              clientSecret: 'nope',
            },
          ],
        },
      ],
    }
    const fetchMock = vi.fn((..._args: Parameters<typeof fetch>) =>
      Promise.resolve(jsonResponse(serverPayload))
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await fetchUserConnectorsFromControlApi('local-user', 'rpc-tok')

    // Exact equality — no `auth`/`secretRef`/`token`/`clientSecret` may leak, and
    // `userId` is the local param, NOT the server echo.
    expect(result).toEqual({
      userId: 'local-user',
      agents: [
        {
          name: 'agent-a',
          contextRef: 'ctx-1',
          connectors: [
            {
              name: 'gdrive',
              provider: 'google',
              authKind: 'oauth-user',
              grantScope: 'user',
              status: 'requires_setup',
            },
            {
              name: 'slack',
              provider: 'slack',
              status: 'authorized',
            },
          ],
        },
      ],
    })

    // Defense in depth: the serialized output carries none of the secret tokens.
    const serialized = JSON.stringify(result)
    for (const leak of [
      'secretRef',
      'accessToken',
      'upstream-token-must-not-leak',
      'clientSecret',
      'cs',
      'sekret',
    ]) {
      expect(serialized).not.toContain(leak)
    }

    // The lookup is keyed by the local (param) userId, url-encoded, with the
    // rpc access token forwarded — not the server-echoed identity.
    const [url] = fetchMock.mock.calls[0]
    expect(String(url)).toContain('/users/local-user/mcp-connectors')
  })

  it('throws on a non-ok control-api response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({}, false, 502))
    )
    await expect(fetchUserConnectorsFromControlApi('local-user', 'rpc-tok')).rejects.toThrow(
      /connectors lookup failed \(502\)/
    )
  })

  // H2 — 401/403 carry a TYPED rejection (with status), so the route can map
  // them to a real client status instead of a non-refreshable 500.
  it.each([401, 403] as const)('throws a typed rejection carrying status %d', async status => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({}, false, status))
    )
    await expect(fetchUserConnectorsFromControlApi('local-user', 'rpc-tok')).rejects.toMatchObject({
      name: 'ControlApiConnectorsRejectedError',
      status,
    })
    // And it is the concrete class, so `instanceof` in the route holds.
    const err = await fetchUserConnectorsFromControlApi('local-user', 'rpc-tok').catch(e => e)
    expect(err).toBeInstanceOf(ControlApiConnectorsRejectedError)
  })

  it('bounds the control-api call with an abort signal (SM3 — no unbounded socket)', async () => {
    // Without a signal, a hung control-api pins the proxy socket indefinitely.
    // The wiring must pass an AbortSignal (AbortSignal.timeout) so a stalled
    // upstream surfaces as a 504 instead of hanging.
    const fetchMock = vi.fn((..._args: Parameters<typeof fetch>) =>
      Promise.resolve(jsonResponse({ userId: 'local-user', agents: [] }))
    )
    vi.stubGlobal('fetch', fetchMock)
    await fetchUserConnectorsFromControlApi('local-user', 'rpc-tok')
    const init = fetchMock.mock.calls[0][1] as RequestInit
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })
})
