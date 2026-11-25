import { afterEach, describe, expect, it, vi } from 'vitest'

const originalProfileUrl = process.env.CONTROL_API_DESKTOP_PROFILE_UI_BASE_URL
const originalExternalRestUrl = process.env.CONTROL_API_DESKTOP_EXTERNAL_REST_API_BASE_URL
const originalAlias = process.env.DESKTOP_PROFILE_UI_PUBLIC_BASE_URL

afterEach(() => {
  vi.doUnmock('../src/memberRegistrationServiceClient.js')
  vi.resetModules()
  if (originalProfileUrl === undefined) delete process.env.CONTROL_API_DESKTOP_PROFILE_UI_BASE_URL
  else process.env.CONTROL_API_DESKTOP_PROFILE_UI_BASE_URL = originalProfileUrl
  if (originalExternalRestUrl === undefined)
    delete process.env.CONTROL_API_DESKTOP_EXTERNAL_REST_API_BASE_URL
  else process.env.CONTROL_API_DESKTOP_EXTERNAL_REST_API_BASE_URL = originalExternalRestUrl
  if (originalAlias === undefined) delete process.env.DESKTOP_PROFILE_UI_PUBLIC_BASE_URL
  else process.env.DESKTOP_PROFILE_UI_PUBLIC_BASE_URL = originalAlias
})

describe('canonical Profile UI origin invitation consumer', () => {
  it('sends the established operator origin to the member-registration invitation API', async () => {
    const canonicalOrigin = 'https://profile.legacy.example.test'
    process.env.CONTROL_API_DESKTOP_PROFILE_UI_BASE_URL = canonicalOrigin
    process.env.CONTROL_API_DESKTOP_EXTERNAL_REST_API_BASE_URL = 'https://api.example.test'
    // This is the inherited feature-variable value from the pre-correction base.
    process.env.DESKTOP_PROFILE_UI_PUBLIC_BASE_URL = 'http://127.0.0.1:3001'

    const request = vi.fn().mockResolvedValue({ sent: true, registered: true })
    vi.doMock('../src/memberRegistrationServiceClient.js', () => ({
      memberRegistrationServiceRequest: request,
    }))
    vi.resetModules()

    const [{ config }, { registerAndSendInvitation }] = await Promise.all([
      import('../src/config.js'),
      import('../src/services/invitationFlowRegistrationService.js'),
    ])
    await registerAndSendInvitation(
      'person@example.test',
      'invitation-id',
      null,
      '2026-11-15T00:00:00.000Z',
      '2026-11-16T00:00:00.000Z'
    )

    expect(config.desktopProfileUiBaseUrl).toBe(canonicalOrigin)
    expect(request).toHaveBeenCalledWith(
      'POST',
      '/invitations-flow/invitations',
      expect.objectContaining({
        destinationBaseUrl: canonicalOrigin,
        body: expect.objectContaining({ desktopProfileUiBaseUrl: canonicalOrigin }),
      })
    )
  })
})
