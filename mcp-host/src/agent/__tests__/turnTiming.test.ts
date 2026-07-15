import { describe, expect, it } from 'vitest'
import { TurnTimingRecorder } from '../turnTiming'

describe('TurnTimingRecorder', () => {
  it('accumulates phases and emits one machine-parseable [TurnTiming] line', () => {
    const t0 = 1_000_000
    const recorder = new TurnTimingRecorder(new Date(t0 - 250), t0)
    recorder.addSessionLoadMs(40)
    recorder.addSessionLoadMs(10)
    recorder.addPromptAssemblyMs(120)
    recorder.setInputCharsApprox(45_000)
    recorder.recordEvent('llm:completed', { iteration: 0, durationMs: 3_000 })
    recorder.recordEvent('llm:completed', { iteration: 1, durationMs: 2_000 })
    recorder.recordEvent('tool:called', { toolName: 'clerum__get_capabilities' })
    recorder.recordEvent('tool:completed', {
      toolName: 'clerum__get_capabilities',
      duration_ms: 500,
    })

    const lines: string[] = []
    recorder.emit('task-123', line => lines.push(line))

    expect(lines).toHaveLength(1)
    expect(lines[0].startsWith('[TurnTiming] ')).toBe(true)
    const payload = JSON.parse(lines[0].slice('[TurnTiming] '.length))
    expect(payload).toMatchObject({
      taskId: 'task-123',
      queue_wait_ms: 250,
      session_load_ms: 50,
      prompt_assembly_ms: 120,
      llm_wall_ms: 5000,
      llm_calls: 2,
      tool_loop_ms: 500,
      tools_called: 1,
      input_chars_approx: 45000,
    })
    expect(payload.total_ms).toBeGreaterThanOrEqual(250)
  })

  it('is fail-safe: malformed events, bad math inputs, and a throwing logger never throw', () => {
    const recorder = new TurnTimingRecorder(undefined)
    expect(() => {
      recorder.recordEvent('llm:completed', null)
      recorder.recordEvent('tool:completed', { duration_ms: 'not-a-number' })
      recorder.recordEvent('unknown:event', 42)
      recorder.addSessionLoadMs(Number.NaN)
      recorder.addPromptAssemblyMs(-5)
      recorder.setInputCharsApprox(Number.POSITIVE_INFINITY)
    }).not.toThrow()

    expect(() =>
      recorder.emit('task-x', () => {
        throw new Error('logger boom')
      })
    ).not.toThrow()

    const lines: string[] = []
    recorder.emit('task-x', line => lines.push(line))
    const payload = JSON.parse(lines[0].slice('[TurnTiming] '.length))
    // The malformed llm:completed still counts as a call; its duration clamps to 0.
    expect(payload.llm_calls).toBe(1)
    expect(payload.llm_wall_ms).toBe(0)
    expect(payload.tool_loop_ms).toBe(0)
    expect(payload.queue_wait_ms).toBe(0)
    expect(payload.session_load_ms).toBe(0)
    expect(payload.prompt_assembly_ms).toBe(0)
    expect(payload.input_chars_approx).toBe(0)
  })
})
