import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { createApprovedToolsUpstream } from './approvedToolsUpstream'

const URL = 'https://chatgpt.com/backend-api/codex/responses'
const bridges = ['clerum__tool_search', 'clerum__tool_describe', 'clerum__tool_call']
const target = 'fixture__workitem_read_receipt'
const tools = bridges.map(name => ({ type: 'function', name, parameters: { type: 'object' } }))
type Entry = Record<string, unknown>

async function request(
  simulator: ReturnType<typeof createApprovedToolsUpstream>,
  input: Entry[],
  definitions = tools
) {
  const response = await simulator.fetchFn(URL, {
    method: 'POST',
    body: JSON.stringify({
      model: 'gpt-5.3-codex',
      stream: true,
      store: false,
      input,
      tools: definitions,
    }),
  })
  const body = await response.text()
  return { response, body, event: response.ok ? JSON.parse(body.split('\n')[0]!.slice(6)) : null }
}

async function complete(
  simulator: ReturnType<typeof createApprovedToolsUpstream>,
  input: Entry[],
  runId: string,
  wrapped = false
) {
  const result = {
    runId,
    tool: 'workitem_read_receipt',
    callId: randomUUID(),
    businessId: randomUUID(),
  }
  const outputs = [
    {
      found: 1,
      returned: 1,
      results: [{ name: target, server: 'fixture', description: 'verification receipt' }],
    },
    {
      found: true,
      name: target,
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
    { content: [{ type: 'text', text: JSON.stringify(result) }] },
  ]
  for (let index = 0; index < 3; index++) {
    const step = await request(simulator, input)
    expect(step.response.status).toBe(200)
    expect(step.event.item.name).toBe(bridges[index])
    const item = step.event.item
    input.push(item, {
      type: 'function_call_output',
      call_id: item.call_id,
      output: wrapped
        ? `<tool_output name="${index === 2 ? target : bridges[index]}" sanitized="false">\n${JSON.stringify(outputs[index])}\n</tool_output>`
        : JSON.stringify(outputs[index]),
    })
  }
  const final = await request(simulator, input)
  expect(final.response.status).toBe(200)
  expect(JSON.parse(final.event.delta)).toEqual(result)
  return result
}

describe('approved-tools isolated upstream boundary', () => {
  it('accepts the BasicSafety envelope with the real bridge execution target', async () => {
    await complete(
      createApprovedToolsUpstream(),
      [{ role: 'user', content: 'verification receipt' }],
      'wrapped',
      true
    )
  })
  it('rejects a safety envelope attributed to another tool or malformed closing tags', async () => {
    const simulator = createApprovedToolsUpstream()
    const user = { role: 'user', content: 'verification receipt' }
    const { event } = await request(simulator, [user])
    for (const output of [
      '<tool_output name="other" sanitized="false">\n{}\n</tool_output>',
      '<tool_output name="clerum__tool_search" sanitized="false">\n{}\n</tool_output>trailing',
    ]) {
      const result = await request(simulator, [
        user,
        event.item,
        { type: 'function_call_output', call_id: event.item.call_id, output },
      ])
      expect(result.response.status).toBe(422)
    }
    expect(simulator.evidence().businessCalls).toBe(0)
  })
  it.each([83, 150, 250])(
    'derives its answer from the selected service result for catalog %s',
    async count => {
      const simulator = createApprovedToolsUpstream()
      const result = await complete(
        simulator,
        [{ role: 'user', content: 'verification receipt' }],
        `catalog-${count}`
      )
      const evidence = simulator.evidence()
      expect(evidence).toMatchObject({
        searchCalls: 1,
        describeCalls: 1,
        businessCalls: 1,
        finalResponses: 1,
        rejected: 0,
      })
      expect(evidence.requests.map(row => row.definitionCount)).toEqual([3, 3, 3, 3])
      expect(
        evidence.requests.every(row => row.connectorDefinitionCount === 0 && !row.leakedSchema)
      ).toBe(true)
      expect(new Set(evidence.requests.map(row => row.definitionBytes)).size).toBe(1)
      expect(JSON.stringify(evidence)).not.toContain(result.businessId)
      expect(JSON.stringify(evidence)).not.toContain(result.runId)
    }
  )

  it('interleaves separate conversations without global stage or answer reuse', async () => {
    const simulator = createApprovedToolsUpstream()
    const results = await Promise.all(
      ['a', 'b'].map(run =>
        complete(simulator, [{ role: 'user', content: 'verification receipt' }], run)
      )
    )
    expect(results[0]!.businessId).not.toBe(results[1]!.businessId)
    expect(simulator.evidence().finalResponses).toBe(2)
  })

  it('rediscovers after a new user turn and returns the actual empty catalog after revocation', async () => {
    const simulator = createApprovedToolsUpstream()
    const input: Entry[] = [{ role: 'user', content: 'verification receipt' }]
    await complete(simulator, input, 'revoked')
    input.push({ role: 'user', content: 'verification receipt again' })
    const search = await request(simulator, input)
    expect(search.event.item.name).toBe(bridges[0])
    const empty = { found: 0, returned: 0, results: [] }
    input.push(search.event.item, {
      type: 'function_call_output',
      call_id: search.event.item.call_id,
      output: JSON.stringify(empty),
    })
    const denied = await request(simulator, input)
    expect(JSON.parse(denied.event.delta)).toEqual(empty)
    expect(simulator.evidence()).toMatchObject({
      businessCalls: 1,
      finalResponses: 1,
      deniedResponses: 1,
    })
  })

  it('rejects missing bridge definitions, incomplete results, wrong call IDs and leaked search schemas', async () => {
    const simulator = createApprovedToolsUpstream()
    const user = { role: 'user', content: 'verification receipt' }
    expect((await request(simulator, [user], tools.slice(0, 2))).response.status).toBe(422)
    const step = await request(simulator, [user])
    const call = step.event.item
    expect((await request(simulator, [user, call])).response.status).toBe(422)
    expect(
      (
        await request(simulator, [
          user,
          call,
          { type: 'function_call_output', call_id: 'wrong', output: '{}' },
        ])
      ).response.status
    ).toBe(422)
    const leaked = { found: 1, results: [{ name: target, parameters: {} }] }
    expect(
      (
        await request(simulator, [
          user,
          call,
          { type: 'function_call_output', call_id: call.call_id, output: JSON.stringify(leaked) },
        ])
      ).response.status
    ).toBe(422)
    expect(simulator.evidence().businessCalls).toBe(0)
  })

  it('accepts only the frozen catalog and completion operations without making network calls', async () => {
    const simulator = createApprovedToolsUpstream()
    const catalog = await simulator.fetchFn(
      'https://chatgpt.com/backend-api/codex/models?client_version=1.0.0'
    )
    expect(await catalog.json()).toMatchObject({ models: [{ slug: 'gpt-5.3-codex' }] })
    for (const url of [
      'http://chatgpt.com/backend-api/codex/responses',
      'https://example.com/',
      URL + '/other',
    ]) {
      expect((await simulator.fetchFn(url, { method: 'POST' })).status).toBe(422)
    }
  })

  it('records schema or catalog leakage without retaining the leaked content', async () => {
    const simulator = createApprovedToolsUpstream()
    await request(
      simulator,
      [{ role: 'user', content: 'verification receipt' }],
      [...tools, { type: 'function', name: target, parameters: { type: 'object' } }]
    )
    await request(simulator, [
      { role: 'user', content: 'verification receipt workitem_read_001 workitem_read_002' },
    ])
    expect(simulator.evidence().requests).toMatchObject([
      { connectorDefinitionCount: 1, leakedSchema: true },
      { connectorDefinitionCount: 0, leakedSchema: true },
    ])
    expect(JSON.stringify(simulator.evidence())).not.toContain('workitem_read_001')
  })
})
