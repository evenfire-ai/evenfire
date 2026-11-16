import { afterEach, describe, expect, it, vi } from 'vitest'

const originalEnv = process.env

const KEY = 'CONTEXT_MAPPER_HOST_WORKSPACE_STORAGE_CLASS'

async function loadConfig(value: string | undefined) {
  vi.resetModules()
  process.env = { ...originalEnv }
  if (value === undefined) delete process.env[KEY]
  else process.env[KEY] = value
  return import('./config')
}

afterEach(() => {
  process.env = originalEnv
  vi.resetModules()
})

describe('CONTEXT_MAPPER_HOST_WORKSPACE_STORAGE_CLASS', () => {
  it('is undefined when unset and reads an explicit class', async () => {
    const unset = await loadConfig(undefined)
    expect(unset.config.hostWorkspaceStorageClassName).toBeUndefined()

    // Witness: the key is read from the environment.
    const set = await loadConfig('standard-rwo')
    expect(set.config.hostWorkspaceStorageClassName).toBe('standard-rwo')

    // An explicit empty value is kept: in Kubernetes it disables dynamic provisioning.
    const empty = await loadConfig('')
    expect(empty.config.hostWorkspaceStorageClassName).toBe('')
  })
})
