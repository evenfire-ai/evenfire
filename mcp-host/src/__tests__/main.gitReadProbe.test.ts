/**
 * main.ts runs the git probe once at startup and gives its result to the
 * native tool config, so the registry registers git_read. Removing that line
 * left every main wiring suite green.
 */
import { describe, expect, it, vi } from 'vitest'
import { register } from 'prom-client'

const probe = vi.hoisted(() => {
  // config.ts reads these when main.ts loads.
  process.env.CLERUM_SERVER_PORT = '0'
  process.env.CLERUM_ENABLE_AUTH = 'false'
  process.env.CLERUM_HOST_NAME = 'host-a'
  return {
    calls: 0,
    result: { available: true as const, gitPath: '/usr/bin/git', version: [2, 39, 5] as const },
  }
})

vi.mock('../core/tools/gitRead/probe', async importOriginal => ({
  ...(await importOriginal<typeof import('../core/tools/gitRead/probe')>()),
  probeGitRead: () => {
    probe.calls++
    return probe.result
  },
}))

describe('main.ts git_read probe wiring', () => {
  it('probes once at startup and the native tool registry registers git_read', async () => {
    register.clear()
    vi.resetModules()
    await import('../main')
    const { config } = await import('../config')
    expect(probe.calls).toBe(1)
    expect(config.nativeTool.gitRead).toBe(probe.result)
    const { NativeToolRegistry } = await import('../core/tools/nativeToolRegistry')
    const names = new NativeToolRegistry(config.nativeTool, 'conv')
      .listDefinitions()
      .map(d => d.name)
    expect(names).toContain('git_read')
  })
})
