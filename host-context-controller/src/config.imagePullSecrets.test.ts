import { afterEach, describe, expect, it, vi } from 'vitest'

const originalEnv = process.env

const KEYS = [
  'CONTEXT_MAPPER_HOST_IMAGE_PULL_SECRET',
  'CONTEXT_MAPPER_WFC_IMAGE_PULL_SECRET',
] as const

async function loadConfig(overrides: Partial<Record<(typeof KEYS)[number], string>>) {
  vi.resetModules()
  process.env = { ...originalEnv }
  for (const k of KEYS) delete process.env[k]
  for (const [k, v] of Object.entries(overrides)) process.env[k] = v
  return import('./config')
}

afterEach(() => {
  process.env = originalEnv
  vi.resetModules()
})

describe('Host and WFC image pull Secret defaults', () => {
  it('default to empty (no imagePullSecrets) and read an explicit name', async () => {
    const unset = await loadConfig({})
    expect(unset.config.hostImagePullSecretName).toBe('')
    expect(unset.config.wfcImagePullSecretName).toBe('')

    // Witness: the same keys are read from the environment.
    const set = await loadConfig({
      CONTEXT_MAPPER_HOST_IMAGE_PULL_SECRET: 'regcred',
      CONTEXT_MAPPER_WFC_IMAGE_PULL_SECRET: 'wfc-regcred',
    })
    expect(set.config.hostImagePullSecretName).toBe('regcred')
    expect(set.config.wfcImagePullSecretName).toBe('wfc-regcred')
  })
})
