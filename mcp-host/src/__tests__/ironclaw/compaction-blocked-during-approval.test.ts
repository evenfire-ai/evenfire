/**
 * IronClaw invariant #1 golden (P.3 §6.1): compaction is bypassed while the
 * conversation has a pending_approval.
 *
 * The plan calls this out as the regression most likely to slip in
 * silently — someone refactors the loop, the guard ends up on the wrong
 * side of an `if`, and the snapshot survives but the live messages get
 * mutated. This test fails fast on that refactor.
 */
import { describe, expect, it, vi } from 'vitest'
import { makeFakeConversation } from '../../core/conversation/__testing__/makeFakeConversation'
import { PressureContextManager } from '../../core/extensions/contextManager'
import type { ReasoningPort, Tool, ToolRegistry } from '../../core/interfaces'
import { SimpleEventEmitter } from '../../core/orchestration/eventEmitter'
import { buildLoopConfig } from '../../core/orchestration/loopConfig'
import { runToolUseLoop } from '../../core/orchestration/toolUseLoop'
import { BasicSafety } from '../../core/safety/safety'
import type { AgentEvent, ChatMessage, RespondResult } from '../../core/types'
import type { ProgressReporter } from '../../progress/types.js'

function fakeReasoning(): ReasoningPort {
  const result: RespondResult = { type: 'text', content: 'final answer' }
  return {
    respondWithTools: vi.fn(async () => result),
    continueWithToolResults: vi.fn(async () => result),
  }
}

function emptyRegistry(): ToolRegistry {
  return {
    get: () => null as unknown as Tool,
    listDefinitions: () => [],
    register: vi.fn(),
  }
}

function fillerMessages(count: number): ChatMessage[] {
  // Each message ~200 chars → 50 tokens at the 4 chars/token estimator. With
  // count=20 we exceed the 200-token cap defined below to ensure manage()
  // would otherwise have plenty to compact.
  const msgs: ChatMessage[] = []
  for (let i = 0; i < count; i++) {
    msgs.push({ role: 'user', content: `q${i} ` + 'lorem ipsum dolor sit amet '.repeat(8) })
    msgs.push({ role: 'assistant', content: `a${i} ` + 'lorem ipsum dolor sit amet '.repeat(8) })
  }
  return msgs
}

describe('IronClaw invariant #1: non-compactable while pending approval', () => {
  it('skips manage() and emits compaction:skipped when skipContextManager=true', async () => {
    const ctxManager = new PressureContextManager(200) // tiny budget
    const manageSpy = vi.spyOn(ctxManager, 'manage')
    const events = new SimpleEventEmitter()
    const seen: AgentEvent[] = []
    events.on('compaction:skipped', e => seen.push(e))
    events.on('context:compacted', e => seen.push(e))

    const config = buildLoopConfig({
      reasoning: fakeReasoning(),
      toolRegistry: emptyRegistry(),
      safety: new BasicSafety(),
      events,
      conversation: makeFakeConversation(),
      contextManager: ctxManager,
      progressReporter: undefined as unknown as ProgressReporter,
    })
    config.skipContextManager = true

    const result = await runToolUseLoop(config, fillerMessages(20))

    expect(result.type).toBe('response')
    expect(manageSpy).not.toHaveBeenCalled()
    const skipped = seen.filter(e => e.type === 'compaction:skipped')
    expect(skipped.length).toBeGreaterThanOrEqual(1)
    expect(skipped[0].data).toMatchObject({
      reason: 'pending_approval',
      phase: 'pre_llm',
    })
    // No `context:compacted` events when guard is on.
    expect(seen.some(e => e.type === 'context:compacted')).toBe(false)
  })

  it('runs manage() normally when skipContextManager is omitted (baseline)', async () => {
    const ctxManager = new PressureContextManager(200)
    const manageSpy = vi.spyOn(ctxManager, 'manage')
    const events = new SimpleEventEmitter()

    const config = buildLoopConfig({
      reasoning: fakeReasoning(),
      toolRegistry: emptyRegistry(),
      safety: new BasicSafety(),
      events,
      conversation: makeFakeConversation(),
      contextManager: ctxManager,
    })
    // skipContextManager omitted (defaults to falsy)

    const result = await runToolUseLoop(config, fillerMessages(20))

    expect(result.type).toBe('response')
    expect(manageSpy).toHaveBeenCalled()
  })
})
