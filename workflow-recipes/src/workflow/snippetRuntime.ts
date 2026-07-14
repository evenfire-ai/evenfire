import { fork, spawnSync } from 'node:child_process'
import path from 'node:path'
import type { SnippetExecuteRequest, SnippetExecuteResponse } from './snippetTypes'

const DEFAULT_SNIPPET_TIMEOUT_MS = 300_000
const SNIPPET_WORKER_TIMEOUT_ENV_PASSTHROUGH = new Set([
  'CLERUM_MCP_TOOL_TIMEOUT_MS',
  'CLERUM_MCP_TOOL_MAX_TOTAL_TIMEOUT_MS',
])
let nodePermissionArgsSupported: boolean | undefined
let nodePermissionArgsWarningLogged = false
let nodePermissionArgsProbeError: string | undefined

export function executeSnippetInWorker(
  request: SnippetExecuteRequest,
  timeoutMs = DEFAULT_SNIPPET_TIMEOUT_MS
): Promise<SnippetExecuteResponse> {
  return new Promise(resolve => {
    let settled = false
    const outputDir = process.env.CLERUM_WORKFLOW_OUTPUT_DIR || '/output'
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

export function buildPermissionArgs(outputDir: string): string[] {
  if (process.env.CLERUM_SNIPPET_DISABLE_NODE_PERMISSIONS === 'true') return []
  if (!supportsNodePermissionArgs()) {
    if (!nodePermissionArgsWarningLogged) {
      nodePermissionArgsWarningLogged = true
      const reason = nodePermissionArgsProbeError
        ? `probe failed to launch: ${nodePermissionArgsProbeError}`
        : 'not supported by this Node runtime'
      console.warn(
        `[SnippetRunner] Node permission flags are unavailable (${reason}); continuing with pod, VM, SDK, and NetworkPolicy sandbox controls`
      )
    }
    return []
  }
  const distRoot = path.resolve(__dirname, '..')
  const nodeModules = path.resolve(__dirname, '..', '..', 'node_modules')
  return [
    '--experimental-permission',
    `--allow-fs-read=${distRoot},${nodeModules}`,
    `--allow-fs-write=${outputDir}`,
  ]
}

function supportsNodePermissionArgs(): boolean {
  if (nodePermissionArgsSupported !== undefined) return nodePermissionArgsSupported
  const result = spawnSync(process.execPath, ['--experimental-permission', '--eval', ''], {
    env: { ...process.env, NODE_OPTIONS: '' },
    stdio: 'ignore',
  })
  nodePermissionArgsProbeError = result.error instanceof Error ? result.error.message : undefined
  nodePermissionArgsSupported = result.status === 0
  return nodePermissionArgsSupported
}

export function resetSnippetPermissionProbeForTests(): void {
  nodePermissionArgsSupported = undefined
  nodePermissionArgsWarningLogged = false
  nodePermissionArgsProbeError = undefined
}
