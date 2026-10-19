import { describe, expect, it, vi } from 'vitest'
import { config } from '../../config.js'
import { fetchHostConnectionFromControlApi } from '../controlApiRestService.js'

const USER_ID = 'user-1'
const TEAM_ID = 'team-1'
const HOST_REF = 'chatllm'
const ORIGIN = 'https://profile.tenant.example'

function response(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: new Headers(),
  } as unknown as Response
}

function hostBody(profileLinkContext?: unknown) {
  return {
    userId: USER_ID,
    hostRef: HOST_REF,
    url: 'http://chatllm:8080',
    ...(profileLinkContext === undefined ? {} : { profileLinkContext }),
  }
}

function profileContext(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    userId: USER_ID,
    teamId: TEAM_ID,
    hostRef: HOST_REF,
    profileUiBaseUrl: `${ORIGIN}/`,
    ...overrides,
  }
}

describe('fetchHostConnectionFromControlApi Profile-link context', () => {
  it('requests and validates the versioned context against the caller binding', async () => {
    const fetchImpl = vi.fn(async () => response(hostBody(profileContext())))

    const host = await fetchHostConnectionFromControlApi(USER_ID, HOST_REF, 'rpc-token', {
      profileLinkContext: { teamId: TEAM_ID },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url] = fetchImpl.mock.calls[0]!
    expect(String(url)).toContain(
      `${config.controlApiBaseUrl.replace(/\/+$/, '')}/rpc/access/users/${USER_ID}/mcp-hosts/${HOST_REF}?profileLinkContext=1`
    )
    expect(host).toMatchObject({
      name: HOST_REF,
      profileLinkContext: {
        version: 1,
        userId: USER_ID,
        teamId: TEAM_ID,
        hostRef: HOST_REF,
        profileUiBaseUrl: ORIGIN,
      },
    })
  })

  it.each([
    ['unknown version', profileContext({ version: 2 })],
    ['user mismatch', profileContext({ userId: 'other-user' })],
    ['team mismatch', profileContext({ teamId: 'other-team' })],
    ['Host mismatch', profileContext({ hostRef: 'other-host' })],
    ['invalid origin', profileContext({ profileUiBaseUrl: 'https://profile.tenant.example/path' })],
  ])(
    'drops an %s optional context while retaining the Host connection',
    async (_label, context) => {
      const host = await fetchHostConnectionFromControlApi(USER_ID, HOST_REF, 'rpc-token', {
        profileLinkContext: { teamId: TEAM_ID },
        fetchImpl: vi.fn(async () => response(hostBody(context))) as unknown as typeof fetch,
      })

      expect(host).toMatchObject({ name: HOST_REF, url: 'http://chatllm:8080' })
      expect(host).not.toHaveProperty('profileLinkContext')
    }
  )

  it('accepts older Control API responses without the optional context', async () => {
    const host = await fetchHostConnectionFromControlApi(USER_ID, HOST_REF, 'rpc-token', {
      profileLinkContext: { teamId: TEAM_ID },
      fetchImpl: vi.fn(async () => response(hostBody())) as unknown as typeof fetch,
    })

    expect(host).toMatchObject({ name: HOST_REF, url: 'http://chatllm:8080' })
    expect(host).not.toHaveProperty('profileLinkContext')
  })

  it('extends only Profile-context lookups beyond the default upstream deadline', async () => {
    const previousTimeoutMs = config.upstreamTimeoutMs
    const defaultSignal = new AbortController().signal
    const profileContextSignal = new AbortController().signal
    const timeoutSpy = vi
      .spyOn(AbortSignal, 'timeout')
      .mockReturnValueOnce(defaultSignal)
      .mockReturnValueOnce(profileContextSignal)
    config.upstreamTimeoutMs = 8_000
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      response(hostBody())
    )

    try {
      await fetchHostConnectionFromControlApi(USER_ID, HOST_REF, 'rpc-token', {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      })
      expect(timeoutSpy).toHaveBeenLastCalledWith(8_000)
      expect(fetchImpl.mock.calls[0]?.[1]?.signal).toBe(defaultSignal)

      await fetchHostConnectionFromControlApi(USER_ID, HOST_REF, 'rpc-token', {
        profileLinkContext: { teamId: TEAM_ID },
        fetchImpl: fetchImpl as unknown as typeof fetch,
      })
      expect(timeoutSpy).toHaveBeenLastCalledWith(40_000)
      expect(fetchImpl.mock.calls[1]?.[1]?.signal).toBe(profileContextSignal)
    } finally {
      config.upstreamTimeoutMs = previousTimeoutMs
      timeoutSpy.mockRestore()
    }
  })

  it('maps a Control API authorization deadline to the sanitized upstream timeout', async () => {
    const timeoutResponse = {
      ok: false,
      status: 504,
      json: async () => ({ error: 'Gateway Timeout' }),
      text: async () => '{"error":"Gateway Timeout"}',
      headers: new Headers(),
    } as unknown as Response

    await expect(
      fetchHostConnectionFromControlApi(USER_ID, HOST_REF, 'rpc-token', {
        profileLinkContext: { teamId: TEAM_ID },
        fetchImpl: vi.fn(async () => timeoutResponse) as unknown as typeof fetch,
      })
    ).rejects.toMatchObject({ name: 'TimeoutError' })
  })
})
