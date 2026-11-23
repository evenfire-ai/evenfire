import { execFile } from 'child_process'

export interface GitSpawnOptions {
  cwd: string
  env: Readonly<Record<string, string>>
  timeoutMs: number
  maxBuffer: number
  signal?: AbortSignal
}

export interface GitSpawnResult {
  /** The exit code when the process exited; null otherwise. */
  exitCode: number | null
  stdout: string
  stderr: string
  /**
   * - `overflow`: stdout passed `maxBuffer`; the child was killed and `stdout`
   *   holds what was read.
   * - `timeout`: the child was killed at the timeout.
   * - `failed`: git ended abnormally (a signal it did not get from us, or
   *   stderr past `maxBuffer`).
   * - `error`: git could not be started.
   */
  outcome: 'exited' | 'timeout' | 'overflow' | 'aborted' | 'failed' | 'error'
}

/** Runs one git process. A seam: tests replace it to see every spawn. */
export type GitSpawn = (
  gitPath: string,
  argv: readonly string[],
  options: GitSpawnOptions
) => Promise<GitSpawnResult>

/**
 * `execFile` with the given environment only (never `process.env`), no shell,
 * stdin closed at once, and SIGKILL on timeout or abort.
 */
export const spawnGit: GitSpawn = (gitPath, argv, options) =>
  new Promise(resolve => {
    let child: ReturnType<typeof execFile>
    try {
      child = execFile(
        gitPath,
        [...argv],
        {
          cwd: options.cwd,
          env: { ...options.env },
          maxBuffer: options.maxBuffer,
          timeout: options.timeoutMs,
          killSignal: 'SIGKILL',
          encoding: 'utf8',
          windowsHide: true,
          ...(options.signal ? { signal: options.signal } : {}),
        },
        (error, stdout, stderr) => {
          resolve(
            classifyExecFileResult(
              error,
              typeof stdout === 'string' ? stdout : '',
              typeof stderr === 'string' ? stderr : ''
            )
          )
        }
      )
    } catch (error) {
      // execFile throws synchronously for some spawn errors (E2BIG).
      resolve(classifyExecFileResult(error as Error, '', ''))
      return
    }
    child.stdin?.end()
  })

/** Maps `execFile`'s callback arguments to a spawn result. */
export function classifyExecFileResult(
  error: Error | null,
  stdout: string,
  stderr: string
): GitSpawnResult {
  if (!error) return { exitCode: 0, stdout, stderr, outcome: 'exited' }
  const failure = error as NodeJS.ErrnoException & {
    code?: number | string
    killed?: boolean
    signal?: NodeJS.Signals | null
  }
  if (failure.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
    const outcome = /stderr/i.test(failure.message) ? 'failed' : 'overflow'
    return { exitCode: null, stdout, stderr, outcome }
  }
  if (failure.name === 'AbortError') return { exitCode: null, stdout, stderr, outcome: 'aborted' }
  // `killed` is set only when Node sent the kill signal: the timeout.
  if (failure.killed === true) return { exitCode: null, stdout, stderr, outcome: 'timeout' }
  if (failure.signal) return { exitCode: null, stdout, stderr, outcome: 'failed' }
  if (typeof failure.code === 'number') {
    return { exitCode: failure.code, stdout, stderr, outcome: 'exited' }
  }
  return { exitCode: null, stdout, stderr, outcome: 'error' }
}
