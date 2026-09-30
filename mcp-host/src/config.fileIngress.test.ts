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

  it('defaults the attachment text page to 64 KiB, under a quarter of the default compaction budget', async () => {
    vi.resetModules()
    // Precondition: the default is what is under test, so the variable must be unset.
    expect(process.env.CLERUM_ATTACHMENT_TEXT_READ_MAX_BYTES).toBeUndefined()
    const { config } = await import('./config')
    expect(config.attachmentTextReadMaxBytes).toBe(65_536)
    expect(config.nativeTool.attachmentTextReadMaxBytes).toBe(65_536)
    // The page is inline, so it is measured against the context budget, not
    // the spillover threshold: bytes / 4 heuristic tokens, 0.8 pressure.
    expect(Math.ceil(65_536 / 4)).toBeLessThanOrEqual(0.8 * config.contextMaxTokens * 0.25)
  })

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

  it('loads an explicit spillover threshold', async () => {
    vi.resetModules()
    vi.stubEnv(SPILLOVER, '16384')
    const { config } = await import('./config')
    expect(config.toolSpilloverThresholdBytes).toBe(16_384)
  })
})
