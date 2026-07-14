import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CredentialsResolver } from '../src/credentials'
import type { CommunicationChannelCRD } from '../src/types'

function makeCC(name: string, ref?: string): CommunicationChannelCRD {
  return {
    name,
    namespace: 'channels',
    spec: {
      hostRef: 'host1',
      ...(ref ? { credentialsSecretRef: { name: ref } } : {}),
      telegram: [{ channelId: '0', userIds: ['0'] }],
    },
  }
}

describe('CredentialsResolver', () => {
  let readNamespacedSecret: ReturnType<typeof vi.fn>
  let resolver: CredentialsResolver

  beforeEach(() => {
    readNamespacedSecret = vi.fn()
    const coreApi = { readNamespacedSecret } as unknown as Parameters<
      typeof CredentialsResolver.prototype.constructor
    >[0]
    resolver = new CredentialsResolver(coreApi, 'channels')
  })

  it('returns empty object when CC has no credentialsSecretRef', async () => {
    const out = await resolver.resolve(makeCC('cc-a'))
    expect(out).toEqual({})
    expect(readNamespacedSecret).not.toHaveBeenCalled()
  })

  it('decodes secret keys for all four channel-type fields', async () => {
    const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64')
    readNamespacedSecret.mockResolvedValue({
      data: {
        'telegram-bot-token': b64('tg-tok'),
        'slack-bot-token': b64('sl-tok'),
        'email-username': b64('mail@example.com'),
        'email-password': b64('mailpw'),
      },
    })
    const out = await resolver.resolve(makeCC('cc-a', 'cc-a-credentials'))
    expect(out).toEqual({
      telegramBotToken: 'tg-tok',
      slackBotToken: 'sl-tok',
      emailUsername: 'mail@example.com',
      emailPassword: 'mailpw',
    })
    expect(readNamespacedSecret).toHaveBeenCalledWith({
      name: 'cc-a-credentials',
      namespace: 'channels',
    })
  })

  it('returns partial object when only some keys present', async () => {
    const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64')
    readNamespacedSecret.mockResolvedValue({
      data: { 'telegram-bot-token': b64('tg-only') },
    })
    const out = await resolver.resolve(makeCC('cc-a', 'cc-a-credentials'))
    expect(out).toEqual({
      telegramBotToken: 'tg-only',
      slackBotToken: undefined,
      emailUsername: undefined,
      emailPassword: undefined,
    })
  })

  it('returns empty object and logs on 404 (missing Secret)', async () => {
    const err = Object.assign(new Error('not found'), { code: 404 })
    readNamespacedSecret.mockRejectedValue(err)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const out = await resolver.resolve(makeCC('cc-a', 'cc-a-credentials'))
      expect(out).toEqual({})
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('[Credentials] CC cc-a references missing Secret cc-a-credentials')
      )
    } finally {
      warn.mockRestore()
    }
  })

  it('throws on non-404 errors', async () => {
    const err = Object.assign(new Error('boom'), { code: 500 })
    readNamespacedSecret.mockRejectedValue(err)
    await expect(resolver.resolve(makeCC('cc-a', 'cc-a-credentials'))).rejects.toThrow('boom')
  })

  it('handles missing/empty secret.data field', async () => {
    readNamespacedSecret.mockResolvedValue({})
    const out = await resolver.resolve(makeCC('cc-a', 'cc-a-credentials'))
    expect(out).toEqual({})
  })
})

describe('DevCredentialsResolver', () => {
  const ORIGINAL_ENV = { ...process.env }

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV }
  })

  it('reads all four credentials from process.env', async () => {
    process.env.CLERUM_TELEGRAM_BOT_TOKEN = 'tg-env'
    process.env.CLERUM_SLACK_BOT_TOKEN = 'sl-env'
    process.env.CLERUM_EMAIL_USERNAME = 'mail-user-env'
    process.env.CLERUM_EMAIL_PASSWORD = 'mail-pw-env'

    const { DevCredentialsResolver } = await import('../src/credentials')
    const resolver = new DevCredentialsResolver()
    const out = await resolver.resolve({
      name: 'cc-dev',
      namespace: 'channels',
      spec: { hostRef: 'h', telegram: [{ channelId: '0', userIds: ['0'] }] },
    })

    expect(out).toEqual({
      telegramBotToken: 'tg-env',
      slackBotToken: 'sl-env',
      emailUsername: 'mail-user-env',
      emailPassword: 'mail-pw-env',
    })
  })

  it('returns undefined for unset env vars', async () => {
    delete process.env.CLERUM_TELEGRAM_BOT_TOKEN
    delete process.env.CLERUM_SLACK_BOT_TOKEN
    delete process.env.CLERUM_EMAIL_USERNAME
    delete process.env.CLERUM_EMAIL_PASSWORD

    const { DevCredentialsResolver } = await import('../src/credentials')
    const resolver = new DevCredentialsResolver()
    const out = await resolver.resolve({
      name: 'cc-dev',
      namespace: 'channels',
      spec: { hostRef: 'h', telegram: [{ channelId: '0', userIds: ['0'] }] },
    })

    expect(out).toEqual({
      telegramBotToken: undefined,
      slackBotToken: undefined,
      emailUsername: undefined,
      emailPassword: undefined,
    })
  })

  it('ignores the cc parameter (same credentials for every CC)', async () => {
    process.env.CLERUM_TELEGRAM_BOT_TOKEN = 'shared'

    const { DevCredentialsResolver } = await import('../src/credentials')
    const resolver = new DevCredentialsResolver()
    const outA = await resolver.resolve({
      name: 'cc-a',
      namespace: 'channels',
      spec: { hostRef: 'h', telegram: [{ channelId: '0', userIds: ['0'] }] },
    })
    const outB = await resolver.resolve({
      name: 'cc-b',
      namespace: 'channels',
      spec: {
        hostRef: 'h',
        credentialsSecretRef: { name: 'sec' },
        telegram: [{ channelId: '0', userIds: ['0'] }],
      },
    })

    expect(outA.telegramBotToken).toBe('shared')
    expect(outB.telegramBotToken).toBe('shared')
  })
})
