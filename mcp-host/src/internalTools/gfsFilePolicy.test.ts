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
      'MCP_HOST_GFS_DOWNLOAD_STORAGE_BYTES',
      'MCP_HOST_GFS_CALLER_DOWNLOAD_STORAGE_BYTES',
      'MCP_HOST_GFS_CALLER_DOWNLOAD_MAX_FILES',
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
      storageBytes: 1024 * 1024 * 1024,
      callerStorageBytes: 256 * 1024 * 1024,
      callerRetainedFiles: 8,
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

  it('enforces source, caller, aggregate and concurrency relationships', async () => {
    expect(configuredGfsInteger('limit', '200', 16, 200)).toBe(200)
    expect(() => configuredGfsInteger('limit', '201', 16, 200)).toThrow()

    vi.stubEnv('MCP_HOST_GFS_MAX_FILE_BYTES', String(17 * 1024 * 1024))
    vi.stubEnv('MCP_HOST_GFS_CALLER_DOWNLOAD_STORAGE_BYTES', String(16 * 1024 * 1024))
    vi.resetModules()
    await expect(import('./gfsFilePolicy')).rejects.toThrow(
      'must fit within the caller retained-storage budget'
    )

    vi.stubEnv('MCP_HOST_GFS_CALLER_DOWNLOAD_STORAGE_BYTES', String(1024 * 1024 * 1024 + 1))
    vi.resetModules()
    await expect(import('./gfsFilePolicy')).rejects.toThrow(
      'must not exceed the Host aggregate retained-storage budget'
    )

    vi.stubEnv('MCP_HOST_GFS_CALLER_DOWNLOAD_STORAGE_BYTES', undefined)
    vi.stubEnv('MCP_HOST_GFS_CALLER_DOWNLOAD_MAX_FILES', '65')
    vi.resetModules()
    await expect(import('./gfsFilePolicy')).rejects.toThrow('must be no greater than 64')

    vi.stubEnv('MCP_HOST_GFS_CALLER_DOWNLOAD_MAX_FILES', undefined)
    vi.stubEnv('MCP_HOST_GFS_CALLER_DOWNLOAD_CONCURRENCY', '3')
    vi.resetModules()
    await expect(import('./gfsFilePolicy')).rejects.toThrow('must be no greater than 2')
  })
})
