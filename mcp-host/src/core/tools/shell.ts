import { spawn } from 'child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { recordGfsShellOutputLimit } from '../../internalTools/gfsDownloadMetrics'
import { ALL_PROVIDERS, LlmProvider, PROVIDERS } from '../../llm/registryCore'
import { verifyManagedCallerRootPath } from '../../workspace/callerRootBinding'
import { ToolError, ToolErrorCode } from '../errors'
import { ExecutionContext, Tool } from '../interfaces'
import { ToolOutput } from '../types'

// D3 (stateless-agents) §1.2 — lexical defense-in-depth: reject commands that
// reference the session state database (state.db + WAL laterals) or the
// reserved `.clerum-state/` runtime directory BEFORE spawning. Word-boundary
// on the left so "mystate.db" doesn't trip; the right side is anchored by the
// literal suffixes. Case-sensitive, matching the exact on-disk names (same
// stance as the identity-file guard). This is a loud tool-level gate, not a
// sandbox: POSIX permissions / a read-only mount remain the OS backstop.
const STATE_DB_COMMAND_PATTERN =
  /(^|[^A-Za-z0-9_.-])state\.db(-wal|-shm)?([^A-Za-z0-9_]|$)|\.clerum-state(\/|[^A-Za-z0-9_.-]|$)/

function truncateUtf8Bytes(value: string, maximumBytes: number): string {
  if (maximumBytes <= 0) return ''
  const bytes = Buffer.from(value, 'utf8')
  if (bytes.length <= maximumBytes) return value
  return bytes
    .subarray(0, maximumBytes)
    .toString('utf8')
    .replace(/\uFFFD$/u, '')
}

function processGroupExists(processGroupId: number): boolean {
  try {
    process.kill(-processGroupId, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function ensureProcessGroupTerminated(processGroupId: number): Promise<boolean> {
  try {
    process.kill(-processGroupId, 'SIGKILL')
  } catch {
    /* The group can exit between leader close and this signal. */
  }
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!processGroupExists(processGroupId)) return true
    await sleep(10)
  }
  return !processGroupExists(processGroupId)
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
  static readonly SIGKILL_GRACE_MS = 5000

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
    // Termination has an existing 5s SIGKILL grace; allow 1s for close/output delivery.
    return ShellTool.SIGKILL_GRACE_MS + 1000
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

    return new Promise<ToolOutput>(resolve => {
      // detached: true makes the child a process group leader so we can kill
      // the whole group (shell + grandchildren like `sleep`) with -pid signal.
      const child = spawn('/bin/sh', ['-c', command], {
        cwd: this.workspacePath,
        env: safeEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      })

      const stdoutBuf: Buffer[] = []
      const stderrBuf: Buffer[] = []
      let totalBytes = 0
      let progressBytes = 0
      let killed: 'timeout' | 'maxbuffer' | 'cancelled' | null = null
      let resolved = false
      let killTimer: ReturnType<typeof setTimeout> | undefined

      const resolveOnce = (out: ToolOutput) => {
        if (resolved) return
        resolved = true
        resolve(out)
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
      }

      const onChunk = (chunk: Buffer, which: 'stdout' | 'stderr') => {
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

      child.stdout?.on('data', c => onChunk(c, 'stdout'))
      child.stderr?.on('data', c => onChunk(c, 'stderr'))

      const timer = setTimeout(() => {
        if (!killed) {
          killed = 'timeout'
          forceKill()
        }
      }, timeout)

      const onAbort = () => {
        if (!killed && !resolved) {
          killed =
            context?.signal?.reason instanceof ToolError &&
            context.signal.reason.code === ToolErrorCode.Timeout
              ? 'timeout'
              : 'cancelled'
          forceKill()
        }
      }
      context?.signal?.addEventListener('abort', onAbort, { once: true })
      if (context?.signal?.aborted) onAbort()
      const cleanup = () => {
        clearTimeout(timer)
        clearTimeout(killTimer)
        context?.signal?.removeEventListener('abort', onAbort)
      }
      const handleClose = async (exitCode: number | null): Promise<void> => {
        // Leader/stdio close does not prove descendants exited. Always complete
        // group termination before resolving.
        const processGroupId = child.pid
        const groupTerminated =
          typeof processGroupId === 'number' && processGroupId > 0
            ? await ensureProcessGroupTerminated(processGroupId)
            : true
        cleanup()
        const stdout = Buffer.concat(stdoutBuf).toString('utf8')
        const stderr = Buffer.concat(stderrBuf).toString('utf8')
        const body =
          [stdout ? `stdout:\n${stdout}` : '', stderr ? `stderr:\n${stderr}` : '']
            .filter(Boolean)
            .join('\n\n') || '(no output)'
        const format = (status: string) => {
          return `${truncateUtf8Bytes(
            body,
            ShellTool.MAX_RESULT_BYTES - Buffer.byteLength(status, 'utf8')
          )}${status}`
        }

        let out: ToolOutput
        if (killed === 'timeout') {
          const status = `\n\n[Command killed after ${timeout}ms timeout — partial output above]`
          out = { content: format(status), duration_ms: Date.now() - startTime, is_error: true }
        } else if (killed === 'cancelled') {
          const status = '\n\n[Command cancelled — partial output above]'
          out = { content: format(status), duration_ms: Date.now() - startTime, is_error: true }
        } else if (killed === 'maxbuffer') {
          const status = `\n\n[output_limit_exceeded: command killed after more than ${ShellTool.MAX_TOTAL_BYTES} output bytes — bounded partial output above]`
          out = { content: format(status), duration_ms: Date.now() - startTime, is_error: true }
        } else if (exitCode !== 0 && exitCode !== null) {
          const status = `Command failed (exit code ${exitCode}):\n`
          out = {
            content: `${status}${truncateUtf8Bytes(
              body,
              ShellTool.MAX_RESULT_BYTES - Buffer.byteLength(status, 'utf8')
            )}`,
            duration_ms: Date.now() - startTime,
            is_error: true,
          }
        } else {
          out = {
            content: truncateUtf8Bytes(body, ShellTool.MAX_RESULT_BYTES),
            duration_ms: Date.now() - startTime,
            is_error: false,
          }
        }

        if (!groupTerminated) {
          const status = '\n\n[process_group_termination_failed]'
          out = {
            content: `${truncateUtf8Bytes(
              out.content,
              ShellTool.MAX_RESULT_BYTES - Buffer.byteLength(status, 'utf8')
            )}${status}`,
            duration_ms: Date.now() - startTime,
            is_error: true,
          }
        }
        resolveOnce(out)
      }

      child.on('close', exitCode => {
        void handleClose(exitCode)
      })

      child.on('error', err => {
        cleanup()
        resolveOnce({
          content: `Command failed to start: ${err.message}`,
          duration_ms: Date.now() - startTime,
          is_error: true,
        })
      })
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
