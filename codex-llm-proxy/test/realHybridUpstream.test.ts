import { describe, expect, it, vi } from 'vitest'
import { createRealHybridUpstream } from './realHybridUpstream'

const url = 'https://chatgpt.com/backend-api/codex/responses'
const prompt = 'model step retry hybrid r1 unique-marker-1234'
const user = { role: 'user', content: prompt }
const call = {
  type: 'function_call',
  call_id: 'physical-1',
  name: 'clerum__tool_call',
  arguments: JSON.stringify({ name: 'fixture__workitem_read_000', arguments: {} }),
}
const output = {
  type: 'function_call_output',
  call_id: 'physical-1',
  output: JSON.stringify({
    runId: 'fixture-run',
    tool: 'workitem_read_000',
    callId: 'mcp-1',
    businessId: 'receipt-1',
  }),
}

function completion(input: unknown[]) {
  return { method: 'POST', body: JSON.stringify({ input }) }
}

describe('real Codex hybrid upstream', () => {
  it('injects the deterministic 503 exactly once after a correlated confirmed tool result', async () => {
    const forwarded = Response.json({ real: true })
    const realFetch = vi.fn<typeof fetch>(async () => forwarded)
    const hybrid = createRealHybridUpstream(realFetch)
    const before = completion([user, call])
    const uncorrelated = completion([user, call, { ...output, call_id: 'other' }])
    const after = completion([user, call, output])

    expect(await hybrid.fetchFn(url, before)).toBe(forwarded)
    expect(await hybrid.fetchFn(url, uncorrelated)).toBe(forwarded)
    const failure = await hybrid.fetchFn(url, after)
    expect(failure.status).toBe(503)
    expect(await failure.json()).toEqual({
      error: { code: 'server_is_overloaded', message: 'fixture provider unavailable' },
    })
    expect(await hybrid.fetchFn(url, after)).toBe(forwarded)
    expect(realFetch).toHaveBeenNthCalledWith(1, url, before)
    expect(realFetch).toHaveBeenNthCalledWith(2, url, uncorrelated)
    expect(realFetch).toHaveBeenNthCalledWith(3, url, after)
    expect(hybrid.evidence()).toEqual({
      forwarded: 3,
      injected503: 1,
      r1: 1,
      r2: 0,
      r1DistinctToolResults: 1,
      r2DistinctToolResults: 0,
    })
  })

  it('forwards unrelated turns and catalog calls unchanged', async () => {
    const realFetch = vi.fn<typeof fetch>(async () => Response.json({ real: true }))
    const hybrid = createRealHybridUpstream(realFetch)
    const catalog = 'https://chatgpt.com/backend-api/codex/models?client_version=1.0.0'
    const ordinary = completion([{ role: 'user', content: 'ordinary turn' }, call, output])
    await hybrid.fetchFn(catalog, { method: 'GET' })
    await hybrid.fetchFn(url, ordinary)
    expect(realFetch).toHaveBeenCalledTimes(2)
    expect(hybrid.evidence()).toEqual({
      forwarded: 2,
      injected503: 0,
      r1: 0,
      r2: 0,
      r1DistinctToolResults: 0,
      r2DistinctToolResults: 0,
    })
  })

  it('scopes each injection to a turn and ignores tool results from earlier turns', async () => {
    const realFetch = vi.fn<typeof fetch>(async () => Response.json({ real: true }))
    const hybrid = createRealHybridUpstream(realFetch)
    const second = { role: 'user', content: 'model step retry hybrid r2 another-marker-1234' }
    expect((await hybrid.fetchFn(url, completion([user, call, output, second]))).status).toBe(200)
    expect((await hybrid.fetchFn(url, completion([second, call, output]))).status).toBe(503)
    expect((await hybrid.fetchFn(url, completion([second, call, output]))).status).toBe(200)
    expect(hybrid.evidence()).toMatchObject({
      forwarded: 2,
      injected503: 1,
      r1: 0,
      r2: 1,
      r2DistinctToolResults: 1,
    })
  })

  it('makes the 503 observation fail when injection is disabled', async () => {
    const realFetch = vi.fn<typeof fetch>(async () => Response.json({ real: true }))
    const hybrid = createRealHybridUpstream(realFetch)
    const realOnly = await realFetch(url, completion([user, call, output]))
    expect(realOnly.status).not.toBe(503)
    expect(hybrid.evidence().injected503).toBe(0)
    const injected = await hybrid.fetchFn(url, completion([user, call, output]))
    expect(injected.status).toBe(503)
    expect(hybrid.evidence().injected503).toBe(1)
  })
})

it('forwards discovery until the physical fixture read is confirmed before the 503', async () => {
  const realFetch = vi.fn<typeof fetch>(async () => Response.json({ real: true }))
  const hybrid = createRealHybridUpstream(realFetch)
  const history = [
    user,
    { type: 'function_call', call_id: 'search-1', name: 'clerum__tool_search' },
    { type: 'function_call_output', call_id: 'search-1', output: '{}' },
  ]
  expect((await hybrid.fetchFn(url, completion(history))).status).toBe(200)
  const physical = {
    type: 'function_call',
    call_id: 'physical-1',
    name: 'clerum__tool_call',
    arguments: JSON.stringify({ name: 'fixture__workitem_read_000', arguments: {} }),
  }
  const result = {
    type: 'function_call_output',
    call_id: 'physical-1',
    output: JSON.stringify({
      runId: 'fixture-run',
      tool: 'workitem_read_000',
      callId: 'mcp-1',
      businessId: 'receipt-1',
    }),
  }
  expect((await hybrid.fetchFn(url, completion([...history, physical]))).status).toBe(200)
  const confirmed = completion([...history, physical, result])
  expect((await hybrid.fetchFn(url, confirmed)).status).toBe(503)
  expect((await hybrid.fetchFn(url, confirmed)).status).toBe(200)
  expect(realFetch).toHaveBeenCalledTimes(3)
})

it('requires a successful fixture result and accepts its BasicSafety envelope', async () => {
  const realFetch = vi.fn<typeof fetch>(async () => Response.json({ real: true }))
  const hybrid = createRealHybridUpstream(realFetch)
  for (const text of ['{}', 'not json', JSON.stringify({ isError: true, content: [] })]) {
    expect(
      (await hybrid.fetchFn(url, completion([user, call, { ...output, output: text }]))).status
    ).toBe(200)
  }
  const wrapped = `<tool_output name="fixture__workitem_read_000" sanitized="false">\n${JSON.stringify({ content: [{ type: 'text', text: output.output }] })}\n</tool_output>`
  expect(
    (await hybrid.fetchFn(url, completion([user, call, { ...output, output: wrapped }]))).status
  ).toBe(503)
  expect(realFetch).toHaveBeenCalledTimes(3)
})
