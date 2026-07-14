import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Config is evaluated at module load time, so each test must:
// 1. Set process.env before the import
// 2. Call vi.resetModules() between tests to clear the module cache

const originalEnv = { ...process.env }

beforeEach(() => {
  vi.resetModules()
  // Reset to a clean env with minimum required vars for prod mode
  process.env = {
    ...originalEnv,
    CLERUM_DEV_MODE: 'false',
    CLERUM_HOST_REF: 'my-host',
  }
  // Remove optional vars so tests start from a known baseline
  delete process.env.CLERUM_CHANNEL
  delete process.env.CLERUM_MCP_HOST_URL
  delete process.env.CLERUM_NOTIFICATION_DELIVERY_POLL_LIMIT
  delete process.env.CLERUM_TELEGRAM_API_ROOT
  delete process.env.CLERUM_NAMESPACE
  delete process.env.CLERUM_EMAIL_IMAP_HOST
  delete process.env.CLERUM_EMAIL_SMTP_HOST
  delete process.env.CLERUM_POLL_INTERVAL_SECONDS
  delete process.env.CLERUM_ENABLE_RESPONSE_ATTACHMENTS
  delete process.env.CLERUM_ATTACHMENT_MAX_COUNT
  delete process.env.CLERUM_ATTACHMENT_MAX_BYTES
})

afterEach(() => {
  process.env = originalEnv
})

describe('channel-reader config — basic properties', () => {
  it('devMode is false by default', async () => {
    const { config } = await import('../src/config.js')
    expect(config.devMode).toBe(false)
  })

  it('devMode is true when CLERUM_DEV_MODE=true', async () => {
    process.env.CLERUM_DEV_MODE = 'true'
    const { config } = await import('../src/config.js')
    expect(config.devMode).toBe(true)
  })

  it('devMode is true when CLERUM_DEV_MODE=1', async () => {
    process.env.CLERUM_DEV_MODE = '1'
    const { config } = await import('../src/config.js')
    expect(config.devMode).toBe(true)
  })

  it('devMode is false when CLERUM_DEV_MODE=false', async () => {
    process.env.CLERUM_DEV_MODE = 'false'
    const { config } = await import('../src/config.js')
    expect(config.devMode).toBe(false)
  })

  it('reads hostRef from CLERUM_HOST_REF', async () => {
    process.env.CLERUM_HOST_REF = 'chatllm'
    const { config } = await import('../src/config.js')
    expect(config.hostRef).toBe('chatllm')
  })

  it("defaults hostRef to 'dev' in devMode", async () => {
    process.env.CLERUM_DEV_MODE = 'true'
    delete process.env.CLERUM_HOST_REF
    const { config } = await import('../src/config.js')
    expect(config.hostRef).toBe('dev')
  })

  it('throws if CLERUM_HOST_REF missing in production mode', async () => {
    delete process.env.CLERUM_HOST_REF
    await expect(() => import('../src/config.js')).rejects.toThrow('CLERUM_HOST_REF')
  })

  it('reads namespace from CLERUM_NAMESPACE', async () => {
    process.env.CLERUM_NAMESPACE = 'channels'
    const { config } = await import('../src/config.js')
    expect(config.namespace).toBe('channels')
  })

  it('defaults namespace to empty string (all namespaces)', async () => {
    const { config } = await import('../src/config.js')
    expect(config.namespace).toBe('')
  })
})

describe('channel-reader config — mcpHostUrl', () => {
  it('uses explicit CLERUM_MCP_HOST_URL when set', async () => {
    process.env.CLERUM_MCP_HOST_URL = 'http://mcp.example.com:8080'
    const { config } = await import('../src/config.js')
    expect(config.mcpHostUrl).toBe('http://mcp.example.com:8080')
  })

  it('resolves cluster URL from hostRef in production mode', async () => {
    process.env.CLERUM_HOST_REF = 'chatllm'
    const { config } = await import('../src/config.js')
    expect(config.mcpHostUrl).toBe('http://chatllm.mcp-host.svc.cluster.local:8080')
  })

  it('defaults to localhost in dev mode', async () => {
    process.env.CLERUM_DEV_MODE = 'true'
    const { config } = await import('../src/config.js')
    expect(config.mcpHostUrl).toBe('http://localhost:8080')
  })
})

describe('channel-reader config — provider API roots', () => {
  it('leaves Telegram API root unset by default', async () => {
    const { config } = await import('../src/config.js')
    expect(config.telegramApiRoot).toBeUndefined()
  })

  it('reads Telegram API root from CLERUM_TELEGRAM_API_ROOT', async () => {
    process.env.CLERUM_TELEGRAM_API_ROOT = 'http://telegram-api.channels.svc.cluster.local:443'
    const { config } = await import('../src/config.js')
    expect(config.telegramApiRoot).toBe('http://telegram-api.channels.svc.cluster.local:443')
  })

  it('defaults Telegram polling handoff guards', async () => {
    const { config } = await import('../src/config.js')
    expect(config.telegramStartupStabilityMs).toBe(1000)
    expect(config.telegramShutdownGraceMs).toBe(750)
  })

  it('reads Telegram polling handoff guards from env', async () => {
    process.env.CLERUM_TELEGRAM_STARTUP_STABILITY_MS = '1500'
    process.env.CLERUM_TELEGRAM_SHUTDOWN_GRACE_MS = '250'
    const { config } = await import('../src/config.js')
    expect(config.telegramStartupStabilityMs).toBe(1500)
    expect(config.telegramShutdownGraceMs).toBe(250)
  })
})

describe('channel-reader config — workflow approval delivery boundary', () => {
  it('does not expose control-api connection settings to channel-reader', async () => {
    const { config } = await import('../src/config.js')
    const values = config as unknown as Record<string, unknown>

    expect(values.controlApiUrl).toBeUndefined()
    expect(values.controlApiServiceName).toBeUndefined()
    expect(values.controlApiServiceToken).toBeUndefined()
  })

  it('keeps only the mcp-host-mediated notification delivery poll limit', async () => {
    process.env.CLERUM_NOTIFICATION_DELIVERY_POLL_LIMIT = '5'
    const { config } = await import('../src/config.js')
    expect(config.notificationDeliveryPollLimit).toBe(5)
  })
})

describe('channel-reader config — channel credentials', () => {
  it('reads email IMAP settings', async () => {
    process.env.CLERUM_EMAIL_IMAP_HOST = 'imap.example.com'
    process.env.CLERUM_EMAIL_IMAP_PORT = '993'
    const { config } = await import('../src/config.js')
    expect(config.emailImapHost).toBe('imap.example.com')
    expect(config.emailImapPort).toBe(993)
  })

  it('defaults emailImapPort to 993', async () => {
    const { config } = await import('../src/config.js')
    expect(config.emailImapPort).toBe(993)
  })

  it('defaults emailSmtpPort to 587', async () => {
    const { config } = await import('../src/config.js')
    expect(config.emailSmtpPort).toBe(587)
  })

  it('falls back emailSmtpHost to emailImapHost when not set', async () => {
    process.env.CLERUM_EMAIL_IMAP_HOST = 'imap.example.com'
    const { config } = await import('../src/config.js')
    expect(config.emailSmtpHost).toBe('imap.example.com')
  })

  it('prefers explicit emailSmtpHost over fallback', async () => {
    process.env.CLERUM_EMAIL_IMAP_HOST = 'imap.example.com'
    process.env.CLERUM_EMAIL_SMTP_HOST = 'smtp.example.com'
    const { config } = await import('../src/config.js')
    expect(config.emailSmtpHost).toBe('smtp.example.com')
  })
})

describe('channel-reader config — polling and attachments', () => {
  it('defaults pollIntervalSeconds to 2', async () => {
    const { config } = await import('../src/config.js')
    expect(config.pollIntervalSeconds).toBe(2)
  })

  it('reads pollIntervalSeconds from env', async () => {
    process.env.CLERUM_POLL_INTERVAL_SECONDS = '60'
    const { config } = await import('../src/config.js')
    expect(config.pollIntervalSeconds).toBe(60)
  })

  it('defaults enableResponseAttachments to true', async () => {
    const { config } = await import('../src/config.js')
    expect(config.enableResponseAttachments).toBe(true)
  })

  it('enables attachments when CLERUM_ENABLE_RESPONSE_ATTACHMENTS=true', async () => {
    process.env.CLERUM_ENABLE_RESPONSE_ATTACHMENTS = 'true'
    const { config } = await import('../src/config.js')
    expect(config.enableResponseAttachments).toBe(true)
  })

  it('disables attachments when CLERUM_ENABLE_RESPONSE_ATTACHMENTS=false', async () => {
    process.env.CLERUM_ENABLE_RESPONSE_ATTACHMENTS = 'false'
    const { config } = await import('../src/config.js')
    expect(config.enableResponseAttachments).toBe(false)
  })

  it('defaults attachmentMaxCount to 3', async () => {
    const { config } = await import('../src/config.js')
    expect(config.attachmentMaxCount).toBe(3)
  })

  it('defaults attachmentMaxBytes to 52428800 (50 MB)', async () => {
    const { config } = await import('../src/config.js')
    expect(config.attachmentMaxBytes).toBe(52_428_800)
  })
})

describe('channel-reader config — devChannelConfig parsing', () => {
  it('parses CLERUM_CHANNEL JSON in dev mode', async () => {
    process.env.CLERUM_DEV_MODE = 'true'
    process.env.CLERUM_CHANNEL = JSON.stringify({
      hostRef: 'chatllm',
      telegram: [{ channelId: 'test', userIds: ['123456789'] }],
    })
    const { config } = await import('../src/config.js')
    expect(config.devChannelConfig?.hostRef).toBe('chatllm')
    expect(config.devChannelConfig?.telegram).toHaveLength(1)
  })

  it('returns undefined devChannelConfig when CLERUM_CHANNEL not set in dev mode', async () => {
    process.env.CLERUM_DEV_MODE = 'true'
    const { config } = await import('../src/config.js')
    expect(config.devChannelConfig).toBeUndefined()
  })

  it('does not parse CLERUM_CHANNEL in production mode', async () => {
    process.env.CLERUM_CHANNEL = JSON.stringify({ hostRef: 'prod' })
    const { config } = await import('../src/config.js')
    expect(config.devChannelConfig).toBeUndefined()
  })

  it('returns undefined devChannelConfig on invalid JSON', async () => {
    process.env.CLERUM_DEV_MODE = 'true'
    process.env.CLERUM_CHANNEL = '{ invalid json }'
    const { config } = await import('../src/config.js')
    expect(config.devChannelConfig).toBeUndefined()
  })
})
