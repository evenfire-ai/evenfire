import { describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { hashCodexCompletionRequestV1 } from '@clerum/llm-provider-attempt-contract'
import { streamCodexCompletion } from '../src/codexTransport.js'
import type { RedeemAttemptSuccess } from '../src/controlApiClient.js'
import { CODEX_COMPLETIONS_ORIGIN } from '../src/originPolicy.js'
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
  it('measures explicit non-strict definitions without altering omitted or true values', async () => {
    const simulator = createApprovedToolsUpstream()
    const definitions = tools.map((tool, index) => ({
      ...tool,
      ...(index === 0 ? { strict: false } : index === 1 ? { strict: true } : {}),
    }))
    const before = JSON.stringify(definitions)
    const result = await request(
      simulator,
      [{ role: 'user', content: 'verification receipt' }],
      definitions
    )
    expect(result.response.status).toBe(200)
    expect(simulator.evidence().requests).toMatchObject([
      { definitionCount: 3, explicitNonStrictCount: 1 },
    ])
    expect(JSON.stringify(definitions)).toBe(before)
  })

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

// Drives one completion through the real proxy transport against the fixture.
function transport(
  simulator: ReturnType<typeof createApprovedToolsUpstream>,
  content: string,
  id: string,
  outcome: 'success' | 'error'
) {
  const probeRequest = {
    schemaVersion: 'codex-completion-request.v1' as const,
    requestId: `req-${id}`,
    idempotencyKey: `idem-${id}`,
    provider: 'codex-subscription' as const,
    model: 'gpt-5.3-codex',
    messages: [{ role: 'user' as const, content }],
    tools: bridges.map(name => ({
      name,
      description: `${name} bridge`,
      parameters: { type: 'object' },
    })),
  }
  const requestHash = hashCodexCompletionRequestV1(probeRequest)
  const emitted: Array<{ type: string }> = []
  const finalize = vi.fn(async () => ({
    providerAttemptId: `att-${id}`,
    outcome,
    duplicate: false,
  }))
  const pending = streamCodexCompletion({
    executionTicket: `ticket-${id}`,
    requestHash,
    request: probeRequest,
    ticket: {
      jti: `jti-${id}`,
      hostRef: 'approved-tools-host',
      model: probeRequest.model,
      requestHash,
      providerAttemptId: `att-${id}`,
    },
    redeem: vi.fn(
      async (): Promise<RedeemAttemptSuccess> => ({
        accessToken: `hdr.${Buffer.from(
          JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct_probe' } })
        ).toString('base64url')}.sig`,
        transport: {
          protocolVersion: 'codex-subscription-transport.v1',
          completionsOrigin: CODEX_COMPLETIONS_ORIGIN,
          catalogOrigin: 'https://chatgpt.com/backend-api/codex/models?client_version=1.0.0',
          operation: 'completion_stream',
          servedModel: probeRequest.model,
          maxStreamDurationMs: 300_000,
        },
        expiryClass: 'short_lived',
        attemptReceipt: 'b'.repeat(64),
      })
    ),
    finalize,
    fetchFn: simulator.fetchFn,
    lookup: async () => [{ address: '104.18.32.47', family: 4 }],
    onFrame: frame => {
      emitted.push(frame)
    },
  })

  return { pending, emitted, finalize }
}

describe('approved-tools tool-call limit probe', () => {
  const probe = { role: 'user', content: 'Run the tool call limit probe now.' }

  function events(body: string): Entry[] {
    return body
      .split('\n\n')
      .filter(Boolean)
      .map(frame => JSON.parse(frame.slice('data: '.length)) as Entry)
  }

  it('answers a probe turn with 257 distinct search calls in one completion', async () => {
    const simulator = createApprovedToolsUpstream()
    const { response, body } = await request(simulator, [probe])
    expect(response.status).toBe(200)
    const rows = events(body)
    const calls = rows.slice(0, -1).map(row => row.item as Entry)
    expect(rows[rows.length - 1]).toEqual({ type: 'response.completed' })
    expect(calls).toHaveLength(257)
    expect(new Set(calls.map(call => call.call_id)).size).toBe(257)
    for (const call of calls) {
      expect(call).toMatchObject({
        type: 'function_call',
        name: 'clerum__tool_search',
        arguments: JSON.stringify({ query: 'verification receipt', limit: 5 }),
      })
    }
    expect(simulator.evidence()).toMatchObject({
      limitProbe: { turns: 1, completions: 1, unexpectedRetries: 0 },
      completions: 1,
      searchCalls: 0,
      rejected: 0,
    })
    expect(simulator.evidence().requests).toMatchObject([{ stage: 'limit_probe' }])
  })

  it('rejects a retry and a continuation of an answered probe turn as unexpected_retry', async () => {
    const simulator = createApprovedToolsUpstream()
    const first = await request(simulator, [probe])
    expect(first.response.status).toBe(200)

    const retry = await request(simulator, [probe])
    const call = events(first.body)[0]!.item as Entry
    const continuation = await request(simulator, [
      probe,
      call,
      { type: 'function_call_output', call_id: call.call_id, output: '{}' },
    ])

    expect(retry.response.status).toBe(422)
    expect(continuation.response.status).toBe(422)
    expect(simulator.evidence()).toMatchObject({
      limitProbe: { turns: 1, completions: 3, unexpectedRetries: 2 },
      rejected: 2,
    })
  })

  it('answers a new probe turn later in the same conversation', async () => {
    const simulator = createApprovedToolsUpstream()
    const first = await request(simulator, [probe])
    const assistant = { role: 'assistant', content: 'The agent stopped.' }
    const second = await request(simulator, [probe, assistant, probe])
    expect([first.response.status, second.response.status]).toEqual([200, 200])
    expect(simulator.evidence().limitProbe).toEqual({
      turns: 2,
      completions: 2,
      unexpectedRetries: 0,
    })
  })

  it('makes the real transport fail the probe with tool_call_limit_exceeded', async () => {
    const simulator = createApprovedToolsUpstream()
    const { pending, emitted, finalize } = transport(
      simulator,
      probe.content,
      'limit-probe',
      'error'
    )
    await expect(pending).rejects.toMatchObject({
      name: 'CodexTransportError',
      code: 'tool_call_limit_exceeded',
      details: { limit: 256, observed: 257 },
    })
    // Liveness witness: the upstream served exactly one probe completion.
    expect(simulator.evidence().limitProbe).toEqual({
      turns: 1,
      completions: 1,
      unexpectedRetries: 0,
    })
    expect(emitted.filter(frame => frame.type === 'tool_call')).toEqual([])
    expect(finalize).toHaveBeenCalledTimes(1)
  })

  it('leaves the receipt journey unchanged after a probe turn (ordinary path witness)', async () => {
    const simulator = createApprovedToolsUpstream()
    await request(simulator, [probe])
    await complete(simulator, [{ role: 'user', content: 'verification receipt' }], 'after-probe')
    expect(simulator.evidence()).toMatchObject({
      limitProbe: { turns: 1, completions: 1, unexpectedRetries: 0 },
      searchCalls: 1,
      describeCalls: 1,
      businessCalls: 1,
      finalResponses: 1,
      rejected: 0,
    })
  })
})

describe('approved-tools tool-call limit boundary', () => {
  const boundary = { role: 'user', content: 'Run the tool call limit boundary now.' }

  function calls(body: string): Entry[] {
    return body
      .split('\n\n')
      .filter(Boolean)
      .map(frame => JSON.parse(frame.slice('data: '.length)) as Entry)
      .slice(0, -1)
      .map(row => row.item as Entry)
  }

  function answered(items: Entry[]): Entry[] {
    return items.flatMap(item => [
      item,
      {
        type: 'function_call_output',
        call_id: item.call_id,
        output: JSON.stringify({ found: 0, returned: 0, results: [] }),
      },
    ])
  }

  it('answers a boundary turn with 256 distinct search calls, then a final answer', async () => {
    const simulator = createApprovedToolsUpstream()
    const first = await request(simulator, [boundary])
    expect(first.response.status).toBe(200)
    const items = calls(first.body)
    expect(items).toHaveLength(256)
    expect(new Set(items.map(item => item.call_id)).size).toBe(256)
    expect(new Set(items.map(item => item.arguments)).size).toBe(256)
    for (const item of items) expect(item).toMatchObject({ name: 'clerum__tool_search' })

    const final = await request(simulator, [boundary, ...answered(items)])
    expect(final.response.status).toBe(200)
    expect(final.event).toEqual({
      type: 'response.output_text.delta',
      delta: 'Tool call limit boundary complete: 256 tool results received.',
    })
    expect(simulator.evidence()).toMatchObject({
      limitBoundary: {
        turns: 1,
        completions: 2,
        toolResults: 256,
        finalResponses: 1,
        unexpectedRetries: 0,
      },
      completions: 2,
      searchCalls: 0,
      rejected: 0,
    })
    expect(simulator.evidence().requests.map(row => row.stage)).toEqual([
      'limit_boundary',
      'limit_boundary_final',
    ])
  })

  it('rejects a missing result, a foreign call ID, a failed search and a repeated turn', async () => {
    const simulator = createApprovedToolsUpstream()
    const items = calls((await request(simulator, [boundary])).body)
    const full = answered(items)
    const missing = await request(simulator, [boundary, ...full.slice(0, -1)])
    const foreign = await request(simulator, [
      boundary,
      ...answered([{ ...items[0]!, call_id: 'foreign' }, ...items.slice(1)]),
    ])
    const failedSearch = await request(simulator, [
      boundary,
      ...full.slice(0, -1),
      { ...full.at(-1)!, output: JSON.stringify({ isError: true }) },
    ])
    const retry = await request(simulator, [boundary])
    expect([missing, foreign, failedSearch, retry].map(result => result.response.status)).toEqual([
      422, 422, 422, 422,
    ])
    // Liveness witness: the rejected continuations did not consume the turn.
    const final = await request(simulator, [boundary, ...full])
    expect(final.response.status).toBe(200)
    const repeated = await request(simulator, [boundary, ...full])
    expect(repeated.response.status).toBe(422)
    expect(simulator.evidence()).toMatchObject({
      limitBoundary: {
        turns: 1,
        completions: 7,
        toolResults: 256,
        finalResponses: 1,
        unexpectedRetries: 2,
      },
      rejected: 5,
    })
  })

  it('makes the real transport deliver all 256 calls without tool_call_limit_exceeded', async () => {
    const simulator = createApprovedToolsUpstream()
    const { pending, emitted, finalize } = transport(
      simulator,
      boundary.content,
      'limit-boundary',
      'success'
    )
    await pending
    const delivered = emitted.filter(frame => frame.type === 'tool_call')
    expect(delivered).toHaveLength(256)
    expect(emitted.some(frame => frame.type === 'error')).toBe(false)
    expect(simulator.evidence().limitBoundary).toMatchObject({ turns: 1, completions: 1 })
    expect(finalize).toHaveBeenCalledTimes(1)
  })
})
