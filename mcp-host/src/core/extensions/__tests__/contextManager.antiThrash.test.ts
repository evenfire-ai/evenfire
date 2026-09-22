/**
 * T1.4 — Anti-thrash goldens for `PressureContextManager`.
 *
 * Covers the 6 cases from `.specs/mcp-hermes/implementation-plans/T1.4-anti-thrashing.md` §8.1
 * plus the §8.3 Test A (defensive pending_approval guard does not mutate the
 * compaction counter).
 *
 * Fixtures rely on the heuristic token estimator (`heuristicCount`): ceil(chars/4)+4
 * per message (#731; it was floor(words×1.3)+4 before). We build deterministic
 * fixtures rather than mocking the estimator so the assertions exercise the real
 * wiring end-to-end.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Counter, register } from 'prom-client'
import { logger } from '../../../logger'
import { makeFakeConversation } from '../../conversation/__testing__/makeFakeConversation'
import { SimpleEventEmitter } from '../../orchestration/eventEmitter'
import {
  type AgentEvent,
  ChatMessage,
  type Conversation,
  ConversationState,
  type PendingApproval,
} from '../../types'
import {
  PressureContextManager,
  clerumCompactionRatio,
  clerumCompactionTotal,
} from '../contextManager'

const TINY = 'x' // 1 char → ceil(1/4)+4 = 5 tokens per message
const PAD_WORDS = 600 // big enough that 3 of them dominate the histogram

/**
 * Build a message array where the last `huge` turns carry almost all the
 * tokens. After a `truncate` (keep 3) the kept set is identical to the
 * last 3 turns, so the post/pre ratio is ≈ 1.0 (ineffective). Tier-driver:
 * the maxTokens budget is sized so even the post-compaction set still has
 * pressure ≥ 0.95 → truncate fires again on subsequent calls.
 */
function buildIneffectiveFixture(): ChatMessage[] {
  const padContent = Array.from({ length: PAD_WORDS }, () => 'lorem').join(' ')
  const msgs: ChatMessage[] = [{ role: 'system', content: 'sys' }]
  for (let i = 0; i < 17; i++) {
    msgs.push({ role: 'user', content: TINY })
    msgs.push({ role: 'assistant', content: TINY })
  }
  for (let i = 0; i < 3; i++) {
    msgs.push({ role: 'user', content: padContent })
    msgs.push({ role: 'assistant', content: padContent })
  }
  return msgs
}

/**
 * Effective fixture: 20 equal-size turns. Truncating to 3 keeps roughly
 * 3/20 ≈ 15% of tokens → ratio well under 0.9.
 */
function buildEffectiveFixture(): ChatMessage[] {
  const content = Array.from({ length: 50 }, () => 'lorem').join(' ')
  const msgs: ChatMessage[] = [{ role: 'system', content: 'sys' }]
  for (let i = 0; i < 20; i++) {
    msgs.push({ role: 'user', content })
    msgs.push({ role: 'assistant', content })
  }
  return msgs
}

const APPROVAL_FIXTURE: PendingApproval = {
  request_id: 'req',
  tool_name: 'shell_exec',
  parameters: {},
  description: 'pending',
  tool_call_id: 'tc',
  context_snapshot: [],
}

/** Snapshot a counter's labeled value (returns 0 when no series exists yet). */
async function counterValue(
  metric: Counter<string>,
  labels: Record<string, string>
): Promise<number> {
  const data = await metric.get()
  for (const v of data.values) {
    const matches = Object.entries(labels).every(([k, val]) => v.labels[k] === val)
    if (matches) return v.value
  }
  return 0
}

describe('PressureContextManager — T1.4 anti-thrash', () => {
  let conv: Conversation
  // Use a small budget so the ineffective fixture lands solidly above the
  // 95% truncate threshold even after one round of trimming.
  const truncateMaxTokens = 2_000

  beforeEach(() => {
    register.resetMetrics()
    conv = makeFakeConversation()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('§8.1 case 1: a single effective compaction does NOT count against ineffectiveCount', async () => {
    const manager = new PressureContextManager(2_500)
    const msgs = buildEffectiveFixture()
    await manager.manage(msgs, conv)
    expect(conv.compactionState).toBeDefined()
    expect(conv.compactionState!.ineffectiveCount).toBe(0)
    expect(conv.compactionState!.stoppedForTask).toBe(false)
    expect(conv.compactionState!.lastRatio).toBeLessThan(0.9)
    expect(await counterValue(clerumCompactionTotal, { outcome: 'thrashing' })).toBe(0)
  })

  it('§8.1 case 2: an effective call between ineffective calls resets ineffectiveCount', async () => {
    const manager = new PressureContextManager(truncateMaxTokens)
    let msgs = buildIneffectiveFixture()
    msgs = await manager.manage(msgs, conv)
    expect(conv.compactionState!.ineffectiveCount).toBe(1)

    // Feed an effective fixture (≈15% retention) to the same conversation.
    msgs = await manager.manage(buildEffectiveFixture(), conv)
    expect(conv.compactionState!.ineffectiveCount).toBe(0)
    expect(conv.compactionState!.stoppedForTask).toBe(false)
  })

  it('§8.1 case 3: two consecutive ineffective compactions keep stoppedForTask=false (lagged backoff)', async () => {
    const manager = new PressureContextManager(truncateMaxTokens)
    let msgs = buildIneffectiveFixture()
    msgs = await manager.manage(msgs, conv)
    expect(conv.compactionState!.ineffectiveCount).toBe(1)
    msgs = await manager.manage(msgs, conv)
    expect(conv.compactionState!.ineffectiveCount).toBe(2)
    // The 2nd compaction DID run — the backoff transitions on the next call.
    expect(conv.compactionState!.stoppedForTask).toBe(false)
    expect(conv.compactionState!.lastRatio).toBeGreaterThan(0.9)
  })

  it('§8.1 case 4: third invocation is no-op, emits compaction:thrashing exactly once, counter increments per post-backoff call', async () => {
    const events = new SimpleEventEmitter()
    const captured: AgentEvent[] = []
    events.on('compaction:thrashing', e => captured.push(e))
    const manager = new PressureContextManager(truncateMaxTokens, undefined, undefined, undefined, {
      events,
      taskId: 'task-A',
    })
    let msgs = buildIneffectiveFixture()
    const after1 = await manager.manage(msgs, conv)
    const after2 = await manager.manage(after1, conv)
    const beforeThird = after2
    const after3 = await manager.manage(beforeThird, conv)

    expect(conv.compactionState!.stoppedForTask).toBe(true)
    // No-op: the same reference is returned untouched.
    expect(after3).toBe(beforeThird)
    expect(captured).toHaveLength(1)
    expect(captured[0].data).toMatchObject({
      taskId: 'task-A',
      conversationId: conv.id,
      consecutiveCount: 2,
    })
    expect(typeof captured[0].data.lastRatio).toBe('number')
    // Counter increments per post-backoff invocation (1 so far).
    expect(await counterValue(clerumCompactionTotal, { outcome: 'thrashing' })).toBe(1)
  })

  it('T-E1 the backoff warns once through the service logger and keeps counting (#731)', async () => {
    // The backoff already emits a core event and a metric. Neither reaches the
    // pod log, and the pod log is what an operator reads when a conversation
    // stops being compacted — so the turn proceeded uncompacted with nothing
    // written down anywhere they would look (#731).
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const manager = new PressureContextManager(truncateMaxTokens, undefined, undefined, undefined, {
      taskId: 'task-E1',
    })
    let msgs = buildIneffectiveFixture()
    msgs = await manager.manage(msgs, conv)
    msgs = await manager.manage(msgs, conv)
    msgs = await manager.manage(msgs, conv) // backoff transition

    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        component: 'ContextManager',
        taskId: 'task-E1',
      }),
      'Compaction backoff: history cannot be shrunk; proceeding uncompacted'
    )
    // `component` is the field the Loki queries for this service filter on; the
    // `[ContextManager]` prefix it replaces carried it before the logger
    // migration. The conversation id is left out: on the email channel it
    // embeds the sender's address, and key-based redaction does not catch a
    // value. `taskId` above is the positive witness that the call was made
    // with its identifying fields.

    // The three numbers are asserted as numbers, not as `expect.any(Number)`,
    // which `NaN` satisfies - and a gauge reading `NaN` is the exact failure
    // #731 is about, so the assertion that says "we logged the state" has to
    // exclude it. Each bound comes from what the field means, not from the
    // implementation: `messageCount` is the length of the history the backoff
    // passed through untouched, `pressure` cleared a tier threshold or no tier
    // would have run, and `lastRatio` is a ratio.
    const [fields] = warnSpy.mock.calls[0] as [Record<string, unknown>, string]
    expect(fields).not.toHaveProperty('conversationId')
    expect(fields.messageCount).toBe(msgs.length)
    expect(fields.pressure).toBeGreaterThan(0.8)
    expect(fields.lastRatio).toBeGreaterThan(0)
    expect(fields.lastRatio).toBeLessThanOrEqual(1)

    for (let i = 0; i < 4; i++) {
      msgs = await manager.manage(msgs, conv)
    }
    // Liveness witness for the negative assertion that follows: the counter
    // proves the four extra calls ran and took the backoff path. Without it,
    // "still 1" would pass just as happily if `manage()` had never been called
    // again.
    expect(await counterValue(clerumCompactionTotal, { outcome: 'thrashing' })).toBe(5)
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })

  it('§8.1 case 5: backoff persists for the rest of the task; ratio histogram is not observed after backoff', async () => {
    const events = new SimpleEventEmitter()
    const captured: AgentEvent[] = []
    events.on('compaction:thrashing', e => captured.push(e))
    const manager = new PressureContextManager(truncateMaxTokens, undefined, undefined, undefined, {
      events,
    })
    let msgs = buildIneffectiveFixture()
    msgs = await manager.manage(msgs, conv) // ok
    msgs = await manager.manage(msgs, conv) // ok (lagged)
    msgs = await manager.manage(msgs, conv) // backoff transition
    expect(conv.compactionState!.stoppedForTask).toBe(true)

    const histogramBefore = await clerumCompactionRatio.get()
    const observationsBefore =
      histogramBefore.values.find(v => v.metricName?.endsWith('_count'))?.value ?? 0

    // Three more invocations — all no-op.
    for (let i = 0; i < 3; i++) {
      const prev = msgs
      msgs = await manager.manage(msgs, conv)
      expect(msgs).toBe(prev)
    }
    expect(await counterValue(clerumCompactionTotal, { outcome: 'thrashing' })).toBe(4)
    // Event still fired exactly once across all the post-backoff calls.
    expect(captured).toHaveLength(1)

    const histogramAfter = await clerumCompactionRatio.get()
    const observationsAfter =
      histogramAfter.values.find(v => v.metricName?.endsWith('_count'))?.value ?? 0
    expect(observationsAfter).toBe(observationsBefore) // no new observations
  })

  it('§8.1 case 6: terminal-result reset (compactionState cleared) lets the next task start fresh', async () => {
    const manager = new PressureContextManager(truncateMaxTokens)
    let msgs = buildIneffectiveFixture()
    msgs = await manager.manage(msgs, conv)
    msgs = await manager.manage(msgs, conv)
    msgs = await manager.manage(msgs, conv) // triggers backoff
    expect(conv.compactionState!.stoppedForTask).toBe(true)

    // Simulate `TaskExecutor.handleLoopResult` terminal path.
    conv.compactionState = undefined

    // A fresh effective compaction should now record state from scratch.
    await manager.manage(buildEffectiveFixture(), conv)
    expect(conv.compactionState).toBeDefined()
    expect(conv.compactionState!.ineffectiveCount).toBe(0)
    expect(conv.compactionState!.stoppedForTask).toBe(false)
  })

  it('§8.3 Test A: pending_approval defensive guard is a silent passthrough — does not touch compactionState or the counter', async () => {
    const manager = new PressureContextManager(truncateMaxTokens)
    const guardedConv = makeFakeConversation({
      state: ConversationState.AwaitingApproval,
      pending_approval: APPROVAL_FIXTURE,
    })
    const msgs = buildIneffectiveFixture()
    const result = await manager.manage(msgs, guardedConv)

    expect(result).toBe(msgs)
    expect(guardedConv.compactionState).toBeUndefined()
    // Defensive guard owns no metric — the loop owns `skipped:pending_approval`.
    expect(await counterValue(clerumCompactionTotal, { outcome: 'skipped:pending_approval' })).toBe(
      0
    )
    expect(await counterValue(clerumCompactionTotal, { outcome: 'ok' })).toBe(0)
    expect(await counterValue(clerumCompactionTotal, { outcome: 'thrashing' })).toBe(0)
  })
})
