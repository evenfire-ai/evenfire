import { type MockInstance, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawn } from 'child_process'
import { EventEmitter } from 'events'
import { existsSync, readFileSync } from 'fs'
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { PassThrough } from 'stream'
import { logger } from '../../../logger'
import { executeWithTimeout } from '../../orchestration/toolExecutionTimeout'
import { ShellTool } from '../shell'
import { SHELL_STDIO_DRAIN_MS, SHELL_TIMEOUT_CLEANUP_MS } from '../shellTimeouts'

// Real processes run unless a test replaces one spawn with a hermetic child.
vi.mock('child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('child_process')>()
  return { ...actual, spawn: vi.fn(actual.spawn) }
})

// The fake clock does not reach node:timers/promises, so the group-termination
// poll sleeps through the global setTimeout: real under real timers, fake under
// a fake clock.
vi.mock('node:timers/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:timers/promises')>()
  return {
    ...actual,
    setTimeout: (delayMs: number) =>
      new Promise<void>(resolve => globalThis.setTimeout(resolve, delayMs)),
  }
})

/** Mirrors ShellTool.MAX_RESULT_BYTES (1 MB minus 2048 bytes of headroom). */
const MAX_RESULT_BYTES = 1024 * 1024 - 2048
/** Delay before a timeout or cancellation is triggered on a real process. */
const TRIGGER_MS = 3_000
/** Scheduling margin for a loaded machine. */
const MARGIN_MS = 2_000
/** F4: cleanup budget + margin + trigger delay. */
const TERMINATION_TEST_TIMEOUT_MS = SHELL_TIMEOUT_CLEANUP_MS + MARGIN_MS + TRIGGER_MS
/** F4: the natural-exit case runs with a 30 s execution timeout and must settle long before it. */
const NATURAL_EXIT_EXECUTION_TIMEOUT_MS = 30_000
const NATURAL_EXIT_TEST_TIMEOUT_MS = 15_000

const notice = (reason: string) =>
  `[stdio_held_by_detached_process: ${reason}; output capture stopped; redirect background output to a file or /dev/null]\n\n`

let workspacePath: string
const holderPids: number[] = []
let warn: MockInstance<typeof logger.warn>

beforeEach(async () => {
  workspacePath = await mkdtemp(join(tmpdir(), 'clerum-shell-held-'))
  vi.mocked(spawn).mockClear()
  warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
})

afterEach(async () => {
  for (const pid of holderPids.splice(0)) {
    if (isAlive(pid)) process.kill(pid, 'SIGKILL')
  }
  vi.restoreAllMocks()
  vi.useRealTimers()
  await rm(workspacePath, { recursive: true, force: true })
})

/**
 * A command prefix that starts a Node process with `detached: true` (its own
 * session and process group, so the shell's group signals never reach it)
 * that inherits the shell's stdout/stderr, writes READY to stdout and then
 * idles. The launcher returns only after READY was written, so the escape has
 * happened before the rest of the command runs. `setsid` is not needed.
 */
async function escapedHolder(): Promise<{ prefix: string; pidFile: string }> {
  const launcher = join(workspacePath, 'launch-holder.js')
  const holder = join(workspacePath, 'holder.js')
  const pidFile = join(workspacePath, 'holder.pid')
  await writeFile(
    holder,
    [
      "const fs = require('fs')",
      "fs.writeSync(1, 'READY\\n')",
      "fs.writeSync(3, 'R')",
      'fs.closeSync(3)',
      // Bounded lifetime in case a failing test never reaches afterEach.
      'setTimeout(() => process.exit(0), 60000)',
    ].join('\n')
  )
  await writeFile(
    launcher,
    [
      "const { spawn } = require('child_process')",
      "const fs = require('fs')",
      'const [pidFile, holderPath] = process.argv.slice(2)',
      'const holder = spawn(process.execPath, [holderPath], {',
      '  detached: true,',
      "  stdio: ['ignore', 'inherit', 'inherit', 'pipe'],",
      '})',
      "holder.stdio[3].once('data', () => {",
      '  fs.writeFileSync(pidFile, String(holder.pid))',
      '  holder.stdio[3].destroy()',
      '  holder.unref()',
      '  process.exit(0)',
      '})',
    ].join('\n')
  )
  const prefix = [process.execPath, launcher, pidFile, holder].map(arg => JSON.stringify(arg))
  return { prefix: `${prefix.join(' ')};`, pidFile }
}

async function holderPid(pidFile: string): Promise<number> {
  const pid = Number(await waitForFile(pidFile))
  expect(Number.isSafeInteger(pid) && pid > 0).toBe(true)
  holderPids.push(pid)
  return pid
}

async function waitFor(condition: () => boolean, what: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

async function waitForFile(file: string, timeoutMs = 5_000): Promise<string> {
  let content = ''
  await waitFor(
    () => existsSync(file) && (content = readFileSync(file, 'utf8').trim()) !== '',
    file,
    timeoutMs
  )
  return content
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw error
  }
}

function heldWarnings(): unknown[] {
  return warn.mock.calls
    .map(call => call[0] as unknown)
    .filter(
      fields =>
        typeof fields === 'object' &&
        fields !== null &&
        (fields as { event?: unknown }).event === 'shell_stdio_held_by_detached_process'
    )
}

describe('ShellTool with stdio held by a process outside its group (#1028 P1)', () => {
  it(
    'P1-a: a timeout with an escaped stdout/stderr holder settles through executeWithTimeout within the cleanup budget',
    async () => {
      const { prefix, pidFile } = await escapedHolder()
      const command = `${prefix} printf out-marker; printf err-marker >&2; sleep 30`
      const tool = new ShellTool(workspacePath, NATURAL_EXIT_EXECUTION_TIMEOUT_MS, ['PATH'])
      let streamed = ''
      const startedAt = performance.now()
      const execution = executeWithTimeout(
        tool,
        { command },
        { onOutput: chunk => (streamed += chunk) },
        TRIGGER_MS
      )

      // Witness before termination: the holder escaped, is alive, and its READY
      // reached the call through the shared pipe.
      const holder = await holderPid(pidFile)
      await waitFor(() => streamed.includes('READY'), 'READY on the progress stream')
      expect(isAlive(holder)).toBe(true)
      expect(performance.now() - startedAt).toBeLessThan(TRIGGER_MS)

      const result = await execution
      const elapsed = performance.now() - startedAt

      expect(elapsed).toBeLessThanOrEqual(TRIGGER_MS + SHELL_TIMEOUT_CLEANUP_MS + MARGIN_MS)
      expect(result.is_error).toBe(true)
      expect(result.content.startsWith(notice('timeout'))).toBe(true)
      expect(result.content).toContain('stdout:\nREADY\nout-marker')
      expect(result.content).toContain('stderr:\nerr-marker')
      expect(result.content).toContain(
        `[Command killed after ${TRIGGER_MS}ms timeout — partial output above]`
      )
      const held = heldWarnings()
      expect(held).toEqual([
        {
          component: 'ShellTool',
          event: 'shell_stdio_held_by_detached_process',
          reason: 'timeout',
          exitCode: null,
          leaderExited: true,
          processGroupTerminated: expect.any(Boolean),
          durationMs: expect.any(Number),
        },
      ])
      // F6: the single probe at the deadline may still see the group.
      const groupTerminated = (held[0] as { processGroupTerminated: boolean })
        .processGroupTerminated
      expect(result.content.includes('[process_group_termination_failed]')).toBe(!groupTerminated)
      const logged = JSON.stringify(warn.mock.calls)
      for (const fragment of ['out-marker', 'err-marker', 'sleep 30', 'launch-holder', pidFile]) {
        expect(logged).not.toContain(fragment)
      }
      // Direct witness that the holder was outside the signalled group.
      expect(isAlive(holder)).toBe(true)
    },
    TERMINATION_TEST_TIMEOUT_MS
  )

  it(
    'P1-b: a cancellation with an escaped holder settles within the cleanup budget with cause cancelled',
    async () => {
      const { prefix, pidFile } = await escapedHolder()
      const tool = new ShellTool(workspacePath, NATURAL_EXIT_EXECUTION_TIMEOUT_MS, ['PATH'])
      const parent = new AbortController()
      let streamed = ''
      const execution = executeWithTimeout(
        tool,
        { command: `${prefix} printf before-cancel; sleep 30` },
        { onOutput: chunk => (streamed += chunk) },
        NATURAL_EXIT_EXECUTION_TIMEOUT_MS,
        parent.signal
      )
      const holder = await holderPid(pidFile)
      await waitFor(() => streamed.includes('before-cancel'), 'output before cancellation')
      expect(isAlive(holder)).toBe(true)

      const cancelledAt = performance.now()
      parent.abort(new Error('user cancelled'))
      const result = await execution

      expect(performance.now() - cancelledAt).toBeLessThanOrEqual(
        SHELL_TIMEOUT_CLEANUP_MS + MARGIN_MS
      )
      expect(result.is_error).toBe(true)
      expect(result.content.startsWith(notice('cancelled'))).toBe(true)
      expect(result.content).toContain('READY\nbefore-cancel')
      expect(result.content).toContain('[Command cancelled — partial output above]')
      expect(result.content).not.toContain('timeout — partial output above')
      expect(heldWarnings()).toEqual([expect.objectContaining({ reason: 'cancelled' })])
      expect(isAlive(holder)).toBe(true)
    },
    TERMINATION_TEST_TIMEOUT_MS
  )

  it(
    'P1-b: an output overflow with an escaped holder settles within the cleanup budget with cause maxbuffer, notice and footer inside the result budget',
    async () => {
      const { prefix, pidFile } = await escapedHolder()
      const tool = new ShellTool(workspacePath, NATURAL_EXIT_EXECUTION_TIMEOUT_MS, ['PATH'])
      let streamedBytes = 0
      const execution = executeWithTimeout(
        tool,
        { command: `${prefix} yes` },
        { onOutput: chunk => (streamedBytes += Buffer.byteLength(chunk)) },
        NATURAL_EXIT_EXECUTION_TIMEOUT_MS
      )
      const holder = await holderPid(pidFile)
      const overflowStartedAt = performance.now()
      const result = await execution

      expect(performance.now() - overflowStartedAt).toBeLessThanOrEqual(
        SHELL_TIMEOUT_CLEANUP_MS + MARGIN_MS
      )
      expect(streamedBytes).toBeGreaterThan(0)
      expect(result.is_error).toBe(true)
      expect(result.content.startsWith(notice('maxbuffer'))).toBe(true)
      expect(result.content).toContain('stdout:\nREADY\ny\ny\n')
      expect(
        result.content.endsWith(
          '[output_limit_exceeded: command killed after more than 1048576 output bytes — bounded partial output above]'
        ) ||
          result.content.endsWith(
            '[output_limit_exceeded: command killed after more than 1048576 output bytes — bounded partial output above]\n\n[process_group_termination_failed]'
          )
      ).toBe(true)
      expect(Buffer.byteLength(result.content)).toBeLessThanOrEqual(MAX_RESULT_BYTES)
      expect(result.content).not.toContain('[Command killed after')
      expect(heldWarnings()).toEqual([expect.objectContaining({ reason: 'maxbuffer' })])
      expect(isAlive(holder)).toBe(true)
    },
    TERMINATION_TEST_TIMEOUT_MS
  )

  it(
    'P1-c: a command that exits 0 after starting an escaped holder settles about one drain interval after exit, not at the execution timeout',
    async () => {
      const { prefix, pidFile } = await escapedHolder()
      const tool = new ShellTool(workspacePath, NATURAL_EXIT_EXECUTION_TIMEOUT_MS, ['PATH'])
      const startedAt = performance.now()
      const execution = executeWithTimeout(
        tool,
        { command: `printf own-before; ${prefix} printf own-after` },
        { onOutput: () => {} },
        NATURAL_EXIT_EXECUTION_TIMEOUT_MS
      )
      const holder = await holderPid(pidFile)
      const result = await execution
      const elapsed = performance.now() - startedAt

      expect(elapsed).toBeGreaterThanOrEqual(SHELL_STDIO_DRAIN_MS)
      expect(elapsed).toBeLessThan(NATURAL_EXIT_EXECUTION_TIMEOUT_MS / 3)
      expect(result.is_error).toBe(true)
      expect(result.content).toBe(`${notice('exited')}stdout:\nown-beforeREADY\nown-after`)
      expect(heldWarnings()).toEqual([
        {
          component: 'ShellTool',
          event: 'shell_stdio_held_by_detached_process',
          reason: 'exited',
          exitCode: 0,
          leaderExited: true,
          processGroupTerminated: true,
          durationMs: expect.any(Number),
        },
      ])
      expect(isAlive(holder)).toBe(true)
    },
    NATURAL_EXIT_TEST_TIMEOUT_MS
  )

  it('P1-d: an in-group background job that writes after the leader exits is still collected', async () => {
    const tool = new ShellTool(workspacePath, NATURAL_EXIT_EXECUTION_TIMEOUT_MS, ['PATH'])
    const result = await tool.execute({ command: '(sleep 2; printf late) & printf early' })

    // Witness: the trailing marker written two drain intervals after exit.
    expect(result).toMatchObject({ is_error: false, content: 'stdout:\nearlylate' })
    expect(result.content).not.toContain('stdio_held_by_detached_process')
    expect(heldWarnings()).toEqual([])
  }, 10_000)

  it(
    'P1-h: a forced closure with a non-zero exit near the output limit keeps the notice and the failure prefix in the first 200 characters',
    async () => {
      const { prefix, pidFile } = await escapedHolder()
      const tool = new ShellTool(workspacePath, NATURAL_EXIT_EXECUTION_TIMEOUT_MS, ['PATH'])
      // Below the 1 MB admission bound, above the result budget.
      const bodyBytes = 1024 * 1024 - 1024
      let streamedBytes = 0
      const execution = tool.execute(
        { command: `${prefix} head -c ${bodyBytes} /dev/zero | tr '\\000' x; exit 3` },
        { onOutput: chunk => (streamedBytes += Buffer.byteLength(chunk)) }
      )
      const holder = await holderPid(pidFile)
      const result = await execution

      expect(streamedBytes).toBeGreaterThan(0)
      expect(result.is_error).toBe(true)
      const head = `${notice('exited')}Command failed (exit code 3):\nstdout:\nREADY\nxxxx`
      expect(result.content.startsWith(head)).toBe(true)
      expect(
        head.indexOf('Command failed (exit code 3):') + 'Command failed (exit code 3):'.length
      ).toBeLessThan(200)
      expect(Buffer.byteLength(result.content)).toBeLessThanOrEqual(MAX_RESULT_BYTES)
      expect(Buffer.byteLength(result.content)).toBeGreaterThan(MAX_RESULT_BYTES - 16)
      expect(heldWarnings()).toEqual([expect.objectContaining({ reason: 'exited', exitCode: 3 })])
      expect(isAlive(holder)).toBe(true)
    },
    NATURAL_EXIT_TEST_TIMEOUT_MS
  )

  it('P1-g: an asynchronous start failure reports only the error code and publishes one result', async () => {
    const loggerError = vi.spyOn(logger, 'error').mockImplementation(() => {})
    const missing = join(workspacePath, 'created-after-first-call')
    const tool = new ShellTool(missing, 5_000, ['PATH'])

    const result = await tool.execute({ command: 'printf never-runs' })
    // Any late close from the failed spawn has time to arrive.
    await new Promise(resolve => setTimeout(resolve, 50))

    expect(result).toEqual({
      content: 'Command failed to start: ENOENT',
      duration_ms: expect.any(Number),
      is_error: true,
    })
    expect(vi.mocked(spawn).mock.results[0]!.type).toBe('return')
    expect(loggerError.mock.calls.map(call => call[0])).toEqual([
      { component: 'ShellTool', errorCode: 'ENOENT' },
    ])
    expect(JSON.stringify(loggerError.mock.calls)).not.toContain(missing)

    // Witness: the same tool instance runs once the directory exists.
    await mkdir(missing)
    const ok = await tool.execute({ command: 'printf runs' })
    expect(ok).toMatchObject({ is_error: false, content: 'stdout:\nruns' })
    expect(spawn).toHaveBeenCalledTimes(2)
  })
})

describe('ShellTool single finalizer races (#1028 P1, hermetic child)', () => {
  // These races cannot be ordered with a real process, so one spawn returns a
  // hermetic ChildProcess and process.kill is intercepted: no signal is sent.
  const FAKE_PID = 424_242

  function hermeticChild() {
    return Object.assign(new EventEmitter(), {
      pid: FAKE_PID,
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      killed: false,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(() => true),
    })
  }

  const groupGone = () => Object.assign(new Error('group gone'), { code: 'ESRCH' })

  it('P1-e: a close delivered after the cleanup deadline finalized the call publishes nothing more and sends no further signal', async () => {
    vi.useFakeTimers()
    const child = hermeticChild()
    vi.mocked(spawn).mockImplementationOnce(() => child as never)
    const signals: Array<[number, unknown]> = []
    vi.spyOn(process, 'kill').mockImplementation((pid: number, signal?: string | number) => {
      signals.push([pid, signal])
      if (signal === 0) throw groupGone()
      return true
    })
    const controller = new AbortController()
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener')
    const streamed: string[] = []
    const execution = new ShellTool(workspacePath, 1_000, []).execute(
      { command: 'hermetic command' },
      { signal: controller.signal, onOutput: chunk => streamed.push(chunk) }
    )
    child.stdout.emit('data', Buffer.from('first chunk'))
    await vi.advanceTimersByTimeAsync(1_000)
    expect(signals).toEqual([[-FAKE_PID, 'SIGTERM']])
    await vi.advanceTimersByTimeAsync(SHELL_TIMEOUT_CLEANUP_MS)
    const result = await execution

    expect(streamed).toEqual(['first chunk'])
    expect(result.content).toBe(
      `${notice('timeout')}stdout:\nfirst chunk\n\n[Command killed after 1000ms timeout — partial output above]`
    )
    // SIGTERM, SIGKILL after the grace, SIGKILL at the deadline, one probe.
    const atSettlement: Array<[number, unknown]> = [
      [-FAKE_PID, 'SIGTERM'],
      [-FAKE_PID, 'SIGKILL'],
      [-FAKE_PID, 'SIGKILL'],
      [-FAKE_PID, 0],
    ]
    expect(signals).toEqual(atSettlement)

    // Destroyed pipes let the runtime deliver close later.
    child.emit('close', null)
    await vi.advanceTimersByTimeAsync(SHELL_TIMEOUT_CLEANUP_MS)

    expect(signals).toEqual(atSettlement)
    expect(heldWarnings()).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function))
  })

  it('P1-e: an abort delivered during close verification keeps the natural-exit result and sends no termination signal', async () => {
    const child = hermeticChild()
    vi.mocked(spawn).mockImplementationOnce(() => child as never)
    const controller = new AbortController()
    const signals: Array<[number, unknown]> = []
    let probes = 0
    vi.spyOn(process, 'kill').mockImplementation((pid: number, signal?: string | number) => {
      signals.push([pid, signal])
      if (signal !== 0) return true
      probes += 1
      if (probes === 1) {
        controller.abort(new Error('late cancellation'))
        return true
      }
      throw groupGone()
    })
    const execution = new ShellTool(workspacePath, 30_000, []).execute(
      { command: 'hermetic command' },
      { signal: controller.signal, onOutput: () => {} }
    )
    child.stdout.emit('data', Buffer.from('natural output'))
    child.exitCode = 0
    child.emit('exit', 0, null)
    child.emit('close', 0)
    const result = await execution

    // Witness: the abort was delivered while the group was still being probed.
    expect(controller.signal.aborted).toBe(true)
    expect(probes).toBe(2)
    expect(result).toEqual({
      content: 'stdout:\nnatural output',
      duration_ms: expect.any(Number),
      is_error: false,
    })
    expect(signals).toEqual([
      [-FAKE_PID, 'SIGKILL'],
      [-FAKE_PID, 0],
      [-FAKE_PID, 0],
    ])
    expect(heldWarnings()).toEqual([])
  })

  it('P1-f: a chunk that arrives after close claimed finalization is neither retained nor streamed', async () => {
    const child = hermeticChild()
    vi.mocked(spawn).mockImplementationOnce(() => child as never)
    const streamed: string[] = []
    let probes = 0
    vi.spyOn(process, 'kill').mockImplementation((_pid: number, signal?: string | number) => {
      if (signal !== 0) return true
      probes += 1
      if (probes === 1) {
        child.stdout.emit('data', Buffer.from('late chunk'))
        return true
      }
      throw groupGone()
    })
    const execution = new ShellTool(workspacePath, 30_000, []).execute(
      { command: 'hermetic command' },
      { onOutput: chunk => streamed.push(chunk) }
    )
    child.stdout.emit('data', Buffer.from('early chunk'))
    child.emit('close', 0)
    const result = await execution

    // Witness: the late chunk was delivered during verification.
    expect(probes).toBe(2)
    expect(streamed).toEqual(['early chunk'])
    expect(result).toMatchObject({ is_error: false, content: 'stdout:\nearly chunk' })
  })

  it('logs and keeps waiting when a group probe fails with a code other than ESRCH or EPERM', async () => {
    const child = hermeticChild()
    vi.mocked(spawn).mockImplementationOnce(() => child as never)
    let probes = 0
    vi.spyOn(process, 'kill').mockImplementation((_pid: number, signal?: string | number) => {
      if (signal !== 0) return true
      probes += 1
      if (probes === 1) throw Object.assign(new Error('invalid'), { code: 'EINVAL' })
      throw groupGone()
    })
    const execution = new ShellTool(workspacePath, 30_000, []).execute({
      command: 'hermetic command',
    })
    child.stdout.emit('data', Buffer.from('output'))
    child.emit('close', 0)
    const result = await execution

    // EINVAL did not count as absence: a second probe was needed.
    expect(probes).toBe(2)
    expect(result).toMatchObject({ is_error: false, content: 'stdout:\noutput' })
    expect(warn.mock.calls.map(call => call[0])).toEqual([
      { component: 'ShellTool', errorCode: 'EINVAL' },
    ])
  })

  /** Fakes performance.now as well, so the termination deadline follows the fake clock. */
  const useFakeClock = () =>
    vi.useFakeTimers({
      toFake: [
        'setTimeout',
        'clearTimeout',
        'setInterval',
        'clearInterval',
        'setImmediate',
        'clearImmediate',
        'Date',
        'performance',
      ],
    })

  /** Intercepts process.kill; the group probe never confirms absence. */
  function groupThatNeverDisappears() {
    const signals: Array<{ pid: number; signal: unknown; at: number }> = []
    vi.spyOn(process, 'kill').mockImplementation((pid: number, signal?: string | number) => {
      signals.push({ pid, signal, at: performance.now() })
      return true
    })
    return signals
  }

  const TIMEOUT_FOOTER = (timeoutMs: number) =>
    `[Command killed after ${timeoutMs}ms timeout — partial output above]`

  for (const closeAfterSigtermMs of [100, SHELL_TIMEOUT_CLEANUP_MS - 100]) {
    it(`R1-H1: a close delivered ${closeAfterSigtermMs}ms after SIGTERM with a group probe that never confirms absence settles within the cleanup budget and reports process_group_termination_failed`, async () => {
      useFakeClock()
      const child = hermeticChild()
      vi.mocked(spawn).mockImplementationOnce(() => child as never)
      const signals = groupThatNeverDisappears()
      const timeoutMs = 1_000
      let settledAt: number | undefined
      const execution = new ShellTool(workspacePath, timeoutMs, []).execute({
        command: 'hermetic command',
      })
      void execution.then(() => {
        settledAt = performance.now()
      })
      child.stdout.emit('data', Buffer.from('partial'))
      await vi.advanceTimersByTimeAsync(timeoutMs)
      const sigterm = signals.find(entry => entry.signal === 'SIGTERM')
      expect(sigterm).toMatchObject({ pid: -FAKE_PID })
      const terminationStartedAt = sigterm!.at

      await vi.advanceTimersByTimeAsync(closeAfterSigtermMs)
      expect(settledAt).toBeUndefined()
      child.signalCode = 'SIGTERM'
      child.emit('close', null)
      await vi.advanceTimersByTimeAsync(SHELL_TIMEOUT_CLEANUP_MS)

      expect(settledAt).toBeDefined()
      expect(settledAt! - terminationStartedAt).toBeLessThanOrEqual(SHELL_TIMEOUT_CLEANUP_MS)
      const result = await execution
      expect(result.is_error).toBe(true)
      expect(result.content).toBe(
        `stdout:\npartial\n\n${TIMEOUT_FOOTER(timeoutMs)}\n\n[process_group_termination_failed]`
      )
      // Witness: close verification ran and probed the group after close.
      const probesAfterClose = signals.filter(
        entry => entry.signal === 0 && entry.at >= terminationStartedAt + closeAfterSigtermMs
      )
      expect(probesAfterClose.length).toBeGreaterThan(0)
      expect(vi.getTimerCount()).toBe(0)
    })
  }

  it('R1-H1: a natural exit whose group never disappears and whose stdio never closes is bounded by the execution timeout plus the cleanup budget', async () => {
    useFakeClock()
    const child = hermeticChild()
    vi.mocked(spawn).mockImplementationOnce(() => child as never)
    const signals = groupThatNeverDisappears()
    const timeoutMs = 3 * SHELL_STDIO_DRAIN_MS + SHELL_STDIO_DRAIN_MS / 2
    const startedAt = performance.now()
    let settledAt: number | undefined
    const execution = new ShellTool(workspacePath, timeoutMs, []).execute({
      command: 'hermetic command',
    })
    void execution.then(() => {
      settledAt = performance.now()
    })
    child.stdout.emit('data', Buffer.from('natural output'))
    child.exitCode = 0
    child.emit('exit', 0, null)

    await vi.advanceTimersByTimeAsync(timeoutMs)
    // Witness: the drain poll probed the live group before the execution timeout.
    const drainProbes = signals.filter(
      entry => entry.signal === 0 && entry.at < startedAt + timeoutMs
    )
    expect(drainProbes).toHaveLength(3)
    expect(signals.filter(entry => entry.signal === 'SIGTERM')).toEqual([
      { pid: -FAKE_PID, signal: 'SIGTERM', at: startedAt + timeoutMs },
    ])

    await vi.advanceTimersByTimeAsync(SHELL_TIMEOUT_CLEANUP_MS - 1)
    expect(settledAt).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)

    expect(settledAt).toBe(startedAt + timeoutMs + SHELL_TIMEOUT_CLEANUP_MS)
    const result = await execution
    expect(result.is_error).toBe(true)
    expect(result.content).toBe(
      `${notice('timeout')}stdout:\nnatural output\n\n${TIMEOUT_FOOTER(timeoutMs)}\n\n[process_group_termination_failed]`
    )
    expect(heldWarnings()).toEqual([
      expect.objectContaining({ reason: 'timeout', processGroupTerminated: false }),
    ])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('R1-H1: a natural exit whose group probe always fails with EPERM is bounded by the execution timeout plus the cleanup budget', async () => {
    useFakeClock()
    const child = hermeticChild()
    vi.mocked(spawn).mockImplementationOnce(() => child as never)
    // EPERM means the group exists under another owner: never proof of absence.
    const signals: Array<{ pid: number; signal: unknown; at: number }> = []
    vi.spyOn(process, 'kill').mockImplementation((pid: number, signal?: string | number) => {
      signals.push({ pid, signal, at: performance.now() })
      if (signal === 0) throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' })
      return true
    })
    const timeoutMs = 3 * SHELL_STDIO_DRAIN_MS + SHELL_STDIO_DRAIN_MS / 2
    const startedAt = performance.now()
    let settledAt: number | undefined
    const execution = new ShellTool(workspacePath, timeoutMs, []).execute({
      command: 'hermetic command',
    })
    void execution.then(() => {
      settledAt = performance.now()
    })
    child.stdout.emit('data', Buffer.from('natural output'))
    child.exitCode = 0
    child.emit('exit', 0, null)

    await vi.advanceTimersByTimeAsync(timeoutMs)
    // Witness: the drain poll probed the group and got EPERM before the timeout.
    const drainProbes = signals.filter(
      entry => entry.signal === 0 && entry.at < startedAt + timeoutMs
    )
    expect(drainProbes).toHaveLength(3)
    expect(signals.filter(entry => entry.signal === 'SIGTERM')).toEqual([
      { pid: -FAKE_PID, signal: 'SIGTERM', at: startedAt + timeoutMs },
    ])

    await vi.advanceTimersByTimeAsync(SHELL_TIMEOUT_CLEANUP_MS - 1)
    expect(settledAt).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)

    expect(settledAt).toBe(startedAt + timeoutMs + SHELL_TIMEOUT_CLEANUP_MS)
    const result = await execution
    expect(result.is_error).toBe(true)
    expect(result.content).toBe(
      `${notice('timeout')}stdout:\nnatural output\n\n${TIMEOUT_FOOTER(timeoutMs)}\n\n[process_group_termination_failed]`
    )
    // EPERM is an expected probe answer, so it logs no probe-failure warning.
    expect(heldWarnings()).toEqual([
      expect.objectContaining({ reason: 'timeout', processGroupTerminated: false }),
    ])
    expect(JSON.stringify(warn.mock.calls)).not.toContain('probe failed')
    expect(vi.getTimerCount()).toBe(0)
  })
})
