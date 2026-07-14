import { beforeEach, describe, expect, it, vi } from 'vitest'
import { pool, withTransaction } from '../src/db.js'
import { getTeamAgents, getUserAgents, listTeams } from '../src/services/directory/index.js'
import { createChallengeCodeHash } from '../src/services/workflowApprovalMediumIdentityService.js'
import { confirmTelegramProviderEventChallenge } from '../src/services/workflowApprovalMediumTelegramProviderEventService.js'
import {
  addTelegramTargetAssociation,
  removeTelegramTargetAssociation,
} from '../src/services/workflowApprovalMediumTelegramTargetAssociationService.js'
import {
  TELEGRAM_PROVIDER_EVENT_PENDING_USER_ID,
  listTelegramApprovalTargets,
} from '../src/services/workflowApprovalMediumTelegramVerificationService.js'
import { MockGateway } from './mockGateway.js'

vi.mock('../src/db.js', () => ({
  pool: { query: vi.fn() },
  withTransaction: vi.fn(),
}))

vi.mock('../src/services/directory/index.js', () => ({
  getTeamAgents: vi.fn(),
  getUserAgents: vi.fn(),
  listTeams: vi.fn(),
}))

const mockedQuery = vi.mocked(pool.query) as ReturnType<typeof vi.fn>
const mockedWithTransaction = vi.mocked(withTransaction)
const mockedGetUserAgents = vi.mocked(getUserAgents)
const mockedGetTeamAgents = vi.mocked(getTeamAgents)
const mockedListTeams = vi.mocked(listTeams)

function telegramProviderTarget() {
  return {
    hostRef: 'agent-a',
    communicationChannelNamespace: 'channels',
    communicationChannelName: 'agent-a-telegram',
  }
}

async function seedTelegramChannel(gateway: MockGateway, name = 'agent-a-telegram') {
  return gateway.createResource(
    'communicationchannels',
    {
      metadata: { name },
      spec: {
        hostRef: 'agent-a',
        access: { users: ['user-1'], teams: [] },
        credentialsSecretRef: { name: `${name}-credentials` },
        telegram: [{ channelId: 'seed-chat', chatType: 'private', userIds: ['seed-user'] }],
      },
    },
    'channels'
  )
}

function seedFinalChallengeExpiredMocks(targetId: string) {
  const row = {
    id: 'challenge-1',
    userId: 'user-1',
    userEmail: 'user@example.com',
    targetId,
    codeHash: createChallengeCodeHash({
      userId: 'user-1',
      medium: 'telegram',
      providerUserId: TELEGRAM_PROVIDER_EVENT_PENDING_USER_ID,
      code: '123456',
      saltHex: 'abcd'.repeat(8),
    }),
    isExpired: false,
    consumedAt: null,
    attempts: 0,
  }
  mockedQuery.mockResolvedValueOnce({ rows: [row], rowCount: 1 } as never)
  const txQuery = vi.fn()
  mockedWithTransaction.mockImplementation(async work => work({ query: txQuery } as never))
  txQuery
    .mockResolvedValueOnce({ rows: [row], rowCount: 1 })
    .mockResolvedValueOnce({ rows: [], rowCount: 0 })
    .mockResolvedValueOnce({ rows: [{ ...row, isExpired: true }], rowCount: 1 })
}

function seedFinalChallengeConsumedMocks(targetId: string, verifiedAfterConsumption: boolean) {
  const row = {
    id: 'challenge-1',
    userId: 'user-1',
    userEmail: 'user@example.com',
    targetId,
    codeHash: createChallengeCodeHash({
      userId: 'user-1',
      medium: 'telegram',
      providerUserId: TELEGRAM_PROVIDER_EVENT_PENDING_USER_ID,
      code: '123456',
      saltHex: 'abcd'.repeat(8),
    }),
    isExpired: false,
    consumedAt: null,
    attempts: 0,
  }
  mockedQuery.mockResolvedValueOnce({ rows: [row], rowCount: 1 } as never).mockResolvedValueOnce({
    rows: verifiedAfterConsumption ? [{ id: 'account-1' }] : [],
    rowCount: verifiedAfterConsumption ? 1 : 0,
  } as never)
  const txQuery = vi.fn()
  mockedWithTransaction.mockImplementation(async work => work({ query: txQuery } as never))
  txQuery
    .mockResolvedValueOnce({ rows: [row], rowCount: 1 })
    .mockResolvedValueOnce({ rows: [], rowCount: 0 })
    .mockResolvedValueOnce({
      rows: [{ ...row, consumedAt: new Date().toISOString() }],
      rowCount: 1,
    })
}

function seedFinalIdentityAlreadyVerifiedBySameUserMocks(targetId: string) {
  const row = {
    id: 'challenge-1',
    userId: 'user-1',
    userEmail: 'user@example.com',
    targetId,
    codeHash: createChallengeCodeHash({
      userId: 'user-1',
      medium: 'telegram',
      providerUserId: TELEGRAM_PROVIDER_EVENT_PENDING_USER_ID,
      code: '123456',
      saltHex: 'abcd'.repeat(8),
    }),
    isExpired: false,
    consumedAt: null,
    attempts: 0,
  }
  mockedQuery.mockResolvedValueOnce({ rows: [row], rowCount: 1 } as never)
  const txQuery = vi.fn()
  mockedWithTransaction.mockImplementation(async work => work({ query: txQuery } as never))
  txQuery
    .mockResolvedValueOnce({ rows: [row], rowCount: 1 })
    .mockResolvedValueOnce({ rows: [], rowCount: 0 })
    .mockResolvedValueOnce({ rows: [row], rowCount: 1 })
    .mockResolvedValueOnce({ rows: [], rowCount: 0 })
    .mockResolvedValueOnce({ rows: [{ id: 'account-1', user_id: 'user-1' }], rowCount: 1 })
    .mockResolvedValueOnce({ rows: [], rowCount: 1 })
  return txQuery
}

describe('Telegram provider event association rollback', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockedQuery.mockReset()
    mockedWithTransaction.mockReset()
    mockedGetUserAgents.mockResolvedValue({ userId: 'user-1', agentNames: ['agent-a'] })
    mockedGetTeamAgents.mockResolvedValue({ teamId: 'team-1', agentNames: [] })
    mockedListTeams.mockResolvedValue({ currentTeamId: '', items: [] })
  })

  it('rolls back only the selected target when final challenge consumption fails', async () => {
    const gateway = new MockGateway('channels')
    await seedTelegramChannel(gateway)
    await seedTelegramChannel(gateway, 'agent-a-secondary')
    const secondary = (await gateway.getResource(
      'communicationchannels',
      'agent-a-secondary',
      'channels'
    )) as { spec: { telegram: Array<{ channelId: string; chatType: string; userIds: string[] }> } }
    secondary.spec.telegram.push({ channelId: '777', chatType: 'private', userIds: ['777'] })
    const targets = await listTelegramApprovalTargets({
      gateway: gateway as never,
      userId: 'user-1',
    })
    const selected = targets.items.find(target => target.channelName === 'agent-a-telegram')!
    seedFinalChallengeExpiredMocks(selected.id)

    await expect(
      confirmTelegramProviderEventChallenge({
        gateway: gateway as never,
        code: '123456',
        providerUserId: '777',
        providerChannelId: '777',
        providerChannelType: 'private',
        providerTarget: telegramProviderTarget(),
      })
    ).resolves.toEqual({ ok: false, error: 'challenge_expired' })

    const selectedChannel = (await gateway.getResource(
      'communicationchannels',
      'agent-a-telegram',
      'channels'
    )) as { spec: { telegram: Array<{ channelId: string; chatType: string; userIds: string[] }> } }
    expect(selectedChannel.spec.telegram).not.toContainEqual({
      channelId: '777',
      chatType: 'private',
      userIds: ['777'],
    })
    expect(secondary.spec.telegram).toContainEqual({
      channelId: '777',
      chatType: 'private',
      userIds: ['777'],
    })
  })

  it('rolls back the selected target when a consumed challenge did not verify this identity', async () => {
    const gateway = new MockGateway('channels')
    await seedTelegramChannel(gateway)
    const [selected] = (
      await listTelegramApprovalTargets({ gateway: gateway as never, userId: 'user-1' })
    ).items
    seedFinalChallengeConsumedMocks(selected!.id, false)

    await expect(
      confirmTelegramProviderEventChallenge({
        gateway: gateway as never,
        code: '123456',
        providerUserId: '777',
        providerChannelId: '777',
        providerChannelType: 'private',
        providerTarget: telegramProviderTarget(),
      })
    ).resolves.toEqual({ ok: false, error: 'challenge_consumed' })

    const selectedChannel = (await gateway.getResource(
      'communicationchannels',
      'agent-a-telegram',
      'channels'
    )) as { spec: { telegram: Array<{ channelId: string; chatType: string; userIds: string[] }> } }
    expect(selectedChannel.spec.telegram).not.toContainEqual({
      channelId: '777',
      chatType: 'private',
      userIds: ['777'],
    })
  })

  it('keeps the selected target when a consumed challenge already verified this identity', async () => {
    const gateway = new MockGateway('channels')
    await seedTelegramChannel(gateway)
    const [selected] = (
      await listTelegramApprovalTargets({ gateway: gateway as never, userId: 'user-1' })
    ).items
    seedFinalChallengeConsumedMocks(selected!.id, true)

    await expect(
      confirmTelegramProviderEventChallenge({
        gateway: gateway as never,
        code: '123456',
        providerUserId: '777',
        providerChannelId: '777',
        providerChannelType: 'private',
        providerTarget: telegramProviderTarget(),
      })
    ).resolves.toEqual({ ok: false, error: 'challenge_consumed' })

    const selectedChannel = (await gateway.getResource(
      'communicationchannels',
      'agent-a-telegram',
      'channels'
    )) as { spec: { telegram: Array<{ channelId: string; chatType: string; userIds: string[] }> } }
    expect(selectedChannel.spec.telegram).toContainEqual(
      expect.objectContaining({
        channelId: '777',
        chatType: 'private',
        confirmedByUserId: 'user-1',
      })
    )
  })

  it('keeps the selected target when the same user already owns the verified identity', async () => {
    const gateway = new MockGateway('channels')
    await seedTelegramChannel(gateway)
    const [selected] = (
      await listTelegramApprovalTargets({ gateway: gateway as never, userId: 'user-1' })
    ).items
    const txQuery = seedFinalIdentityAlreadyVerifiedBySameUserMocks(selected!.id)

    await expect(
      confirmTelegramProviderEventChallenge({
        gateway: gateway as never,
        code: '123456',
        providerUserId: '777',
        providerChannelId: '777',
        providerChannelType: 'private',
        providerTarget: telegramProviderTarget(),
      })
    ).resolves.toEqual({
      ok: true,
      accountId: 'account-1',
      userEmail: 'user@example.com',
    })

    const selectedChannel = (await gateway.getResource(
      'communicationchannels',
      'agent-a-telegram',
      'channels'
    )) as { spec: { telegram: Array<{ channelId: string; chatType: string; userIds: string[] }> } }
    expect(selectedChannel.spec.telegram).toContainEqual(
      expect.objectContaining({
        channelId: '777',
        chatType: 'private',
        confirmedByUserId: 'user-1',
      })
    )
    expect(
      txQuery.mock.calls.some(call => String(call[0]).includes('SET consumed_at = NOW()'))
    ).toBe(true)
  })

  it('does not remove a pre-existing transport filter when association was already present', async () => {
    const gateway = new MockGateway('channels')
    await seedTelegramChannel(gateway)
    const channel = (await gateway.getResource(
      'communicationchannels',
      'agent-a-telegram',
      'channels'
    )) as { spec: { telegram: Array<{ channelId: string; chatType: string; userIds: string[] }> } }
    channel.spec.telegram.push({ channelId: '777', chatType: 'private', userIds: ['777'] })
    const [selected] = (
      await listTelegramApprovalTargets({ gateway: gateway as never, userId: 'user-1' })
    ).items
    seedFinalChallengeExpiredMocks(selected!.id)

    await expect(
      confirmTelegramProviderEventChallenge({
        gateway: gateway as never,
        code: '123456',
        providerUserId: '777',
        providerChannelId: '777',
        providerChannelType: 'private',
        providerTarget: telegramProviderTarget(),
      })
    ).resolves.toEqual({ ok: false, error: 'challenge_expired' })

    expect(channel.spec.telegram).toContainEqual({
      channelId: '777',
      chatType: 'private',
      userIds: ['777'],
    })
  })

  it('rolls back a provider-id confirmed row when the member id is not available', async () => {
    const gateway = new MockGateway('channels')
    await seedTelegramChannel(gateway)
    const [selected] = (
      await listTelegramApprovalTargets({ gateway: gateway as never, userId: 'user-1' })
    ).items
    const channel = (await gateway.getResource(
      'communicationchannels',
      'agent-a-telegram',
      'channels'
    )) as {
      spec: {
        telegram: Array<{
          channelId: string
          chatType: string
          userIds?: string[]
          confirmedByUserId?: string
        }>
      }
    }
    channel.spec.telegram.push({
      channelId: '777',
      chatType: 'private',
      confirmedByUserId: '777',
    })

    await removeTelegramTargetAssociation(
      gateway as never,
      selected!,
      {
        providerUserId: '777',
        providerChannelId: '777',
        providerChannelType: 'private',
      },
      { changed: true, previousGroup: null }
    )

    const updatedChannel = (await gateway.getResource(
      'communicationchannels',
      'agent-a-telegram',
      'channels'
    )) as {
      spec: {
        telegram: Array<{
          channelId: string
          chatType: string
          userIds?: string[]
          confirmedByUserId?: string
        }>
      }
    }

    expect(updatedChannel.spec.telegram).not.toContainEqual(
      expect.objectContaining({
        channelId: '777',
        chatType: 'private',
        confirmedByUserId: '777',
      })
    )
  })

  it('reports no local mutation when a retry observes an association from another writer', async () => {
    const mutateResource = vi.fn(async (_plural, _name, mutate) => {
      await mutate({ spec: { hostRef: 'agent-a', telegram: [] } })
      return mutate({
        spec: {
          hostRef: 'agent-a',
          telegram: [
            {
              channelId: '777',
              chatType: 'private',
              confirmedByUserId: '777',
              userIds: ['777'],
            },
          ],
        },
      })
    })

    await expect(
      addTelegramTargetAssociation(
        { mutateResource } as never,
        {
          id: 'telegram:target',
          medium: 'telegram',
          agentName: 'agent-a',
          channelName: 'agent-a-telegram',
          channelNamespace: 'channels',
          botLabel: 'Agent Telegram bot',
          botUsername: null,
          botDeepLink: null,
          status: 'ready',
        },
        { providerUserId: '777', providerChannelId: '777' }
      )
    ).resolves.toEqual({ changed: false })
  })
})
