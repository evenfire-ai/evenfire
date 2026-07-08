import { describe, expect, it } from 'vitest'
import { verifyTelegramOperationalChannelBinding } from '../src/services/workflowApprovalTelegramChannelGateService.js'
import { MockGateway } from './mockGateway.js'

const TARGET = {
  hostRef: 'agent-a',
  communicationChannelNamespace: 'channels',
  communicationChannelName: 'agent-a-telegram',
  providerBotUsername: 'clerum_test_bot',
}

async function gatewayWithTelegramChannel() {
  const gateway = new MockGateway('channels')
  await gateway.createResource(
    'communicationchannels',
    {
      metadata: {
        name: 'agent-a-telegram',
      },
      spec: {
        hostRef: 'agent-a',
        telegramSettings: { botHandle: '@clerum_test_bot' },
        telegram: [
          { channelId: 'private-4242', chatType: 'private' },
          { channelId: 'group-1', chatType: 'group' },
          { channelId: 'supergroup-1', chatType: 'supergroup' },
        ],
      },
    },
    'channels'
  )
  return gateway
}

async function gatewayWithConfirmedTelegramChannel() {
  const gateway = new MockGateway('channels')
  await gateway.createResource(
    'communicationchannels',
    {
      metadata: {
        name: 'agent-a-telegram',
      },
      spec: {
        hostRef: 'agent-a',
        telegramSettings: { botHandle: '@clerum_test_bot' },
        telegram: [
          {
            channelId: 'group-1',
            chatType: 'group',
            confirmedByUserId: 'user-1',
          },
        ],
      },
    },
    'channels'
  )
  return gateway
}

describe('workflowApprovalTelegramChannelGateService', () => {
  it('allows a verified actor to use a configured group even when userIds is absent', async () => {
    const gateway = await gatewayWithTelegramChannel()

    await expect(
      verifyTelegramOperationalChannelBinding({
        gateway: gateway as never,
        providerChannelId: 'group-1',
        providerChannelType: 'group',
        providerTarget: TARGET,
      })
    ).resolves.toEqual({ ok: true })
  })

  it('allows configured private operational chats with explicit private chatType', async () => {
    const gateway = await gatewayWithTelegramChannel()

    await expect(
      verifyTelegramOperationalChannelBinding({
        gateway: gateway as never,
        providerChannelId: 'private-4242',
        providerChannelType: 'private',
        providerTarget: TARGET,
      })
    ).resolves.toEqual({ ok: true })
  })

  it('allows configured supergroup operational chats with explicit supergroup chatType', async () => {
    const gateway = await gatewayWithTelegramChannel()

    await expect(
      verifyTelegramOperationalChannelBinding({
        gateway: gateway as never,
        providerChannelId: 'supergroup-1',
        providerChannelType: 'supergroup',
        providerTarget: TARGET,
      })
    ).resolves.toEqual({ ok: true })
  })

  it('fails closed for wrong group and wrong CommunicationChannel binding', async () => {
    const gateway = await gatewayWithTelegramChannel()

    await expect(
      verifyTelegramOperationalChannelBinding({
        gateway: gateway as never,
        providerChannelId: 'group-2',
        providerChannelType: 'group',
        providerTarget: TARGET,
      })
    ).resolves.toEqual({ ok: false, error: 'communication_channel_not_allowed' })

    await expect(
      verifyTelegramOperationalChannelBinding({
        gateway: gateway as never,
        providerChannelId: 'group-1',
        providerChannelType: 'group',
        providerTarget: { ...TARGET, hostRef: 'agent-b' },
      })
    ).resolves.toEqual({ ok: false, error: 'communication_channel_binding_mismatch' })

    await expect(
      verifyTelegramOperationalChannelBinding({
        gateway: gateway as never,
        providerChannelId: 'group-1',
        providerChannelType: 'group',
        providerTarget: { ...TARGET, communicationChannelName: 'other-telegram' },
      })
    ).resolves.toEqual({ ok: false, error: 'communication_channel_not_found' })
  })

  it('fails closed for unsupported Telegram channel chat type and bot target mismatch', async () => {
    const gateway = await gatewayWithTelegramChannel()

    await expect(
      verifyTelegramOperationalChannelBinding({
        gateway: gateway as never,
        providerChannelId: 'group-1',
        providerChannelType: 'channel',
        providerTarget: TARGET,
      })
    ).resolves.toEqual({ ok: false, error: 'unsupported_chat_type' })

    await expect(
      verifyTelegramOperationalChannelBinding({
        gateway: gateway as never,
        providerChannelId: 'group-1',
        providerChannelType: 'group',
        providerTarget: { ...TARGET, providerBotUsername: 'other_bot' },
      })
    ).resolves.toEqual({ ok: false, error: 'communication_channel_binding_mismatch' })
  })

  it('requires the current channel conversation to match the verified account user', async () => {
    const gateway = await gatewayWithConfirmedTelegramChannel()

    await expect(
      verifyTelegramOperationalChannelBinding({
        gateway: gateway as never,
        providerChannelId: 'group-1',
        providerChannelType: 'group',
        providerTarget: TARGET,
        accountUserId: 'user-1',
        providerUserId: 'telegram-user-1',
      })
    ).resolves.toEqual({ ok: true })

    await expect(
      verifyTelegramOperationalChannelBinding({
        gateway: gateway as never,
        providerChannelId: 'group-1',
        providerChannelType: 'group',
        providerTarget: TARGET,
        accountUserId: 'user-2',
        providerUserId: 'telegram-user-2',
      })
    ).resolves.toEqual({ ok: false, error: 'communication_channel_not_allowed' })
  })

  it('does not use Telegram userIds as approval verification', async () => {
    const gateway = await gatewayWithTelegramChannel()
    const channel = (await gateway.getResource(
      'communicationchannels',
      'agent-a-telegram',
      'channels'
    )) as {
      spec: { telegram: Array<{ channelId: string; chatType: string; userIds?: string[] }> }
    }
    channel.spec.telegram.push({
      channelId: 'transport-group',
      chatType: 'group',
      userIds: ['telegram-user-1'],
    })

    await expect(
      verifyTelegramOperationalChannelBinding({
        gateway: gateway as never,
        providerChannelId: 'transport-group',
        providerChannelType: 'group',
        providerTarget: TARGET,
        accountUserId: 'user-1',
        providerUserId: 'telegram-user-1',
      })
    ).resolves.toEqual({ ok: false, error: 'communication_channel_not_allowed' })

    await expect(
      verifyTelegramOperationalChannelBinding({
        gateway: gateway as never,
        providerChannelId: 'transport-group',
        providerChannelType: 'group',
        providerTarget: TARGET,
        accountUserId: 'user-1',
        providerUserId: 'telegram-user-1',
        requireAccountMatch: false,
      })
    ).resolves.toEqual({ ok: true })
  })

  it('can allow operational group chat while keeping approval binding per verifier', async () => {
    const gateway = await gatewayWithConfirmedTelegramChannel()

    await expect(
      verifyTelegramOperationalChannelBinding({
        gateway: gateway as never,
        providerChannelId: 'group-1',
        providerChannelType: 'group',
        providerTarget: TARGET,
        accountUserId: 'user-2',
        providerUserId: 'telegram-user-2',
        requireAccountMatch: false,
      })
    ).resolves.toEqual({ ok: true })

    await expect(
      verifyTelegramOperationalChannelBinding({
        gateway: gateway as never,
        providerChannelId: 'group-1',
        providerChannelType: 'group',
        providerTarget: TARGET,
        accountUserId: 'user-2',
        providerUserId: 'telegram-user-2',
      })
    ).resolves.toEqual({ ok: false, error: 'communication_channel_not_allowed' })
  })

  it('can verify the current channel by communicationChannelRef for alias-only events', async () => {
    const gateway = await gatewayWithConfirmedTelegramChannel()

    await expect(
      verifyTelegramOperationalChannelBinding({
        gateway: gateway as never,
        providerChannelId: 'group-1',
        providerChannelType: 'group',
        communicationChannelRef: 'channels/agent-a-telegram',
        accountUserId: 'user-1',
        providerUserId: 'telegram-user-1',
      })
    ).resolves.toEqual({ ok: true })
  })
})
