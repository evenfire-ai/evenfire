import { afterEach, describe, expect, it, vi } from 'vitest'

const KEY = 'WORKFLOW_APPROVAL_READER_ENABLED_MEDIA'
const originalEnv = process.env

async function loadConfig(value: string | undefined) {
  vi.resetModules()
  process.env = { ...originalEnv }
  if (value === undefined) delete process.env[KEY]
  else process.env[KEY] = value
  return import('../src/config.js')
}

afterEach(() => {
  process.env = originalEnv
  vi.resetModules()
})

describe('WORKFLOW_APPROVAL_READER_ENABLED_MEDIA', () => {
  it('defaults to telegram, slack and teams, and reads an explicit list', async () => {
    const unset = await loadConfig(undefined)
    expect([...unset.config.enabledMedia].sort()).toEqual(['slack', 'teams', 'telegram'])

    // Witness: the key is read from the environment.
    const set = await loadConfig('slack')
    expect([...set.config.enabledMedia]).toEqual(['slack'])
  })

  it('rejects an unsupported medium at import', async () => {
    await expect(loadConfig('email')).rejects.toThrow(
      'WORKFLOW_APPROVAL_READER_ENABLED_MEDIA unsupported medium: email'
    )
  })
})
