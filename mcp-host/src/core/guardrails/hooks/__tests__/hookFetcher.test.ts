/**
 * Hook fetcher transport routing (spec §8.1/§8.3): in-cluster targets use the
 * plain transport; `external` (remote) targets use the SSRF-guarded transport.
 */
import { describe, expect, it, vi } from 'vitest'
import { type FetchLike, createHookFetcher } from '../hookFetcher'
import type { HookDescriptor } from '../types'

const base: HookDescriptor = {
  id: 'h',
  endpoint: 'http://svc.llm-hooks.svc.cluster.local:8080',
  path: '/',
  lifecyclePoints: ['pre_call'],
  capabilities: [],
  failMode: 'closed',
  order: 100,
}

function okFetch(): FetchLike {
  return vi.fn(async () => ({ status: 200, text: async () => '{"ok":true}' }))
}

describe('createHookFetcher transport routing', () => {
  it('dials an in-cluster (non-external) target with the plain transport', async () => {
    const inCluster = okFetch()
    const external = okFetch()
    const fetch = createHookFetcher({
      getAuthToken: () => 't',
      fetchImpl: inCluster,
      externalFetchImpl: external,
    })
    const res = await fetch({ point: 'pre_call', descriptor: base, body: {} })
    expect(res.status).toBe(200)
    expect(inCluster).toHaveBeenCalledTimes(1)
    expect(external).not.toHaveBeenCalled()
  })

  it('dials a remote (external) target with the SSRF-guarded transport', async () => {
    const inCluster = okFetch()
    const external = okFetch()
    const fetch = createHookFetcher({
      getAuthToken: () => 't',
      fetchImpl: inCluster,
      externalFetchImpl: external,
    })
    const descriptor: HookDescriptor = {
      ...base,
      endpoint: 'https://guardrails.aporia.com',
      external: true,
    }
    await fetch({ point: 'pre_call', descriptor, body: {} })
    expect(external).toHaveBeenCalledTimes(1)
    expect(inCluster).not.toHaveBeenCalled()
  })

  it('maps an SSRF refusal (transport throws) to unavailable → fail-mode', async () => {
    const external: FetchLike = vi.fn(async () => {
      throw new Error('Domain resolves to private IP (10.0.0.5)')
    })
    const fetch = createHookFetcher({ getAuthToken: () => 't', externalFetchImpl: external })
    const descriptor: HookDescriptor = { ...base, endpoint: 'https://evil.example', external: true }
    const res = await fetch({ point: 'pre_call', descriptor, body: {} })
    expect(res.unavailable).toBe(true)
    expect(res.status).toBe(0)
  })
})
