import { beforeEach, describe, expect, it, vi } from 'vitest'
import { pool, withTransaction } from '../src/db.js'
import { getTeamAgents, getUserAgents, listTeams } from '../src/services/directory/index.js'
import { createChallengeCodeHash } from '../src/services/workflowApprovalMediumIdentityService.js'
import { confirmTelegramProviderEventChallenge } from '../src/services/workflowApprovalMediumTelegramProviderEventService.js'
import {
  addTelegramTargetAssociation,
  removeTelegramAssociations,
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

function telegramProviderTarget(hostRef = 'agent-a') {
  return {
    hostRef,
    communicationChannelNamespace: 'channels',
    communicationChannelName: `${hostRef}-telegram`,
  }
}

async function seedTelegramChannel(gateway: MockGateway) {
  return gateway.createResource(
    'communicationchannels',
    {
      metadata: { name: 'agent-a-telegram' },
      spec: {
        hostRef: 'agent-a',
        access: { users: ['user-1'], teams: [] },
        credentialsSecretRef: { name: 'agent-a-credentials' },
        telegram: [{ channelId: 'seed-chat', chatType: 'private', userIds: ['seed-user'] }],
      },
    },
    'channels'
  )
}

function challengeRow(targetId: string) {
  const codeHash = createChallengeCodeHash({
    userId: 'user-1',
    medium: 'telegram',
    providerUserId: TELEGRAM_PROVIDER_EVENT_PENDING_USER_ID,
    code: '123456',
    saltHex: 'abcd'.repeat(8),
  })
  return {
    id: 'challenge-1',
    userId: 'user-1',
    userEmail: 'user@example.com',
    targetId,
    codeHash,
    isExpired: false,
    consumedAt: null,
    attempts: 0,
  }
}

function seedChallengeMocks(targetId: string) {
  const row = challengeRow(targetId)
  mockedQuery.mockResolvedValueOnce({
    rows: [row],
    rowCount: 1,
  } as never)
  const txQuery = vi.fn()
  mockedWithTransaction.mockImplementation(async work => work({ query: txQuery } as never))
  txQuery
    .mockResolvedValueOnce({ rows: [row], rowCount: 1 })
    .mockResolvedValueOnce({ rows: [], rowCount: 0 })
    .mockResolvedValueOnce({ rows: [row], rowCount: 1 })
    .mockResolvedValueOnce({ rows: [{ id: 'account-1' }], rowCount: 1 })
    .mockResolvedValueOnce({ rows: [], rowCount: 1 })
  return txQuery
}

function seedAlreadyVerifiedByAnotherUserMocks(targetId: string) {
  const row = challengeRow(targetId)
  mockedQuery.mockResolvedValueOnce({
    rows: [row],
    rowCount: 1,
  } as never)
  const txQuery = vi.fn()
  mockedWithTransaction.mockImplementation(async work => work({ query: txQuery } as never))
  txQuery
    .mockResolvedValueOnce({ rows: [row], rowCount: 1 })
    .mockResolvedValueOnce({ rows: [{ id: 'account-2' }], rowCount: 1 })
  return txQuery
}

function seedAssociationRetryMocks(targetId: string) {
  const row = challengeRow(targetId)
  mockedQuery
    .mockResolvedValueOnce({ rows: [row], rowCount: 1 } as never)
    .mockResolvedValueOnce({ rows: [row], rowCount: 1 } as never)
  const txQuery = vi.fn()
  mockedWithTransaction.mockImplementation(async work => work({ query: txQuery } as never))
  txQuery
    .mockResolvedValueOnce({
      rows: [row],
      rowCount: 1,
    })
    .mockResolvedValueOnce({ rows: [], rowCount: 0 })
    .mockResolvedValueOnce({ rows: [row], rowCount: 1 })
    .mockResolvedValueOnce({ rows: [], rowCount: 0 })
    .mockResolvedValueOnce({ rows: [row], rowCount: 1 })
    .mockResolvedValueOnce({ rows: [{ id: 'account-1' }], rowCount: 1 })
    .mockResolvedValueOnce({ rows: [], rowCount: 1 })
  return txQuery
}

describe('Telegram provider event CommunicationChannel mutation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockedQuery.mockReset()
    mockedWithTransaction.mockReset()
    mockedGetUserAgents.mockResolvedValue({ userId: 'user-1', agentNames: ['agent-a'] })
    mockedGetTeamAgents.mockResolvedValue({ teamId: 'team-1', agentNames: [] })
    mockedListTeams.mockResolvedValue({ currentTeamId: '', items: [] })
  })

  it('keeps separate confirmed rows when two members verify the same group', async () => {
    const gateway = new MockGateway('channels')
    await seedTelegramChannel(gateway)
    const [target] = (
      await listTelegramApprovalTargets({ gateway: gateway as never, userId: 'user-1' })
    ).items

    await addTelegramTargetAssociation(gateway as never, target!, {
      userId: 'user-1',
      providerUserId: 'telegram-user-1',
      providerChannelId: 'group-777',
      providerChannelType: 'group',
      providerChannelTitle: 'Release room',
    })
    await addTelegramTargetAssociation(gateway as never, target!, {
      userId: 'user-2',
      providerUserId: 'telegram-user-2',
      providerChannelId: 'group-777',
      providerChannelType: 'group',
      providerChannelTitle: 'Release room',
    })

    const channel = (await gateway.getResource(
      'communicationchannels',
      'agent-a-telegram',
      'channels'
    )) as {
      spec: {
        telegram: Array<{
          channelId: string
          chatType: string
          confirmedByUserId?: string
          userIds?: string[]
        }>
      }
    }
    const groupRows = channel.spec.telegram.filter(group => group.channelId === 'group-777')
    expect(groupRows).toHaveLength(2)
    expect(groupRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          channelId: 'group-777',
          chatType: 'group',
          confirmedByUserId: 'user-1',
        }),
        expect.objectContaining({
          channelId: 'group-777',
          chatType: 'group',
          confirmedByUserId: 'user-2',
        }),
      ])
    )
    expect(groupRows.every(group => group.userIds === undefined)).toBe(true)
  })

  it('removes only the current member when disconnecting a shared verified group', async () => {
    const gateway = new MockGateway('channels')
    await seedTelegramChannel(gateway)
    const [target] = (
      await listTelegramApprovalTargets({ gateway: gateway as never, userId: 'user-1' })
    ).items
    await addTelegramTargetAssociation(gateway as never, target!, {
      userId: 'user-1',
      providerUserId: 'telegram-user-1',
      providerChannelId: 'group-777',
      providerChannelType: 'group',
    })
    await addTelegramTargetAssociation(gateway as never, target!, {
      userId: 'user-2',
      providerUserId: 'telegram-user-2',
      providerChannelId: 'group-777',
      providerChannelType: 'group',
    })

    await removeTelegramAssociations({
      gateway: gateway as never,
      userId: 'user-1',
      providerChannelId: 'group-777',
    })

    const channel = (await gateway.getResource(
      'communicationchannels',
      'agent-a-telegram',
      'channels'
    )) as {
      spec: { telegram: Array<{ channelId: string; confirmedByUserId?: string }> }
    }
    const groupRows = channel.spec.telegram.filter(group => group.channelId === 'group-777')
    expect(groupRows).toEqual([
      expect.objectContaining({
        channelId: 'group-777',
        confirmedByUserId: 'user-2',
      }),
    ])
  })

  it('preserves concurrent conversations while adding a confirmed conversation', async () => {
    const gateway = new MockGateway('channels')
    await seedTelegramChannel(gateway)
    const [target] = (
      await listTelegramApprovalTargets({ gateway: gateway as never, userId: 'user-1' })
    ).items
    seedChallengeMocks(target!.id)

    const originalMutateResource = gateway.mutateResource.bind(gateway)
    let injectedConcurrentEntry = false
    vi.spyOn(gateway, 'mutateResource').mockImplementation((plural, name, mutate, namespace) =>
      originalMutateResource(
        plural,
        name,
        current => {
          if (!injectedConcurrentEntry) {
            injectedConcurrentEntry = true
            const telegram = Array.isArray(current.spec.telegram) ? current.spec.telegram : []
            telegram.push({ channelId: 'concurrent-group', chatType: 'group', userIds: ['999'] })
            current.spec.telegram = telegram
          }
          return mutate(current)
        },
        namespace
      )
    )

    await expect(
      confirmTelegramProviderEventChallenge({
        gateway: gateway as never,
        code: '123456',
        providerUserId: '777',
        providerChannelId: '777',
        providerChannelType: 'private',
        providerTarget: telegramProviderTarget('agent-a'),
      })
    ).resolves.toEqual({
      ok: true,
      accountId: 'account-1',
      userEmail: 'user@example.com',
    })

    const channel = (await gateway.getResource(
      'communicationchannels',
      'agent-a-telegram',
      'channels'
    )) as {
      spec: { telegram: Array<{ channelId: string; chatType: string; userIds: string[] }> }
    }
    expect(channel.spec.telegram).toContainEqual({
      channelId: 'concurrent-group',
      chatType: 'group',
      userIds: ['999'],
    })
    expect(channel.spec.telegram).toContainEqual(
      expect.objectContaining({
        channelId: '777',
        chatType: 'private',
        confirmedByUserId: 'user-1',
      })
    )
  })

  it('confirms from Telegram provider identity and enables only the selected target', async () => {
    const gateway = new MockGateway('channels')
    await seedTelegramChannel(gateway)
    const [target] = (
      await listTelegramApprovalTargets({ gateway: gateway as never, userId: 'user-1' })
    ).items
    const txQuery = seedChallengeMocks(target!.id)

    await expect(
      confirmTelegramProviderEventChallenge({
        gateway: gateway as never,
        code: '123456',
        providerUserId: '777',
        providerChannelId: '777',
        providerChannelType: 'private',
        providerTarget: telegramProviderTarget('agent-a'),
      })
    ).resolves.toEqual({
      ok: true,
      accountId: 'account-1',
      userEmail: 'user@example.com',
    })

    const channel = (await gateway.getResource(
      'communicationchannels',
      'agent-a-telegram',
      'channels'
    )) as {
      spec: { telegram: Array<{ channelId: string; chatType: string; userIds: string[] }> }
    }
    expect(channel.spec.telegram).toContainEqual(
      expect.objectContaining({
        channelId: '777',
        chatType: 'private',
        confirmedByUserId: 'user-1',
      })
    )
    const consumedAtUpdates = txQuery.mock.calls.filter(call =>
      String(call[0]).includes('SET consumed_at = NOW()')
    )
    expect(consumedAtUpdates).toHaveLength(1)
  })

  it('accepts a shared-bot candidate target list when only a secondary target matches', async () => {
    const gateway = new MockGateway('channels')
    await seedTelegramChannel(gateway)
    const [target] = (
      await listTelegramApprovalTargets({ gateway: gateway as never, userId: 'user-1' })
    ).items
    seedChallengeMocks(target!.id)

    await expect(
      confirmTelegramProviderEventChallenge({
        gateway: gateway as never,
        code: '123456',
        providerUserId: '777',
        providerChannelId: '777',
        providerChannelType: 'private',
        providerTarget: telegramProviderTarget('agent-unrelated'),
        providerTargets: [
          telegramProviderTarget('agent-unrelated'),
          telegramProviderTarget('agent-a'),
        ],
      })
    ).resolves.toEqual({
      ok: true,
      accountId: 'account-1',
      userEmail: 'user@example.com',
    })
  })

  it('rejects provider confirmation when the Telegram identity is already verified by another user', async () => {
    const gateway = new MockGateway('channels')
    await seedTelegramChannel(gateway)
    const [target] = (
      await listTelegramApprovalTargets({ gateway: gateway as never, userId: 'user-1' })
    ).items
    const txQuery = seedAlreadyVerifiedByAnotherUserMocks(target!.id)
    const mutateSpy = vi.spyOn(gateway, 'mutateResource')

    await expect(
      confirmTelegramProviderEventChallenge({
        gateway: gateway as never,
        code: '123456',
        providerUserId: '777',
        providerChannelId: '777',
        providerChannelType: 'private',
        providerTarget: telegramProviderTarget('agent-a'),
      })
    ).resolves.toEqual({ ok: false, error: 'telegram_identity_already_verified' })

    expect(mutateSpy).not.toHaveBeenCalled()
    expect(txQuery).toHaveBeenCalledTimes(2)
  })

  it('keeps the provider-event challenge reusable when target association fails', async () => {
    const gateway = new MockGateway('channels')
    await seedTelegramChannel(gateway)
    const [target] = (
      await listTelegramApprovalTargets({ gateway: gateway as never, userId: 'user-1' })
    ).items
    const txQuery = seedAssociationRetryMocks(target!.id)
    const originalMutateResource = gateway.mutateResource.bind(gateway)
    vi.spyOn(gateway, 'mutateResource')
      .mockRejectedValueOnce(new Error('temporary k8s write failure'))
      .mockImplementation((plural, name, mutate, namespace) =>
        originalMutateResource(plural, name, mutate, namespace)
      )

    const providerEvent = {
      gateway: gateway as never,
      code: '123456',
      providerUserId: '777',
      providerChannelId: '777',
      providerChannelType: 'private',
      providerTarget: telegramProviderTarget('agent-a'),
    }

    await expect(confirmTelegramProviderEventChallenge(providerEvent)).resolves.toEqual({
      ok: false,
      error: 'telegram_target_not_ready',
    })
    expect(
      txQuery.mock.calls.some(call => String(call[0]).includes('SET consumed_at = NOW()'))
    ).toBe(false)

    await expect(confirmTelegramProviderEventChallenge(providerEvent)).resolves.toEqual({
      ok: true,
      accountId: 'account-1',
      userEmail: 'user@example.com',
    })
    const channel = (await gateway.getResource(
      'communicationchannels',
      'agent-a-telegram',
      'channels'
    )) as {
      spec: { telegram: Array<{ channelId: string; chatType: string; userIds: string[] }> }
    }
    expect(channel.spec.telegram).toContainEqual(
      expect.objectContaining({
        channelId: '777',
        chatType: 'private',
        confirmedByUserId: 'user-1',
      })
    )
  })
})
