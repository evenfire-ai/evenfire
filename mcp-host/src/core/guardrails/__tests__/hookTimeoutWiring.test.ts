import { describe, expect, it } from 'vitest'
import type { ToolCompletionRequest } from '../../types'
import type { FetchLike } from '../hooks/hookFetcher'
import type { HookDescriptor } from '../hooks/types'
import { buildLlmLaneHooks } from '../llm/llmLaneHooks'
import { buildToolLaneGuardrail } from '../tool/toolLaneAdapter'

/**
 * `limits.maxHookTimeoutMs` is an admin-settable Host field (host.yaml, default
 * 5000) that reached nothing: the CRD accepted it while `createHookFetcher` always
 * fell back to its own 5000ms, even though the two sibling caps
 * (maxHookOutputBytes / maxHookRewriteBytes) were wired through the same call.
 *
 * Asserted behaviourally rather than by spying on the wiring: the fetcher puts
 * `AbortSignal.timeout(timeoutMs)` on the request, so a fake transport can watch
 * WHEN that signal fires. A configured 25ms aborts almost immediately; the 5000ms
 * default does not fire inside the same window. A "did we call X with Y" assertion
 * would pass even if the value were dropped one layer further down.
 */

const CONFIGURED_MS = 25
/** Long enough for a 25ms signal to fire, far short of the 5000ms default. */
const OBSERVE_MS = 300

function descriptor(points: HookDescriptor['lifecyclePoints']): HookDescriptor {
  return {
    id: 'hook-1',
    endpoint: 'http://hook.llm-hooks.svc.cluster.local:8080',
    path: '/',
    lifecyclePoints: points,
    capabilities: [],
    failMode: 'open',
    order: 100,
  }
}

/** Resolves to the ms until the request's signal aborted, or null if it never did. */
function signalWatcher(): { fetchImpl: FetchLike; aborted: Promise<boolean> } {
  let settle: (v: boolean) => void = () => {}
  const aborted = new Promise<boolean>(r => {
    settle = r
  })
  const fetchImpl: FetchLike = async (_url, init) => {
    const signal = init?.signal
    if (!signal) {
      settle(false)
    } else if (signal.aborted) {
      settle(true)
    } else {
      signal.addEventListener('abort', () => settle(true))
      setTimeout(() => settle(false), OBSERVE_MS)
    }
    // Never resolve the body: the only thing under test is the deadline.
    return new Promise(() => {}) as unknown as Response
  }
  return { fetchImpl, aborted }
}

const request = { messages: [{ role: 'user', content: 'hi' }] } as ToolCompletionRequest

describe('limits.maxHookTimeoutMs reaches the hook transport', () => {
  it('LLM lane: a configured deadline aborts the dial', async () => {
    const { fetchImpl, aborted } = signalWatcher()
    const hooks = buildLlmLaneHooks([descriptor(['pre_call'])], {
      getAuthToken: () => 't',
      fetchImpl,
      timeoutMs: CONFIGURED_MS,
    })
    void hooks.preCall[0].preCall(request)

    expect(await aborted).toBe(true)
  })

  it('LLM lane: without one, the dial is still pending at the same point', async () => {
    const { fetchImpl, aborted } = signalWatcher()
    const hooks = buildLlmLaneHooks([descriptor(['pre_call'])], {
      getAuthToken: () => 't',
      fetchImpl,
    })
    void hooks.preCall[0].preCall(request)

    // Proves the previous assertion came from CONFIGURED_MS, not from something
    // that aborts every dial regardless.
    expect(await aborted).toBe(false)
  })

  it('tool lane: the admin deadline applies there too', async () => {
    const { fetchImpl, aborted } = signalWatcher()
    const guardrail = buildToolLaneGuardrail(
      {
        hookDescriptors: [descriptor(['pre_tool_use'])],
        limits: { maxHookTimeoutMs: CONFIGURED_MS },
      },
      { getAuthToken: () => 't', fetchImpl }
    )
    void guardrail!.decide({ provenance: 'native', name: 'shell' }, {})

    expect(await aborted).toBe(true)
  })

  it('tool lane: an explicit dep still wins over the admin limit', async () => {
    const { fetchImpl, aborted } = signalWatcher()
    const guardrail = buildToolLaneGuardrail(
      {
        hookDescriptors: [descriptor(['pre_tool_use'])],
        limits: { maxHookTimeoutMs: 60_000 },
      },
      { getAuthToken: () => 't', fetchImpl, timeoutMs: CONFIGURED_MS }
    )
    void guardrail!.decide({ provenance: 'native', name: 'shell' }, {})

    expect(await aborted).toBe(true)
  })
})
