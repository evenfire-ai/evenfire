import { afterEach, describe, expect, it, vi } from 'vitest'

async function loadConfig(raw?: string) {
  const original = process.env.CONTROL_API_HOST_RPC_ADMISSION_RL_PER_MIN
  if (raw === undefined) delete process.env.CONTROL_API_HOST_RPC_ADMISSION_RL_PER_MIN
  else process.env.CONTROL_API_HOST_RPC_ADMISSION_RL_PER_MIN = raw
  vi.resetModules()
  try {
    return (await import('../src/config.js')).config
  } finally {
    if (original === undefined) delete process.env.CONTROL_API_HOST_RPC_ADMISSION_RL_PER_MIN
    else process.env.CONTROL_API_HOST_RPC_ADMISSION_RL_PER_MIN = original
  }
}

describe('Host-RPC admission configuration', () => {
  afterEach(() => vi.resetModules())

  it('defaults to 300 per fixed minute and accepts positive finite integer overrides', async () => {
    expect((await loadConfig()).hostRpcAdmissionRlPerMin).toBe(300)
    expect((await loadConfig('3')).hostRpcAdmissionRlPerMin).toBe(3)
  })

  it.each(['0', '-1', '1.5', 'Infinity', '9007199254740992'])(
    'rejects invalid override %s without an unlimited bypass',
    async raw => {
      await expect(loadConfig(raw)).rejects.toThrow(
        'CONTROL_API_HOST_RPC_ADMISSION_RL_PER_MIN must be a positive integer'
      )
    }
  )
})
