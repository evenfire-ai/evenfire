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
   * `overflow`: stdout passed `maxBuffer`; the child was killed and `stdout`
   * holds what was read. `error`: git could not be started.
   */
  outcome: 'exited' | 'timeout' | 'overflow' | 'aborted' | 'error'
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
    const child = execFile(
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
        const out = typeof stdout === 'string' ? stdout : ''
        const err = typeof stderr === 'string' ? stderr : ''
        if (!error) {
          resolve({ exitCode: 0, stdout: out, stderr: err, outcome: 'exited' })
          return
        }
        const failure = error as NodeJS.ErrnoException & {
          code?: number | string
          killed?: boolean
          signal?: NodeJS.Signals | null
        }
        if (failure.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
          resolve({ exitCode: null, stdout: out, stderr: err, outcome: 'overflow' })
        } else if (failure.name === 'AbortError') {
          resolve({ exitCode: null, stdout: out, stderr: err, outcome: 'aborted' })
        } else if (failure.killed || failure.signal) {
          resolve({ exitCode: null, stdout: out, stderr: err, outcome: 'timeout' })
        } else if (typeof failure.code === 'number') {
          resolve({ exitCode: failure.code, stdout: out, stderr: err, outcome: 'exited' })
        } else {
          resolve({ exitCode: null, stdout: out, stderr: err, outcome: 'error' })
        }
      }
    )
    child.stdin?.end()
  })
