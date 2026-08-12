/**
 * RemoteToolHook `/v1` pre_tool_use mapping (spec §6.2/§8.1): capability
 * enforcement (F4) + fail-posture (§8.6).
 */
import { describe, expect, it } from 'vitest'
import type { ToolIdentity } from '../../tool/provenance'
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
