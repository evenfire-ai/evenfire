import { describe, expect, it, vi } from 'vitest'
import {
  type ChannelCredentialsGateway,
  CommunicationChannelCredentialsResolver,
} from '../src/services/communicationChannelCredentialsResolver.js'

function b64(value: string): string {
  return Buffer.from(value, 'utf-8').toString('base64')
}

function makeGateway(overrides: {
  getResource?: ReturnType<typeof vi.fn>
  getSecret?: ReturnType<typeof vi.fn>
}): ChannelCredentialsGateway {
  return {
    getResource: overrides.getResource ?? vi.fn(),
    getSecret: overrides.getSecret ?? vi.fn(),
  } as unknown as ChannelCredentialsGateway
}

describe('CommunicationChannelCredentialsResolver', () => {
  it('resolves the per-channel bot token from the channel Secret (ns from ref)', async () => {
    const getResource = vi.fn().mockResolvedValue({
      spec: { credentialsSecretRef: { name: 'cc-a-credentials' } },
    })
    const getSecret = vi.fn().mockResolvedValue({
      data: { 'telegram-bot-token': b64('tg-token'), 'slack-bot-token': b64('sl-token') },
    })
    const resolver = new CommunicationChannelCredentialsResolver(
      makeGateway({ getResource, getSecret })
    )

    const creds = await resolver.resolve('channels/cc-a')

    expect(getResource).toHaveBeenCalledWith('communicationchannels', 'cc-a', 'channels')
    // The Secret read MUST use the channel's own namespace (from the ref), never
    // the gateway's default Secret namespace (mcp-host).
    expect(getSecret).toHaveBeenCalledWith('cc-a-credentials', 'channels')
    expect(creds).toEqual({ telegramBotToken: 'tg-token', slackBotToken: 'sl-token' })
  })

  it('returns {} when the CommunicationChannel is missing (404 → no_bot)', async () => {
    const getResource = vi.fn().mockRejectedValue(Object.assign(new Error('nf'), { code: 404 }))
    const resolver = new CommunicationChannelCredentialsResolver(makeGateway({ getResource }))
    await expect(resolver.resolve('channels/cc-a')).resolves.toEqual({})
  })

  it('returns {} when the Secret is missing (404 → no_bot)', async () => {
    const getResource = vi.fn().mockResolvedValue({
      spec: { credentialsSecretRef: { name: 'cc-a-credentials' } },
    })
    const getSecret = vi.fn().mockRejectedValue(Object.assign(new Error('nf'), { code: 404 }))
    const resolver = new CommunicationChannelCredentialsResolver(
      makeGateway({ getResource, getSecret })
    )
    await expect(resolver.resolve('channels/cc-a')).resolves.toEqual({})
  })

  it('returns {} when the channel has no credentialsSecretRef', async () => {
    const getResource = vi.fn().mockResolvedValue({ spec: {} })
    const resolver = new CommunicationChannelCredentialsResolver(makeGateway({ getResource }))
    await expect(resolver.resolve('channels/cc-a')).resolves.toEqual({})
  })

  it('propagates a non-404 error on the CC read (transient → retry)', async () => {
    const getResource = vi.fn().mockRejectedValue(Object.assign(new Error('rbac'), { code: 403 }))
    const resolver = new CommunicationChannelCredentialsResolver(makeGateway({ getResource }))
    await expect(resolver.resolve('channels/cc-a')).rejects.toThrow('rbac')
  })

  it('propagates a non-404 error on the Secret read (transient → retry)', async () => {
    const getResource = vi.fn().mockResolvedValue({
      spec: { credentialsSecretRef: { name: 'cc-a-credentials' } },
    })
    const getSecret = vi.fn().mockRejectedValue(Object.assign(new Error('timeout'), { code: 503 }))
    const resolver = new CommunicationChannelCredentialsResolver(
      makeGateway({ getResource, getSecret })
    )
    await expect(resolver.resolve('channels/cc-a')).rejects.toThrow('timeout')
  })

  it('throws on a malformed ref (no namespace/name slash)', async () => {
    const resolver = new CommunicationChannelCredentialsResolver(makeGateway({}))
    await expect(resolver.resolve('cc-a')).rejects.toThrow(/Invalid communication_channel_ref/)
  })

  it('decodes only the present keys (no token → undefined, never throws)', async () => {
    const getResource = vi.fn().mockResolvedValue({
      spec: { credentialsSecretRef: { name: 'cc-a-credentials' } },
    })
    const getSecret = vi.fn().mockResolvedValue({ data: {} })
    const resolver = new CommunicationChannelCredentialsResolver(
      makeGateway({ getResource, getSecret })
    )
    await expect(resolver.resolve('channels/cc-a')).resolves.toEqual({
      telegramBotToken: undefined,
      slackBotToken: undefined,
    })
  })

  it('decodes the slack token while telegram-bot-token is absent (no_bot for telegram)', async () => {
    const getResource = vi.fn().mockResolvedValue({
      spec: { credentialsSecretRef: { name: 'cc-a-credentials' } },
    })
    const getSecret = vi.fn().mockResolvedValue({ data: { 'slack-bot-token': b64('sl-only') } })
    const resolver = new CommunicationChannelCredentialsResolver(
      makeGateway({ getResource, getSecret })
    )
    // Telegram delivery for this channel resolves to no_bot; slack is unaffected.
    await expect(resolver.resolve('channels/cc-a')).resolves.toEqual({
      telegramBotToken: undefined,
      slackBotToken: 'sl-only',
    })
  })
})
