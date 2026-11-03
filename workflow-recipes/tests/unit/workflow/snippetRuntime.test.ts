import { afterEach, describe, expect, it, vi } from 'vitest'
import { fork } from 'node:child_process'
import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import type {
  SnippetExecuteRequest,
  SnippetExecuteResponse,
} from '../../../src/workflow/snippetTypes'

const WORKFLOW_RECIPES_ROOT = path.resolve(__dirname, '..', '..', '..')
const DIST_ROOT = path.join(WORKFLOW_RECIPES_ROOT, 'dist')
const NODE_MODULES = path.join(WORKFLOW_RECIPES_ROOT, 'node_modules')
const PERMISSION_PROBE = path.resolve(
  __dirname,
  '..',
  '..',
  'fixtures',
  'workflow',
  'snippetPermissionProbe.cjs'
)
const CHECK_SCRIPT = 'process.exit(process.permission ? 0 : 3)'
// The dist/workflow modules that the compiled runtime and its worker fork load.
const COMPILED_SNIPPET_MODULES = ['snippetRuntime', 'snippetWorker', 'snippetTypes']
const nodeRequire = createRequire(__filename)

type SnippetRuntimeModule = typeof import('../../../src/workflow/snippetRuntime')

interface PermissionProbeConfig {
  outputDir: string
  distRoot: string
  nodeModules: string
  outsideFile: string
  plantedLink: string
  escapeName: string
  networkPort: number
}

interface PermissionProbeReport {
  permission: string
  artifact: { sizeBytes?: number; error?: string }
  readGranted: string
  network: string
  readOutside: string
  readOutput: string
  readPlantedLink: string
  writeDist: string
  writeNodeModules: string
  writeParent: string
  createSymlink: string
  createHardLink: string
  childProcess: string
}

// `npm test` builds dist/ first (the pretest script); a direct `vitest run` does not. A
// missing dist/ module, or one older than its source, fails the test here instead of
// testing a worker that no longer matches src/.
async function loadCompiledSnippetRuntime(): Promise<SnippetRuntimeModule> {
  for (const name of COMPILED_SNIPPET_MODULES) {
    const source = path.join(WORKFLOW_RECIPES_ROOT, 'src', 'workflow', `${name}.ts`)
    const compiled = path.join(DIST_ROOT, 'workflow', `${name}.js`)
    let compiledMtimeMs: number
    try {
      compiledMtimeMs = (await fs.stat(compiled)).mtimeMs
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      throw new Error(`${compiled} is missing: run \`npm run build\` in workflow-recipes`)
    }
    if (compiledMtimeMs < (await fs.stat(source)).mtimeMs) {
      throw new Error(
        `${compiled} is older than ${source}: run \`npm run build\` in workflow-recipes`
      )
    }
  }
  return nodeRequire(path.join(DIST_ROOT, 'workflow', 'snippetRuntime.js')) as SnippetRuntimeModule
}

function snippetRequest(code: string): SnippetExecuteRequest {
  return {
    workflowName: 'nightly-report',
    stepId: 'render-report',
    run: { type: 'snippet', language: 'typescript', code },
    previousOutputs: {},
    resolvedWorkloads: [],
    resolvedMcpServers: [],
  }
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
  config: PermissionProbeConfig
): Promise<PermissionProbeReport> {
  return new Promise((resolve, reject) => {
    // executeSnippetInWorker (src/workflow/snippetRuntime.ts) forks the worker with an
    // explicit env that has no NODE_OPTIONS.
    const child = fork(PERMISSION_PROBE, [JSON.stringify(config)], {
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
      `--allow-fs-read=${NODE_MODULES}`,
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

    const result = await executeSnippetInWorker(snippetRequest('return 1'))

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
      `--allow-fs-read=${NODE_MODULES}`,
      `--allow-fs-write=${outputDir}`,
    ])
  })

  it('runs a snippet that writes an artifact in the compiled worker, forked by the compiled runtime with its grants', async () => {
    const runtime = await loadCompiledSnippetRuntime()
    const outputDir = await makeOutputDir()
    vi.stubEnv('CLERUM_WORKFLOW_OUTPUT_DIR', outputDir)

    const response = await runtime.executeSnippetInWorker(
      snippetRequest("await sdk.artifacts.writeMarkdown('report.md', '# ok')\nreturn 'done'"),
      10_000
    )

    expect(response).toEqual({
      stepId: 'render-report',
      status: 'completed',
      output: 'done',
      artifacts: [
        {
          name: 'report.md',
          format: 'md',
          sizeBytes: 4,
          path: '/output/report.md',
          createdAt: expect.any(String),
        },
      ],
    })
    await expect(fs.readFile(path.join(outputDir, 'report.md'), 'utf8')).resolves.toBe('# ok')
    // The fork above used these grants: the compiled runtime grants dist/, where the
    // worker that ships lives, not src/.
    expect(runtime.buildPermissionArgs(outputDir)).toEqual([
      '--permission',
      `--allow-fs-read=${DIST_ROOT}`,
      `--allow-fs-read=${NODE_MODULES}`,
      `--allow-fs-write=${outputDir}`,
    ])
  })

  it('runs the compiled worker under the permission model: an artifact write into an output directory that was absent at fork time is denied', async () => {
    const runtime = await loadCompiledSnippetRuntime()
    const absentOutputDir = path.join(await makeOutputDir(), 'absent')
    vi.stubEnv('CLERUM_WORKFLOW_OUTPUT_DIR', absentOutputDir)

    const response = await runtime.executeSnippetInWorker(
      snippetRequest("await sdk.artifacts.writeMarkdown('report.md', '# ok')\nreturn 'done'"),
      10_000
    )

    // Without the permission model the worker creates the directory and the write
    // succeeds. The worker's own failure reply (not an exit code) and the directory its
    // mkdir created are the liveness witnesses; the file it could not open is absent.
    expect(response).toEqual({
      stepId: 'render-report',
      status: 'failed',
      error: expect.stringMatching(/^Access to this API has been restricted/),
    })
    expect((await fs.stat(absentOutputDir)).isDirectory()).toBe(true)
    await expect(fs.stat(path.join(absentOutputDir, 'report.md'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('lets a child forked with the compiled runtime grants write an artifact and open a TCP connection, and denies reads of the output directory, writes outside it, links and child processes', async () => {
    const runtime = await loadCompiledSnippetRuntime()
    const base = await makeOutputDir()
    const outputDir = path.join(base, 'output')
    await fs.mkdir(outputDir)
    const outsideFile = path.join(await makeOutputDir(), 'outside.txt')
    await fs.writeFile(outsideFile, 'outside', 'utf8')
    // The kind of link another workload sharing the output volume can place there.
    const plantedLink = path.join(outputDir, 'planted-link')
    await fs.symlink(outsideFile, plantedLink)
    const escapeName = `snippet-permission-escape-${process.pid}.txt`
    const escapeTargets = [DIST_ROOT, NODE_MODULES, base].map(dir => path.join(dir, escapeName))
    const server = await startLoopbackServer()

    let report: PermissionProbeReport
    try {
      const { port } = server.address() as net.AddressInfo
      report = await runPermissionProbe(runtime.buildPermissionArgs(outputDir), {
        outputDir,
        distRoot: DIST_ROOT,
        nodeModules: NODE_MODULES,
        outsideFile,
        plantedLink,
        escapeName,
        networkPort: port,
      })
    } finally {
      await new Promise(resolve => server.close(resolve))
      // Only a broken grant set creates these; remove them so no file stays in dist/
      // or node_modules/.
      await Promise.all(escapeTargets.map(file => fs.rm(file, { force: true })))
    }

    // One assertion, so a failure diff shows every field. permission, artifact,
    // readGranted and network are the liveness witnesses (the model is on and the
    // granted work succeeds under it); every other field is a negative assertion.
    // On a Node major that gates network access under --permission, network turns red
    // until the grants add --allow-net.
    expect(report).toEqual({
      permission: 'object',
      artifact: { sizeBytes: 2 },
      readGranted: 'ok',
      network: 'ok',
      readOutside: 'ERR_ACCESS_DENIED',
      readOutput: 'ERR_ACCESS_DENIED',
      readPlantedLink: 'ERR_ACCESS_DENIED',
      writeDist: 'ERR_ACCESS_DENIED',
      writeNodeModules: 'ERR_ACCESS_DENIED',
      writeParent: 'ERR_ACCESS_DENIED',
      createSymlink: 'ERR_ACCESS_DENIED',
      createHardLink: 'ERR_ACCESS_DENIED',
      childProcess: 'ERR_ACCESS_DENIED',
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
