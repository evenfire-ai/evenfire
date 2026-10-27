import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveHostConnectionForUser } from '../mcpProxyService.js'

const controlApi = vi.hoisted(() => ({
  fetchHostConnectionFromControlApi: vi.fn(),
  fetchUserAllowedServersFromControlApi: vi.fn(),
}))

vi.mock('../controlApiRestService.js', () => controlApi)

const USER_ID = 'user-1'
const TEAM_ID = 'team-1'
const HOST_REF = 'chatllm'
const ORIGIN = 'https://profile.tenant.example'

function context(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    userId: USER_ID,
    teamId: TEAM_ID,
    hostRef: HOST_REF,
    profileUiBaseUrl: ORIGIN,
    ...overrides,
  }
}

describe('resolveHostConnectionForUser Profile-link edge context', () => {
  beforeEach(() => {
    controlApi.fetchHostConnectionFromControlApi.mockReset()
    controlApi.fetchHostConnectionFromControlApi.mockResolvedValue({
      name: HOST_REF,
      url: 'http://chatllm:8080',
      headers: {
        'x-clerum-edge-caller': 'spoofed-host-value',
        'x-clerum-edge-user-id': 'spoofed-user',
        'x-clerum-edge-profile-link-context': 'spoofed-context',
      },
      profileLinkContext: context(),
    })
  })

  it('forwards only a context returned for this authenticated user, team, and Host', async () => {
    const resolved = await resolveHostConnectionForUser(USER_ID, HOST_REF, 'rpc-token', {
      accessScope: 'team',
      teamId: TEAM_ID,
      includeProfileLinkContext: true,
    })

    expect(controlApi.fetchHostConnectionFromControlApi).toHaveBeenCalledWith(
      USER_ID,
      HOST_REF,
      'rpc-token',
      { profileLinkContext: { teamId: TEAM_ID }, directRunBinding: undefined }
    )
    if ('denied' in resolved) throw new Error('unexpected host denial')
    const encoded = resolved.headers['x-clerum-edge-profile-link-context']
    expect(JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))).toEqual(context())
    expect(resolved.headers['x-clerum-edge-caller']).toBe('rpc-proxy')
    expect(resolved.headers['x-clerum-edge-user-id']).toBe(USER_ID)
  })

  it.each([
    ['user mismatch', context({ userId: 'other-user' })],
    ['team mismatch', context({ teamId: 'other-team' })],
    ['Host mismatch', context({ hostRef: 'other-host' })],
    [
      'non-canonical Profile origin',
      context({ profileUiBaseUrl: 'https://profile.tenant.example/path' }),
    ],
  ])('does not forward a %s context', async (_label, profileLinkContext) => {
    controlApi.fetchHostConnectionFromControlApi.mockResolvedValueOnce({
      name: HOST_REF,
      url: 'http://chatllm:8080',
      headers: {},
      profileLinkContext,
    })

    const resolved = await resolveHostConnectionForUser(USER_ID, HOST_REF, 'rpc-token', {
      teamId: TEAM_ID,
      includeProfileLinkContext: true,
    })

    if ('denied' in resolved) throw new Error('unexpected host denial')
    expect(resolved.headers).not.toHaveProperty('x-clerum-edge-profile-link-context')
  })

  it('keeps older RPC callers on the existing edge contract', async () => {
    const resolved = await resolveHostConnectionForUser(USER_ID, HOST_REF, 'rpc-token', {
      teamId: TEAM_ID,
    })

    if ('denied' in resolved) throw new Error('unexpected host denial')
    expect(resolved.headers).not.toHaveProperty('x-clerum-edge-profile-link-context')
    expect(controlApi.fetchHostConnectionFromControlApi).toHaveBeenCalledWith(
      USER_ID,
      HOST_REF,
      'rpc-token',
      { profileLinkContext: undefined, directRunBinding: undefined }
    )
  })
})
