import { afterEach, describe, expect, it, vi } from 'vitest'

describe('config.removedStatelessCommunicationChannelPolicy', () => {
  afterEach(() => {
    delete process.env.CLERUM_STATELESS_COMMUNICATION_CHANNEL_POLICY
    delete process.env.CLERUM_STATELESS_ALLOW_CRON_MANAGE
    vi.resetModules()
  })

  it('loads when the retired channel policy env is absent', async () => {
    const { config } = await import('../src/config')
    expect(config.channelsNamespace).toBe('channels')
  })

  it('does not derive channel behavior from the cron policy flag', async () => {
    process.env.CLERUM_STATELESS_ALLOW_CRON_MANAGE = 'true'
    const { config } = await import('../src/config')
    expect(config.channelsNamespace).toBe('channels')
  })

  it('fails closed when wake_on_interaction is configured', async () => {
    process.env.CLERUM_STATELESS_COMMUNICATION_CHANNEL_POLICY = 'wake_on_interaction'
    await expect(import('../src/config')).rejects.toThrow(/no longer supported/)
  })

  it('fails closed when the retired env is configured to any value', async () => {
    process.env.CLERUM_STATELESS_COMMUNICATION_CHANNEL_POLICY = 'force_always_on'
    await expect(import('../src/config')).rejects.toThrow(
      /CLERUM_STATELESS_COMMUNICATION_CHANNEL_POLICY/
    )
  })
})
