import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { rejectedNodeFlagSpawnSyncResult } from './rejectedNodeFlagSpawnSync'

// Separate from snippetRunnerServer.test.ts, which imports the module statically:
// these cases reset modules and mock node:child_process before importing it.
describe('snippet runner startup Node permission check', () => {
  let tokenDir: string
  let outputDir: string

  beforeEach(async () => {
    tokenDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snippet-runner-token-'))
    outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snippet-runner-output-'))
    const tokenPath = path.join(tokenDir, 'token')
    await fs.writeFile(tokenPath, 'runner-token\n', 'utf8')
    vi.stubEnv('SNIPPET_RUNNER_TOKEN_FILE', tokenPath)
    vi.stubEnv('CLERUM_WORKFLOW_OUTPUT_DIR', outputDir)
  })

  afterEach(async () => {
    vi.resetModules()
    vi.doUnmock('node:child_process')
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    await fs.rm(tokenDir, { recursive: true, force: true })
    await fs.rm(outputDir, { recursive: true, force: true })
  })

  it('refuses to start when the Node runtime rejects the permission flags', async () => {
    // Shaped by a real `node --bogus` rejection, so the status, signal and stderr cannot
    // drift from what spawnSync returns.
    const rejected = rejectedNodeFlagSpawnSyncResult()
    const spawnSync = vi.fn(() => rejected)
    vi.doMock('node:child_process', async () => {
      const actual =
        await vi.importActual<typeof import('node:child_process')>('node:child_process')
      return { ...actual, spawnSync }
    })
    const { createSnippetRunnerServer } = await import('../../../src/workflow/snippetRunnerServer')

    let thrown: unknown
    try {
      createSnippetRunnerServer()
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).message).toContain(
      `Node permission model check failed (status ${rejected.status}`
    )
    expect((thrown as Error).message).toContain('bad option: --permission')
    // Liveness witnesses: the check ran once, with the grants for the output directory
    // that resolveSnippetOutputDir() returns, under a timeout.
    expect(spawnSync).toHaveBeenCalledOnce()
    const [bin, args, options] = spawnSync.mock.calls[0] as unknown as [
      string,
      string[],
      { timeout?: number },
    ]
    expect(bin).toBe(process.execPath)
    const root = path.resolve(__dirname, '..', '..', '..')
    expect(args).toEqual([
      '--permission',
      `--allow-fs-read=${path.join(root, 'src')}`,
      `--allow-fs-read=${path.join(root, 'node_modules')}`,
      `--allow-fs-write=${outputDir}`,
      '-e',
      'process.exit(process.permission ? 0 : 3)',
    ])
    expect(options.timeout).toBe(10_000)
  })

  it('starts on the pinned Node runtime with the real permission check', async () => {
    // Spies through to the real spawnSync, so the check runs on the Node that runs the tests.
    const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
    const spawnSync = vi.fn(actual.spawnSync)
    vi.doMock('node:child_process', () => ({ ...actual, spawnSync }))
    const { createSnippetRunnerServer } = await import('../../../src/workflow/snippetRunnerServer')

    const server = createSnippetRunnerServer()

    expect(server).toBeInstanceOf(http.Server)
    expect(server.listening).toBe(false)
    // Liveness witness: the real check ran once before the server was returned, and passed.
    expect(spawnSync).toHaveBeenCalledOnce()
    expect((spawnSync.mock.results[0].value as { status: number | null }).status).toBe(0)
  })
})
