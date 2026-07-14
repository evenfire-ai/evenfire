import { describe, expect, it } from 'vitest'
import { __test__normalizeHostStatusPayload as normalize } from '../mcpHostRestService.js'

const baseUpstream = {
  agent: {
    state: 'idle',
    currentTaskId: null,
    tasksProcessed: 0,
    tasksSucceeded: 0,
    tasksFailed: 0,
    uptime: 1,
  },
  queue: { pending: 0, processing: 0, completed: 0, failed: 0 },
  cronJobs: 0,
}

describe('normalizeHostStatusPayload — mcpServers passthrough', () => {
  it('returns undefined mcpServers when upstream omits the field (old mcp-host)', () => {
    const out = normalize('h1', { ...baseUpstream })
    expect(out).not.toBeNull()
    expect(out!.mcpServers).toBeUndefined()
  })

  it('normalizes a well-formed row verbatim', () => {
    const row = {
      name: 'mcp-coingecko-remote',
      state: 'failed',
      expected: true,
      toolCount: 0,
      reason: 'auth_failed',
      message: 'initialize returned 401',
      observedAt: '2026-04-21T18:00:00.000Z',
    }
    const out = normalize('h1', { ...baseUpstream, mcpServers: [row] })
    expect(out!.mcpServers).toEqual([row])
  })

  it("coerces unknown state strings to 'unknown'", () => {
    const out = normalize('h1', {
      ...baseUpstream,
      mcpServers: [
        {
          name: 'x',
          state: 'exploding',
          expected: true,
          toolCount: 0,
          reason: null,
          message: null,
          observedAt: '2026-04-21T18:00:00.000Z',
        },
      ],
    })
    expect(out!.mcpServers![0].state).toBe('unknown')
  })

  it("coerces unknown reason strings to 'unknown' when state !== connected", () => {
    const out = normalize('h1', {
      ...baseUpstream,
      mcpServers: [
        {
          name: 'x',
          state: 'failed',
          expected: true,
          toolCount: 0,
          reason: 'martian_intervention',
          message: 'what',
          observedAt: '2026-04-21T18:00:00.000Z',
        },
      ],
    })
    expect(out!.mcpServers![0].reason).toBe('unknown')
  })

  it('preserves null reason (connected row, no failure)', () => {
    const out = normalize('h1', {
      ...baseUpstream,
      mcpServers: [
        {
          name: 'x',
          state: 'connected',
          expected: true,
          toolCount: 3,
          reason: null,
          message: null,
          observedAt: '2026-04-21T18:00:00.000Z',
        },
      ],
    })
    expect(out!.mcpServers![0].reason).toBeNull()
  })

  it('drops rows that are missing `name`', () => {
    const out = normalize('h1', {
      ...baseUpstream,
      mcpServers: [
        { state: 'connected' }, // no name
        {
          name: 'ok',
          state: 'connected',
          expected: true,
          toolCount: 1,
          reason: null,
          message: null,
          observedAt: '2026-04-21T18:00:00.000Z',
        },
      ],
    })
    expect(out!.mcpServers).toHaveLength(1)
    expect(out!.mcpServers![0].name).toBe('ok')
  })

  it('returns undefined mcpServers when the field is non-array garbage', () => {
    const out = normalize('h1', { ...baseUpstream, mcpServers: 'no' })
    expect(out!.mcpServers).toBeUndefined()
  })

  it('clamps toolCount to non-negative integer', () => {
    const out = normalize('h1', {
      ...baseUpstream,
      mcpServers: [
        {
          name: 'x',
          state: 'connected',
          expected: true,
          toolCount: -5,
          reason: null,
          message: null,
          observedAt: '2026-04-21T18:00:00.000Z',
        },
      ],
    })
    expect(out!.mcpServers![0].toolCount).toBe(0)
  })

  it('still returns a valid HostRuntimeStatus shape for existing fields', () => {
    const out = normalize('h1', baseUpstream)!
    expect(out.hostRef).toBe('h1')
    expect(out.agent.state).toBe('idle')
    expect(out.queue.pending).toBe(0)
    expect(out.cronJobs).toBe(0)
    expect(typeof out.observedAt).toBe('string')
  })
})

describe('normalizeHostStatusPayload — degraded passthrough', () => {
  it('omits degraded when upstream omits it', () => {
    const out = normalize('h1', baseUpstream)!
    expect(out.degraded).toBeUndefined()
  })

  it('passes degraded:null through verbatim', () => {
    const out = normalize('h1', { ...baseUpstream, degraded: null })!
    expect(out.degraded).toBeNull()
  })

  it('forwards a well-formed llm_key_missing payload', () => {
    const out = normalize('h1', {
      ...baseUpstream,
      degraded: {
        reason: 'llm_key_missing',
        message: 'LLM API key is missing or the referenced Secret is empty.',
      },
    })!
    expect(out.degraded).toEqual({
      reason: 'llm_key_missing',
      message: 'LLM API key is missing or the referenced Secret is empty.',
    })
  })

  it('drops unknown reasons (forward-compat / forces narrow contract)', () => {
    const out = normalize('h1', {
      ...baseUpstream,
      degraded: { reason: 'something_else', message: '...' },
    })!
    expect(out.degraded).toBeUndefined()
  })

  it('falls back to a default message when missing/blank', () => {
    const out = normalize('h1', {
      ...baseUpstream,
      degraded: { reason: 'llm_key_missing' },
    })!
    expect(out.degraded?.reason).toBe('llm_key_missing')
    expect(out.degraded?.message).toBeTruthy()
  })
})
