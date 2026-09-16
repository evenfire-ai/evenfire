import { afterEach, describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'
import type { Tool } from '../../interfaces'
import { ShellTool } from '../../tools/shell'
import { executeWithTimeout } from '../toolExecutionTimeout'

const context = { onOutput: () => {} }
function tool(overrides: Partial<Tool> = {}): Tool {
  return {
    name: () => 'test',
    description: () => '',
    parametersSchema: () => ({}),
    requiresApproval: () => false,
    requiresSanitization: () => true,
    execute: vi.fn(async () => ({ content: 'done', is_error: false, duration_ms: 0 })),
    ...overrides,
  }
}
afterEach(() => vi.useRealTimers())
describe('tool execution deadline', () => {
  it('clears deadline timers when execution succeeds', async () => {
    vi.useFakeTimers()
    await expect(executeWithTimeout(tool(), {}, context, 100)).resolves.toMatchObject({
      content: 'done',
    })
    expect(vi.getTimerCount()).toBe(0)
  })
  it('stops an uncooperative ordinary tool at the execution deadline', async () => {
    vi.useFakeTimers()
    // Intentionally never settles to exercise the outer deadline.
    const pending = executeWithTimeout(
      tool({ execute: () => new Promise(() => {}) }),
      {},
      context,
      100
    ).catch(error => error)
    await vi.advanceTimersByTimeAsync(100)
    expect((await pending).code).toBe('TOOL_TIMEOUT')
    expect(vi.getTimerCount()).toBe(0)
  })
  it('allows bounded cleanup after abort but never an unlimited wait', async () => {
    vi.useFakeTimers()
    let signal: AbortSignal | undefined
    const pending = executeWithTimeout(
      tool({
        timeoutCleanupMs: () => 20,
        execute: async (_, ctx) => {
          signal = ctx?.signal
          return new Promise(() => {})
        },
      }),
      {},
      context,
      100
    ).catch(error => error)
    await vi.advanceTimersByTimeAsync(100)
    expect(signal?.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(20)
    expect((await pending).code).toBe('TOOL_TIMEOUT')
    expect(vi.getTimerCount()).toBe(0)
  })
  it('propagates task cancellation before the tool deadline', async () => {
    vi.useFakeTimers()
    const parent = new AbortController()
    const pending = executeWithTimeout(
      tool({
        execute: async (_, ctx) =>
          new Promise((_, reject) => {
            ctx!.signal!.addEventListener('abort', () => reject(ctx!.signal!.reason), {
              once: true,
            })
          }),
      }),
      {},
      context,
      1000,
      parent.signal
    ).catch(error => error)
    const reason = new Error('task deadline')
    parent.abort(reason)
    expect(await pending).toBe(reason)
    expect(vi.getTimerCount()).toBe(0)
  })
  it.each([-1, NaN, Infinity, 2_147_483_647])(
    'rejects invalid cleanup allowance %s before execution',
    async cleanup => {
      const t = tool({ timeoutCleanupMs: () => cleanup })
      await expect(executeWithTimeout(t, {}, context, 100)).rejects.toThrow('Invalid tool')
      expect(t.execute).not.toHaveBeenCalled()
    }
  )
  it('preserves partial shell output when both deadlines are equal', async () => {
    const shell = new ShellTool(tmpdir(), 100, ['PATH'])
    const result = await executeWithTimeout(
      shell,
      { command: 'printf partial; sleep 60' },
      context,
      100
    )
    expect(result.is_error).toBe(true)
    expect(result.content).toContain('partial')
    expect(result.content).toContain('100ms timeout')
  })
  it('uses the shorter caller deadline with progress reporting disabled', async () => {
    const shell = new ShellTool(tmpdir(), 60000, ['PATH'])
    const result = await executeWithTimeout(
      shell,
      { command: 'printf partial; sleep 60' },
      context,
      100
    )
    expect(result.content).toContain('100ms timeout')
    expect(result.duration_ms).toBeLessThan(6100)
  })
})
