import { type ChildProcess, spawn } from 'child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { recordGfsShellOutputLimit } from '../../internalTools/gfsDownloadMetrics'
import { ALL_PROVIDERS, LlmProvider, PROVIDERS } from '../../llm/registryCore'
import { logger } from '../../logger'
import { verifyManagedCallerRootPath } from '../../workspace/callerRootBinding'
import { ToolError, ToolErrorCode } from '../errors'
import { ExecutionContext, Tool } from '../interfaces'
import { ToolOutput } from '../types'
import {
  SHELL_SIGKILL_GRACE_MS,
  SHELL_STDIO_DRAIN_MS,
  SHELL_TIMEOUT_CLEANUP_MS,
} from './shellTimeouts'

// D3 (stateless-agents) §1.2 — lexical defense-in-depth: reject commands that
// reference the session state database (state.db + WAL laterals) or the
// reserved `.clerum-state/` runtime directory BEFORE spawning. Word-boundary
// on the left so "mystate.db" doesn't trip; the right side is anchored by the
// literal suffixes. Case-sensitive, matching the exact on-disk names (same
// stance as the identity-file guard). This is a loud tool-level gate, not a
// sandbox: POSIX permissions / a read-only mount remain the OS backstop.
const STATE_DB_COMMAND_PATTERN =
  /(^|[^A-Za-z0-9_.-])state\.db(-wal|-shm)?([^A-Za-z0-9_]|$)|\.clerum-state(\/|[^A-Za-z0-9_.-]|$)/

// Node/libuv error codes (E2BIG, ENOMEM, ERR_INVALID_ARG_VALUE) are fixed
// identifiers; anything else is not echoed to the model.
const SPAWN_ERROR_CODE_PATTERN = /^[A-Z0-9_]+$/

/** Returns a well-formed Node/libuv error code, never any part of the message. */
function wellFormedErrorCode(error: unknown): string | undefined {
  const rawCode = (error as NodeJS.ErrnoException | undefined)?.code
  return typeof rawCode === 'string' && SPAWN_ERROR_CODE_PATTERN.test(rawCode) ? rawCode : undefined
}

function truncateUtf8Bytes(value: string, maximumBytes: number): string {
  if (maximumBytes <= 0) return ''
  const bytes = Buffer.from(value, 'utf8')
  if (bytes.length <= maximumBytes) return value
  return bytes
    .subarray(0, maximumBytes)
    .toString('utf8')
    .replace(/\uFFFD$/u, '')
}

/**
 * Only ESRCH confirms that the group is gone. EPERM means it exists under
 * another owner; any other failure leaves absence unconfirmed, so the group is
 * treated as present and the code is logged.
 */
function processGroupExists(processGroupId: number): boolean {
  try {
    process.kill(-processGroupId, 0)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ESRCH') return false
    if (code !== 'EPERM') {
      logger.warn(
        { component: 'ShellTool', errorCode: wellFormedErrorCode(error) ?? 'UNKNOWN' },
        'Shell process-group probe failed; group absence is not confirmed'
      )
    }
    return true
  }
}

/**
 * Sends SIGKILL to the group and polls for its absence. Polling stops after
 * about one second, or at `deadlineAt` (a `performance.now()` value) when the
 * call is already inside its declared termination budget.
 */
async function ensureProcessGroupTerminated(
  processGroupId: number,
  deadlineAt?: number
): Promise<boolean> {
  try {
    process.kill(-processGroupId, 'SIGKILL')
  } catch {
    /* The group can exit between leader close and this signal. */
  }
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!processGroupExists(processGroupId)) return true
    if (deadlineAt !== undefined) {
      const remaining = deadlineAt - performance.now()
      if (remaining <= 0) break
      await sleep(Math.min(10, remaining))
    } else {
      await sleep(10)
    }
  }
  return !processGroupExists(processGroupId)
}

function isValidProcessId(pid: number | undefined): pid is number {
  return typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0
}

/**
 * ShellTool — runs an arbitrary shell command in the agent's workspace.
 *
 * HIGH RISK — gated behind requiresApproval(). The user sees and approves
 * every command before execution; that is the trust boundary.
 *
 * Uses child_process.spawn (not exec) so we can:
 * 1. Stream output to the progress watcher via ExecutionContext.onOutput
 * 2. Return partial stdout/stderr when the command is killed by timeout,
 *    giving the LLM something to reason about instead of a bare error.
 *
 * Each execute() call creates its own local state (stdout/stderr buffers,
 * timers) — no shared state across concurrent invocations.
 */
export class ShellTool implements Tool {
  private static readonly MAX_TOTAL_BYTES = 1024 * 1024 // 1 MB — preserved from pre-spawn behavior
  /** Leaves room for status text, XML wrapping, and message serialization. */
  private static readonly MAX_RESULT_BYTES = ShellTool.MAX_TOTAL_BYTES - 2048
  private static readonly MAX_PROGRESS_BYTES = 64 * 1024
  static readonly SIGKILL_GRACE_MS = SHELL_SIGKILL_GRACE_MS

  /**
   * `dynamicEnvProvider` returns operator-managed env vars from the
   * ConfigStore (per-Host CM/Secret + the LLM key). Merged into the child's
   * env at spawn time so the LLM can reference them via `$VAR` and let the
   * subprocess shell expand them — mcp-host never substitutes in JS.
   */
  constructor(
    private readonly workspacePath: string | undefined,
    private readonly timeout: number,
    private readonly envAllowlist: string[],
    private readonly dynamicEnvProvider: () => Record<string, string> = () => ({}),
    // §13 (stateless agents) — the ACTIVE LLM provider. Steers credential-slot
    // stripping: only this provider's credential env var survives into the
    // child env; every other provider slot is deleted. Undefined (tool-name
    // listing registry, legacy tests) strips ALL slots — the secure default.
    private readonly activeLlmProvider?: LlmProvider,
    /**
     * Re-verify that the caller workspace root is still canonical before every
     * command. Set for Host-managed per-user roots; this is per-user directory
     * scoping and never touches the GFS download store.
     */
    private readonly verifyCallerRoot: boolean = false
  ) {}

  name() {
    return 'shell_exec'
  }

  description() {
    return (
      'Execute a shell command in the workspace directory. ' +
      'Supports full shell syntax (pipes, redirects, &&, etc.). ' +
      'Commands run with a timeout and restricted environment. ' +
      `Node.js executable: ${JSON.stringify(process.execPath)}. ` +
      `Resolve installed Host libraries with require('node:module').createRequire(${JSON.stringify(require.resolve('exceljs'))}); load fast-csv through that resolver and use parseStream for streaming CSV parsing (exceljs.csv is not available). ` +
      'Verify any other executable or library before using it. ' +
      'This tool requires approval before execution.'
    )
  }

  parametersSchema() {
    return {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description:
            "The shell command to execute (e.g., 'ls -la', 'echo hello | wc -c', 'git status')",
        },
      },
      required: ['command'],
    }
  }

  requiresSanitization(): boolean {
    return true
  }

  requiresApproval(): boolean {
    return true
  } // HIGH RISK — approval gate is the security boundary

  supportsProgressOutput(): boolean {
    return true
  }

  timeoutCleanupMs(): number {
    return SHELL_TIMEOUT_CLEANUP_MS
  }

  joinsAbortSettlement(): boolean {
    return true
  }

  async execute(params: Record<string, unknown>, context?: ExecutionContext): Promise<ToolOutput> {
    context?.signal?.throwIfAborted()
    const timeout = Math.min(this.timeout, context?.timeoutMs ?? this.timeout)
    const startTime = Date.now()
    const command = params.command as string
    if (this.verifyCallerRoot && this.workspacePath) {
      if (verifyManagedCallerRootPath(this.workspacePath) === undefined) {
        return this.managedRootUnavailable(startTime)
      }
    }
    if (!this.workspacePath) {
      return {
        content:
          'Managed shell unavailable: no verified caller workspace is available for this Host runtime.',
        duration_ms: Date.now() - startTime,
        is_error: true,
      }
    }

    if (STATE_DB_COMMAND_PATTERN.test(command)) {
      return {
        content:
          'Command rejected: it references the session state database ' +
          '(state.db / state.db-wal / state.db-shm / .clerum-state), which is ' +
          'platform-managed state the agent cannot access.',
        duration_ms: Date.now() - startTime,
        is_error: true,
      }
    }

    const safeEnv: Record<string, string> = {
      HOME: this.workspacePath, // Sandbox HOME to prevent leaking host config (~/.gitconfig, etc.)
    }
    for (const key of this.envAllowlist) {
      if (process.env[key]) {
        safeEnv[key] = process.env[key]!
      }
    }
    // Layer ConfigStore values on top so operator-managed env (per-Host
    // CM/Secret + the LLM key) is visible to the subprocess shell. The
    // shell — not mcp-host — expands `$VAR` at runtime; secret values
    // never enter mcp-host's JS state outside of this single env object.
    const dynamicEnv = this.dynamicEnvProvider()
    for (const [k, v] of Object.entries(dynamicEnv)) {
      if (typeof v === 'string') safeEnv[k] = v
    }
    // Set HOME after operator/dynamic environment merging. A supplied HOME must
    // never relocate the approved shell outside the caller's workspace root.
    safeEnv.HOME = this.workspacePath

    // §13 (stateless agents) — credential-slot stripping. The child env
    // carries ONLY the ACTIVE provider's credential slots; every OTHER
    // provider's credential env vars are explicitly deleted, even when present
    // in process.env (via the allowlist) or in the ConfigStore layer above.
    // The slot set is DERIVED from the provider registry (registryCore
    // PROVIDERS), so a future provider is stripped automatically. Multi-slot
    // providers (R4: Bedrock's key pair, Vertex's SA JSON) keep ALL of the
    // active provider's slots; primarySlot() is deliberately NOT used here
    // (the exclusion boundary must span the full slot set — spec §3-R4.3).
    const activeProvider = this.activeLlmProvider
    for (const provider of ALL_PROVIDERS) {
      if (provider === activeProvider) continue
      for (const slot of PROVIDERS[provider].credentialSlots) {
        delete safeEnv[slot.envName]
      }
    }

    // A NUL byte in an env value (e.g. a ConfigStore secret, which BasicSafety
    // never sees, #1020) makes spawn() throw ERR_INVALID_ARG_VALUE with up to
    // 128 characters of the raw value in its message. Reject it here and name
    // only the key, so no part of the value reaches the model or the logs.
    for (const [key, value] of Object.entries(safeEnv)) {
      if (value.includes('\0')) {
        logger.error(
          { component: 'ShellTool', errorCode: 'ENV_VALUE_CONTAINS_NUL' },
          'Shell command failed to start'
        )
        return {
          content: `Command failed to start: environment variable ${key} contains a NUL character`,
          duration_ms: Date.now() - startTime,
          is_error: true,
        }
      }
    }

    return new Promise<ToolOutput>(resolve => {
      // detached: true makes the child a process group leader so we can kill
      // the whole group (shell + grandchildren like `sleep`) with -pid signal.
      let child: ChildProcess
      try {
        child = spawn('/bin/sh', ['-c', command], {
          cwd: this.workspacePath,
          env: safeEnv,
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: true,
        })
      } catch (error) {
        // spawn() throws synchronously for invalid arguments and for most libuv
        // errors (E2BIG for an oversized command, ENOMEM under memory pressure).
        // No process exists, so this is a start failure reported as an error
        // result. Node error messages can embed argument and env values, so
        // only a well-formed error code is reported, never the message.
        const errorCode = wellFormedErrorCode(error)
        logger.error(
          { component: 'ShellTool', errorCode: errorCode ?? 'UNKNOWN' },
          'Shell command failed to start'
        )
        resolve({
          content:
            errorCode === undefined
              ? 'Command failed to start'
              : `Command failed to start: ${errorCode}`,
          duration_ms: Date.now() - startTime,
          is_error: true,
        })
        return
      }

      const stdoutBuf: Buffer[] = []
      const stderrBuf: Buffer[] = []
      let totalBytes = 0
      let progressBytes = 0
      // The first cause wins; later events never overwrite it.
      let killed: 'timeout' | 'maxbuffer' | 'cancelled' | null = null
      let resolved = false
      // Claimed synchronously by the first finalizer (close, drain check,
      // cleanup deadline, start failure). Every later path returns.
      let finalizing = false
      let terminationStartedAt: number | undefined
      let killTimer: ReturnType<typeof setTimeout> | undefined
      let deadlineTimer: ReturnType<typeof setTimeout> | undefined
      let drainTimer: ReturnType<typeof setInterval> | undefined

      const resolveOnce = (out: ToolOutput) => {
        if (resolved) return
        resolved = true
        resolve(out)
      }

      const clearFinalizationTimers = () => {
        clearInterval(drainTimer)
        drainTimer = undefined
        clearTimeout(deadlineTimer)
        deadlineTimer = undefined
      }

      const claimFinalization = (): boolean => {
        if (finalizing) return false
        finalizing = true
        clearFinalizationTimers()
        return true
      }

      const forceKill = () => {
        // Kill the entire process group so grandchildren (e.g., `sleep` inside a
        // semi-colon chain) are also terminated and the stdout/stderr pipes close.
        // Guard against undefined/zero pid: process.kill(-0, ...) would signal the
        // entire process group mcp-host belongs to. Fall back to child.kill() if
        // pid is not a valid positive integer.
        const pid = child.pid
        const canGroupKill = typeof pid === 'number' && pid > 0
        if (canGroupKill) {
          try {
            process.kill(-pid, 'SIGTERM')
          } catch {
            child.kill('SIGTERM')
          }
        } else {
          child.kill('SIGTERM')
        }
        terminationStartedAt = performance.now()
        // Termination owns settlement from here; the natural-exit drain poll stops.
        clearInterval(drainTimer)
        drainTimer = undefined
        killTimer = setTimeout(() => {
          if (canGroupKill) {
            try {
              process.kill(-(pid as number), 'SIGKILL')
            } catch {
              if (!child.killed) child.kill('SIGKILL')
            }
          } else if (!child.killed) {
            child.kill('SIGKILL')
          }
        }, ShellTool.SIGKILL_GRACE_MS)
        killTimer.unref?.()
        // A process outside the group can hold stdout/stderr open after the
        // group is gone, so `close` may never arrive. The deadline bounds the
        // call to the declared cleanup budget.
        deadlineTimer = setTimeout(() => finalizeAtCleanupDeadline(), SHELL_TIMEOUT_CLEANUP_MS)
      }

      const onChunk = (chunk: Buffer, which: 'stdout' | 'stderr') => {
        if (finalizing) return
        // Bound both destinations before accepting the chunk. Bytes beyond the
        // admission bound are counted only for the truthful limit decision and
        // never enter retained output.
        if (totalBytes >= ShellTool.MAX_TOTAL_BYTES) {
          if (!killed) {
            killed = 'maxbuffer'
            recordGfsShellOutputLimit('output_limit_exceeded')
            forceKill()
          }
          return
        }
        const retained = Math.min(chunk.length, ShellTool.MAX_TOTAL_BYTES - totalBytes)
        if (retained > 0) stdoutOrStderr(which).push(chunk.subarray(0, retained))
        totalBytes += chunk.length

        // Progress is a live preview, not a second output channel. Stop it at
        // its own fixed bound even while the final result is allowed to reach
        // its larger admission bound.
        const progressRemaining = ShellTool.MAX_PROGRESS_BYTES - progressBytes
        if (progressRemaining > 0) {
          const preview = chunk.subarray(0, progressRemaining)
          progressBytes += preview.length
          context?.onOutput(preview.toString('utf8'))
        }
        if (totalBytes > ShellTool.MAX_TOTAL_BYTES && !killed) {
          killed = 'maxbuffer'
          recordGfsShellOutputLimit('output_limit_exceeded')
          forceKill()
        }
      }

      function stdoutOrStderr(which: 'stdout' | 'stderr'): Buffer[] {
        return which === 'stdout' ? stdoutBuf : stderrBuf
      }

      const onStdout = (chunk: Buffer) => onChunk(chunk, 'stdout')
      const onStderr = (chunk: Buffer) => onChunk(chunk, 'stderr')
      child.stdout?.on('data', onStdout)
      child.stderr?.on('data', onStderr)

      // Destroying the pipes bounds settlement; it does not contain or signal
      // the process holding them, which may get EPIPE on later writes.
      const stopOutputCapture = () => {
        child.stdout?.off('data', onStdout)
        child.stderr?.off('data', onStderr)
        child.stdout?.destroy()
        child.stderr?.destroy()
      }

      const timer = setTimeout(() => {
        if (!killed && !finalizing) {
          killed = 'timeout'
          forceKill()
        }
      }, timeout)

      const onAbort = () => {
        if (!killed && !resolved && !finalizing) {
          killed =
            context?.signal?.reason instanceof ToolError &&
            context.signal.reason.code === ToolErrorCode.Timeout
              ? 'timeout'
              : 'cancelled'
          forceKill()
        }
      }
      const cleanup = () => {
        clearTimeout(timer)
        clearTimeout(killTimer)
        clearFinalizationTimers()
        context?.signal?.removeEventListener('abort', onAbort)
      }

      /** Builds and publishes the one result of this call. */
      const publish = (
        exitCode: number | null,
        groupTerminated: boolean,
        outputCaptureStopped: boolean,
        cause: typeof killed
      ) => {
        cleanup()
        const stdout = Buffer.concat(stdoutBuf).toString('utf8')
        const stderr = Buffer.concat(stderrBuf).toString('utf8')
        const body =
          [stdout ? `stdout:\n${stdout}` : '', stderr ? `stderr:\n${stderr}` : '']
            .filter(Boolean)
            .join('\n\n') || '(no output)'

        // The completion summary keeps only the first 200 characters, so the
        // forced-closure notice goes first.
        const notice = outputCaptureStopped
          ? `[stdio_held_by_detached_process: ${cause ?? 'exited'}; output capture stopped; redirect background output to a file or /dev/null]\n\n`
          : ''
        const failure =
          cause === null && exitCode !== 0 && exitCode !== null
            ? `Command failed (exit code ${exitCode}):\n`
            : ''
        let footers = ''
        if (cause === 'timeout') {
          footers += `\n\n[Command killed after ${timeout}ms timeout — partial output above]`
        } else if (cause === 'cancelled') {
          footers += '\n\n[Command cancelled — partial output above]'
        } else if (cause === 'maxbuffer') {
          footers += `\n\n[output_limit_exceeded: command killed after more than ${ShellTool.MAX_TOTAL_BYTES} output bytes — bounded partial output above]`
        }
        if (!groupTerminated) footers += '\n\n[process_group_termination_failed]'
        // Every diagnostic is reserved before the body is truncated, so none
        // erases another; a negative budget would keep almost the whole body.
        const bodyBudget = Math.max(
          0,
          ShellTool.MAX_RESULT_BYTES - Buffer.byteLength(`${notice}${failure}${footers}`, 'utf8')
        )
        const durationMs = Date.now() - startTime

        if (outputCaptureStopped) {
          logger.warn(
            {
              component: 'ShellTool',
              event: 'shell_stdio_held_by_detached_process',
              reason: cause ?? 'exited',
              exitCode,
              leaderExited: child.exitCode !== null || child.signalCode !== null,
              processGroupTerminated: groupTerminated,
              durationMs,
            },
            "A process outside the command's process group kept stdout/stderr open; shell output capture stopped"
          )
        }
        resolveOnce({
          content: `${notice}${failure}${truncateUtf8Bytes(body, bodyBudget)}${footers}`,
          duration_ms: durationMs,
          is_error: outputCaptureStopped || cause !== null || failure !== '' || !groupTerminated,
        })
      }

      // Termination path: `close` did not arrive within the cleanup budget.
      const finalizeAtCleanupDeadline = () => {
        if (!claimFinalization()) return
        const pid = child.pid
        if (isValidProcessId(pid)) {
          try {
            process.kill(-pid, 'SIGKILL')
          } catch {
            /* The group can already be gone; the probe below decides. */
          }
        } else if (!child.killed) {
          child.kill('SIGKILL')
        }
        stopOutputCapture()
        // One probe only: the budget is spent.
        const groupTerminated = isValidProcessId(pid) ? !processGroupExists(pid) : true
        publish(child.exitCode, groupTerminated, true, killed)
      }

      // Natural-exit path: the leader exited without a cause. Exit alone does
      // not publish, because an in-group background job can still write; only
      // the absence of the whole group does.
      child.once('exit', () => {
        const processGroupId = child.pid
        if (killed || finalizing || !isValidProcessId(processGroupId)) return
        let absentProbes = 0
        drainTimer = setInterval(() => {
          if (finalizing) return
          if (processGroupExists(processGroupId)) {
            absentProbes = 0
            return
          }
          // The last in-group writer can exit before its pipe EOF reaches this
          // process; under load that EOF can miss the poll phase below. Only a
          // second consecutive absent probe without `close` means a process
          // outside the group holds stdio.
          absentProbes += 1
          if (absentProbes < 2) return
          // A pipe EOF pending in this poll phase delivers `close` first.
          setImmediate(() => {
            if (!claimFinalization()) return
            stopOutputCapture()
            publish(child.exitCode, true, true, killed)
          })
        }, SHELL_STDIO_DRAIN_MS)
      })

      const handleClose = async (exitCode: number | null): Promise<void> => {
        if (!claimFinalization()) return
        const cause = killed
        // Leader/stdio close does not prove descendants exited. Always complete
        // group termination before resolving, inside the cleanup budget when a
        // cause already started it.
        const processGroupId = child.pid
        const deadlineAt =
          cause !== null && terminationStartedAt !== undefined
            ? terminationStartedAt + SHELL_TIMEOUT_CLEANUP_MS
            : undefined
        const groupTerminated = isValidProcessId(processGroupId)
          ? await ensureProcessGroupTerminated(processGroupId, deadlineAt)
          : true
        publish(exitCode, groupTerminated, false, cause)
      }

      child.on('close', exitCode => {
        void handleClose(exitCode)
      })

      child.on('error', error => {
        // Node error messages can embed argument and env values, so only a
        // well-formed error code is reported, never the message.
        const errorCode = wellFormedErrorCode(error)
        const loggedCode = errorCode ?? 'UNKNOWN'
        if (isValidProcessId(child.pid)) {
          // A started process reports `error` only when signalling it failed.
          // Termination stays with the existing timers and cause.
          logger.error(
            { component: 'ShellTool', errorCode: loggedCode },
            'Shell process reported an error'
          )
          return
        }
        if (!claimFinalization()) return
        cleanup()
        logger.error(
          { component: 'ShellTool', errorCode: loggedCode },
          'Shell command failed to start'
        )
        resolveOnce({
          content:
            errorCode === undefined
              ? 'Command failed to start'
              : `Command failed to start: ${errorCode}`,
          duration_ms: Date.now() - startTime,
          is_error: true,
        })
      })

      context?.signal?.addEventListener('abort', onAbort, { once: true })
      if (context?.signal?.aborted) onAbort()
    })
  }

  private managedRootUnavailable(startTime: number): ToolOutput {
    return {
      content:
        'Managed shell unavailable: the verified caller workspace root is no longer canonical.',
      duration_ms: Date.now() - startTime,
      is_error: true,
    }
  }
}
