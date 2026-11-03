import { afterEach, describe, expect, it, vi } from 'vitest'
import { fork } from 'node:child_process'
import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import type { SnippetExecuteResponse } from '../../../src/workflow/snippetTypes'

const WORKFLOW_RECIPES_ROOT = path.resolve(__dirname, '..', '..', '..')
const PERMISSION_PROBE = path.resolve(
  __dirname,
  '..',
  '..',
  'fixtures',
  'workflow',
  'snippetPermissionProbe.cjs'
)
// Exists on Linux and macOS runners and is outside every grant.
const OUTSIDE_EVERY_GRANT = '/etc/hosts'
const CHECK_SCRIPT = 'process.exit(process.permission ? 0 : 3)'

interface PermissionProbeReport {
  permission: string
  modules: Record<string, string>
  artifact: { sizeBytes?: number; error?: string }
  network: string
  outsideRead: string
}

async function startLoopbackServer(): Promise<net.Server> {
  const server = net.createServer(socket => socket.end('ok'))
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  return server
}

function runPermissionProbe(
  execArgv: string[],
  outputDir: string,
  networkPort: number
): Promise<PermissionProbeReport> {
  return new Promise((resolve, reject) => {
    // executeSnippetInWorker (src/workflow/snippetRuntime.ts) forks the worker with an
    // explicit env that has no NODE_OPTIONS.
    const child = fork(PERMISSION_PROBE, [outputDir, OUTSIDE_EVERY_GRANT, String(networkPort)], {
      execArgv,
      env: {},
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    })
    let stderr = ''
    let report: PermissionProbeReport | undefined
    child.stderr?.on('data', chunk => {
      stderr += String(chunk)
    })
    child.once('message', message => {
      report = message as PermissionProbeReport
    })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (report) resolve(report)
      else
        reject(
          new Error(
            `permission probe exited (code ${code}, signal ${signal}) without a report: ${stderr}`
          )
        )
    })
  })
}

async function mockSpawnSync(result: Record<string, unknown>) {
  const spawnSync = vi.fn(() => result)
  vi.doMock('node:child_process', async () => {
    const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
    return { ...actual, spawnSync }
  })
  return spawnSync
}

interface FakeWorkerChild {
  stdout: null
  stderr: null
  killed: boolean
  once: (event: string, handler: (...args: unknown[]) => void) => FakeWorkerChild
  kill: () => boolean
  send: () => boolean
}

// Captures the fork options instead of starting a real worker: the caller controls the
// single reply the fake child delivers when the request is sent.
function mockForkOnce(response: SnippetExecuteResponse): {
  fork: ReturnType<typeof vi.fn>
  child: FakeWorkerChild
} {
  const handlers = new Map<string, (...args: unknown[]) => void>()
  const child: FakeWorkerChild = {
    stdout: null,
    stderr: null,
    killed: false,
    once: (event, handler) => {
      handlers.set(event, handler)
      return child
    },
    kill: () => {
      child.killed = true
      return true
    },
    send: () => {
      // Deferred so executeSnippetInWorker has armed its timeout before the reply lands.
      queueMicrotask(() => handlers.get('message')?.(response))
      return true
    },
  }
  const fork = vi.fn(() => child)
  vi.doMock('node:child_process', async () => {
    const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
    return { ...actual, fork }
  })
  return { fork, child }
}

// Spies through to the real spawnSync, so the check runs on the Node that runs the tests.
async function spyOnRealSpawnSync() {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
  const spawnSync = vi.fn(actual.spawnSync)
  vi.doMock('node:child_process', () => ({ ...actual, spawnSync }))
  return spawnSync
}

function captureThrown(fn: () => unknown): unknown {
  try {
    fn()
  } catch (error) {
    return error
  }
  return undefined
}

describe('snippet runtime Node permission model', () => {
  const tempDirs: string[] = []

  afterEach(async () => {
    vi.resetModules()
    vi.doUnmock('node:child_process')
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })))
  })

  async function makeOutputDir(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'snippet-permission-'))
    tempDirs.push(dir)
    return dir
  }

  it('uses the stable Node permission flag with one grant per path', async () => {
    const { buildPermissionArgs } = await import('../../../src/workflow/snippetRuntime')

    expect(buildPermissionArgs('/out')).toEqual([
      '--permission',
      `--allow-fs-read=${path.join(WORKFLOW_RECIPES_ROOT, 'src')}`,
      `--allow-fs-read=${path.join(WORKFLOW_RECIPES_ROOT, 'node_modules')}`,
      '--allow-fs-write=/out',
    ])
  })

  it('forks the snippet worker under the permission model with grants for the configured output directory', async () => {
    const outputDir = await makeOutputDir()
    vi.stubEnv('CLERUM_WORKFLOW_OUTPUT_DIR', outputDir)
    const response: SnippetExecuteResponse = {
      stepId: 'render-report',
      status: 'completed',
      output: 'ok',
    }
    const { fork } = mockForkOnce(response)
    const { buildPermissionArgs, executeSnippetInWorker, resolveSnippetOutputDir } =
      await import('../../../src/workflow/snippetRuntime')
    expect(resolveSnippetOutputDir()).toBe(outputDir)

    const result = await executeSnippetInWorker({
      workflowName: 'nightly-report',
      stepId: 'render-report',
      run: { type: 'snippet', language: 'typescript', code: 'return 1' },
      previousOutputs: {},
      resolvedWorkloads: [],
      resolvedMcpServers: [],
    })

    // Liveness witnesses: the single fork started the snippet worker with no argv of its
    // own, the grants follow the configured output directory, and the reply reached the caller.
    expect(result).toEqual(response)
    expect(fork).toHaveBeenCalledOnce()
    const [workerPath, args, options] = fork.mock.calls[0] as unknown as [
      string,
      string[],
      { execArgv: string[] },
    ]
    expect(workerPath).toBe(path.join(WORKFLOW_RECIPES_ROOT, 'src', 'workflow', 'snippetWorker.js'))
    expect(args).toEqual([])
    expect(options.execArgv).toEqual(buildPermissionArgs(outputDir))
    // Spelled out so a hardcoded '/output' grant cannot pass the comparison above.
    expect(options.execArgv).toEqual([
      '--permission',
      `--allow-fs-read=${path.join(WORKFLOW_RECIPES_ROOT, 'src')}`,
      `--allow-fs-read=${path.join(WORKFLOW_RECIPES_ROOT, 'node_modules')}`,
      `--allow-fs-write=${outputDir}`,
    ])
  })

  it('forks a child under the permission model that loads the worker modules, writes an artifact, reaches the network and cannot read outside its grants', async () => {
    const { buildPermissionArgs } = await import('../../../src/workflow/snippetRuntime')
    const outputDir = await makeOutputDir()
    const server = await startLoopbackServer()

    let report: PermissionProbeReport
    try {
      const { port } = server.address() as net.AddressInfo
      report = await runPermissionProbe(buildPermissionArgs(outputDir), outputDir, port)
    } finally {
      await new Promise(resolve => server.close(resolve))
    }

    // One assertion, so a failure diff shows every field. permission, modules,
    // artifact and network are the liveness witnesses (the model is on and the
    // worker's own work succeeds under it); outsideRead is the negative assertion.
    expect(report).toEqual({
      permission: 'object',
      modules: {
        '@modelcontextprotocol/sdk/client/index.js': 'ok',
        '@modelcontextprotocol/sdk/client/sse.js': 'ok',
        '@modelcontextprotocol/sdk/client/streamableHttp.js': 'ok',
        mongodb: 'ok',
        pg: 'ok',
        typescript: 'ok',
      },
      artifact: { sizeBytes: 2 },
      network: 'ok',
      outsideRead: 'ERR_ACCESS_DENIED',
    })
  })

  it('runs the real permission model check on the pinned Node runtime', async () => {
    const spawnSync = await spyOnRealSpawnSync()
    const { assertNodePermissionModel, buildPermissionArgs } =
      await import('../../../src/workflow/snippetRuntime')
    const outputDir = await makeOutputDir()

    expect(() => assertNodePermissionModel(outputDir)).not.toThrow()

    // Liveness witnesses: the real check ran once, with the worker grants, and returned 0.
    expect(spawnSync).toHaveBeenCalledOnce()
    const [bin, args] = spawnSync.mock.calls[0] as unknown as [string, string[]]
    expect(bin).toBe(process.execPath)
    expect(args).toEqual([...buildPermissionArgs(outputDir), '-e', CHECK_SCRIPT])
    expect((spawnSync.mock.results[0].value as { status: number | null }).status).toBe(0)
  })

  it('passes the real check when the output directory does not exist (runner Pod without an output volume)', async () => {
    const spawnSync = await spyOnRealSpawnSync()
    const { assertNodePermissionModel, buildPermissionArgs } =
      await import('../../../src/workflow/snippetRuntime')
    const absentOutputDir = path.join(await makeOutputDir(), 'absent')

    expect(() => assertNodePermissionModel(absentOutputDir)).not.toThrow()

    // Liveness witnesses: the real check ran once, with the grants for the absent path,
    // and returned 0; the path still does not exist afterwards.
    expect(spawnSync).toHaveBeenCalledOnce()
    const [bin, args] = spawnSync.mock.calls[0] as unknown as [string, string[]]
    expect(bin).toBe(process.execPath)
    expect(args).toEqual([...buildPermissionArgs(absentOutputDir), '-e', CHECK_SCRIPT])
    expect((spawnSync.mock.results[0].value as { status: number | null }).status).toBe(0)
    await expect(fs.stat(absentOutputDir)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('throws with the status, signal and first stderr line when the runtime rejects the flags', async () => {
    const spawnSync = await mockSpawnSync({
      pid: 0,
      output: [null, null, Buffer.from('node: bad option: --permission\nmore\n')],
      stdout: null,
      stderr: Buffer.from('node: bad option: --permission\nmore\n'),
      status: 9,
      signal: null,
    })
    const { assertNodePermissionModel } = await import('../../../src/workflow/snippetRuntime')

    const thrown = captureThrown(() => assertNodePermissionModel('/out'))

    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).message).toBe(
      'snippet runner refuses to start: Node permission model check failed (status 9, signal null): node: bad option: --permission'
    )
    expect(spawnSync).toHaveBeenCalledOnce()
  })

  it('names the launch error when the check process cannot be spawned', async () => {
    const spawnSync = await mockSpawnSync({
      pid: 0,
      output: null,
      stdout: null,
      stderr: null,
      status: null,
      signal: null,
      error: new Error('spawnSync node EAGAIN'),
    })
    const { assertNodePermissionModel } = await import('../../../src/workflow/snippetRuntime')

    const thrown = captureThrown(() => assertNodePermissionModel('/out'))

    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).message).toBe(
      'snippet runner refuses to start: Node permission model check failed (status null, signal null, error spawnSync node EAGAIN): '
    )
    expect(spawnSync).toHaveBeenCalledOnce()
  })
})
