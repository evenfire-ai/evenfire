import { afterEach, describe, expect, it, vi } from 'vitest'

const ENV_NAME = 'HCC_HOST_K8S_REQUEST_TIMEOUT_MS'

describe('config.hostK8sRequestTimeoutMs', () => {
  afterEach(() => {
    delete process.env[ENV_NAME]
    vi.resetModules()
  })

  it('defaults to 30 seconds when the env is absent', async () => {
    const { config } = await import('../src/config')
    expect(config.hostK8sRequestTimeoutMs).toBe(30_000)
  })

  it('accepts a positive finite integer', async () => {
    process.env[ENV_NAME] = '1250'
    const { config } = await import('../src/config')
    expect(config.hostK8sRequestTimeoutMs).toBe(1_250)
  })

  it.each(['', '0', '-1', 'not-a-number', 'Infinity', '1.5'])(
    'fails boot for invalid value %j',
    async value => {
      process.env[ENV_NAME] = value
      await expect(import('../src/config')).rejects.toThrow(
        /HCC_HOST_K8S_REQUEST_TIMEOUT_MS must be a positive integer/
      )
    }
  )
})
