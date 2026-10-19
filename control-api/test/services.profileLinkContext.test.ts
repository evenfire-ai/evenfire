import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildGfsResourceWebLink } from '@clerum/desktop-app-links'
import { resolveProfileUiBaseUrlForUser } from '../src/services/profileLinkContext.js'
import { MRS_PROFILE_LOOKUP_RESPONSE_V1 } from './fixtures/mrsProfileLookupResponseV1.js'

const directory = vi.hoisted(() => ({ getMe: vi.fn() }))
const memberRegistration = vi.hoisted(() => ({ request: vi.fn() }))
const profileConfig = vi.hoisted(() => ({
  desktopProfileUiBaseUrl: '',
}))

vi.mock('../src/config.js', () => ({
  config: profileConfig,
}))
vi.mock('../src/memberRegistrationServiceClient.js', () => ({
  memberRegistrationServiceRequest: memberRegistration.request,
}))
vi.mock('../src/services/directory/membership.js', () => ({ getMe: directory.getMe }))

const USER_ID = 'user-1'
const TEAM_ID = 'team-1'
const EMAIL = 'person@example.com'
const GFS_URI = 'gfs://main/0123456789abcdef0123456789abcdef'
let configuredOrigin = ''
let configSequence = 0

beforeEach(() => {
  configSequence += 1
  configuredOrigin = `https://profile-config-${configSequence}.example`
  profileConfig.desktopProfileUiBaseUrl = configuredOrigin
  directory.getMe.mockReset()
  memberRegistration.request.mockReset()
  directory.getMe.mockResolvedValue({ id: USER_ID, email: ' Person@Example.com ' })
  memberRegistration.request.mockResolvedValue({
    valid: true,
    email: EMAIL,
    appName: 'Evenfire',
    profileUiBaseUrl: `${configuredOrigin}/`,
  })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('resolveProfileUiBaseUrlForUser', () => {
  it('accepts the response emitted by the current MRS route and service producer', async () => {
    profileConfig.desktopProfileUiBaseUrl = MRS_PROFILE_LOOKUP_RESPONSE_V1.profileUiBaseUrl
    memberRegistration.request.mockResolvedValueOnce(MRS_PROFILE_LOOKUP_RESPONSE_V1)

    await expect(resolveProfileUiBaseUrlForUser(USER_ID, TEAM_ID)).resolves.toBe(
      MRS_PROFILE_LOOKUP_RESPONSE_V1.profileUiBaseUrl
    )

    expect(memberRegistration.request).toHaveBeenCalledWith(
      'POST',
      '/invitations-flow/profile',
      expect.objectContaining({
        body: { email: EMAIL, domain: 'profile.tenant.example' },
      })
    )
  })

  it('fails closed when an older MRS response omits the Profile origin field', async () => {
    memberRegistration.request.mockResolvedValueOnce({
      valid: true,
      email: EMAIL,
      appName: 'Evenfire',
    })

    await expect(resolveProfileUiBaseUrlForUser(USER_ID, TEAM_ID)).resolves.toBeNull()
  })

  it('uses the active directory identity and the configured activation origin', async () => {
    const producerLink = buildGfsResourceWebLink(configuredOrigin, GFS_URI)

    await expect(resolveProfileUiBaseUrlForUser(USER_ID, TEAM_ID)).resolves.toBe(
      new URL(producerLink).origin
    )

    expect(directory.getMe).toHaveBeenCalledWith(USER_ID, TEAM_ID)
    expect(memberRegistration.request).toHaveBeenCalledWith('POST', '/invitations-flow/profile', {
      destinationBaseUrl: configuredOrigin,
      body: { email: EMAIL, domain: new URL(configuredOrigin).hostname },
      timeoutMs: 1000,
    })
  })

  it('does not query activation without an active matching directory user', async () => {
    directory.getMe.mockResolvedValueOnce(null)

    await expect(resolveProfileUiBaseUrlForUser(USER_ID, null)).resolves.toBeNull()
    expect(memberRegistration.request).not.toHaveBeenCalled()
  })

  it.each(['http://localhost:3001', 'http://[::1]:3001'])(
    'fails closed when the configured Profile host cannot scope an MRS lookup (%s)',
    async profileUiBaseUrl => {
      profileConfig.desktopProfileUiBaseUrl = profileUiBaseUrl

      await expect(resolveProfileUiBaseUrlForUser(USER_ID, TEAM_ID)).resolves.toBeNull()
      expect(memberRegistration.request).not.toHaveBeenCalled()
    }
  )

  it.each([
    { valid: false, email: EMAIL, profileUiBaseUrl: 'https://profile-config.example' },
    { valid: true, email: 'other@example.com', profileUiBaseUrl: 'https://profile-config.example' },
    { valid: true, email: EMAIL, profileUiBaseUrl: 'https://profile-config.example/path' },
    { valid: true, email: EMAIL, profileUiBaseUrl: 'https://user:pass@profile-config.example' },
    { valid: true, email: EMAIL, profileUiBaseUrl: 'http://profile-config.example' },
    { valid: true, email: EMAIL, profileUiBaseUrl: 'https://profile-config.example:8443' },
    { valid: true, email: EMAIL, profileUiBaseUrl: 'https://different.example' },
  ])(
    'rejects activation data that is not bound to the directory user and exact configured origin',
    async result => {
      memberRegistration.request.mockResolvedValueOnce({
        ...result,
        profileUiBaseUrl: result.profileUiBaseUrl.replace(
          'profile-config.example',
          new URL(configuredOrigin).hostname
        ),
      })

      await expect(resolveProfileUiBaseUrlForUser(USER_ID, TEAM_ID)).resolves.toBeNull()
    }
  )

  it('does not use a mismatching origin returned for the same configured host', async () => {
    memberRegistration.request.mockResolvedValueOnce({
      valid: true,
      email: EMAIL,
      profileUiBaseUrl: `http://${new URL(configuredOrigin).hostname}`,
    })

    await expect(resolveProfileUiBaseUrlForUser(USER_ID, TEAM_ID)).resolves.toBeNull()
  })

  it('reuses only a positive exact-origin result while rechecking the directory identity', async () => {
    await expect(resolveProfileUiBaseUrlForUser(USER_ID, TEAM_ID)).resolves.toBe(configuredOrigin)
    await expect(resolveProfileUiBaseUrlForUser(USER_ID, TEAM_ID)).resolves.toBe(configuredOrigin)

    expect(directory.getMe).toHaveBeenCalledTimes(2)
    expect(memberRegistration.request).toHaveBeenCalledTimes(1)
  })

  it('deduplicates concurrent lookups for the same verified identity', async () => {
    let resolveLookup!: (value: unknown) => void
    memberRegistration.request.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          resolveLookup = resolve
        })
    )

    const first = resolveProfileUiBaseUrlForUser(USER_ID, TEAM_ID)
    const second = resolveProfileUiBaseUrlForUser(USER_ID, TEAM_ID)
    await vi.waitFor(() => expect(memberRegistration.request).toHaveBeenCalledTimes(1))
    resolveLookup({ valid: true, email: EMAIL, profileUiBaseUrl: configuredOrigin })

    await expect(Promise.all([first, second])).resolves.toEqual([
      configuredOrigin,
      configuredOrigin,
    ])
    expect(memberRegistration.request).toHaveBeenCalledTimes(1)
  })

  it('refreshes an exact-origin cache entry after its bounded TTL', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-19T00:00:00.000Z'))
    await expect(resolveProfileUiBaseUrlForUser(USER_ID, TEAM_ID)).resolves.toBe(configuredOrigin)

    vi.advanceTimersByTime(5 * 60 * 1000)
    await expect(resolveProfileUiBaseUrlForUser(USER_ID, TEAM_ID)).resolves.toBe(configuredOrigin)

    expect(memberRegistration.request).toHaveBeenCalledTimes(2)
  })

  it('separates cached origins by current directory email and team', async () => {
    await expect(resolveProfileUiBaseUrlForUser(USER_ID, TEAM_ID)).resolves.toBe(configuredOrigin)
    directory.getMe.mockResolvedValueOnce({ id: USER_ID, email: 'new@example.com' })
    memberRegistration.request.mockResolvedValueOnce({
      valid: true,
      email: 'new@example.com',
      profileUiBaseUrl: configuredOrigin,
    })
    await expect(resolveProfileUiBaseUrlForUser(USER_ID, TEAM_ID)).resolves.toBe(configuredOrigin)
    await expect(resolveProfileUiBaseUrlForUser(USER_ID, 'team-2')).resolves.toBe(configuredOrigin)
    directory.getMe.mockResolvedValueOnce({ id: 'user-2', email: EMAIL })
    await expect(resolveProfileUiBaseUrlForUser('user-2', TEAM_ID)).resolves.toBe(configuredOrigin)
    const nextConfiguredOrigin = 'https://profile-config-next.example'
    profileConfig.desktopProfileUiBaseUrl = nextConfiguredOrigin
    directory.getMe.mockResolvedValue({ id: 'user-2', email: EMAIL })
    memberRegistration.request.mockResolvedValueOnce({
      valid: true,
      email: EMAIL,
      profileUiBaseUrl: nextConfiguredOrigin,
    })
    await expect(resolveProfileUiBaseUrlForUser('user-2', TEAM_ID)).resolves.toBe(
      nextConfiguredOrigin
    )

    expect(memberRegistration.request).toHaveBeenCalledTimes(5)
    expect(memberRegistration.request).toHaveBeenNthCalledWith(
      2,
      'POST',
      '/invitations-flow/profile',
      expect.objectContaining({
        body: { email: 'new@example.com', domain: new URL(configuredOrigin).hostname },
      })
    )
  })

  it('does not cache a missing or mismatching activation result', async () => {
    memberRegistration.request.mockResolvedValueOnce({ valid: false, email: EMAIL })
    await expect(resolveProfileUiBaseUrlForUser(USER_ID, TEAM_ID)).resolves.toBeNull()

    memberRegistration.request.mockResolvedValueOnce({
      valid: true,
      email: EMAIL,
      profileUiBaseUrl: configuredOrigin,
    })
    await expect(resolveProfileUiBaseUrlForUser(USER_ID, TEAM_ID)).resolves.toBe(configuredOrigin)
    expect(memberRegistration.request).toHaveBeenCalledTimes(2)
  })

  it('does not cache a throttled MRS lookup, so a later request can retry', async () => {
    memberRegistration.request.mockRejectedValueOnce(new Error('rate limited (429)'))
    await expect(resolveProfileUiBaseUrlForUser(USER_ID, TEAM_ID)).rejects.toThrow('rate limited')

    memberRegistration.request.mockResolvedValueOnce({
      valid: true,
      email: EMAIL,
      profileUiBaseUrl: configuredOrigin,
    })
    await expect(resolveProfileUiBaseUrlForUser(USER_ID, TEAM_ID)).resolves.toBe(configuredOrigin)
    expect(memberRegistration.request).toHaveBeenCalledTimes(2)
  })

  it('does not fabricate a Profile origin when activation lookup fails', async () => {
    memberRegistration.request.mockRejectedValueOnce(new Error('lookup unavailable'))

    await expect(resolveProfileUiBaseUrlForUser(USER_ID, TEAM_ID)).rejects.toThrow(
      'lookup unavailable'
    )
  })
})
