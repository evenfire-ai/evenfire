import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { ALL_PROVIDERS, LlmProvider, PROVIDERS } from '../../../llm/registryCore'
import { executeWithTimeout } from '../../orchestration/toolExecutionTimeout'
import { ShellTool } from '../shell'

// Real processes run; the spy only observes whether a process was started.
vi.mock('child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('child_process')>()
  return { ...actual, spawn: vi.fn(actual.spawn) }
})

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

  it('uses the advertised Node environment to stream parsed records from the caller workspace', async () => {
    const tool = new ShellTool(workspacePath, 5000, ['PATH'])
    const description = tool.description()
    const executable = JSON.parse(
      description.match(/Node\.js executable: ("(?:[^"\\]|\\.)*")/)![1]
    ) as string
    const resolverBase = JSON.parse(
      description.match(/createRequire\(("(?:[^"\\]|\\.)*")\)/)![1]
    ) as string
    expect(description).toContain('load fast-csv through that resolver and use parseStream')
    expect(description).toContain('exceljs.csv is not available')
    await writeFile(
      join(workspacePath, 'input.csv'),
      'id,"label,name",notes\r\n' +
        '1,"comma,label","line1\nline2"\r\n' +
        '2,"say ""hi""","CRLF\r\ninside"\r\n' +
        '3,plain,end'
    )
    const program =
      `const load=require('node:module').createRequire(${JSON.stringify(resolverBase)});` +
      "let records=0;let columns=[];const input=require('node:fs').createReadStream('input.csv',{highWaterMark:1});" +
      "load('fast-csv').parseStream(input,{headers:true})" +
      ".on('headers',value=>{columns=value;}).on('data',()=>{records++;})" +
      ".on('error',()=>{process.exitCode=1;})" +
      ".on('end',()=>{console.log(JSON.stringify({records,columns}));});"
    const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`
    const result = await tool.execute({ command: `${quote(executable)} -e ${quote(program)}` })

    expect(result.is_error).toBe(false)
    expect(result.content).toContain(
      JSON.stringify({ records: 3, columns: ['id', 'label,name', 'notes'] })
    )
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

  describe('credential-slot stripping (§13 stateless agents)', () => {
    const SLOT_ENV_NAMES = ALL_PROVIDERS.flatMap(p =>
      PROVIDERS[p].credentialSlots.map(s => s.envName)
    )
    // Probes every registry slot in one shell round-trip: NAME=value or NAME=ABSENT.
    const probeCommand =
      'echo "' + SLOT_ENV_NAMES.map(n => n + '=${' + n + ':-ABSENT}').join(';') + '"'

    const setAllSlotsInProcessEnv = (): (() => void) => {
      const previous: Record<string, string | undefined> = {}
      for (const name of SLOT_ENV_NAMES) {
        previous[name] = process.env[name]
        process.env[name] = 'parent-' + name
      }
      return () => {
        for (const name of SLOT_ENV_NAMES) {
          if (previous[name] === undefined) delete process.env[name]
          else process.env[name] = previous[name]!
        }
      }
    }

    const expectOnlyActiveSlot = (
      content: string,
      active: LlmProvider | undefined,
      prefix: string
    ) => {
      for (const provider of ALL_PROVIDERS) {
        for (const slot of PROVIDERS[provider].credentialSlots) {
          const envName = slot.envName
          if (provider === active) {
            expect(content).toContain(envName + '=' + prefix + envName)
          } else {
            expect(content).toContain(envName + '=ABSENT')
          }
        }
      }
    }

    it('with all slots in the parent env, ONLY the active slot survives — each other slot is absent', async () => {
      const restore = setAllSlotsInProcessEnv()
      try {
        const tool = new ShellTool(
          workspacePath,
          5000,
          ['PATH', ...SLOT_ENV_NAMES],
          () => ({}),
          'claude'
        )
        const result = await tool.execute({ command: probeCommand })
        expect(result.is_error).toBe(false)
        expectOnlyActiveSlot(result.content as string, 'claude', 'parent-')
      } finally {
        restore()
      }
    })

    it('rotating the active provider changes which slot survives', async () => {
      const restore = setAllSlotsInProcessEnv()
      try {
        const openaiTool = new ShellTool(
          workspacePath,
          5000,
          [...SLOT_ENV_NAMES],
          () => ({}),
          'openai'
        )
        const r1 = await openaiTool.execute({ command: probeCommand })
        expectOnlyActiveSlot(r1.content as string, 'openai', 'parent-')

        const zaiTool = new ShellTool(workspacePath, 5000, [...SLOT_ENV_NAMES], () => ({}), 'zai')
        const r2 = await zaiTool.execute({ command: probeCommand })
        expectOnlyActiveSlot(r2.content as string, 'zai', 'parent-')
      } finally {
        restore()
      }
    })

    it('strips inactive slots layered via dynamicEnvProvider (ConfigStore) too', async () => {
      const storeEnv: Record<string, string> = {}
      for (const name of SLOT_ENV_NAMES) storeEnv[name] = 'store-' + name
      const tool = new ShellTool(workspacePath, 5000, ['PATH'], () => storeEnv, 'bailian')
      const result = await tool.execute({ command: probeCommand })
      expect(result.is_error).toBe(false)
      expectOnlyActiveSlot(result.content as string, 'bailian', 'store-')
    })

    it('without an active provider ALL credential slots are stripped (secure default)', async () => {
      const restore = setAllSlotsInProcessEnv()
      try {
        const tool = new ShellTool(workspacePath, 5000, ['PATH', ...SLOT_ENV_NAMES])
        const result = await tool.execute({ command: probeCommand })
        expect(result.is_error).toBe(false)
        expectOnlyActiveSlot(result.content as string, undefined, '')
      } finally {
        restore()
      }
    })

    it('non-credential env vars are untouched by the stripping pass', async () => {
      const tool = new ShellTool(
        workspacePath,
        5000,
        ['PATH'],
        () => ({ UNRELATED_VAR: 'kept' }),
        'openai'
      )
      const result = await tool.execute({ command: 'echo "$UNRELATED_VAR"' })
      expect(result.is_error).toBe(false)
      expect(result.content).toContain('kept')
    })
  })

  // PR #1005 pins the sha256 of the native tools[] baseline, which includes
  // shell_exec. Decoupling the shell from the GFS download store (#1019) must
  // not change the advertised name, description or schema. The two
  // machine-specific paths are normalized so the pin is portable.
  it('keeps the advertised shell_exec definition byte-identical to the pre-#1019 contract', () => {
    const tool = new ShellTool(workspacePath, 5000, ['PATH'])
    const description = tool
      .description()
      .replace(JSON.stringify(process.execPath), '<NODE_EXEC_PATH>')
      .replace(JSON.stringify(require.resolve('exceljs')), '<EXCELJS_PATH>')
    expect(tool.name()).toBe('shell_exec')
    expect(description).toBe(
      'Execute a shell command in the workspace directory. ' +
        'Supports full shell syntax (pipes, redirects, &&, etc.). ' +
        'Commands run with a timeout and restricted environment. ' +
        'Node.js executable: <NODE_EXEC_PATH>. ' +
        "Resolve installed Host libraries with require('node:module').createRequire(<EXCELJS_PATH>); load fast-csv through that resolver and use parseStream for streaming CSV parsing (exceljs.csv is not available). " +
        'Verify any other executable or library before using it. ' +
        'This tool requires approval before execution.'
    )
    expect(JSON.stringify(tool.parametersSchema())).toBe(
      JSON.stringify({
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description:
              "The shell command to execute (e.g., 'ls -la', 'echo hello | wc -c', 'git status')",
          },
        },
        required: ['command'],
      })
    )
  })
})

/** A Host-managed per-user root: `<host>/users/<caller>`. */
async function managedCallerRoot(): Promise<{ host: string; callerRoot: string }> {
  const host = await mkdtemp(join(tmpdir(), 'clerum-shell-managed-'))
  const callerRoot = join(host, 'users', 'caller')
  await mkdir(callerRoot, { recursive: true })
  return { host, callerRoot }
}

async function waitForFile(file: string, timeoutMs = 5_000): Promise<string> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(file)) {
      const content = (await readFile(file, 'utf8')).trim()
      if (content.length > 0) return content
    }
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`Timed out waiting for ${file}`)
}

function processIsGone(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH'
  }
}

describe('ShellTool without the GFS download store (#1019)', () => {
  const hosts: string[] = []
  beforeEach(() => {
    vi.mocked(spawn).mockClear()
  })
  afterEach(async () => {
    for (const host of hosts.splice(0)) await rm(host, { recursive: true, force: true })
  })

  it('U1: runs in the verified caller root with no store dependency', async () => {
    const { host, callerRoot } = await managedCallerRoot()
    hosts.push(host)
    const tool = new ShellTool(callerRoot, 5_000, ['PATH'], () => ({}), undefined, true)

    const result = await tool.execute({ command: 'printf ok' })

    expect(result).toMatchObject({ is_error: false, content: 'stdout:\nok' })
    expect(vi.mocked(spawn).mock.calls[0][2]).toMatchObject({ cwd: callerRoot })
  })

  it('U2: fails closed when the caller root is no longer canonical', async () => {
    const { host, callerRoot } = await managedCallerRoot()
    hosts.push(host)
    const tool = new ShellTool(callerRoot, 5_000, ['PATH'], () => ({}), undefined, true)
    // Witness: the same tool runs while the root is still canonical.
    expect(await tool.execute({ command: 'printf canonical' })).toMatchObject({
      is_error: false,
      content: 'stdout:\ncanonical',
    })
    expect(spawn).toHaveBeenCalledTimes(1)

    const moved = join(host, 'moved-caller')
    await rename(callerRoot, moved)
    await symlink(moved, callerRoot)
    const result = await tool.execute({ command: 'printf escaped' })

    expect(result.is_error).toBe(true)
    expect(result.content).toBe(
      'Managed shell unavailable: the verified caller workspace root is no longer canonical.'
    )
    expect(spawn).toHaveBeenCalledTimes(1)
  })

  describe('U6: process-group termination is unchanged', () => {
    const background = (pidFile: string) =>
      `sleep 30 & echo $! > ${JSON.stringify(pidFile)}; printf started;`

    it('kills the whole group on timeout', async () => {
      const pidFile = join(workspacePath, 'timeout.pid')
      const tool = new ShellTool(workspacePath, 500, ['PATH'])
      const result = await tool.execute({ command: `${background(pidFile)} wait` })

      expect(result.is_error).toBe(true)
      expect(result.content).toContain('[Command killed after 500ms timeout')
      const grandchild = Number(await waitForFile(pidFile))
      expect(grandchild).toBeGreaterThan(0)
      expect(processIsGone(grandchild)).toBe(true)
    })

    it('kills the whole group on cancellation', async () => {
      const pidFile = join(workspacePath, 'cancel.pid')
      const controller = new AbortController()
      const tool = new ShellTool(workspacePath, 30_000, ['PATH'])
      // The pid file is written before `printf started`, so aborting as soon as
      // it exists can race the stdout read. Abort only after the tool has
      // streamed "started", which it retains before calling onOutput.
      let streamed = ''
      let markStarted!: () => void
      const started = new Promise<void>(resolve => {
        markStarted = resolve
      })
      const execution = tool.execute(
        { command: `${background(pidFile)} wait` },
        {
          signal: controller.signal,
          onOutput: chunk => {
            streamed += chunk
            if (streamed.includes('started')) markStarted()
          },
        }
      )
      await started
      const grandchild = Number(await waitForFile(pidFile))
      controller.abort(new Error('user cancelled'))
      const result = await execution

      expect(result.is_error).toBe(true)
      expect(result.content).toContain('[Command cancelled — partial output above]')
      expect(result.content).toContain('started')
      expect(processIsGone(grandchild)).toBe(true)
    })

    it('kills the whole group when output exceeds the bound', async () => {
      const pidFile = join(workspacePath, 'maxbuffer.pid')
      const tool = new ShellTool(workspacePath, 30_000, ['PATH'])
      const result = await tool.execute({ command: `${background(pidFile)} yes` })

      expect(result.is_error).toBe(true)
      expect(result.content).toContain('output_limit_exceeded')
      const grandchild = Number(await waitForFile(pidFile))
      expect(processIsGone(grandchild)).toBe(true)
    })

    it('does not spawn when cancellation precedes process start', async () => {
      const tool = new ShellTool(workspacePath, 5_000, ['PATH'])
      const reason = new Error('cancelled before start')
      const controller = new AbortController()
      controller.abort(reason)

      await expect(
        tool.execute({ command: 'printf late' }, { signal: controller.signal, onOutput: () => {} })
      ).rejects.toBe(reason)
      expect(spawn).not.toHaveBeenCalled()

      // Witness: the same tool with a live signal does start the process.
      const live = await tool.execute(
        { command: 'printf live' },
        { signal: new AbortController().signal, onOutput: () => {} }
      )
      expect(live).toMatchObject({ is_error: false, content: 'stdout:\nlive' })
      expect(spawn).toHaveBeenCalledTimes(1)
    })

    it('joins the outer cancellation boundary until the group has exited', async () => {
      const pidFile = join(workspacePath, 'join.pid')
      const tool = new ShellTool(workspacePath, 30_000, ['PATH'])
      expect(tool.joinsAbortSettlement()).toBe(true)
      const parent = new AbortController()
      let settled = false
      const execution = executeWithTimeout(
        tool,
        { command: `${background(pidFile)} wait` },
        { onOutput: () => {} },
        30_000,
        parent.signal
      ).finally(() => {
        settled = true
      })
      const grandchild = Number(await waitForFile(pidFile))
      parent.abort(new Error('outer cancellation'))
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(settled).toBe(false)

      const result = await execution
      expect(result.is_error).toBe(true)
      expect(result.content).toContain('[Command cancelled — partial output above]')
      expect(processIsGone(grandchild)).toBe(true)
    })
  })
})

describe('ShellTool start failures (#1020)', () => {
  beforeEach(() => {
    vi.mocked(spawn).mockClear()
  })

  it('U3: resolves a synchronous spawn throw from a NUL env value as a start failure', async () => {
    const tool = new ShellTool(workspacePath, 5_000, ['PATH'], () => ({ BROKEN: 'a\0b' }))
    const result = await tool.execute({ command: 'printf never-runs' })
    expect(result.is_error).toBe(true)
    expect(result.content).toMatch(/^Command failed to start: /)
    expect(result.content).not.toContain('never-runs')
    expect(result.duration_ms).toBeGreaterThanOrEqual(0)
    // Witness: spawn was reached and threw; no process exists to report on.
    expect(spawn).toHaveBeenCalledOnce()
    expect(vi.mocked(spawn).mock.results[0]!.type).toBe('throw')
  })

  it('U4: reports an asynchronous spawn failure (missing cwd) as a start failure', async () => {
    const missing = join(workspacePath, 'removed-before-spawn')
    const tool = new ShellTool(missing, 5_000, ['PATH'])
    const result = await tool.execute({ command: 'printf never-runs' })
    expect(result.is_error).toBe(true)
    expect(result.content).toMatch(/^Command failed to start: .*ENOENT/)
    expect(result.content).not.toContain('never-runs')
    // Witness: spawn returned a child; the failure arrived on its error event.
    expect(spawn).toHaveBeenCalledOnce()
    expect(vi.mocked(spawn).mock.results[0]!.type).toBe('return')
  })
})
