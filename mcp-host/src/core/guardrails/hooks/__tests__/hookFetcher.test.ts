/**
 * HookFetcher transport tests (spec §8.1 wire contract): URL building, auth
 * header, and outcome classification (5xx / timeout / malformed / oversized →
 * unavailable; 2xx/4xx returned for the mapping).
 */
import { describe, expect, it, vi } from 'vitest'
import { type FetchLike, buildHookUrl, createHookFetcher } from '../hookFetcher'
import type { HookDescriptor } from '../types'

const desc: HookDescriptor = {
  id: 'h',
  endpoint: 'http://hook-server.llm-hooks.svc/',
  path: '/pii-redact',
  lifecyclePoints: ['moderate'],
  capabilities: [],
  failMode: 'closed',
  order: 100,
}

const okResponse = (
  status: number,
  text: string
): { status: number; text: () => Promise<string> } => ({
  status,
  text: async () => text,
})

describe('buildHookUrl', () => {
  it('normalizes slashes → {endpoint}{path}/v1/{point}', () => {
    expect(buildHookUrl('http://svc/', '/pii-redact', 'moderate')).toBe(
      'http://svc/pii-redact/v1/moderate'
    )
    expect(buildHookUrl('http://svc', '/', 'pre_call')).toBe('http://svc/v1/pre_call')
    expect(buildHookUrl('http://svc', '', 'on_error')).toBe('http://svc/v1/on_error')
  })
})

describe('createHookFetcher', () => {
  it('POSTs with bearer auth to the built URL and parses JSON', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => okResponse(200, '{"action":"continue"}'))
    const fetcher = createHookFetcher({ getAuthToken: () => 'tok', fetchImpl })
    const r = await fetcher({ point: 'moderate', descriptor: desc, body: { a: 1 } })
    expect(r).toEqual({ status: 200, body: { action: 'continue' }, unavailable: false })
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('http://hook-server.llm-hooks.svc/pii-redact/v1/moderate')
    expect(init.headers.Authorization).toBe('Bearer tok')
    expect(init.method).toBe('POST')
  })

  it('5xx → unavailable', async () => {
    const fetcher = createHookFetcher({
      getAuthToken: () => 't',
      fetchImpl: async () => okResponse(503, ''),
    })
    expect((await fetcher({ point: 'moderate', descriptor: desc, body: {} })).unavailable).toBe(
      true
    )
  })

  it('4xx is NOT unavailable (mapping classifies it)', async () => {
    const fetcher = createHookFetcher({
      getAuthToken: () => 't',
      fetchImpl: async () => okResponse(422, '{"code":"blocked"}'),
    })
    const r = await fetcher({ point: 'moderate', descriptor: desc, body: {} })
    expect(r).toEqual({ status: 422, body: { code: 'blocked' }, unavailable: false })
  })

  it('malformed JSON → unavailable', async () => {
    const fetcher = createHookFetcher({
      getAuthToken: () => 't',
      fetchImpl: async () => okResponse(200, 'not json'),
    })
    expect((await fetcher({ point: 'moderate', descriptor: desc, body: {} })).unavailable).toBe(
      true
    )
  })

  it('oversized body → unavailable', async () => {
    const fetcher = createHookFetcher({
      getAuthToken: () => 't',
      maxOutputBytes: 4,
      fetchImpl: async () => okResponse(200, '{"action":"continue"}'),
    })
    expect((await fetcher({ point: 'moderate', descriptor: desc, body: {} })).unavailable).toBe(
      true
    )
  })

  it('connection error / timeout → unavailable', async () => {
    const fetcher = createHookFetcher({
      getAuthToken: () => 't',
      fetchImpl: async () => {
        throw new Error('ECONNREFUSED')
      },
    })
    expect(await fetcher({ point: 'moderate', descriptor: desc, body: {} })).toEqual({
      status: 0,
      body: undefined,
      unavailable: true,
    })
  })
})
