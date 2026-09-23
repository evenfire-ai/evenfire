/**
 * #731 — the journey tests.
 *
 * These prove the route, not the destination: a long MCP-heavy conversation is
 * compacted by `PressureContextManager` and then dispatched through
 * `CodexSubscriptionProvider`, which hashes the canonical request and refuses it
 * when the attempt contract says it is too large. Every intermediate transition
 * is asserted — the tier that ran, the shape of the history that came out, and
 * the request the provider actually built — because a test that only asserts the
 * final state would pass just as happily if compaction never ran and the request
 * happened to fit.
 *
 * J1 is the success route: the history shrinks and the request is accepted. It
 * runs twice. Under the deployed configuration, pre-prune alone brings the
 * history under the threshold and no tier runs. With the kill switch
 * (`CLERUM_COMPACTION_PRE_PRUNE=false`), the truncate tier does the work.
 * J2 is the failure route: the history cannot shrink, the anti-thrash backoff
 * lets the turn proceed uncompacted, and the contract refuses it. The two
 * differ only in their fixture's shape, and the compaction counters are what
 * tell the two no-op-looking outcomes apart.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type Counter, register } from 'prom-client'
import { LIMITS, hashCanonicalCodexRequest } from '@clerum/llm-provider-attempt-contract'
import { minifiedMcpResult } from '../../__tests__/fixtures/minifiedMcpResult'
import { config as appConfig } from '../../config'
import { makeFakeConversation } from '../../core/conversation/__testing__/makeFakeConversation'
import { LlmErrorCode } from '../../core/errors'
import { PressureContextManager, clerumCompactionTotal } from '../../core/extensions/contextManager'
import { clerumPrePruneSavingsTokensTotal } from '../../core/extensions/prePrune'
import { SimpleEventEmitter } from '../../core/orchestration/eventEmitter'
import { validateToolLinkages } from '../../core/orchestration/toolUseLoop'
import type { AgentEvent, ChatMessage, ToolDefinition } from '../../core/types'
import { logger } from '../../logger'
import { CodexSubscriptionProvider } from '../codexSubscription'

const requestHash = 'a'.repeat(64)

/**
 * The provider's dependencies, with `authorize` and `stream` as spies. Same
 * shape as the `deps()` helper in `codexSubscription.test.ts`; replicated
 * here rather than exported from that file so neither test file constrains the
 * other's fixtures.
 */
function deps() {
  const authorize = vi.fn().mockResolvedValue({
    providerAttemptId: 'attempt-1',
    requestHash,
    executionTicket: 'ticket-123456',
    expiresAt: '2026-08-20T10:00:00.000Z',
  })
  const stream = vi.fn().mockResolvedValue({
    text: 'hello from proxy',
    toolCalls: [],
    outcome: 'success',
  })
  return {
    authorizer: { authorize },
    proxy: { stream },
    attemptContext: vi.fn(() => ({
      policyRevision: 1,
      policyHash: 'b'.repeat(64),
      hostRef: 'chatllm',
    })),
    authorize,
    stream,
  }
}

const TOOLS: ToolDefinition[] = [
  {
    name: 'crm_search_contacts',
    description: 'Search contacts that replied to a campaign.',
    parameters: { type: 'object', properties: { campaignId: { type: 'string' } } },
  },
]

/** Snapshot a counter's labeled value (0 when the series does not exist yet). */
async function counterValue(
  metric: Counter<string>,
  labels: Record<string, string>
): Promise<number> {
  const data = await metric.get()
  for (const v of data.values) {
    if (Object.entries(labels).every(([k, val]) => v.labels[k] === val)) return v.value
  }
  return 0
}

/**
 * The unshrinkable shape: a run of small exchanges followed by one MCP result
 * that is larger than the contract's whole budget.
 *
 * `truncate` keeps the last 3 non-system messages, so the cut removes the 34
 * small ones and keeps the payload that is the actual problem. The tier runs,
 * it does remove messages, and the ratio still lands above `ineffectiveRatio`
 * — which is what arms the anti-thrash backoff. A history of many equal-sized
 * turns (`mcpHeavyHistory`) cannot do this: truncating it is effective, which
 * is exactly why it is J1's fixture and not J2's.
 */
function unshrinkableHistory(finalResultBytes: number): ChatMessage[] {
  const msgs: ChatMessage[] = [{ role: 'system', content: 'You are a helpful assistant.' }]
  for (let i = 0; i < 17; i++) {
    msgs.push({ role: 'user', content: `step ${i}` })
    msgs.push({ role: 'assistant', content: 'ok' })
  }
  msgs.push({ role: 'user', content: 'Export every contact in the workspace.' })
  msgs.push({
    role: 'assistant',
    content: '',
    tool_calls: [
      { id: 'call_final', name: 'crm_search_contacts', arguments: { campaignId: '*', limit: 0 } },
    ],
  })
  msgs.push({
    role: 'tool',
    content: minifiedMcpResult(99, finalResultBytes),
    tool_call_id: 'call_final',
    name: 'crm_search_contacts',
  })
  return msgs
}

/**
 * `turns` rounds of user → assistant (one tool call, small arguments) → tool
 * result carrying `bytesPerResult` of minified JSON.
 */
/**
 * J1's history is sized from the contract: enough equal turns to pass the byte
 * cap by 10%. The result size stays fixed and the turn count grows with the
 * cap, so the protected tail (the last three turns) stays small and pre-prune
 * alone still brings pressure under the threshold.
 */
const J1_RESULT_BYTES = 35_000
const J1_TURNS = Math.ceil((LIMITS.maxRequestBodyBytes * 1.1) / J1_RESULT_BYTES)
/**
 * J1's window sits between the two estimates of that history: the byte-based
 * count fills it about 2.3 times, the word-based count #731 replaced about 0.55
 * times. With a 100K window both overrun it and pre-prune runs either way, so
 * J1 could not tell a regressed tokenizer from the fixed one.
 */
const J1_CONTEXT_WINDOW_TOKENS = 1_000_000

function mcpHeavyHistory(turns: number, bytesPerResult: number): ChatMessage[] {
  const msgs: ChatMessage[] = [{ role: 'system', content: 'You are a helpful assistant.' }]
  for (let turn = 1; turn <= turns; turn++) {
    msgs.push({ role: 'user', content: `Find the contacts that replied in campaign ${turn}.` })
    msgs.push({
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: `call_${turn}`,
          name: 'crm_search_contacts',
          arguments: { campaignId: `camp_${turn}`, limit: 60 },
        },
      ],
    })
    msgs.push({
      role: 'tool',
      content: minifiedMcpResult(turn, bytesPerResult),
      tool_call_id: `call_${turn}`,
      name: 'crm_search_contacts',
    })
  }
  return msgs
}

describe('#731 context-overrun journey', () => {
  beforeEach(() => {
    register.resetMetrics()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('J1 deployed config: pre-prune alone shrinks an MCP-heavy history and the contract accepts the request (#731)', async () => {
    const msgs = mcpHeavyHistory(J1_TURNS, J1_RESULT_BYTES)
    const inputBytes = Buffer.byteLength(JSON.stringify(msgs), 'utf8')
    expect(inputBytes).toBeGreaterThan(LIMITS.maxRequestBodyBytes)

    // Built the way `taskExecutor` builds it: pre-prune on or off, and its
    // options, come from the deployed configuration.
    const manager = new PressureContextManager(
      J1_CONTEXT_WINDOW_TOKENS,
      undefined,
      undefined,
      undefined,
      {
        prePruneEnabled: appConfig.compactionPrePruneEnabled,
        prePruneOptions: {
          protectedTailTurns: appConfig.compactionPrePruneProtectedTailTurns,
          summaryThresholdTokens: appConfig.compactionPrePruneSummaryTokens,
          maxArgsBytes: appConfig.compactionPrePruneMaxArgsBytes,
          dedupEnabled: appConfig.compactionPrePruneDedup,
          oneLineSummariesEnabled: appConfig.compactionPrePruneOneLine,
          jsonSafeTruncateEnabled: appConfig.compactionPrePruneJsonTruncate,
          stripMediaEnabled: appConfig.compactionPrePruneStripMedia,
        },
      }
    )
    const wired = deps()
    const provider = new CodexSubscriptionProvider('gpt-5.3-codex', wired as never)

    const managed = await manager.manage(msgs, makeFakeConversation())

    // Route: pre-prune ran and saved tokens (the witness), and no tier ran.
    expect(await counterValue(clerumPrePruneSavingsTokensTotal, {})).toBeGreaterThan(0)
    const tierRuns = (await clerumCompactionTotal.get()).values.reduce((n, v) => n + v.value, 0)
    expect(tierRuns).toBe(0)

    // State: at least halved in bytes, linkages intact.
    expect(Buffer.byteLength(JSON.stringify(managed), 'utf8')).toBeLessThan(inputBytes / 2)
    expect(() => validateToolLinkages(managed)).not.toThrow()

    await provider.completeSingleTurnWithTools(managed, TOOLS)

    expect(wired.authorize).toHaveBeenCalledTimes(1)
    const req = wired.authorize.mock.calls[0][0].request
    expect(Buffer.byteLength(JSON.stringify(req), 'utf8')).toBeLessThanOrEqual(
      LIMITS.maxRequestBodyBytes
    )
    expect(hashCanonicalCodexRequest(req).ok).toBe(true)
  })

  it('J1 kill switch (CLERUM_COMPACTION_PRE_PRUNE=false): the truncate tier compacts and the contract accepts the request (#731)', async () => {
    const msgs = mcpHeavyHistory(J1_TURNS, J1_RESULT_BYTES)
    // Precondition, asserted rather than assumed: the uncompacted history is
    // already past the contract's byte ceiling, so a request built from it
    // cannot be accepted. Without this the rest of the test could pass on a
    // history that never needed compacting.
    expect(Buffer.byteLength(JSON.stringify(msgs), 'utf8')).toBeGreaterThan(
      LIMITS.maxRequestBodyBytes
    )

    const manager = new PressureContextManager(100000, undefined, undefined, undefined, {
      prePruneEnabled: false,
    })
    const conversation = makeFakeConversation()
    const wired = deps()
    const provider = new CodexSubscriptionProvider('gpt-5.3-codex', wired as never)

    const managed = await manager.manage(msgs, conversation)

    // Route: the emergency tier ran, and the backoff did not — those are the two
    // paths that can return a shorter or an unchanged array respectively, and
    // only one of them is this journey.
    expect(await counterValue(clerumCompactionTotal, { tier: 'truncate', outcome: 'ok' })).toBe(1)
    expect(
      await counterValue(clerumCompactionTotal, { tier: 'truncate', outcome: 'thrashing' })
    ).toBe(0)

    // State: shorter history, linkages intact.
    expect(managed.length).toBeLessThan(msgs.length)
    expect(() => validateToolLinkages(managed)).not.toThrow()

    await provider.completeSingleTurnWithTools(managed, TOOLS)

    // Business signal: the provider got far enough to authorize, and what it
    // built is a request the contract accepts and would hash.
    expect(wired.authorize).toHaveBeenCalledTimes(1)
    const req = wired.authorize.mock.calls[0][0].request
    expect(Buffer.byteLength(JSON.stringify(req), 'utf8')).toBeLessThanOrEqual(
      LIMITS.maxRequestBodyBytes
    )
    expect(hashCanonicalCodexRequest(req).ok).toBe(true)
  })

  it('J2 a single long agentic turn reaches backoff and is refused as ContextLengthExceeded (#731)', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const events = new SimpleEventEmitter()
    const captured: AgentEvent[] = []
    events.on('compaction:thrashing', e => captured.push(e))
    // The backoff state lives on the conversation object; built here and never
    // shared, so this journey cannot inherit a run from another test.
    const conversation = makeFakeConversation()
    const manager = new PressureContextManager(100000, undefined, undefined, undefined, {
      ineffectiveRatio: 0.9,
      ineffectiveMaxRun: 2,
      events,
      taskId: 'task-J2',
    })
    const wired = deps()
    const provider = new CodexSubscriptionProvider('gpt-5.3-codex', wired as never)

    // The final result alone passes the byte cap by 10%, whatever its value.
    const first = await manager.manage(
      unshrinkableHistory(Math.ceil(LIMITS.maxRequestBodyBytes * 1.1)),
      conversation
    )
    const second = await manager.manage(first, conversation)
    const third = await manager.manage(second, conversation)

    // Route: the tier ran twice and was ineffective both times, then the third
    // call took the backoff. The two counters separate the paths — `ok` means
    // a tier produced a result, `thrashing` means it declined to.
    expect(await counterValue(clerumCompactionTotal, { tier: 'truncate', outcome: 'ok' })).toBe(2)
    expect(
      await counterValue(clerumCompactionTotal, { tier: 'truncate', outcome: 'thrashing' })
    ).toBe(1)
    expect(captured).toHaveLength(1)
    expect(captured[0].data).toMatchObject({ taskId: 'task-J2', consecutiveCount: 2 })
    // The operator-facing half of the same transition: the event goes to the
    // bus, this goes to the pod log. The thrashing counter above is the
    // liveness witness that makes "exactly once" mean something here (#731).
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 'task-J2' }),
      'Compaction backoff: history cannot be shrunk; proceeding uncompacted'
    )

    // State: the backoff returns its input untouched. That unchanged array is
    // the one legitimate no-op in this system, which is why J1 pins
    // `thrashing` to 0 and this test pins it to 1 — the same shape, told apart
    // by the counter rather than by inspection.
    expect(third).toBe(second)
    expect(() => validateToolLinkages(third)).not.toThrow()
    // Precondition for the refusal below, asserted rather than assumed.
    expect(Buffer.byteLength(JSON.stringify(third), 'utf8')).toBeGreaterThan(
      LIMITS.maxRequestBodyBytes
    )

    // Business signal: the turn proceeds and the contract refuses it by name.
    const rejected = provider.completeSingleTurnWithTools(third, TOOLS)
    await expect(rejected).rejects.toMatchObject({
      code: 'request_limit_exceeded',
      message: 'request exceeds maxRequestBodyBytes',
    })
    expect(wired.authorize).not.toHaveBeenCalled()

    const err = await rejected.catch((e: unknown) => e)
    // What the user is shown depends on this: `ContextLengthExceeded` reads as
    // "Conversation Too Long", while the `invalid_request` returned before #731
    // reached the UI as "Connection Error", a label that reads as transient and
    // invites a retry that reproduces the same failure.
    expect(provider.classifyError(err)).toMatchObject({
      code: LlmErrorCode.ContextLengthExceeded,
      retryable: false,
    })
  })
})
