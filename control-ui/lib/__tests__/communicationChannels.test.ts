import { describe, expect, it } from 'vitest'
import { slackWebhookUrlForChannel } from '../communicationChannels'

const telegramOnly = {
  metadata: { name: 'jose-tg', namespace: 'channels' },
  spec: { telegram: [{ channelId: '1', chatType: 'private' as const }] },
}
const slackConfigured = {
  metadata: { name: 'slack-jose', namespace: 'channels' },
  spec: { slackSettings: { botHandle: 'Evenfire' } },
}

describe('slackWebhookUrlForChannel', () => {
  it('returns null for a channel with no Slack provider', () => {
    expect(slackWebhookUrlForChannel(telegramOnly)).toBeNull()
  })

  it('returns a URL for a channel with Slack configured', () => {
    expect(slackWebhookUrlForChannel(slackConfigured)).toContain('/webhooks/slack/')
  })

  it('treats a confirmed conversation as Slack configured even with no settings', () => {
    expect(
      slackWebhookUrlForChannel({
        metadata: { name: 'x', namespace: 'channels' },
        spec: { slack: [{ channelId: 'C1', workspaceId: 'T1', userIds: ['U1'] }] },
      })
    ).toContain('/webhooks/slack/')
  })
})
