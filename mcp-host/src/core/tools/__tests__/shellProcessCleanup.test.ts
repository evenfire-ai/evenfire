import { afterEach, describe, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { ShellTool } from '../shell'

vi.mock('child_process', () => ({ spawn: vi.fn() }))
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})
describe('ShellTool process-group cleanup', () => {
  it('terminates remaining group members before clearing escalation on leader close', async () => {
    vi.useFakeTimers()
    // Hermetic child/process-group model: no subprocess or signal is sent.
    const child = Object.assign(new EventEmitter(), {
      pid: 424242,
      killed: false,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(),
    })
    vi.mocked(spawn).mockReturnValue(child as any)
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true)
    const pending = new ShellTool('/tmp', 100, []).execute({ command: 'test command' })
    child.stdout.write('partial output')
    await vi.advanceTimersByTimeAsync(100)
    expect(kill).toHaveBeenCalledWith(-424242, 'SIGTERM')
    child.emit('close', null)
    const result = await pending
    expect(kill).toHaveBeenCalledWith(-424242, 'SIGKILL')
    expect(result.content).toContain('partial output')
    expect(vi.getTimerCount()).toBe(0)
    child.stdout.destroy()
    child.stderr.destroy()
  })
})
