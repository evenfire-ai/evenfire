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
 * J1 is the success route (this step). J2, the failure route, arrives in step 4
 * of the plan together with the error-taxonomy fix.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { type Counter, register } from 'prom-client'
import { hashCanonicalCodexRequest } from '@clerum/llm-provider-attempt-contract'
import { minifiedMcpResult } from '../../__tests__/fixtures/minifiedMcpResult'
import { makeFakeConversation } from '../../core/conversation/__testing__/makeFakeConversation'
import { PressureContextManager, clerumCompactionTotal } from '../../core/extensions/contextManager'
import { validateToolLinkages } from '../../core/orchestration/toolUseLoop'
import type { ChatMessage, ToolDefinition } from '../../core/types'
import { CodexSubscriptionProvider } from '../codexSubscription'

const requestHash = 'a'.repeat(64)

/**
 * The provider's dependencies, with `authorize` and `stream` as spies. Same
 * shape as the `deps()` helper in `codexSubscription.test.ts:21-47`; replicated
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
 * `turns` rounds of user → assistant (one tool call, small arguments) → tool
 * result carrying `bytesPerResult` of minified JSON.
 */
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

  it('J1 an MCP-heavy multi-turn history compacts and the contract accepts the request (#731)', async () => {
    const msgs = mcpHeavyHistory(32, 35_000)
    // Precondition, asserted rather than assumed: the uncompacted history is
    // already past the contract's 1 MiB ceiling, so a request built from it
    // cannot be accepted. Without this the rest of the test could pass on a
    // history that never needed compacting.
    expect(Buffer.byteLength(JSON.stringify(msgs), 'utf8')).toBeGreaterThan(1_048_576)

    const manager = new PressureContextManager(100000)
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
    expect(Buffer.byteLength(JSON.stringify(req), 'utf8')).toBeLessThanOrEqual(1_048_576)
    expect(hashCanonicalCodexRequest(req).ok).toBe(true)
  })
})
