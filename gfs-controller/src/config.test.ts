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

  it.each([undefined, ''])(
    'rejects absent or empty role %s instead of granting writer authority',
    role => {
      vi.stubEnv('GFS_DEV_MODE', 'true')
      vi.stubEnv('GFS_STORAGE_ROLE', role)
      expect(() => loadConfig()).toThrow(/GFS_STORAGE_ROLE must be explicitly set/)
    }
  )

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
    for (const raw of ['', ' ', '0', '-1', '1.5', 'NaN', 'Infinity', '1e3', '9007199254740992']) {
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

describe('GFS_UPLOAD_V2 strict disabled contract', () => {
  beforeEach(() => vi.stubEnv('GFS_STORAGE_ROLE', 'writer'))
  afterEach(() => vi.unstubAllEnvs())

  it('uses the 200 MiB product policy, 1 GiB protocol ceiling, and disabled capability defaults', () => {
    vi.stubEnv('GFS_DEV_MODE', 'true')
    expect(loadConfig().uploadV2).toMatchObject({
      productMaxFileBytes: 209715200,
      protocolMaxFileBytes: 1073741824,
      preferredPartBytes: 8388608,
      maxPartBytes: 16777216,
      maxConcurrentPartsPerSession: 4,
      maxConcurrentPartStreamsGlobal: 16,
      instabilityFailureThreshold: 3,
      enabled: false,
    })
  })

  it('accepts an explicit enable only as a configuration value; runtime readiness owns activation', () => {
    vi.stubEnv('GFS_DEV_MODE', 'true')
    vi.stubEnv('GFS_UPLOAD_V2_ENABLED', 'true')
    expect(loadConfig().uploadV2.enabled).toBe(true)
  })

  it('requires the product boundary and deprecated max-file alias to agree', () => {
    vi.stubEnv('GFS_DEV_MODE', 'true')
    vi.stubEnv('GFS_UPLOAD_PRODUCT_MAX_FILE_BYTES', '209715200')
    vi.stubEnv('GFS_UPLOAD_MAX_FILE_BYTES', '209715199')
    expect(() => loadConfig()).toThrow(/must match/)
  })

  it('accepts matching canonical and deprecated runtime product limits', () => {
    vi.stubEnv('GFS_DEV_MODE', 'true')
    vi.stubEnv('GFS_UPLOAD_PRODUCT_MAX_FILE_BYTES', String(300 * 1024 * 1024))
    vi.stubEnv('GFS_UPLOAD_MAX_FILE_BYTES', String(300 * 1024 * 1024))
    expect(loadConfig().uploadV2.productMaxFileBytes).toBe(300 * 1024 * 1024)
  })

  it.each([
    ['one byte', 1],
    ['100 MiB', 100 * 1024 * 1024],
    ['200 MiB', 200 * 1024 * 1024],
    ['250 MiB', 250 * 1024 * 1024],
    ['300 MiB', 300 * 1024 * 1024],
    ['the protocol maximum', 1024 * 1024 * 1024],
  ] as const)('accepts a runtime product limit at %s', (_label, bytes) => {
    vi.stubEnv('GFS_DEV_MODE', 'true')
    vi.stubEnv('GFS_UPLOAD_PRODUCT_MAX_FILE_BYTES', String(bytes))
    expect(loadConfig().uploadV2.productMaxFileBytes).toBe(bytes)
  })

  it.each([
    '',
    '0',
    '-1',
    '1.5',
    'NaN',
    'Infinity',
    '1e3',
    '01',
    '+1',
    ' 1',
    '1 ',
    '9007199254740992',
    '1073741825',
  ])(
    'rejects invalid runtime product limit %s',
    raw => {
      vi.stubEnv('GFS_DEV_MODE', 'true')
      vi.stubEnv('GFS_UPLOAD_PRODUCT_MAX_FILE_BYTES', raw)
      expect(() => loadConfig()).toThrow(/GFS_UPLOAD_PRODUCT_MAX_FILE_BYTES/)
    }
  )

  it('rejects a product limit above the configured protocol maximum', () => {
    vi.stubEnv('GFS_DEV_MODE', 'true')
    vi.stubEnv('GFS_UPLOAD_PROTOCOL_MAX_FILE_BYTES', String(300 * 1024 * 1024))
    vi.stubEnv('GFS_UPLOAD_PRODUCT_MAX_FILE_BYTES', String(300 * 1024 * 1024 + 1))
    expect(() => loadConfig()).toThrow(/GFS_UPLOAD_PRODUCT_MAX_FILE_BYTES/)
  })

  it.each([
    ['the configured minimum', 200 * 1024 * 1024],
    ['a normal canonical value', 300 * 1024 * 1024],
    ['the compiled maximum', 1024 * 1024 * 1024],
  ] as const)('accepts %s as a canonical protocol maximum', (_label, bytes) => {
    vi.stubEnv('GFS_DEV_MODE', 'true')
    vi.stubEnv('GFS_UPLOAD_PROTOCOL_MAX_FILE_BYTES', String(bytes))
    expect(loadConfig().uploadV2.protocolMaxFileBytes).toBe(bytes)
  })

  it.each([
    '01073741824',
    '+1073741824',
    ' 1073741824',
    '1073741824 ',
    '1e9',
    '1073741824.0',
    '-1',
    '9007199254740992',
  ])('rejects non-canonical protocol maximum %s', raw => {
    vi.stubEnv('GFS_DEV_MODE', 'true')
    vi.stubEnv('GFS_UPLOAD_PROTOCOL_MAX_FILE_BYTES', raw)
    expect(() => loadConfig()).toThrow(/GFS_UPLOAD_PROTOCOL_MAX_FILE_BYTES/)
  })

  it('accepts the plan-owned chunk and millisecond TTL names', () => {
    vi.stubEnv('GFS_DEV_MODE', 'true')
    vi.stubEnv('GFS_UPLOAD_PREFERRED_CHUNK_BYTES', '8388608')
    vi.stubEnv('GFS_UPLOAD_MAX_CHUNK_BYTES', '16777216')
    vi.stubEnv('GFS_UPLOAD_MIN_PART_BYTES', '1048576')
    vi.stubEnv('GFS_UPLOAD_SESSION_TTL_MS', '86400000')
    vi.stubEnv('GFS_UPLOAD_COMPLETED_RECEIPT_TTL_MS', '86400000')
    expect(loadConfig().uploadV2).toMatchObject({
      productMaxFileBytes: 209715200,
      preferredPartBytes: 8388608,
      maxPartBytes: 16777216,
      sessionTtlSeconds: 86400,
      receiptRetentionSeconds: 86400,
    })
  })

  it.each(['', '1', 'yes', 'TRUE'])('rejects non-canonical flag %s', raw => {
    vi.stubEnv('GFS_DEV_MODE', 'true')
    vi.stubEnv('GFS_UPLOAD_V2_ENABLED', raw)
    expect(() => loadConfig()).toThrow(/must be exactly 'true' or 'false'/)
  })

  it('rejects a protocol ceiling below the default product boundary or above 1 GiB', () => {
    for (const raw of ['209715199', '1073741825']) {
      vi.stubEnv('GFS_DEV_MODE', 'true')
      vi.stubEnv('GFS_UPLOAD_PROTOCOL_MAX_FILE_BYTES', raw)
      expect(() => loadConfig()).toThrow(/GFS_UPLOAD_PROTOCOL_MAX_FILE_BYTES/)
      vi.unstubAllEnvs()
      vi.stubEnv('GFS_STORAGE_ROLE', 'writer')
    }
  })

  it('rejects a fallback concurrency that cannot reduce the four-part window', () => {
    vi.stubEnv('GFS_DEV_MODE', 'true')
    vi.stubEnv('GFS_UPLOAD_FALLBACK_CONCURRENCY', '4')
    expect(() => loadConfig()).toThrow(/FALLBACK_CONCURRENCY must be lower/)
  })

  it('accepts the bounded instability threshold and rejects values outside the capability contract', () => {
    vi.stubEnv('GFS_DEV_MODE', 'true')
    vi.stubEnv('GFS_UPLOAD_INSTABILITY_FAILURE_THRESHOLD', '7')
    expect(loadConfig().uploadV2.instabilityFailureThreshold).toBe(7)
    for (const raw of ['0', '101', '1.5', 'NaN', 'Infinity']) {
      vi.stubEnv('GFS_UPLOAD_INSTABILITY_FAILURE_THRESHOLD', raw)
      expect(() => loadConfig(), `threshold=${raw}`).toThrow(
        /GFS_UPLOAD_INSTABILITY_FAILURE_THRESHOLD must be an integer from 1 through 100/
      )
    }
  })

  it('fails closed when stale lease cleanup could race an active part timeout', () => {
    vi.stubEnv('GFS_DEV_MODE', 'true')
    vi.stubEnv('GFS_UPLOAD_PART_TIMEOUT_MS', '600000')
    vi.stubEnv('GFS_UPLOAD_STALE_PART_LEASE_MS', '600000')
    expect(() => loadConfig()).toThrow(
      /GFS_UPLOAD_STALE_PART_LEASE_MS must be greater than GFS_UPLOAD_PART_TIMEOUT_MS/
    )

    vi.stubEnv('GFS_UPLOAD_STALE_PART_LEASE_MS', '600001')
    expect(loadConfig().uploadV2.stalePartLeaseMs).toBe(600001)
  })
})
