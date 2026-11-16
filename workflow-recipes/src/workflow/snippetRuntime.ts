import { fork, spawnSync } from 'node:child_process'
import path from 'node:path'
import type { SnippetExecuteRequest, SnippetExecuteResponse } from './snippetTypes'

const DEFAULT_SNIPPET_TIMEOUT_MS = 300_000
const SNIPPET_WORKER_TIMEOUT_ENV_PASSTHROUGH = new Set([
  'CLERUM_MCP_TOOL_TIMEOUT_MS',
  'CLERUM_MCP_TOOL_MAX_TOTAL_TIMEOUT_MS',
])
const NODE_PERMISSION_MODEL_CHECK_SCRIPT = 'process.exit(process.permission ? 0 : 3)'
const NODE_PERMISSION_MODEL_CHECK_TIMEOUT_MS = 10_000

export function resolveSnippetOutputDir(): string {
  return process.env.CLERUM_WORKFLOW_OUTPUT_DIR || '/output'
}

export function executeSnippetInWorker(
  request: SnippetExecuteRequest,
  timeoutMs = DEFAULT_SNIPPET_TIMEOUT_MS
): Promise<SnippetExecuteResponse> {
  return new Promise(resolve => {
    let settled = false
    const outputDir = resolveSnippetOutputDir()
    const workerPath = path.join(__dirname, 'snippetWorker.js')
    const child = fork(workerPath, [], {
      execArgv: buildPermissionArgs(outputDir),
      env: {
        NODE_ENV: process.env.NODE_ENV ?? 'production',
        CLERUM_SNIPPET_WORKER_CHILD: 'true',
        ...filterSnippetWorkerEnv(process.env),
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    })
    child.stdout?.on('data', chunk => process.stdout.write(chunk))
    child.stderr?.on('data', chunk => process.stderr.write(chunk))

    const finish = (response: SnippetExecuteResponse): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (!child.killed) child.kill('SIGKILL')
      resolve(response)
    }

    const timer = setTimeout(() => {
      finish({
        stepId: request.stepId,
        status: 'failed',
        error: `snippet step "${request.stepId}" timed out after ${Math.floor(timeoutMs / 1000)}s`,
      })
    }, timeoutMs + 1000)

    child.once('message', message => {
      finish(message as SnippetExecuteResponse)
    })
    child.once('error', error => {
      finish({
        stepId: request.stepId,
        status: 'failed',
        error: error.message,
      })
    })
    child.once('exit', code => {
      if (code === 0) return
      finish({
        stepId: request.stepId,
        status: 'failed',
        error: `snippet worker exited with code ${code}`,
      })
    })
    child.send({
      request,
      outputDir,
      timeoutMs,
      env: filterSnippetWorkerEnv(process.env),
    })
  })
}

function filterSnippetWorkerEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] =>
        (entry[0].startsWith('CLERUM_SNIPPET_SECRET_') ||
          SNIPPET_WORKER_TIMEOUT_ENV_PASSTHROUGH.has(entry[0])) &&
        entry[1] !== undefined
    )
  )
}

// Node permission model grants for the forked snippet worker. Each path takes its own
// flag: a comma-separated value is one literal path.
// - outputDir is write-only. Other workloads share the output volume and can place
//   symlinks in it; Node follows a symlink inside a granted directory, so a read grant
//   would let a snippet read whatever such a link points at.
// - Node adds the implicit "/*" to a directory grant only when the directory exists at
//   process start. The runner Pod mounts outputDir when the recipe has an output volume;
//   without one the path does not exist, the worker still starts, and artifact writes fail.
// - Modules are read at their realpath. node_modules/@clerum/* are symlinks to
//   ../packages/*, outside these grants: a runtime import of an @clerum package from
//   snippetWorker needs its own --allow-fs-read for that package directory.
// - Node 24 does not gate network access under --permission. Node 25 and later do and
//   need --allow-net, which Node 24 rejects: a Node major bump of this image must add it.
export function buildPermissionArgs(outputDir: string): string[] {
  const distRoot = path.resolve(__dirname, '..')
  const nodeModules = path.resolve(__dirname, '..', '..', 'node_modules')
  return [
    '--permission',
    `--allow-fs-read=${distRoot}`,
    `--allow-fs-read=${nodeModules}`,
    `--allow-fs-write=${outputDir}`,
  ]
}

export function assertNodePermissionModel(outputDir: string): void {
  const result = spawnSync(
    process.execPath,
    [...buildPermissionArgs(outputDir), '-e', NODE_PERMISSION_MODEL_CHECK_SCRIPT],
    {
      env: { ...process.env, NODE_OPTIONS: '' },
      stdio: ['ignore', 'ignore', 'pipe'],
      // A hung check must fail with the message below (status, signal, stderr) instead
      // of leaving the runner alive but never listening.
      timeout: NODE_PERMISSION_MODEL_CHECK_TIMEOUT_MS,
    }
  )
  if (result.status === 0) return
  const launchError = result.error ? `, error ${result.error.message}` : ''
  const stderrLine = result.stderr ? result.stderr.toString('utf8').split('\n', 1)[0] : ''
  throw new Error(
    `snippet runner refuses to start: Node permission model check failed (status ${result.status}, signal ${result.signal}${launchError}): ${stderrLine}`
  )
}
