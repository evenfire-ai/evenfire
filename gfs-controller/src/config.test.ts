import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadConfig } from './config'

describe('GFS_STORAGE_ROLE', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it.each(['reader', 'writer'] as const)('accepts %s', role => {
    vi.stubEnv('GFS_DEV_MODE', 'true')
    vi.stubEnv('GFS_STORAGE_ROLE', role)
    expect(loadConfig().storageRole).toBe(role)
  })

  it.each([undefined, ''])('rejects absent or empty role %s instead of granting writer authority', role => {
    vi.stubEnv('GFS_DEV_MODE', 'true')
    vi.stubEnv('GFS_STORAGE_ROLE', role)
    expect(() => loadConfig()).toThrow(/GFS_STORAGE_ROLE must be explicitly set/)
  })

  it.each(['Writer', 'read', 'writer ', 'unknown'])('rejects unknown value %s', role => {
    vi.stubEnv('GFS_DEV_MODE', 'true')
    vi.stubEnv('GFS_STORAGE_ROLE', role)
    expect(() => loadConfig()).toThrow(/GFS_STORAGE_ROLE must be explicitly set/)
  })
})

describe('GFS_SYNC_COPY_*', () => {
  beforeEach(() => vi.stubEnv('GFS_STORAGE_ROLE', 'writer'))
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  function configWith(name: string, value: string | undefined) {
    vi.stubEnv('GFS_DEV_MODE', 'true')
    vi.stubEnv(name, value)
    return loadConfig()
  }

  it('uses documented defaults only when the variables are absent', () => {
    vi.stubEnv('GFS_DEV_MODE', 'true')
    vi.stubEnv('GFS_SYNC_COPY_MAX_OBJECTS', undefined)
    vi.stubEnv('GFS_SYNC_COPY_MAX_BYTES', undefined)
    vi.stubEnv('GFS_SYNC_COPY_TIMEOUT_MS', undefined)
    vi.stubEnv('GFS_SYNC_RENAME_MAX_OBJECTS', undefined)
    vi.stubEnv('GFS_SYNC_RENAME_TIMEOUT_MS', undefined)
    expect(loadConfig()).toMatchObject({
      syncCopyMaxObjects: 1000,
      syncCopyMaxBytes: 1073741824,
      syncCopyTimeoutMs: 30000,
      syncRenameMaxObjects: 1000,
      syncRenameTimeoutMs: 30000,
    })
  })

  it.each([
    ['GFS_SYNC_COPY_MAX_OBJECTS', '25', 'syncCopyMaxObjects', 25],
    ['GFS_SYNC_COPY_MAX_OBJECTS', '2500', 'syncCopyMaxObjects', 2500],
    ['GFS_SYNC_COPY_MAX_BYTES', '1024', 'syncCopyMaxBytes', 1024],
    ['GFS_SYNC_COPY_MAX_BYTES', '2147483648', 'syncCopyMaxBytes', 2147483648],
    ['GFS_SYNC_COPY_TIMEOUT_MS', '5000', 'syncCopyTimeoutMs', 5000],
    ['GFS_SYNC_COPY_TIMEOUT_MS', '60000', 'syncCopyTimeoutMs', 60000],
    ['GFS_SYNC_RENAME_MAX_OBJECTS', '250', 'syncRenameMaxObjects', 250],
    ['GFS_SYNC_RENAME_TIMEOUT_MS', '15000', 'syncRenameTimeoutMs', 15000],
  ] as const)('accepts %s=%s without a hidden ceiling', (name, raw, field, expected) => {
    expect(configWith(name, raw)[field]).toBe(expected)
  })

  it.each([
    'GFS_SYNC_COPY_MAX_OBJECTS',
    'GFS_SYNC_COPY_MAX_BYTES',
    'GFS_SYNC_COPY_TIMEOUT_MS',
    'GFS_SYNC_RENAME_MAX_OBJECTS',
    'GFS_SYNC_RENAME_TIMEOUT_MS',
  ])('rejects invalid explicitly configured values for %s', name => {
    for (const raw of [
      '',
      ' ',
      '0',
      '-1',
      '1.5',
      'NaN',
      'Infinity',
      '1e3',
      '9007199254740992',
    ]) {
      expect(() => configWith(name, raw), `${name}=${JSON.stringify(raw)}`).toThrow(
        new RegExp(`${name} must be a positive safe integer`)
      )
    }
  })

  it('accepts the largest safely representable integer', () => {
    expect(
      configWith('GFS_SYNC_COPY_MAX_OBJECTS', String(Number.MAX_SAFE_INTEGER)).syncCopyMaxObjects
    ).toBe(Number.MAX_SAFE_INTEGER)
  })
})
