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

  it('loads an explicit spillover threshold', async () => {
    vi.resetModules()
    vi.stubEnv(SPILLOVER, '16384')
    const { config } = await import('./config')
    expect(config.toolSpilloverThresholdBytes).toBe(16_384)
  })
})
