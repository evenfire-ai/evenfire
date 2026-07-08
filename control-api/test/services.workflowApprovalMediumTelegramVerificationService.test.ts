import { beforeEach, describe, expect, it, vi } from 'vitest'
import { pool, withTransaction } from '../src/db.js'
import { getTeamAgents, getUserAgents, listTeams } from '../src/services/directory/index.js'
import { createChallengeCodeHash } from '../src/services/workflowApprovalMediumIdentityService.js'
import {
  confirmTelegramProviderEventChallenge,
  disableVerifiedMediumAccountWithTelegramAssociations,
} from '../src/services/workflowApprovalMediumTelegramProviderEventService.js'
import { attachTelegramTargetsToAccounts } from '../src/services/workflowApprovalMediumTelegramTargetAssociationService.js'
import {
  TELEGRAM_PROVIDER_EVENT_PENDING_USER_ID,
  createTelegramProviderEventChallenge,
  listTelegramApprovalTargets,
  userCanAccessTelegramCommunicationChannel,
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

async function seedTelegramChannel(
  gateway: MockGateway,
  hostRef = 'agent-a',
  userIds: string[] = ['seed-user']
) {
  return gateway.createResource(
    'communicationchannels',
    {
      metadata: {
        name: `${hostRef}-telegram`,
      },
      spec: {
        hostRef,
        access: { users: ['user-1'], teams: [] },
        credentialsSecretRef: { name: `${hostRef}-credentials` },
        telegramSettings: { botHandle: '@clerum_test_bot' },
        telegram: [{ channelId: 'seed-chat', chatType: 'private', userIds }],
      },
    },
    'channels'
  )
}

describe('Telegram workflow approval medium verification', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockedQuery.mockReset()
    mockedWithTransaction.mockReset()
    mockedGetUserAgents.mockResolvedValue({ userId: 'user-1', agentNames: ['agent-a'] })
    mockedGetTeamAgents.mockResolvedValue({ teamId: 'team-1', agentNames: [] })
    mockedListTeams.mockResolvedValue({ currentTeamId: '', items: [] })
  })

  it('lists only active Telegram targets for agents the user can access', async () => {
    const gateway = new MockGateway('channels')
    await seedTelegramChannel(gateway, 'agent-a')
    await seedTelegramChannel(gateway, 'agent-b')
    await gateway.createResource(
      'communicationchannels',
      {
        metadata: { name: 'agent-a-email-only' },
        spec: { hostRef: 'agent-a', credentialsSecretRef: { name: 'email-creds' }, email: [] },
      },
      'channels'
    )

    const targets = await listTelegramApprovalTargets({
      gateway: gateway as never,
      userId: 'user-1',
    })

    expect(targets.items).toHaveLength(1)
    expect(targets.items[0]).toMatchObject({
      agentName: 'agent-a',
      botDeepLink: 'https://t.me/clerum_test_bot',
      botUsername: 'clerum_test_bot',
      medium: 'telegram',
    })
    expect(JSON.stringify(targets.items[0])).not.toContain('telegram-bot-token')
  })

  it('does not list a target when the user has agent access but no channel access grant', async () => {
    const gateway = new MockGateway('channels')
    await gateway.createResource(
      'communicationchannels',
      {
        metadata: { name: 'agent-a-telegram' },
        spec: {
          hostRef: 'agent-a',
          access: { users: ['user-2'], teams: [] },
          credentialsSecretRef: { name: 'agent-a-credentials' },
          telegramSettings: { botHandle: '@clerum_test_bot' },
        },
      },
      'channels'
    )

    const targets = await listTelegramApprovalTargets({
      gateway: gateway as never,
      userId: 'user-1',
    })

    expect(targets.items).toEqual([])
  })

  it('does not list a team-granted target when the team has no agent access', async () => {
    const gateway = new MockGateway('channels')
    await gateway.createResource(
      'communicationchannels',
      {
        metadata: { name: 'agent-a-telegram' },
        spec: {
          hostRef: 'agent-a',
          access: { users: [], teams: ['team-1'] },
          credentialsSecretRef: { name: 'agent-a-credentials' },
          telegramSettings: { botHandle: '@clerum_test_bot' },
        },
      },
      'channels'
    )
    mockedGetUserAgents.mockResolvedValue({ userId: 'user-1', agentNames: [] })
    mockedListTeams.mockResolvedValue({ currentTeamId: 'team-1', items: [{ id: 'team-1' }] })
    mockedGetTeamAgents.mockResolvedValue({ teamId: 'team-1', agentNames: [] })

    const targets = await listTelegramApprovalTargets({
      gateway: gateway as never,
      userId: 'user-1',
    })

    expect(targets.items).toEqual([])
  })

  it('lists a target when the user has direct channel and agent access', async () => {
    const gateway = new MockGateway('channels')
    await seedTelegramChannel(gateway, 'agent-a', [])

    const targets = await listTelegramApprovalTargets({
      gateway: gateway as never,
      userId: 'user-1',
    })

    expect(targets.items).toHaveLength(1)
    expect(targets.items[0]).toMatchObject({
      agentName: 'agent-a',
      channelName: 'agent-a-telegram',
    })
  })

  it('does not treat empty telegramSettings as an enabled Telegram provider', async () => {
    const gateway = new MockGateway('channels')
    await gateway.createResource(
      'communicationchannels',
      {
        metadata: { name: 'agent-a-empty-telegram' },
        spec: {
          hostRef: 'agent-a',
          access: { users: ['user-1'], teams: [] },
          credentialsSecretRef: { name: 'agent-a-credentials' },
          telegramSettings: {},
        },
      },
      'channels'
    )

    const targets = await listTelegramApprovalTargets({
      gateway: gateway as never,
      userId: 'user-1',
    })

    expect(targets.items).toEqual([])
  })

  it('revokes operational access when the user loses current agent access', async () => {
    const gateway = new MockGateway('channels')
    await seedTelegramChannel(gateway)
    const input = {
      gateway: gateway as never,
      userId: 'user-1',
      hostRef: 'agent-a',
      channelName: 'agent-a-telegram',
      channelNamespace: 'channels',
    }

    await expect(userCanAccessTelegramCommunicationChannel(input)).resolves.toBe(true)

    mockedGetUserAgents.mockResolvedValueOnce({ userId: 'user-1', agentNames: [] })
    await expect(userCanAccessTelegramCommunicationChannel(input)).resolves.toBe(false)
  })

  it('creates a target-scoped challenge with a provider-event pending marker', async () => {
    const gateway = new MockGateway('channels')
    await seedTelegramChannel(gateway)
    const [target] = (
      await listTelegramApprovalTargets({ gateway: gateway as never, userId: 'user-1' })
    ).items
    mockedQuery.mockResolvedValueOnce({
      rows: [{ id: 'challenge-1', expiresAt: '2026-06-02T12:00:00.000Z' }],
      rowCount: 1,
    } as never)

    const challenge = await createTelegramProviderEventChallenge({
      gateway: gateway as never,
      userId: 'user-1',
      targetId: target!.id,
    })

    expect(challenge.code).toMatch(/^\d{6}$/)
    expect(mockedQuery.mock.calls[0]![1]).toEqual([
      'user-1',
      TELEGRAM_PROVIDER_EVENT_PENDING_USER_ID,
      target!.id,
      expect.stringMatching(/^sha256:/),
      expect.any(Number),
    ])
  })

  it('lists a Telegram target before any user is verified for that bot', async () => {
    const gateway = new MockGateway('channels')
    await seedTelegramChannel(gateway, 'agent-a', [])

    const targets = await listTelegramApprovalTargets({
      gateway: gateway as never,
      userId: 'user-1',
    })

    expect(targets.items).toHaveLength(1)
    expect(targets.items[0]).toMatchObject({ agentName: 'agent-a', medium: 'telegram' })
  })

  it('does not attach an account to unverified Telegram transport rows', async () => {
    const gateway = new MockGateway('channels')
    await seedTelegramChannel(gateway, 'agent-a', ['telegram-user-1'])
    const accounts = await attachTelegramTargetsToAccounts(gateway as never, 'user-1', [
      {
        id: 'account-1',
        userId: 'user-1',
        medium: 'telegram',
        providerUserId: 'telegram-user-1',
        providerWorkspaceId: null,
        providerChannelId: 'seed-chat',
        communicationChannelRef: 'channels/agent-a-telegram',
        disabledAt: null,
      },
    ])

    expect(accounts[0]?.targets).toEqual([])
    expect(accounts[0]?.providerChannelType).toBeNull()
  })

  it('rejects provider confirmation when the receiving bot hostRef does not match the target', async () => {
    const gateway = new MockGateway('channels')
    await seedTelegramChannel(gateway, 'agent-a')
    const [target] = (
      await listTelegramApprovalTargets({ gateway: gateway as never, userId: 'user-1' })
    ).items
    const codeHash = createChallengeCodeHash({
      userId: 'user-1',
      medium: 'telegram',
      providerUserId: TELEGRAM_PROVIDER_EVENT_PENDING_USER_ID,
      code: '123456',
      saltHex: 'abcd'.repeat(8),
    })
    mockedQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 'challenge-1',
          userId: 'user-1',
          userEmail: 'user@example.com',
          targetId: target!.id,
          codeHash,
          isExpired: false,
          consumedAt: null,
          attempts: 0,
        },
      ],
      rowCount: 1,
    } as never)

    await expect(
      confirmTelegramProviderEventChallenge({
        gateway: gateway as never,
        code: '123456',
        providerUserId: '777',
        providerChannelId: '777',
        providerChannelType: 'private',
        providerTarget: telegramProviderTarget('agent-b'),
      })
    ).resolves.toEqual({ ok: false, error: 'telegram_target_not_found' })
    expect(mockedWithTransaction).not.toHaveBeenCalled()
    const channel = (await gateway.getResource(
      'communicationchannels',
      'agent-a-telegram',
      'channels'
    )) as { spec: { telegram: Array<{ channelId: string; chatType?: string; userIds: string[] }> } }
    expect(channel.spec.telegram).not.toContainEqual({
      channelId: '777',
      chatType: 'private',
      userIds: ['777'],
    })
  })

  it('rejects provider confirmation when Telegram private chat identity is inconsistent', async () => {
    const gateway = new MockGateway('channels')

    await expect(
      confirmTelegramProviderEventChallenge({
        gateway: gateway as never,
        code: '123456',
        providerUserId: '777',
        providerChannelId: '778',
        providerChannelType: 'private',
        providerTarget: telegramProviderTarget('agent-a'),
      })
    ).resolves.toEqual({ ok: false, error: 'invalid_provider_identity' })
    expect(mockedQuery).not.toHaveBeenCalled()
    expect(mockedWithTransaction).not.toHaveBeenCalled()
  })

  it('disables the account and removes only that confirmed Telegram association', async () => {
    const gateway = new MockGateway('channels')
    await seedTelegramChannel(gateway, 'agent-a', [])
    const channel = (await gateway.getResource(
      'communicationchannels',
      'agent-a-telegram',
      'channels'
    )) as {
      spec: {
        telegram: Array<{
          channelId: string
          chatType?: string
          userIds?: string[]
          confirmedByUserId?: string
        }>
      }
    }
    channel.spec.telegram.push({
      channelId: '777',
      chatType: 'private',
      confirmedByUserId: 'user-1',
    })
    channel.spec.telegram.push({
      channelId: '777',
      chatType: 'private',
      confirmedByUserId: 'user-2',
    })
    channel.spec.telegram.push({ channelId: '777', chatType: 'private', userIds: ['777'] })
    mockedQuery
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'account-1',
            medium: 'telegram',
            providerUserId: '777',
            providerChannelId: '777',
            disabledAt: null,
          },
        ],
        rowCount: 1,
      } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)

    await expect(
      disableVerifiedMediumAccountWithTelegramAssociations({
        gateway: gateway as never,
        userId: 'user-1',
        accountId: 'account-1',
      })
    ).resolves.toBe(true)

    const updated = (await gateway.getResource(
      'communicationchannels',
      'agent-a-telegram',
      'channels'
    )) as {
      spec: {
        telegram: Array<{
          channelId: string
          chatType?: string
          userIds?: string[]
          confirmedByUserId?: string
        }>
      }
    }
    expect(updated.spec.telegram).toContainEqual({
      channelId: 'seed-chat',
      chatType: 'private',
      userIds: [],
    })
    expect(updated.spec.telegram).not.toContainEqual(
      expect.objectContaining({ channelId: '777', confirmedByUserId: 'user-1' })
    )
    expect(updated.spec.telegram).toContainEqual(
      expect.objectContaining({ channelId: '777', confirmedByUserId: 'user-2' })
    )
    expect(updated.spec.telegram).toContainEqual({
      channelId: '777',
      chatType: 'private',
      userIds: ['777'],
    })
  })

  it('removes an already disconnected Telegram account record without mutating channel targets', async () => {
    const gateway = new MockGateway('channels')
    await seedTelegramChannel(gateway, 'agent-a', ['777'])
    mockedQuery
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'account-1',
            medium: 'telegram',
            providerUserId: '777',
            providerChannelId: '777',
            disabledAt: '2026-06-05T18:00:00.000Z',
          },
        ],
        rowCount: 1,
      } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)

    await expect(
      disableVerifiedMediumAccountWithTelegramAssociations({
        gateway: gateway as never,
        userId: 'user-1',
        accountId: 'account-1',
      })
    ).resolves.toBe(true)

    expect(String(mockedQuery.mock.calls[1]![0])).toContain('DELETE FROM')
    const channel = (await gateway.getResource(
      'communicationchannels',
      'agent-a-telegram',
      'channels'
    )) as {
      spec: { telegram: Array<{ channelId: string; chatType?: string; userIds: string[] }> }
    }
    expect(channel.spec.telegram[0]?.userIds).toEqual(['777'])
  })
})
