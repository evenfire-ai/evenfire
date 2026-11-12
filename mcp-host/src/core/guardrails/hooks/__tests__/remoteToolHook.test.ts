/**
 * RemoteToolHook `/v1` pre_tool_use mapping (spec §6.2/§8.1): capability
 * enforcement (F4) + fail-posture (§8.6).
 */
import { describe, expect, it } from 'vitest'
import type { ToolIdentity } from '../../tool/provenance'
import { HookBreakerRegistry } from '../hookBreaker'
import { RemoteToolHook } from '../remoteToolHook'
import type { HookDescriptor, HookFetcher, HookHttpResult } from '../types'

const desc = (over: Partial<HookDescriptor> = {}): HookDescriptor => ({
  id: 'th',
  endpoint: 'http://svc',
  path: '/',
  lifecyclePoints: ['pre_tool_use'],
  capabilities: [],
  failMode: 'closed',
  order: 100,
  ...over,
})

const fetcher =
  (result: HookHttpResult): HookFetcher =>
  async () =>
    result
const id: ToolIdentity = { provenance: 'native', name: 'run_command' }

describe('RemoteToolHook.preToolUse', () => {
  it('deny + may_deny → deny', async () => {
    const h = new RemoteToolHook(
      desc({ capabilities: ['may_deny'] }),
      fetcher({
        status: 200,
        body: { decision: 'deny', reasonCode: 'blocked' },
        unavailable: false,
      })
    )
    const c = await h.preToolUse(id, {})
    expect(c?.decision).toBe('deny')
    expect(c?.reasonCode).toBe('blocked')
  })

  it('deny WITHOUT may_deny → no_decision (F4)', async () => {
    const h = new RemoteToolHook(
      desc({ capabilities: [] }),
      fetcher({ status: 200, body: { decision: 'deny' }, unavailable: false })
    )
    expect((await h.preToolUse(id, {}))?.decision).toBe('no_decision')
  })

  it('updatedInput + may_rewrite → rewrite', async () => {
    const h = new RemoteToolHook(
      desc({ capabilities: ['may_rewrite'] }),
      fetcher({ status: 200, body: { updatedInput: { command: ['ls'] } }, unavailable: false })
    )
    const c = await h.preToolUse(id, { command: ['rm', '-rf', '/'] })
    expect(c?.rewrite).toEqual({ command: ['ls'] })
  })

  it('updatedInput WITHOUT may_rewrite → dropped (F4)', async () => {
    const h = new RemoteToolHook(
      desc({ capabilities: [] }),
      fetcher({ status: 200, body: { updatedInput: { command: ['ls'] } }, unavailable: false })
    )
    expect(await h.preToolUse(id, {})).toBeNull()
  })

  it('unavailable + closed + may_deny → deny hook_unavailable (§8.6)', async () => {
    const h = new RemoteToolHook(
      desc({ capabilities: ['may_deny'], failMode: 'closed' }),
      fetcher({ status: 0, body: undefined, unavailable: true })
    )
    expect((await h.preToolUse(id, {}))?.reasonCode).toBe('hook_unavailable')
  })

  it('a point the hook does not subscribe to → null', async () => {
    const h = new RemoteToolHook(
      desc({ lifecyclePoints: ['moderate'] }),
      fetcher({ status: 200, body: { decision: 'deny' }, unavailable: false })
    )
    expect(await h.preToolUse(id, {})).toBeNull()
  })
})

describe('RemoteToolHook.postToolUse', () => {
  const result = { content: 'secret=abc123', isError: false }

  it('updatedResult + may_rewrite → redacted content (is_error preserved)', async () => {
    const h = new RemoteToolHook(
      desc({ lifecyclePoints: ['post_tool_use'], capabilities: ['may_rewrite'] }),
      fetcher({
        status: 200,
        body: { updatedResult: { content: 'secret=[redacted]' } },
        unavailable: false,
      })
    )
    const v = await h.postToolUse(id, {}, result)
    expect(v).toEqual({ content: 'secret=[redacted]', isError: false })
  })

  it('is_error is authoritative — a hook cannot flip it', async () => {
    const h = new RemoteToolHook(
      desc({ lifecyclePoints: ['post_tool_use'], capabilities: ['may_rewrite'] }),
      fetcher({
        status: 200,
        body: { updatedResult: { content: 'x', is_error: true } },
        unavailable: false,
      })
    )
    const v = await h.postToolUse(id, {}, { content: 'ok', isError: false })
    expect(v?.isError).toBe(false)
  })

  it('WITHOUT may_rewrite → no redaction (F4)', async () => {
    const h = new RemoteToolHook(
      desc({ lifecyclePoints: ['post_tool_use'], capabilities: [] }),
      fetcher({ status: 200, body: { updatedResult: { content: 'x' } }, unavailable: false })
    )
    expect(await h.postToolUse(id, {}, result)).toBeNull()
  })

  it('fail-closed + unavailable + may_rewrite → withhold content (§8.6)', async () => {
    const h = new RemoteToolHook(
      desc({
        lifecyclePoints: ['post_tool_use'],
        capabilities: ['may_rewrite'],
        failMode: 'closed',
      }),
      fetcher({ status: 0, body: undefined, unavailable: true })
    )
    const v = await h.postToolUse(id, {}, result)
    expect(v?.content).not.toContain('abc123')
  })

  it('fail-open + unavailable → no redaction (original passes through)', async () => {
    const h = new RemoteToolHook(
      desc({ lifecyclePoints: ['post_tool_use'], capabilities: ['may_rewrite'], failMode: 'open' }),
      fetcher({ status: 0, body: undefined, unavailable: true })
    )
    expect(await h.postToolUse(id, {}, result)).toBeNull()
  })

  it('not subscribed to post_tool_use → null', async () => {
    const h = new RemoteToolHook(
      desc({ lifecyclePoints: ['pre_tool_use'], capabilities: ['may_rewrite'] }),
      fetcher({ status: 200, body: { updatedResult: { content: 'x' } }, unavailable: false })
    )
    expect(await h.postToolUse(id, {}, result)).toBeNull()
  })
})

/** A fetcher that counts its dials and returns whatever `getResult` yields. */
function countingFetcher(getResult: () => HookHttpResult) {
  let calls = 0
  const fetch: HookFetcher = async () => {
    calls += 1
    return getResult()
  }
  return { fetch, calls: () => calls }
}

const ok: HookHttpResult = { status: 200, body: {}, unavailable: false }
const unavailable: HookHttpResult = { status: 0, body: undefined, unavailable: true }
const toolResult = { content: 'secret=abc123', isError: false }

describe('quarantine (§8.2) — tool lane matches the LLM lane', () => {
  it('quarantined may_deny + fail-closed pre_tool_use → deny hook_unavailable, never dialed', async () => {
    const cf = countingFetcher(() => ok)
    const h = new RemoteToolHook(
      desc({ capabilities: ['may_deny'], failMode: 'closed', quarantined: true }),
      cf.fetch
    )
    const c = await h.preToolUse(id, {})
    expect(c?.decision).toBe('deny')
    expect(c?.reasonCode).toBe('hook_unavailable')
    expect(cf.calls()).toBe(0)
  })

  it('quarantined advisory pre_tool_use → no contribution, never dialed', async () => {
    const cf = countingFetcher(() => ({
      status: 200,
      body: { updatedInput: { command: ['ls'] } },
      unavailable: false,
    }))
    const h = new RemoteToolHook(
      desc({ capabilities: ['may_rewrite'], failMode: 'open', quarantined: true }),
      cf.fetch
    )
    expect(await h.preToolUse(id, { command: ['pwd'] })).toBeNull()
    expect(cf.calls()).toBe(0)
  })

  it('quarantined fail-closed post_tool_use redactor → withholds content, never dialed', async () => {
    const cf = countingFetcher(() => ok)
    const h = new RemoteToolHook(
      desc({
        lifecyclePoints: ['post_tool_use'],
        capabilities: ['may_rewrite'],
        failMode: 'closed',
        quarantined: true,
      }),
      cf.fetch
    )
    const v = await h.postToolUse(id, {}, toolResult)
    expect(v?.content).not.toContain('abc123')
    expect(v?.isError).toBe(false)
    expect(cf.calls()).toBe(0)
  })

  it('quarantined fail-open post_tool_use → no change, never dialed', async () => {
    const cf = countingFetcher(() => ({
      status: 200,
      body: { updatedResult: { content: 'x' } },
      unavailable: false,
    }))
    const h = new RemoteToolHook(
      desc({
        lifecyclePoints: ['post_tool_use'],
        capabilities: ['may_rewrite'],
        failMode: 'open',
        quarantined: true,
      }),
      cf.fetch
    )
    expect(await h.postToolUse(id, {}, toolResult)).toBeNull()
    expect(cf.calls()).toBe(0)
  })
})

describe('circuit breaker (§8.6) — tool lane', () => {
  const advisory = (over: Partial<HookDescriptor> = {}): HookDescriptor =>
    desc({
      capabilities: ['may_rewrite'],
      failMode: 'open',
      lifecyclePoints: ['pre_tool_use', 'post_tool_use'],
      onUnavailable: { mode: 'breaker', failureThreshold: 2, cooldownMs: 1000 },
      ...over,
    })

  it('advisory breaker-mode hook trips and stops dialing during cooldown', async () => {
    const reg = new HookBreakerRegistry()
    const cf = countingFetcher(() => unavailable)
    const h = new RemoteToolHook(advisory(), cf.fetch, reg, () => 0)
    expect(await h.preToolUse(id, {})).toBeNull()
    expect(await h.postToolUse(id, {}, toolResult)).toBeNull()
    expect(cf.calls()).toBe(2) // tripped
    expect(await h.preToolUse(id, {})).toBeNull()
    expect(await h.postToolUse(id, {}, toolResult)).toBeNull()
    expect(cf.calls()).toBe(2) // short-circuited
  })

  it('re-probes after cooldown and closes on success', async () => {
    const reg = new HookBreakerRegistry()
    let t = 0
    let healthy = false
    const cf = countingFetcher(() => (healthy ? ok : unavailable))
    const h = new RemoteToolHook(advisory(), cf.fetch, reg, () => t)
    await h.preToolUse(id, {})
    await h.preToolUse(id, {})
    await h.preToolUse(id, {}) // open → no dial
    expect(cf.calls()).toBe(2)
    t = 1000
    healthy = true
    await h.preToolUse(id, {})
    await h.preToolUse(id, {})
    expect(cf.calls()).toBe(4)
  })

  it('may_deny hook ignores breaker mode — always dials and fails closed', async () => {
    const reg = new HookBreakerRegistry()
    const cf = countingFetcher(() => unavailable)
    const h = new RemoteToolHook(
      advisory({ capabilities: ['may_deny'], failMode: 'closed' }),
      cf.fetch,
      reg,
      () => 0
    )
    for (let i = 0; i < 5; i++) {
      expect((await h.preToolUse(id, {}))?.decision).toBe('deny')
    }
    expect(cf.calls()).toBe(5)
  })

  it('strict mode never trips', async () => {
    const reg = new HookBreakerRegistry()
    const cf = countingFetcher(() => unavailable)
    const h = new RemoteToolHook(
      advisory({ onUnavailable: { mode: 'strict', failureThreshold: 2, cooldownMs: 1000 } }),
      cf.fetch,
      reg,
      () => 0
    )
    for (let i = 0; i < 5; i++) await h.preToolUse(id, {})
    expect(cf.calls()).toBe(5)
  })
})
