import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Tool } from './core/interfaces'
import { executeSingleTool } from './core/orchestration/toolUseLoopSingleTool'
import type { ToolOutput } from './core/types'

const KEY = 'CLERUM_TOOL_PROGRESS_INTERVAL_MS'
const MESSAGE =
  'CLERUM_TOOL_PROGRESS_INTERVAL_MS must be 0 (disables tool progress streaming) or an integer from 1000 to 2147483647 (inclusive)'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.resetModules()
})

async function intervalFor(value: string | undefined): Promise<number> {
  vi.resetModules()
  vi.stubEnv(KEY, value)
  const { config } = await import('./config')
  return config.nativeTool.toolProgressInterval
}

async function startupErrorFor(value: string): Promise<unknown> {
  vi.resetModules()
  vi.stubEnv(KEY, value)
  return import('./config').then(
    () => undefined,
    (error: unknown) => error
  )
}

/**
 * Runs one progress-capable tool call through executeSingleTool, the consumer
 * of the interval, for 1500 ms of fake time and counts the snapshots.
 */
async function snapshotsWithInterval(toolProgressInterval: number) {
  vi.useFakeTimers()
  const reporter = {
    reportToolStart: vi.fn(),
    reportToolComplete: vi.fn(),
    reportToolProgress: vi.fn(),
    reportThinking: vi.fn(),
    reportLlmInProgress: vi.fn(),
  }
  let finish!: (output: ToolOutput) => void
  const tool: Tool = {
    name: () => 'shell_exec',
    description: () => 'progress-capable tool',
    parametersSchema: () => ({ type: 'object', properties: {} }),
    execute: (_params, context) =>
      new Promise<ToolOutput>(resolve => {
        finish = resolve
        context?.onOutput('line one\n')
      }),
    requiresSanitization: () => false,
    requiresApproval: () => false,
    supportsProgressOutput: () => true,
  }
  const config = {
    toolRegistry: { get: () => tool },
    toolOutputProcessor: {
      beforeExecution: () => ({ is_valid: true, errors: [] }),
      afterExecution: (_name: string, output: ToolOutput) => output.content,
    },
    safety: {
      sanitizeOutput: (_name: string, output: string) => ({
        content: output,
        was_modified: false,
        warnings: [],
      }),
    },
    events: { emit: () => {} },
    toolTimeout: 60_000,
    toolProgressInterval,
    progressReporter: reporter,
  } as unknown as Parameters<typeof executeSingleTool>[1]
  const pending = executeSingleTool(
    { id: 'call-1', name: 'shell_exec', arguments: { command: 'x' } },
    config
  )
  await vi.advanceTimersByTimeAsync(1_500)
  finish({ content: 'done', is_error: false, duration_ms: 1 })
  const result = await pending
  vi.useRealTimers()
  return {
    snapshots: reporter.reportToolProgress.mock.calls.length,
    result,
  }
}

describe('CLERUM_TOOL_PROGRESS_INTERVAL_MS (#1028 P2)', () => {
  it('P2-a: unset keeps 30000, 0 disables periodic snapshots through executeSingleTool, and 1000 produces one', async () => {
    expect(await intervalFor(undefined)).toBe(30_000)

    const enabled = await intervalFor('1000')
    expect(enabled).toBe(1_000)
    const enabledRun = await snapshotsWithInterval(enabled)
    // Witness: the same consumer publishes a snapshot at the 1000 ms interval.
    expect(enabledRun.snapshots).toBe(1)
    expect(enabledRun.result).toMatchObject({ is_error: false, content: 'done' })

    const disabled = await intervalFor('0')
    expect(disabled).toBe(0)
    const disabledRun = await snapshotsWithInterval(disabled)
    expect(disabledRun.snapshots).toBe(0)
    // The call itself still completes with the tool's output.
    expect(disabledRun.result).toMatchObject({ is_error: false, content: 'done' })
  })

  it('P2-b: malformed and sub-second values stop startup with the exact message and do not echo the value', async () => {
    // Witness: the same import succeeds with a valid value first.
    expect(await intervalFor('1000')).toBe(1_000)

    const rejected = [
      '',
      ' 1000',
      '1000 ',
      '+1000',
      '-1',
      '1.5',
      '1e4',
      '10s',
      'abc',
      '1',
      '999',
      '0x3e8',
      'Infinity',
    ]
    for (const value of rejected) {
      const error = await startupErrorFor(value)
      expect(error, `value ${JSON.stringify(value)}`).toBeInstanceOf(Error)
      // Exact equality: the message is fixed and carries no part of the value.
      expect((error as Error).message, `value ${JSON.stringify(value)}`).toBe(MESSAGE)
    }
  }, 30_000)

  it('P2-c: 1000 and 2147483647 are accepted inclusively, 0001000 reads as 1000, and 2147483648 is rejected', async () => {
    expect(await intervalFor('1000')).toBe(1_000)
    expect(await intervalFor('2147483647')).toBe(2_147_483_647)
    expect(await intervalFor('0001000')).toBe(1_000)

    const error = await startupErrorFor('2147483648')
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe(MESSAGE)
  })
})
