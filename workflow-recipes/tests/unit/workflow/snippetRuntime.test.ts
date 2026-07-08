import { afterEach, describe, expect, it, vi } from 'vitest'

describe('snippet runtime worker permission args', () => {
  afterEach(() => {
    vi.resetModules()
    vi.doUnmock('node:child_process')
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('uses Node permission flags when the current runtime supports them', async () => {
    const spawnSync = vi.fn(() => ({ status: 0 }))
    vi.doMock('node:child_process', async () => {
      const actual =
        await vi.importActual<typeof import('node:child_process')>('node:child_process')
      return { ...actual, spawnSync }
    })

    const { buildPermissionArgs, resetSnippetPermissionProbeForTests } =
      await import('../../../src/workflow/snippetRuntime')
    resetSnippetPermissionProbeForTests()

    const args = buildPermissionArgs('/output')

    expect(spawnSync).toHaveBeenCalledOnce()
    expect(args).toContain('--experimental-permission')
    expect(args.some(arg => arg.includes('--allow-fs-write=/output'))).toBe(true)
  })

  it('falls back when the current runtime does not support Node permission flags', async () => {
    const spawnSync = vi.fn(() => ({ status: 9 }))
    vi.doMock('node:child_process', async () => {
      const actual =
        await vi.importActual<typeof import('node:child_process')>('node:child_process')
      return { ...actual, spawnSync }
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const { buildPermissionArgs, resetSnippetPermissionProbeForTests } =
      await import('../../../src/workflow/snippetRuntime')
    resetSnippetPermissionProbeForTests()

    expect(buildPermissionArgs('/output')).toEqual([])
    expect(buildPermissionArgs('/output')).toEqual([])
    expect(spawnSync).toHaveBeenCalledOnce()
    expect(warn).toHaveBeenCalledOnce()
    expect(warn.mock.calls[0][0]).toMatch(/not supported by this Node runtime/)
  })

  it('logs a distinct fallback reason when the permission probe cannot launch', async () => {
    const spawnSync = vi.fn(() => ({ status: null, error: new Error('spawn failed') }))
    vi.doMock('node:child_process', async () => {
      const actual =
        await vi.importActual<typeof import('node:child_process')>('node:child_process')
      return { ...actual, spawnSync }
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const { buildPermissionArgs, resetSnippetPermissionProbeForTests } =
      await import('../../../src/workflow/snippetRuntime')
    resetSnippetPermissionProbeForTests()

    expect(buildPermissionArgs('/output')).toEqual([])
    expect(warn).toHaveBeenCalledOnce()
    expect(warn.mock.calls[0][0]).toMatch(/probe failed to launch: spawn failed/)
  })

  it('keeps the explicit permission-flag opt out for local tests', async () => {
    const spawnSync = vi.fn(() => ({ status: 0 }))
    vi.doMock('node:child_process', async () => {
      const actual =
        await vi.importActual<typeof import('node:child_process')>('node:child_process')
      return { ...actual, spawnSync }
    })
    vi.stubEnv('CLERUM_SNIPPET_DISABLE_NODE_PERMISSIONS', 'true')

    const { buildPermissionArgs, resetSnippetPermissionProbeForTests } =
      await import('../../../src/workflow/snippetRuntime')
    resetSnippetPermissionProbeForTests()

    expect(buildPermissionArgs('/output')).toEqual([])
    expect(spawnSync).not.toHaveBeenCalled()
  })
})
