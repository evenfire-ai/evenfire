import { beforeEach, describe, expect, it, vi } from 'vitest'
import { controlApiRequest, controlApiRequestWithStatus } from '../src/controlApiClient.js'
import {
  confirmWorkflowApprovalMediumChallenge,
  createWorkflowApprovalMediumChallenge,
  createWorkflowApprovalMediumLinkSession,
  disableWorkflowApprovalMedium,
  listApprovalChannelTargets,
  listWorkflowApprovalMediums,
  preferWorkflowApprovalMedium,
} from '../src/services/workflowApprovalMediumsService.js'

vi.mock('../src/controlApiClient.js', () => ({
  controlApiRequest: vi.fn(),
  controlApiRequestWithStatus: vi.fn(),
}))

describe('workflowApprovalMediumsService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('creates non-Telegram medium verification challenges through the control-api external lane', async () => {
    vi.mocked(controlApiRequest).mockResolvedValueOnce({
      challengeId: 'challenge-1',
      expiresAt: '2026-05-03T12:00:00.000Z',
      delivery: { channel: 'first-party-email' },
    })

    await expect(
      createWorkflowApprovalMediumChallenge('session-token', {
        medium: 'slack',
        providerUserId: 'U123',
        providerWorkspaceId: 'T123',
      })
    ).resolves.toMatchObject({ challengeId: 'challenge-1' })

    expect(controlApiRequest).toHaveBeenCalledWith(
      'POST',
      '/external/workflow-approval-mediums/challenges',
      {
        userSessionToken: 'session-token',
        body: {
          medium: 'slack',
          providerUserId: 'U123',
          providerWorkspaceId: 'T123',
        },
      }
    )
  })

  it('creates target-scoped Telegram challenges without browser-supplied provider identity', async () => {
    vi.mocked(controlApiRequest).mockResolvedValueOnce({
      challengeId: 'challenge-1',
      expiresAt: '2026-06-02T12:00:00.000Z',
      code: '123456',
      delivery: { channel: 'telegram-provider-event' },
    })

    await expect(
      createWorkflowApprovalMediumChallenge('session-token', {
        medium: 'telegram',
        targetId: 'telegram:target',
      })
    ).resolves.toMatchObject({ challengeId: 'challenge-1', code: '123456' })

    expect(controlApiRequest).toHaveBeenCalledWith(
      'POST',
      '/external/workflow-approval-mediums/challenges',
      {
        userSessionToken: 'session-token',
        body: {
          medium: 'telegram',
          targetId: 'telegram:target',
        },
      }
    )
  })

  it('creates reader-driven link sessions through the control-api external lane', async () => {
    vi.mocked(controlApiRequest).mockResolvedValueOnce({
      linkSessionId: 'session-1',
      nonce: '123456',
      expiresAt: '2026-06-01T10:00:00.000Z',
      deepLinkUrl: null,
    })

    await expect(
      createWorkflowApprovalMediumLinkSession('session-token', {
        medium: 'slack',
        providerWorkspaceId: 'T123',
      })
    ).resolves.toMatchObject({ linkSessionId: 'session-1' })

    expect(controlApiRequest).toHaveBeenCalledWith(
      'POST',
      '/external/workflow-approval-mediums/link-sessions',
      {
        userSessionToken: 'session-token',
        body: {
          medium: 'slack',
          providerWorkspaceId: 'T123',
        },
      }
    )
  })

  it('lists approval channel targets through user session auth', async () => {
    vi.mocked(controlApiRequest).mockResolvedValueOnce({ items: [] })

    await expect(listApprovalChannelTargets('session-token')).resolves.toEqual({ items: [] })

    expect(controlApiRequest).toHaveBeenCalledWith(
      'GET',
      '/external/workflow-approval-mediums/targets',
      {
        userSessionToken: 'session-token',
      }
    )
  })

  it('confirms a six digit medium challenge', async () => {
    vi.mocked(controlApiRequest).mockResolvedValueOnce({ ok: true, accountId: 'account-1' })

    await expect(
      confirmWorkflowApprovalMediumChallenge('session-token', 'challenge/1', '123456')
    ).resolves.toEqual({ ok: true, accountId: 'account-1' })

    expect(controlApiRequest).toHaveBeenCalledWith(
      'POST',
      '/external/workflow-approval-mediums/challenges/challenge%2F1/confirm',
      {
        userSessionToken: 'session-token',
        body: { code: '123456' },
      }
    )
  })

  it('lists, prefers, and disables verified mediums through user session auth', async () => {
    vi.mocked(controlApiRequest).mockResolvedValueOnce({ items: [] })
    vi.mocked(controlApiRequest).mockResolvedValueOnce({
      ok: true,
      account: { id: 'account/1', isPreferred: true },
    })
    vi.mocked(controlApiRequestWithStatus).mockResolvedValueOnce({ data: null, status: 204 })

    await expect(
      listWorkflowApprovalMediums('session-token', { includeDisabled: true })
    ).resolves.toEqual({ items: [] })
    await expect(preferWorkflowApprovalMedium('session-token', 'account/1')).resolves.toEqual({
      ok: true,
      account: { id: 'account/1', isPreferred: true },
    })
    await expect(
      disableWorkflowApprovalMedium('session-token', 'account/1')
    ).resolves.toBeUndefined()

    expect(controlApiRequest).toHaveBeenCalledWith('GET', '/external/workflow-approval-mediums', {
      userSessionToken: 'session-token',
      query: { includeDisabled: 'true' },
    })
    expect(controlApiRequest).toHaveBeenCalledWith(
      'PUT',
      '/external/workflow-approval-mediums/account%2F1/preference',
      {
        userSessionToken: 'session-token',
      }
    )
    expect(controlApiRequestWithStatus).toHaveBeenCalledWith(
      'DELETE',
      '/external/workflow-approval-mediums/account%2F1',
      {
        userSessionToken: 'session-token',
      }
    )
  })
})
