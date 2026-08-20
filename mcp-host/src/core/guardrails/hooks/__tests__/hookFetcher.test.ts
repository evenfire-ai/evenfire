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

describe('point-aware response caps (§8.1)', () => {
  // ~ (chars+10) byte JSON body, valid so pre_call parses when under its cap.
  const bigFetch = (chars: number): FetchLike => {
    const body = JSON.stringify({ pad: 'x'.repeat(chars) })
    return vi.fn(async () => ({ status: 200, text: async () => body }))
  }
  const caps = (fetchImpl: FetchLike) =>
    createHookFetcher({
      getAuthToken: () => 't',
      fetchImpl,
      maxOutputBytes: 100,
      maxRewriteBytes: 1000,
    })

  it('pre_call: a large rewrite UNDER the generous rewrite cap is applied (not oversized)', async () => {
    const f = caps(bigFetch(500))
    const out = await f({ point: 'pre_call', descriptor: base, body: {} })
    expect(out.unavailable).toBe(false)
    expect(out.oversized).toBeFalsy()
    expect(out.body).toBeDefined()
  })

  it('moderate: the SAME body exceeds the tight response cap → oversized + unavailable', async () => {
    const f = caps(bigFetch(500))
    const out = await f({
      point: 'moderate',
      descriptor: { ...base, lifecyclePoints: ['moderate'] },
      body: {},
    })
    expect(out.unavailable).toBe(true)
    expect(out.oversized).toBe(true)
  })

  it('pre_call: over EVEN the rewrite cap → oversized + unavailable', async () => {
    const f = caps(bigFetch(2000))
    const out = await f({ point: 'pre_call', descriptor: base, body: {} })
    expect(out.unavailable).toBe(true)
    expect(out.oversized).toBe(true)
  })
})
