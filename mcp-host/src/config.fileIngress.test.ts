import { afterEach, describe, expect, it, vi } from 'vitest'
import { FILE_REFERENCE_MAX_COUNT } from '@clerum/gfs-interaction-policy'

// #666 file ingress limits. The Host takes its reference-count limit from the
// contract's shared constant, the same one the Desktop composer imports, and
// exposes no override, so the two cannot disagree. An unparseable spillover
// threshold stops the Host at load instead of describing "NaN bytes" to the
// model.
const SPILLOVER = 'CLERUM_TOOL_SPILLOVER_THRESHOLD'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('#666 file ingress configuration', () => {
  it('takes the reference-count limit from the shared contract constant', async () => {
    vi.resetModules()
    const { config } = await import('./config')
    expect(FILE_REFERENCE_MAX_COUNT).toBeGreaterThan(0)
    expect(config.fileReferenceMaxCount).toBe(FILE_REFERENCE_MAX_COUNT)
  })

  it('ignores the retired CLERUM_FILE_REFERENCE_MAX_COUNT variable', async () => {
    vi.resetModules()
    vi.stubEnv('CLERUM_FILE_REFERENCE_MAX_COUNT', String(FILE_REFERENCE_MAX_COUNT + 5))
    const { config } = await import('./config')
    expect(config.fileReferenceMaxCount).toBe(FILE_REFERENCE_MAX_COUNT)
  })

  it.each(['abc', '0', '1.5', '10k'])(
    'rejects a spillover threshold of %j at config load, naming the variable',
    async value => {
      vi.resetModules()
      vi.stubEnv(SPILLOVER, value)
      await expect(import('./config')).rejects.toThrow(SPILLOVER)
    }
  )

  it('defaults the per-file attachment limit to 11MiB, the parser file quota (#678)', async () => {
    vi.resetModules()
    // Precondition: the default is what is under test, so the variable must be unset.
    expect(process.env.CLERUM_ATTACHMENT_FILE_MAX_BYTES).toBeUndefined()
    const { config } = await import('./config')
    expect(config.attachmentFileMaxBytes).toBe(11_534_336)
  })

  it('defaults the attachment text page to 64 KiB without assuming a token-to-byte ratio', async () => {
    vi.resetModules()
    // Precondition: the default is what is under test, so the variable must be unset.
    expect(process.env.CLERUM_ATTACHMENT_TEXT_READ_MAX_BYTES).toBeUndefined()
    const { config } = await import('./config')
    expect(config.attachmentTextReadMaxBytes).toBe(65_536)
    expect(config.nativeTool.attachmentTextReadMaxBytes).toBe(65_536)
  })

  it.each([
    ['CLERUM_ATTACHMENT_TEXT_READ_MAX_BYTES', '1048577', '1048576'],
    ['CLERUM_ATTACHMENT_FILE_MAX_BYTES', '11534337', '11534336'],
  ])(
    'rejects %s above its transport ceiling and accepts the ceiling',
    async (key, above, ceiling) => {
      vi.resetModules()
      vi.stubEnv(key, above)
      await expect(import('./config').then(() => undefined)).rejects.toThrow(key)

      vi.resetModules()
      vi.stubEnv(key, ceiling)
      const { config } = await import('./config')
      const field =
        key === 'CLERUM_ATTACHMENT_TEXT_READ_MAX_BYTES'
          ? config.attachmentTextReadMaxBytes
          : config.attachmentFileMaxBytes
      expect(field).toBe(Number(ceiling))
    }
  )

  it.each(['0', 'abc', '1.5', '10k'])(
    'rejects an attachment text page of %j while accepting a smaller bounded page',
    async value => {
      vi.resetModules()
      vi.stubEnv('CLERUM_ATTACHMENT_TEXT_READ_MAX_BYTES', value)
      await expect(import('./config')).rejects.toThrow('CLERUM_ATTACHMENT_TEXT_READ_MAX_BYTES')

      vi.resetModules()
      vi.stubEnv('CLERUM_ATTACHMENT_TEXT_READ_MAX_BYTES', '4096')
      const { config } = await import('./config')
      expect(config.attachmentTextReadMaxBytes).toBe(4096)
      expect(config.nativeTool.attachmentTextReadMaxBytes).toBe(4096)
    }
  )

  it.each(['0', 'abc', '2147483648'])(
    'rejects a per-file attachment limit of %j at config load, naming the variable',
    async value => {
      vi.resetModules()
      vi.stubEnv('CLERUM_ATTACHMENT_FILE_MAX_BYTES', value)
      await expect(import('./config')).rejects.toThrow(
        'CLERUM_ATTACHMENT_FILE_MAX_BYTES must be a valid bounded integer'
      )
    }
  )

  it('loads an explicit per-file attachment limit', async () => {
    vi.resetModules()
    vi.stubEnv('CLERUM_ATTACHMENT_FILE_MAX_BYTES', '3145728')
    const { config } = await import('./config')
    expect(config.attachmentFileMaxBytes).toBe(3_145_728)
  })

  it('ignores the attachment retention variables, which have no store to configure', async () => {
    vi.resetModules()
    // Each value stopped the Host at load while the retention limits were parsed.
    vi.stubEnv('CLERUM_ATTACHMENT_STORE_TTL_HOURS', '0')
    vi.stubEnv('CLERUM_ATTACHMENT_STORE_SESSION_MAX_BYTES', '11534335')
    vi.stubEnv('CLERUM_ATTACHMENT_STORE_HOST_MAX_BYTES', '1')
    vi.stubEnv('CLERUM_ATTACHMENT_FILE_MAX_BYTES', '3145728')
    const loaded = import('./config').then(({ config }) => config)
    // Witness: the per-file limit is still read from its own variable.
    await expect(loaded).resolves.toMatchObject({ attachmentFileMaxBytes: 3_145_728 })
    expect(Object.keys(await loaded).filter(key => key.startsWith('attachmentStore'))).toEqual([])
  })

  it('loads an explicit spillover threshold', async () => {
    vi.resetModules()
    vi.stubEnv(SPILLOVER, '16384')
    const { config } = await import('./config')
    expect(config.toolSpilloverThresholdBytes).toBe(16_384)
  })
})
