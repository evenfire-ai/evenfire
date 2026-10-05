import { type ChildProcess, spawn } from 'node:child_process'

/** Hard ceiling for one approved operation, shared with the input receiver. */
export const MAX_EXECUTION_TIMEOUT_MS = 1_500_000
/** Aggregate bound on captured stdout + stderr, binary bytes included. */
export const MAX_CAPTURED_OUTPUT_BYTES = 65_536

const EXECUTION_PATH = '/usr/local/bin:/usr/bin:/bin'
const EXECUTION_TMPDIR = '/tmp'
const EXECUTION_LANG = 'C.UTF-8'

export type ExecutionResultReason =
  | 'exited'
  | 'timeout'
  | 'output_limit'
  | 'spawn_failed'
  | 'invalid_contract'

/**
 * One bounded result. `stdout`/`stderr` are base64 because the captured bytes
 * are arbitrary; `truncated` is true only when the aggregate cap cut them.
 */
export interface ExecutionResult {
  reason: ExecutionResultReason
  exitCode: number | null
  signal: string | null
  truncated: boolean
  stdout: string
  stderr: string
}

/** Fixed, non-secret environment; nothing else from the launcher is passed. */
export function executionEnvironment(cwd: string): Record<string, string> {
  return {
    PATH: EXECUTION_PATH,
    HOME: cwd,
    TMPDIR: EXECUTION_TMPDIR,
    LANG: EXECUTION_LANG,
  }
}

function emptyResult(reason: ExecutionResultReason): ExecutionResult {
  return { reason, exitCode: null, signal: null, truncated: false, stdout: '', stderr: '' }
}

function invalidContract(timeoutMs: number, argv: string[]): boolean {
  return (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > MAX_EXECUTION_TIMEOUT_MS ||
    !Array.isArray(argv) ||
    argv.length === 0 ||
    typeof argv[0] !== 'string' ||
    argv[0].length === 0 ||
    argv.some(argument => typeof argument !== 'string' || argument.includes('\0'))
  )
}

/**
 * Best-effort stop for the child's own process group. This launcher is PID 1
 * inside a private Job Pod: a signal covers the approved command's descendants
 * that still share the group. Verified runtime termination of the private Pod
 * is the physical cleanup boundary; API deletion or a signal alone is not
 * proof that no descendant survives.
 */
function stopProcessGroup(child: ChildProcess): void {
  if (typeof child.pid !== 'number') return
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    // A missing group or failed signal does not prove cleanup. The bounded
    // workload lifecycle must separately terminate and verify the private Pod.
  }
}

/**
 * Runs one already-approved argument vector, literally and without a shell.
 * The vector is never parsed, quoted or re-interpreted, stdin is not forwarded,
 * and no child output is written to the launcher's own streams.
 */
export function runExecution(timeoutMs: number, argv: string[]): Promise<ExecutionResult> {
  if (invalidContract(timeoutMs, argv)) {
    return Promise.resolve(emptyResult('invalid_contract'))
  }
  const cwd = process.cwd()

  return new Promise(resolve => {
    let settled = false
    let reason: ExecutionResultReason = 'exited'
    let truncated = false
    let timer: NodeJS.Timeout | undefined
    const captured = {
      stdout: { chunks: [] as Buffer[], bytes: 0 },
      stderr: { chunks: [] as Buffer[], bytes: 0 },
    }

    const settle = (result: ExecutionResult): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve(result)
    }

    const stop = (next: ExecutionResultReason): void => {
      if (reason === 'exited') reason = next
      stopProcessGroup(child)
    }

    const absorb = (name: 'stdout' | 'stderr', chunk: Buffer): void => {
      const bucket = captured[name]
      const remaining = MAX_CAPTURED_OUTPUT_BYTES - captured.stdout.bytes - captured.stderr.bytes
      if (remaining <= 0) {
        truncated = true
        stop('output_limit')
        return
      }
      const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk
      bucket.chunks.push(slice)
      bucket.bytes += slice.length
      if (slice.length < chunk.length) {
        truncated = true
        stop('output_limit')
      }
    }

    let child: ChildProcess
    try {
      child = spawn(argv[0], argv.slice(1), {
        cwd,
        env: executionEnvironment(cwd),
        stdio: ['ignore', 'pipe', 'pipe'],
        // The approved command leads its own process group so a timeout or the
        // output cap can stop the tree it started, not just the direct child.
        detached: true,
      })
    } catch {
      // Node can reject an unusable spawn synchronously; the caller still gets
      // one bounded result instead of an exception.
      resolve(emptyResult('spawn_failed'))
      return
    }

    child.stdout?.on('data', (chunk: Buffer) => absorb('stdout', chunk))
    child.stderr?.on('data', (chunk: Buffer) => absorb('stderr', chunk))
    child.on('error', () => settle(emptyResult('spawn_failed')))
    child.on('close', (code, signal) =>
      settle({
        reason,
        exitCode: typeof code === 'number' ? code : null,
        signal: signal ?? null,
        truncated,
        stdout: Buffer.concat(captured.stdout.chunks).toString('base64'),
        stderr: Buffer.concat(captured.stderr.chunks).toString('base64'),
      })
    )
    timer = setTimeout(() => stop('timeout'), timeoutMs)
  })
}

if (require.main === module) {
  // CLI: <timeoutMs> <exe> [...args]. The approved vector is passed through as
  // process arguments on purpose: no JSON re-encoding and no shell.
  const [rawTimeoutMs, ...approvedArgv] = process.argv.slice(2)
  const timeoutMs = Number(rawTimeoutMs)
  const run = /^\d+$/.test(rawTimeoutMs ?? '')
    ? runExecution(timeoutMs, approvedArgv)
    : Promise.resolve(emptyResult('invalid_contract'))
  run
    .then(result => {
      // Exactly one bounded JSON line; the child's bytes only travel inside it.
      process.stdout.write(`${JSON.stringify(result)}\n`)
      process.exitCode = result.reason === 'invalid_contract' ? 1 : 0
    })
    .catch(() => {
      // Never log raw exceptions or captured content.
      process.stdout.write(`${JSON.stringify(emptyResult('spawn_failed'))}\n`)
      process.exitCode = 0
    })
}
