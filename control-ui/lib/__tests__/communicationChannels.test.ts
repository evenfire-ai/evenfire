import { describe, expect, it } from 'vitest'
import { slackWebhookUrlForChannel, slackWebhookUrlForChannelName } from '../communicationChannels'

/** The `{namespace, name}` the reader will decode back out of a target id. */
function decodeTargetId(url: string): unknown {
  const targetId = decodeURIComponent(url.slice(url.lastIndexOf('/') + 1))
  const payload = targetId.slice('slack:'.length).replace(/-/g, '+').replace(/_/g, '/')
  return JSON.parse(atob(payload))
}

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

describe('slackWebhookUrlForChannelName', () => {
  it('encodes the same namespace and name the reader decodes', () => {
    // What makes a draft-derived URL safe to show before anything is saved: the
    // id carries only the channel's coordinates, and both are fixed at create
    // time. If this encoding drifts, the URL an operator pastes into Slack
    // resolves to nothing.
    const url = slackWebhookUrlForChannelName('slack-jose', 'channels')
    expect(url).not.toBeNull()
    expect(decodeTargetId(url!)).toEqual({ namespace: 'channels', name: 'slack-jose' })
    expect(url).toBe(slackWebhookUrlForChannel(slackConfigured))
  })

  it('defaults an absent namespace to channels', () => {
    expect(decodeTargetId(slackWebhookUrlForChannelName('slack-jose')!)).toEqual({
      namespace: 'channels',
      name: 'slack-jose',
    })
  })

  it('returns null without a channel name', () => {
    expect(slackWebhookUrlForChannelName('')).toBeNull()
    expect(slackWebhookUrlForChannelName('   ')).toBeNull()
  })
})
