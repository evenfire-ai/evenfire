import { spawn } from 'child_process'
import { ALL_PROVIDERS, LlmProvider, PROVIDERS } from '../../llm/registryCore'
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
  private static readonly SIGKILL_GRACE_MS = 5000

  /**
   * `dynamicEnvProvider` returns operator-managed env vars from the
   * ConfigStore (per-Host CM/Secret + the LLM key). Merged into the child's
   * env at spawn time so the LLM can reference them via `$VAR` and let the
   * subprocess shell expand them — mcp-host never substitutes in JS.
   */
  constructor(
    private readonly workspacePath: string,
    private readonly timeout: number,
    private readonly envAllowlist: string[],
    private readonly dynamicEnvProvider: () => Record<string, string> = () => ({}),
    // §13 (stateless agents) — the ACTIVE LLM provider. Steers credential-slot
    // stripping: only this provider's credential env var survives into the
    // child env; every other provider slot is deleted. Undefined (tool-name
    // listing registry, legacy tests) strips ALL slots — the secure default.
    private readonly activeLlmProvider?: LlmProvider
  ) {}

  name() {
    return 'shell_exec'
  }

  description() {
    return (
      'Execute a shell command in the workspace directory. ' +
      'Supports full shell syntax (pipes, redirects, &&, etc.). ' +
      'Commands run with a timeout and restricted environment. ' +
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

  async execute(params: Record<string, unknown>, context?: ExecutionContext): Promise<ToolOutput> {
    const startTime = Date.now()
    const command = params.command as string

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

      const stdoutBuf: string[] = []
      const stderrBuf: string[] = []
      let totalBytes = 0
      let killed: 'timeout' | 'maxbuffer' | null = null
      let resolved = false

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
        const killTimer = setTimeout(() => {
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
        const s = chunk.toString('utf8')
        const buf = which === 'stdout' ? stdoutBuf : stderrBuf
        buf.push(s)
        totalBytes += Buffer.byteLength(s, 'utf8')
        // Stream to watcher (if any). Interleaved stdout+stderr is fine for the preview.
        context?.onOutput(s)
        if (totalBytes > ShellTool.MAX_TOTAL_BYTES && !killed) {
          killed = 'maxbuffer'
          forceKill()
        }
      }

      child.stdout?.on('data', c => onChunk(c, 'stdout'))
      child.stderr?.on('data', c => onChunk(c, 'stderr'))

      const timer = setTimeout(() => {
        if (!killed) {
          killed = 'timeout'
          forceKill()
        }
      }, this.timeout)

      child.on('close', exitCode => {
        clearTimeout(timer)
        const stdout = stdoutBuf.join('')
        const stderr = stderrBuf.join('')
        const body =
          [stdout ? `stdout:\n${stdout}` : '', stderr ? `stderr:\n${stderr}` : '']
            .filter(Boolean)
            .join('\n\n') || '(no output)'

        if (killed === 'timeout') {
          resolveOnce({
            content: `${body}\n\n[Command killed after ${this.timeout}ms timeout — partial output above]`,
            duration_ms: Date.now() - startTime,
            is_error: true,
          })
          return
        }
        if (killed === 'maxbuffer') {
          resolveOnce({
            content: `${body}\n\n[Command killed: output exceeded ${ShellTool.MAX_TOTAL_BYTES} bytes — partial output above]`,
            duration_ms: Date.now() - startTime,
            is_error: true,
          })
          return
        }
        if (exitCode !== 0 && exitCode !== null) {
          resolveOnce({
            content: `Command failed (exit code ${exitCode}):\n${body}`,
            duration_ms: Date.now() - startTime,
            is_error: true,
          })
          return
        }
        resolveOnce({
          content: body,
          duration_ms: Date.now() - startTime,
          is_error: false,
        })
      })

      child.on('error', err => {
        clearTimeout(timer)
        resolveOnce({
          content: `Command failed to start: ${err.message}`,
          duration_ms: Date.now() - startTime,
          is_error: true,
        })
      })
    })
  }
}
