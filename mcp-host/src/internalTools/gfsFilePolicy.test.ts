import { afterEach, describe, expect, it, vi } from 'vitest'
import { VISUAL_INPUT_LIMITS } from '../visualInput/policy'
import { configuredGfsInteger } from './gfsFilePolicy'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('GFS file policy', () => {
  it('uses independent defaults for source transfer, text, retention and quotas', async () => {
    for (const name of [
      'MCP_HOST_GFS_MAX_FILE_BYTES',
      'MCP_HOST_GFS_DOWNLOAD_STORAGE_PERCENT',
      'MCP_HOST_GFS_CALLER_DOWNLOAD_CONCURRENCY',
      'MCP_HOST_GFS_DOWNLOAD_TTL_HOURS',
    ]) {
      vi.stubEnv(name, undefined)
    }
    vi.resetModules()

    const { GFS_FILE_LIMITS } = await import('./gfsFilePolicy')

    expect(GFS_FILE_LIMITS).toEqual({
      maxFileBytes: 16 * 1024 * 1024,
      inlineTextBytes: 8192,
      metadataBytes: 64 * 1024,
      errorBytes: 8 * 1024,
      storagePercent: 85,
      callerActiveDownloads: 1,
      retentionMs: 7 * 24 * 60 * 60 * 1000,
    })
    expect(VISUAL_INPUT_LIMITS.fileBytes).toBe(3 * 1024 * 1024)
  })

  it('accepts an explicitly configured larger source only below the protocol ceiling', async () => {
    vi.stubEnv('MCP_HOST_GFS_MAX_FILE_BYTES', String(200 * 1024 * 1024))
    vi.resetModules()

    const { GFS_FILE_LIMITS } = await import('./gfsFilePolicy')

    expect(GFS_FILE_LIMITS.maxFileBytes).toBe(200 * 1024 * 1024)
  })

  it.each([
    '',
    '0',
    '-1',
    '1.5',
    '1e6',
    'NaN',
    'Infinity',
    ' 16777216 ',
    '+16777216',
    '016777216',
    '16777216bytes',
  ])('rejects non-canonical integer %s', raw => {
    expect(() => configuredGfsInteger('limit', raw, 16, 200)).toThrow()
  })

  it.each(['1', '85', '100'])('accepts a storage percent of %s', async raw => {
    vi.stubEnv('MCP_HOST_GFS_DOWNLOAD_STORAGE_PERCENT', raw)
    vi.resetModules()

    const { GFS_FILE_LIMITS } = await import('./gfsFilePolicy')

    expect(GFS_FILE_LIMITS.storagePercent).toBe(Number(raw))
  })

  it.each(['0', '101', '85.5', '', '-1'])('refuses storage percent %j at startup', async raw => {
    vi.stubEnv('MCP_HOST_GFS_DOWNLOAD_STORAGE_PERCENT', raw)
    vi.resetModules()

    await expect(import('./gfsFilePolicy')).rejects.toThrow('MCP_HOST_GFS_DOWNLOAD_STORAGE_PERCENT')
  })

  it('enforces the protocol ceilings of the remaining integer limits', async () => {
    expect(configuredGfsInteger('limit', '200', 16, 200)).toBe(200)
    expect(() => configuredGfsInteger('limit', '201', 16, 200)).toThrow()

    vi.stubEnv('MCP_HOST_GFS_CALLER_DOWNLOAD_CONCURRENCY', '3')
    vi.resetModules()
    await expect(import('./gfsFilePolicy')).rejects.toThrow('must be no greater than 2')

    // Witness: the same module loads once the value is within its ceiling.
    vi.stubEnv('MCP_HOST_GFS_CALLER_DOWNLOAD_CONCURRENCY', '2')
    vi.resetModules()
    await expect(import('./gfsFilePolicy')).resolves.toBeDefined()
  })

  it('removed retained-storage variables no longer shape the policy', async () => {
    vi.stubEnv('MCP_HOST_GFS_DOWNLOAD_STORAGE_BYTES', '1')
    vi.stubEnv('MCP_HOST_GFS_CALLER_DOWNLOAD_STORAGE_BYTES', 'not-a-number')
    vi.stubEnv('MCP_HOST_GFS_CALLER_DOWNLOAD_MAX_FILES', '65')
    vi.stubEnv('MCP_HOST_GFS_DOWNLOAD_STORAGE_PERCENT', undefined)
    vi.resetModules()

    const policy = await import('./gfsFilePolicy')

    expect(policy.GFS_FILE_LIMITS.storagePercent).toBe(85)
    expect(Object.keys(policy.GFS_FILE_LIMITS)).not.toContain('storageBytes')
    expect(policy.REMOVED_GFS_STORAGE_VARIABLES).toEqual([
      'MCP_HOST_GFS_DOWNLOAD_STORAGE_BYTES',
      'MCP_HOST_GFS_CALLER_DOWNLOAD_STORAGE_BYTES',
      'MCP_HOST_GFS_CALLER_DOWNLOAD_MAX_FILES',
    ])
  })
})
