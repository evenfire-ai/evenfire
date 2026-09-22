import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('compaction pre-prune default (#731)', () => {
  it('T-B pre-prune is on by default and the env var remains the kill switch', async () => {
    // Both halves live in one test on purpose: each is the other's liveness
    // witness. Two different values out of two evaluations prove the module was
    // really re-evaluated and the env really read, so neither assertion can
    // pass on a module cached from an earlier test.
    vi.resetModules()
    vi.stubEnv('CLERUM_COMPACTION_PRE_PRUNE', undefined)
    const unset = await import('./config')
    expect(unset.config.compactionPrePruneEnabled).toBe(true)

    vi.resetModules()
    vi.stubEnv('CLERUM_COMPACTION_PRE_PRUNE', 'false')
    const disabled = await import('./config')
    expect(disabled.config.compactionPrePruneEnabled).toBe(false)
  })
})
