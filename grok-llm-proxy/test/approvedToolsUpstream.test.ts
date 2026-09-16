import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { createApprovedToolsUpstream } from './approvedToolsUpstream'

const URL = 'https://cli-chat-proxy.grok.com/v1/responses'
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
      model: 'gpt-5.3-grok',
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

  it('recovers after an interrupted user task and returns the actual empty catalog after revocation', async () => {
    const simulator = createApprovedToolsUpstream()
    const input: Entry[] = [{ role: 'user', content: 'verification receipt' }]
    await complete(simulator, input, 'revoked')
    input.push({ role: 'user', content: 'verification receipt before cancellation' })
    const canceled = await request(simulator, input)
    input.push(canceled.event.item) // Genuine cancellation leaves no execution result.
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
      businessCalls: 2,
      finalResponses: 1,
      deniedResponses: 1,
    })
  })

  it('reuses an earlier real schema for an ordinary repeated request', async () => {
    const simulator = createApprovedToolsUpstream()
    const input: Entry[] = [{ role: 'user', content: 'Show my verification receipt.' }]
    const receipt = await complete(simulator, input, 'reuse')
    const before = simulator.evidence()
    input.push({ role: 'user', content: 'Show my verification receipt again.' })
    const call = await request(simulator, input)
    expect(call.event.item.name).toBe(bridges[2])
    // Persisted JSON may reorder object keys without changing the call.
    call.event.item.arguments = JSON.stringify({ arguments: {}, name: target })
    input.push(call.event.item, {
      type: 'function_call_output',
      call_id: call.event.item.call_id,
      output: `<tool_output name="${target}" sanitized="false">\n${JSON.stringify(receipt)}\n</tool_output>`,
    })
    const final = await request(simulator, input)
    expect(JSON.parse(final.event.delta)).toEqual(receipt)
    expect(simulator.evidence().searchCalls).toBe(before.searchCalls)
    expect(simulator.evidence().describeCalls).toBe(before.describeCalls)
    expect(
      simulator
        .evidence()
        .requests.slice(before.requests.length)
        .map(row => row.stage)
    ).toEqual([bridges[2], 'final'])
  })

  it('approval denial returns the real denial and never requests another business call', async () => {
    const simulator = createApprovedToolsUpstream()
    const input: Entry[] = [{ role: 'user', content: 'verification receipt' }]
    await complete(simulator, input, 'denial')
    input.push({ role: 'user', content: 'Please read my verification receipt.' })
    const call = await request(simulator, input)
    input.push(call.event.item, {
      type: 'function_call_output',
      call_id: call.event.item.call_id,
      output: 'Error: Approval denied by user',
    })
    const final = await request(simulator, input)
    expect(final.event.delta).toContain('Approval denied by user')
    expect(simulator.evidence().businessCalls).toBe(2)
    expect(simulator.evidence().deniedResponses).toBe(1)
    input.push({ role: 'user', content: 'verification receipt please' })
    expect((await request(simulator, input)).event.item.name).toBe(bridges[0])
  })

  it('revalidates an obsolete cached target through real search after a catalog denial', async () => {
    const simulator = createApprovedToolsUpstream()
    const input: Entry[] = [{ role: 'user', content: 'verification receipt' }]
    await complete(simulator, input, 'obsolete')
    input.push({ role: 'user', content: 'verification receipt again' })
    const call = await request(simulator, input)
    input.push(call.event.item, {
      type: 'function_call_output',
      call_id: call.event.item.call_id,
      output: 'Error: Tool not found in current catalog',
    })
    const search = await request(simulator, input)
    expect(search.event.item.name).toBe(bridges[0])
    input.push(search.event.item, {
      type: 'function_call_output',
      call_id: search.event.item.call_id,
      output: JSON.stringify({ found: 0, results: [] }),
    })
    expect((await request(simulator, input)).event.delta).toContain('"found":0')
  })

  it.each(['running', 'completed'])(
    'uses the native workflow result after %s status, never a fabricated receipt',
    async phase => {
      const simulator = createApprovedToolsUpstream()
      const workflow = 'approved-receipt-workflow'
      const nativeNames = [
        'workflow_list',
        'workflow_trigger',
        'workflow_status',
        'workflow_result',
      ]
      const definitions = [
        ...tools,
        ...nativeNames.map(name => ({ type: 'function', name, parameters: { type: 'object' } })),
      ]
      const input: Entry[] = [
        {
          role: 'user',
          content: `Run my ${workflow} workflow, check that it finishes, and show the business ID from its result artifact.`,
        },
      ]
      const businessId = randomUUID()
      const outputs = [
        {
          items: [
            { name: 'other-workflow' },
            {
              name: workflow,
              requiresInput: false,
              targets: [{ kind: 'user', label: 'Personal' }],
            },
          ],
        },
        { workflowName: workflow, phase: 'pending' },
        { name: workflow, latestRun: { phase } },
        {
          workflowName: workflow,
          artifactAvailable: true,
          result: { businessId, tool: 'workitem_read_receipt' },
        },
      ]
      for (let index = 0; index < nativeNames.length; index++) {
        const call = await request(simulator, input, definitions)
        expect(call.response.status).toBe(200)
        expect(call.event.item.name).toBe(nativeNames[index])
        if (index > 0)
          expect(JSON.parse(call.event.item.arguments)).toEqual({
            name: workflow,
            targetLabel: 'Personal',
          })
        input.push(call.event.item, {
          type: 'function_call_output',
          call_id: call.event.item.call_id,
          output: `<tool_output name="${nativeNames[index]}" sanitized="false">\n${JSON.stringify(outputs[index])}\n</tool_output>`,
        })
      }
      const final = await request(simulator, input, definitions)
      expect(JSON.parse(final.event.delta)).toEqual(outputs[3])
      expect(simulator.evidence().requests.map(row => row.stage)).toEqual([...nativeNames, 'final'])
      expect(simulator.evidence().businessCalls).toBe(0)
    }
  )

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
      'https://cli-chat-proxy.grok.com/v1/models'
    )
    expect(await catalog.json()).toMatchObject({ models: [{ slug: 'gpt-5.3-grok' }] })
    for (const url of [
      'http://cli-chat-proxy.grok.com/backend-api/grok/responses',
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
