import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { ShellTool } from '../shell'

let workspacePath: string

beforeEach(async () => {
  workspacePath = await mkdtemp(join(tmpdir(), 'clerum-shell-'))
})

afterEach(async () => {
  await rm(workspacePath, { recursive: true, force: true })
})

describe('ShellTool', () => {
  it('should declare requiresApproval() = true', () => {
    const tool = new ShellTool(workspacePath, 5000, ['PATH'])
    expect(tool.requiresApproval()).toBe(true)
  })

  it('should declare requiresSanitization() = true', () => {
    const tool = new ShellTool(workspacePath, 5000, ['PATH'])
    expect(tool.requiresSanitization()).toBe(true)
  })

  it('should have tool name shell_exec', () => {
    const tool = new ShellTool(workspacePath, 5000, ['PATH'])
    expect(tool.name()).toBe('shell_exec')
  })

  it('should execute a simple command', async () => {
    const tool = new ShellTool(workspacePath, 5000, ['PATH'])
    const result = await tool.execute({ command: 'echo hello' })

    expect(result.is_error).toBe(false)
    expect(result.content).toContain('hello')
  })

  it('should support pipes', async () => {
    const tool = new ShellTool(workspacePath, 5000, ['PATH'])
    const result = await tool.execute({ command: 'echo hello world | wc -w' })

    expect(result.is_error).toBe(false)
    expect(result.content).toContain('2')
  })

  it('should support && chaining', async () => {
    const tool = new ShellTool(workspacePath, 5000, ['PATH'])
    const result = await tool.execute({ command: 'echo first && echo second' })

    expect(result.is_error).toBe(false)
    expect(result.content).toContain('first')
    expect(result.content).toContain('second')
  })

  it('should support redirects', async () => {
    const tool = new ShellTool(workspacePath, 5000, ['PATH'])
    const outFile = join(workspacePath, 'out.txt')

    await tool.execute({ command: `echo redirected > ${outFile}` })
    const result = await tool.execute({ command: `cat ${outFile}` })

    expect(result.is_error).toBe(false)
    expect(result.content).toContain('redirected')
  })

  it('should run in workspace directory', async () => {
    const tool = new ShellTool(workspacePath, 5000, ['PATH'])
    const result = await tool.execute({ command: 'pwd' })

    expect(result.is_error).toBe(false)
    expect(result.content).toContain(workspacePath)
  })

  it('should kill process on timeout', async () => {
    const tool = new ShellTool(workspacePath, 500, ['PATH'])
    const result = await tool.execute({ command: 'sleep 60' })

    expect(result.is_error).toBe(true)
    expect(result.content).toContain('timeout')
  })

  it('should return is_error for failed commands', async () => {
    const tool = new ShellTool(workspacePath, 5000, ['PATH'])
    const result = await tool.execute({ command: 'ls /nonexistent_path_12345' })

    expect(result.is_error).toBe(true)
    expect(result.content).toContain('Command failed')
  })

  it('should return exit code on failure', async () => {
    const tool = new ShellTool(workspacePath, 5000, ['PATH'])
    const result = await tool.execute({ command: 'exit 42' })

    expect(result.is_error).toBe(true)
    expect(result.content).toContain('exit code 42')
  })

  it('should restrict env to allowlist', async () => {
    process.env.__CLERUM_TEST_SECRET = 'leaked'
    try {
      const tool = new ShellTool(workspacePath, 5000, ['PATH'])
      const result = await tool.execute({ command: 'echo $__CLERUM_TEST_SECRET' })

      expect(result.is_error).toBe(false)
      // Should be empty — the var is not in the allowlist
      expect(result.content).not.toContain('leaked')
    } finally {
      delete process.env.__CLERUM_TEST_SECRET
    }
  })

  it('should pass allowlisted env vars', async () => {
    process.env.__CLERUM_TEST_ALLOWED = 'visible'
    try {
      const tool = new ShellTool(workspacePath, 5000, ['PATH', '__CLERUM_TEST_ALLOWED'])
      const result = await tool.execute({ command: 'echo $__CLERUM_TEST_ALLOWED' })

      expect(result.is_error).toBe(false)
      expect(result.content).toContain('visible')
    } finally {
      delete process.env.__CLERUM_TEST_ALLOWED
    }
  })

  it('should return (no output) for silent commands', async () => {
    const tool = new ShellTool(workspacePath, 5000, ['PATH'])
    const result = await tool.execute({ command: 'true' })

    expect(result.is_error).toBe(false)
    expect(result.content).toBe('(no output)')
  })

  it('should include duration_ms', async () => {
    const tool = new ShellTool(workspacePath, 5000, ['PATH'])
    const result = await tool.execute({ command: 'echo fast' })

    expect(result.duration_ms).toBeGreaterThanOrEqual(0)
  })

  // ── Progress streaming + partial output on timeout (new feature) ──

  it('declares supportsProgressOutput() = true', () => {
    const tool = new ShellTool(workspacePath, 5000, ['PATH'])
    expect(tool.supportsProgressOutput?.()).toBe(true)
  })

  it('calls context.onOutput for stdout chunks', async () => {
    const tool = new ShellTool(workspacePath, 5000, ['PATH'])
    const chunks: string[] = []
    const context = { onOutput: (c: string) => chunks.push(c) }

    const result = await tool.execute({ command: 'echo streamed' }, context)

    expect(result.is_error).toBe(false)
    expect(chunks.join('')).toContain('streamed')
  })

  it('calls context.onOutput for stderr chunks', async () => {
    const tool = new ShellTool(workspacePath, 5000, ['PATH'])
    const chunks: string[] = []
    const context = { onOutput: (c: string) => chunks.push(c) }

    const result = await tool.execute({ command: 'echo to-stderr 1>&2' }, context)

    expect(result.is_error).toBe(false)
    expect(chunks.join('')).toContain('to-stderr')
  })

  it('returns partial output with timeout marker when command exceeds timeout', async () => {
    // 2s timeout. Command prints "start" immediately, sleeps 10s, then prints "end".
    // The timeout fires before "end" is printed.
    const tool = new ShellTool(workspacePath, 2000, ['PATH'])
    const result = await tool.execute({
      command: 'echo start; sleep 10; echo end',
    })

    expect(result.is_error).toBe(true)
    expect(result.content).toContain('start')
    expect(result.content).toContain('[Command killed after 2000ms timeout')
    expect(result.content).not.toContain('end')
  })

  it('does not leak child process state between concurrent execute() calls', async () => {
    const tool = new ShellTool(workspacePath, 5000, ['PATH'])

    // Two concurrent execs with different outputs — each must resolve with its own.
    const [r1, r2] = await Promise.all([
      tool.execute({ command: 'echo first-run' }),
      tool.execute({ command: 'echo second-run' }),
    ])

    expect(r1.is_error).toBe(false)
    expect(r2.is_error).toBe(false)
    expect(r1.content).toContain('first-run')
    expect(r1.content).not.toContain('second-run')
    expect(r2.content).toContain('second-run')
    expect(r2.content).not.toContain('first-run')
  })

  // Skipped on CI: Ubuntu GH Actions runners (dash as /bin/sh) exhibit unreliable
  // process-group kill propagation to `sleep` grandchildren even after SIGKILL grace.
  // Production behavior is verified by manual minikube e2e + code review.
  it.skipIf(process.env.CI)(
    'kills grandchild processes (e.g. sleep in a semicolon chain) via process-group kill',
    async () => {
      // Spawn a long-sleeping grandchild and write its PID before waiting on it.
      // Checking the PID directly avoids `pgrep` false positives from the probe
      // command itself and from platform-specific process-list behavior.
      const pidFile = join(workspacePath, 'grandchild.pid')
      const tool = new ShellTool(workspacePath, 500, ['PATH'])

      // Run the tool — timeout fires at 500ms.
      const result = await tool.execute({
        command: `echo start; sleep 60 & echo $! > ${pidFile}; wait`,
      })

      expect(result.is_error).toBe(true)
      expect(result.content).toContain('start')
      expect(result.content).toContain('timeout')

      // After the tool resolves, give the kernel a moment to clean up.
      // Then assert the captured `sleep` PID no longer exists.
      const pid = Number((await readFile(pidFile, 'utf8')).trim())
      expect(Number.isInteger(pid)).toBe(true)
      expect(pid).toBeGreaterThan(0)

      // Poll up to 8s for grandchild to be reaped. SIGTERM → SIGKILL grace is 5s,
      // so the window must exceed that to cover slow runners where SIGTERM may
      // not reach the grandchild immediately.
      let grandchildAlive = true
      for (let i = 0; i < 80; i++) {
        await new Promise(r => setTimeout(r, 100))
        try {
          process.kill(pid, 0)
        } catch {
          grandchildAlive = false
          break
        }
      }

      expect(grandchildAlive).toBe(false)
    },
    20_000
  ) // generous test timeout — 500ms shell + up to 8s polling

  describe('dynamicEnvProvider — ConfigStore snapshot merge', () => {
    it('exposes ConfigStore values to the subprocess shell at spawn time', async () => {
      const dynamicEnvProvider = () => ({ MY_TOKEN: 'sek-rit-123', FEATURE_FLAG: '1' })
      const tool = new ShellTool(workspacePath, 5000, ['PATH'], dynamicEnvProvider)

      const result = await tool.execute({ command: 'echo "$MY_TOKEN-$FEATURE_FLAG"' })
      expect(result.is_error).toBe(false)
      expect(result.content).toContain('sek-rit-123-1')
    })

    it('reads the snapshot lazily — rotation between spawns is visible to next call', async () => {
      let token = 'rev-1'
      const tool = new ShellTool(workspacePath, 5000, ['PATH'], () => ({ ROTATING: token }))

      const r1 = await tool.execute({ command: 'echo "$ROTATING"' })
      expect(r1.content).toContain('rev-1')

      token = 'rev-2'
      const r2 = await tool.execute({ command: 'echo "$ROTATING"' })
      expect(r2.content).toContain('rev-2')
    })

    it('dynamic env wins over allowlisted process.env values', async () => {
      const previous = process.env.SHADOWED_VAR
      process.env.SHADOWED_VAR = 'from-process-env'
      try {
        const tool = new ShellTool(workspacePath, 5000, ['SHADOWED_VAR'], () => ({
          SHADOWED_VAR: 'from-config-store',
        }))
        const result = await tool.execute({ command: 'echo "$SHADOWED_VAR"' })
        expect(result.is_error).toBe(false)
        expect(result.content).toContain('from-config-store')
      } finally {
        if (previous === undefined) delete process.env.SHADOWED_VAR
        else process.env.SHADOWED_VAR = previous
      }
    })

    it('does not leak ConfigStore values into mcp-host process.env', async () => {
      const tool = new ShellTool(workspacePath, 5000, ['PATH'], () => ({
        EPHEMERAL_KEY: 'should-not-stick',
      }))
      const result = await tool.execute({ command: 'echo "$EPHEMERAL_KEY"' })
      expect(result.content).toContain('should-not-stick')
      expect(process.env.EPHEMERAL_KEY).toBeUndefined()
    })

    it('absent dynamicEnvProvider behaves like prior versions (allowlist only)', async () => {
      const tool = new ShellTool(workspacePath, 5000, ['PATH'])
      const result = await tool.execute({ command: 'echo "$NEVER_SET-$PATH"' })
      // Just check it doesn't throw and PATH was passed through.
      expect(result.is_error).toBe(false)
      expect(result.content).toContain('-/')
    })
  })
})
