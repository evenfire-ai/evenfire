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

  const jsonResponse = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    vi.fn(
      async () =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json', ...headers },
        })
    )

  // control-api reports the denial reason in this header; its 403 body is always
  // exactly {"error":"Forbidden"}. Pinned literally so the test fails if the two
  // services ever disagree on the name.
  const REASON_HEADER = 'x-host-access-denial-reason'
  const FORBIDDEN_BODY = { error: 'Forbidden' }

  // R1-M6: the denial reason (read from the response header, never the body)
  // decides whether Desktop may treat the loss as a revocation. Only the two
  // reasons that prove removed access map to `host_access_revoked`;
  // `subject_mismatch` is a request-shape error (R3-L8).
  it.each([
    ['team_membership_missing', 'host_access_revoked'],
    ['directory_grant_missing', 'host_access_revoked'],
    ['subject_mismatch', 'host_access_denied'],
    ['host_disabled', 'host_access_denied'],
    ['host_missing', 'host_access_denied'],
    ['host_claim_missing', 'host_access_denied'],
    ['unheard_of_reason', 'host_access_denied'],
  ])('a non-direct-run 403 with reason %s resolves to the denial %s', async (reason, code) => {
    const fetchImpl = jsonResponse(403, FORBIDDEN_BODY, { [REASON_HEADER]: reason })

    await expect(
      fetchHostConnectionFromControlApi('user-1', 'host-a', 'signed-rpc-token', {
        fetchImpl: fetchImpl as typeof fetch,
      })
    ).resolves.toEqual({ denied: true, code })
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('a non-direct-run 403 without the reason header resolves to host_access_denied', async () => {
    const fetchImpl = jsonResponse(403, FORBIDDEN_BODY)

    await expect(
      fetchHostConnectionFromControlApi('user-1', 'host-a', 'signed-rpc-token', {
        fetchImpl: fetchImpl as typeof fetch,
      })
    ).resolves.toEqual({ denied: true, code: 'host_access_denied' })
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('a non-direct-run 403 with an unknown header value resolves to host_access_denied', async () => {
    const fetchImpl = jsonResponse(403, FORBIDDEN_BODY, { [REASON_HEADER]: 'a_reason_added_later' })

    await expect(
      fetchHostConnectionFromControlApi('user-1', 'host-a', 'signed-rpc-token', {
        fetchImpl: fetchImpl as typeof fetch,
      })
    ).resolves.toEqual({ denied: true, code: 'host_access_denied' })
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('a non-direct-run 403 with a non-JSON body still honours the header', async () => {
    // A revoking reason: a denied-anyway reason would pass even if the header
    // were ignored.
    const fetchImpl = vi.fn(
      async () =>
        new Response('not json', {
          status: 403,
          headers: { [REASON_HEADER]: 'team_membership_missing' },
        })
    )

    await expect(
      fetchHostConnectionFromControlApi('user-1', 'host-a', 'signed-rpc-token', {
        fetchImpl: fetchImpl as typeof fetch,
      })
    ).resolves.toEqual({ denied: true, code: 'host_access_revoked' })
  })

  it('a reason present only in the body (legacy shape) is ignored', async () => {
    // Proves the body is never read: the same reason maps to host_access_revoked
    // when it arrives as the header (see the table above) but not from the body.
    const fetchImpl = jsonResponse(403, { error: 'Forbidden', reason: 'team_membership_missing' })

    await expect(
      fetchHostConnectionFromControlApi('user-1', 'host-a', 'signed-rpc-token', {
        fetchImpl: fetchImpl as typeof fetch,
      })
    ).resolves.toEqual({ denied: true, code: 'host_access_denied' })
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('a non-direct-run 404 resolves to host_access_denied', async () => {
    const fetchImpl = jsonResponse(404, { error: 'not found' })

    await expect(
      fetchHostConnectionFromControlApi('user-1', 'host-a', 'signed-rpc-token', {
        fetchImpl: fetchImpl as typeof fetch,
      })
    ).resolves.toEqual({ denied: true, code: 'host_access_denied' })
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it.each([
    ['userId mismatch', { userId: 'someone-else', hostRef: 'host-a', url: 'http://h:8080' }],
    ['hostRef mismatch', { userId: 'user-1', hostRef: 'host-b', url: 'http://h:8080' }],
    ['empty url', { userId: 'user-1', hostRef: 'host-a', url: ' ' }],
  ])('a 200 with %s resolves to host_access_denied', async (_label, body) => {
    const fetchImpl = jsonResponse(200, body)

    await expect(
      fetchHostConnectionFromControlApi('user-1', 'host-a', 'signed-rpc-token', {
        fetchImpl: fetchImpl as typeof fetch,
      })
    ).resolves.toEqual({ denied: true, code: 'host_access_denied' })
  })

  it.each([
    ['team_membership_missing', 'host_access_revoked'],
    ['host_disabled', 'host_access_denied'],
    [undefined, 'host_access_denied'],
  ])('a direct-run 403 (reason %s) throws with denialCode %s', async (reason, code) => {
    const fetchImpl = jsonResponse(403, FORBIDDEN_BODY, reason ? { [REASON_HEADER]: reason } : {})

    await expect(
      fetchHostConnectionFromControlApi('user-1', 'host-a', 'signed-rpc-token', {
        directRunBinding: BINDING,
        fetchImpl: fetchImpl as typeof fetch,
      })
    ).rejects.toMatchObject({ status: 403, denialCode: code })
  })

  it.each([401, 409] as const)('a %s carries no denial code', async status => {
    const fetchImpl = jsonResponse(
      status,
      { error: 'x', reason: 'team_membership_missing' },
      { [REASON_HEADER]: 'team_membership_missing' }
    )

    await expect(
      fetchHostConnectionFromControlApi('user-1', 'host-a', 'signed-rpc-token', {
        directRunBinding: BINDING,
        fetchImpl: fetchImpl as typeof fetch,
      })
    ).rejects.toMatchObject({ status, denialCode: null })
  })
})
