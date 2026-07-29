import { describe, expect, it } from 'vitest'
import {
  type ContextBreakdown,
  type Conversation,
  ConversationState,
  type Turn,
} from '../../core/types'
import {
  decodeSessionsCursor,
  paginateSessionSummaries,
  projectContextBreakdown,
  projectMessageWindowBounds,
  projectSessionTokens,
  projectTurnTokens,
  projectTurnToolSteps,
} from '../wireProjections'

describe('session pagination projections', () => {
  it('rejects malformed and invalid-date cursors', () => {
    expect(decodeSessionsCursor('not-base64-json')).toBeNull()
    const invalidDate = Buffer.from(
      JSON.stringify({ updatedAt: 'not-a-date', key: 'session-1' })
    ).toString('base64url')
    expect(decodeSessionsCursor(invalidDate)).toBeNull()
  })

  it('rejects legacy and cross-scope cursors', () => {
    const legacy = Buffer.from(
      JSON.stringify({ updatedAt: '2026-01-03T00:00:00.000Z', key: 'a' })
    ).toString('base64url')
    expect(decodeSessionsCursor(legacy)).toBeNull()

    const scoped = paginateSessionSummaries(
      [
        { key: 'a', lastActivityAt: new Date('2026-01-03T00:00:00Z') },
        { key: 'b', lastActivityAt: new Date('2026-01-02T00:00:00Z') },
      ],
      1,
      key => key,
      'scope-a'
    ).nextCursor
    expect(decodeSessionsCursor(scoped, 'scope-a')).not.toBeNull()
    expect(decodeSessionsCursor(scoped, 'scope-b')).toBeNull()
  })

  it('returns a cursor only when another summary page exists', () => {
    const entries = [
      { key: 'a', lastActivityAt: new Date('2026-01-03T00:00:00Z') },
      { key: 'b', lastActivityAt: new Date('2026-01-02T00:00:00Z') },
    ]
    const result = paginateSessionSummaries(entries, 1)
    expect(result.page).toEqual([entries[0]])
    expect(decodeSessionsCursor(result.nextCursor)).toEqual({
      version: 1,
      scope: 'unscoped',
      updatedAt: '2026-01-03T00:00:00.000Z',
      key: 'a',
    })
    expect(paginateSessionSummaries(entries, 2).nextCursor).toBeUndefined()
    expect(paginateSessionSummaries(entries, undefined)).toEqual({ page: entries })
  })

  it('projects bounded message-window navigation consistently', () => {
    expect(
      projectMessageWindowBounds(
        [{ number: 3 }, { number: 4 }],
        { firstTurnNumber: 1, lastTurnNumber: 6 },
        {}
      )
    ).toEqual({
      oldestTurnNumber: 3,
      latestTurnNumber: 4,
      hasMoreBefore: true,
      hasMoreAfter: true,
    })
  })

  it('reports closed boundaries and empty windows without false pagination affordances', () => {
    expect(
      projectMessageWindowBounds(
        [{ number: 1 }, { number: 6 }],
        { firstTurnNumber: 1, lastTurnNumber: 6 },
        {}
      )
    ).toEqual({
      oldestTurnNumber: 1,
      latestTurnNumber: 6,
      hasMoreBefore: false,
      hasMoreAfter: false,
    })
    expect(projectMessageWindowBounds([], {}, {})).toEqual({
      oldestTurnNumber: undefined,
      latestTurnNumber: undefined,
      hasMoreBefore: false,
      hasMoreAfter: false,
    })
  })
})

function makeConversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: 'conv-1',
    user_id: 'u-1',
    state: ConversationState.Idle,
    turns: [],
    auto_approved_tools: new Set(),
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  }
}

describe('projectSessionTokens', () => {
  it('returns undefined when the session has had no LLM call (all token fields absent)', () => {
    expect(projectSessionTokens(makeConversation())).toBeUndefined()
  })

  it('returns undefined when every token field is explicitly 0 (and no cache reported)', () => {
    const conv = makeConversation({
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
    })
    expect(projectSessionTokens(conv)).toBeUndefined()
  })

  it('emits input/output only when the provider does not report cache (OpenAI-style)', () => {
    const conv = makeConversation({
      input_tokens: 100,
      output_tokens: 40,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      cacheTokensReported: false,
    })
    expect(projectSessionTokens(conv)).toEqual({ input: 100, output: 40 })
  })

  it('includes the cache breakdown when the model reports cache (Anthropic-style), even at 0', () => {
    const conv = makeConversation({
      input_tokens: 200,
      output_tokens: 80,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      cacheTokensReported: true,
    })
    expect(projectSessionTokens(conv)).toEqual({
      input: 200,
      output: 80,
      cacheRead: 0,
      cacheWrite: 0,
    })
  })

  it('reports non-zero cache figures when present', () => {
    const conv = makeConversation({
      input_tokens: 150,
      output_tokens: 60,
      cache_read_tokens: 13,
      cache_write_tokens: 5,
      cacheTokensReported: true,
    })
    expect(projectSessionTokens(conv)).toEqual({
      input: 150,
      output: 60,
      cacheRead: 13,
      cacheWrite: 5,
    })
  })

  it('emits tokens for an output-only session (input still 0)', () => {
    const conv = makeConversation({ input_tokens: 0, output_tokens: 7 })
    expect(projectSessionTokens(conv)).toEqual({ input: 0, output: 7 })
  })
})

describe('projectContextBreakdown (F1.5)', () => {
  const breakdown: ContextBreakdown = {
    buckets: { messages: 100, systemTools: 30, metaContext: 10, systemPrompt: 5 },
    totalInputTokens: 32900,
    maxTokens: 100000,
    capturedAtTurn: 3,
  }

  it('returns undefined when the session has no snapshot yet', () => {
    expect(projectContextBreakdown(makeConversation())).toBeUndefined()
  })

  it('computes fillRatio and copies buckets/total/maxTokens/capturedAtTurn', () => {
    const wire = projectContextBreakdown(makeConversation({ contextBreakdown: breakdown }))
    expect(wire).toBeDefined()
    expect(wire!.buckets).toEqual(breakdown.buckets)
    expect(wire!.totalInputTokens).toBe(32900)
    expect(wire!.maxTokens).toBe(100000)
    expect(wire!.fillRatio).toBeCloseTo(0.329, 5)
    expect(wire!.capturedAtTurn).toBe(3)
  })

  it('fillRatio is 0 when maxTokens is 0 (no divide-by-zero)', () => {
    const wire = projectContextBreakdown(
      makeConversation({ contextBreakdown: { ...breakdown, maxTokens: 0 } })
    )
    expect(wire!.fillRatio).toBe(0)
  })

  it('omits cacheHitRate when the provider does not report cache (#11)', () => {
    const wire = projectContextBreakdown(
      makeConversation({
        contextBreakdown: breakdown,
        cacheTokensReported: false,
        cache_read_tokens: 0,
        input_tokens: 1000,
      })
    )
    expect(wire).not.toHaveProperty('cacheHitRate')
  })

  it('computes cacheHitRate = cache_read / (cache_read + input) only when reported (#11)', () => {
    const wire = projectContextBreakdown(
      makeConversation({
        contextBreakdown: breakdown,
        cacheTokensReported: true,
        cache_read_tokens: 300,
        input_tokens: 700,
      })
    )
    expect(wire!.cacheHitRate).toBeCloseTo(0.3, 5)
  })

  it('omits cacheHitRate when reported but there is no usage yet (denom=0)', () => {
    const wire = projectContextBreakdown(
      makeConversation({
        contextBreakdown: breakdown,
        cacheTokensReported: true,
        cache_read_tokens: 0,
        input_tokens: 0,
      })
    )
    expect(wire!.cacheHitRate).toBeUndefined()
    expect(wire).not.toHaveProperty('cacheHitRate')
  })
})

function makeTurn(overrides: Partial<Turn> = {}): Turn {
  return { number: 1, user_input: 'hi', tool_calls: [], started_at: new Date(), ...overrides }
}

describe('projectTurnTokens', () => {
  it('returns undefined for a turn with no recorded usage', () => {
    expect(projectTurnTokens(makeTurn())).toBeUndefined()
  })

  it('emits input/output only when the turn has no cache fields (OpenAI-style)', () => {
    // cache_* undefined → not reported
    const turn = makeTurn({ input_tokens: 100, output_tokens: 40 })
    expect(projectTurnTokens(turn)).toEqual({ input: 100, output: 40 })
  })

  it('includes the cache breakdown when the turn has cache defined (Anthropic-style), even at 0', () => {
    const turn = makeTurn({
      input_tokens: 200,
      output_tokens: 80,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
    })
    expect(projectTurnTokens(turn)).toEqual({
      input: 200,
      output: 80,
      cacheRead: 0,
      cacheWrite: 0,
    })
  })

  it('reports non-zero per-turn cache figures', () => {
    const turn = makeTurn({
      input_tokens: 130,
      output_tokens: 50,
      cache_read_tokens: 10,
      cache_write_tokens: 0,
    })
    expect(projectTurnTokens(turn)).toEqual({
      input: 130,
      output: 50,
      cacheRead: 10,
      cacheWrite: 0,
    })
  })
})

describe('projectTurnToolSteps (#582)', () => {
  // Identity redactor for the non-security assertions; the redaction wiring is
  // exercised by the dedicated "redacts" test below and lives in main.ts.
  const passthrough = (_toolName: string, raw: string) => raw

  it('returns undefined when the turn made no tool calls', () => {
    expect(projectTurnToolSteps(makeTurn(), passthrough)).toBeUndefined()
  })

  it('projects completed tool calls with a server-derived displayName and duration', () => {
    const turn = makeTurn({
      tool_calls: [
        {
          name: 'web-research__fetch_page',
          parameters: { url: 'x' },
          result: 'ok',
          duration_ms: 40123,
        },
      ],
    })
    const steps = projectTurnToolSteps(turn, passthrough)
    expect(steps).toHaveLength(1)
    expect(steps![0]).toMatchObject({
      toolName: 'web-research__fetch_page',
      state: 'completed',
      durationMs: 40123,
    })
    expect(typeof steps![0]!.displayName).toBe('string')
    expect(steps![0]!.displayName.length).toBeGreaterThan(0)
  })

  it('marks a tool call with an error as state="error" and carries the redacted errorSummary', () => {
    const turn = makeTurn({
      tool_calls: [{ name: 'shell_exec', parameters: {}, error: 'exit code 1' }],
    })
    const steps = projectTurnToolSteps(turn, passthrough)
    expect(steps![0]).toMatchObject({ state: 'error', errorSummary: 'exit code 1' })
  })

  it('routes the persisted error through the redactor before the wire (P1-1)', () => {
    const turn = makeTurn({
      tool_calls: [{ name: 'http_request', parameters: {}, error: 'failed: token=sk-SECRET123' }],
    })
    // Simulate the main.ts redactor scrubbing a secret value.
    const redact = (_t: string, raw: string) => raw.replace('sk-SECRET123', '[REDACTED]')
    const steps = projectTurnToolSteps(turn, redact)
    expect(steps![0]!.errorSummary).toBe('failed: token=[REDACTED]')
    expect(JSON.stringify(steps)).not.toContain('sk-SECRET123')
  })

  it('omits errorSummary when the redactor returns empty', () => {
    const turn = makeTurn({
      tool_calls: [{ name: 'shell_exec', parameters: {}, error: 'noise' }],
    })
    const steps = projectTurnToolSteps(turn, () => '')
    expect(steps![0]!.state).toBe('error')
    expect(steps![0]!).not.toHaveProperty('errorSummary')
  })

  it('never leaks raw arguments or tool output to the wire', () => {
    const turn = makeTurn({
      tool_calls: [
        { name: 'http_request', parameters: { secret: 'TOPSECRET' }, result: 'SENSITIVE_BODY' },
      ],
    })
    const json = JSON.stringify(projectTurnToolSteps(turn, passthrough))
    expect(json).not.toContain('TOPSECRET')
    expect(json).not.toContain('SENSITIVE_BODY')
    expect(json).not.toContain('parameters')
  })
})
