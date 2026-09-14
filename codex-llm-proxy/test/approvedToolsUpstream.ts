/** External model boundary for the isolated approved-tools E2E image only. */
import { randomUUID } from 'node:crypto'

type Row = Record<string, unknown>
const COMPLETIONS = 'https://chatgpt.com/backend-api/codex/responses'
const CATALOG = 'https://chatgpt.com/backend-api/codex/models?client_version=1.0.0'
const BRIDGES = ['clerum__tool_search', 'clerum__tool_describe', 'clerum__tool_call']
// The deterministic external model is scoped to this fixture's read journey.
const FIXTURE_QUERY = 'verification receipt'

function record(value: unknown): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('expected_object')
  return value as Row
}

function parse(value: unknown): Row {
  if (typeof value !== 'string') throw new Error('expected_json_text')
  return record(JSON.parse(value))
}

function textResult(value: unknown, expectedName: string): Row {
  if (typeof value === 'string' && value.startsWith('<tool_output')) {
    const wrapped =
      /^<tool_output name="([^"]+)" sanitized="(?:true|false)">\n([\s\S]*)\n<\/tool_output>$/.exec(
        value
      )
    if (!wrapped || wrapped[1] !== expectedName || wrapped[2]!.includes('</tool_output>')) {
      throw new Error('invalid_tool_output_envelope')
    }
    value = wrapped[2]
  }
  const result = parse(value)
  if (result.isError === true || result.is_error === true) throw new Error('tool_failed')
  if (Array.isArray(result.content)) {
    const blocks = result.content.map(record)
    if (blocks.length !== 1 || blocks[0]?.type !== 'text')
      throw new Error('expected_single_text_result')
    return parse(blocks[0].text)
  }
  return result
}

function stream(event: Row): Response {
  return new Response(
    [event, { type: 'response.completed' }].map(row => `data: ${JSON.stringify(row)}\n\n`).join(''),
    {
      headers: { 'content-type': 'text/event-stream' },
    }
  )
}

export function createApprovedToolsUpstream() {
  const evidence = {
    catalogRequests: 0,
    rejected: 0,
    completions: 0,
    searchCalls: 0,
    describeCalls: 0,
    businessCalls: 0,
    finalResponses: 0,
    deniedResponses: 0,
    // Only bounded measurements, never request or result contents.
    requests: [] as Array<{
      definitionCount: number
      definitionBytes: number
      inputBytes: number
      connectorDefinitionCount: number
      leakedSchema: boolean
      stage: string
    }>,
  }

  const fetchFn: typeof fetch = async (input, init) => {
    try {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url === CATALOG && (!init?.method || init.method === 'GET')) {
        evidence.catalogRequests++
        return Response.json({
          models: [{ slug: 'gpt-5.3-codex', display_name: 'Codex isolated tool test' }],
        })
      }
      if (url !== COMPLETIONS || init?.method !== 'POST') throw new Error('operation_denied')
      const payload = parse(init.body)
      if (payload.stream !== true || payload.store !== false)
        throw new Error('invalid_stream_contract')
      if (!Array.isArray(payload.input) || !Array.isArray(payload.tools))
        throw new Error('missing_input_or_tools')
      const history = payload.input.map(record)
      const tools = payload.tools.map(record)
      const names = new Set(tools.map(tool => tool.name))
      if (!BRIDGES.every(name => names.has(name))) throw new Error('missing_discovery_bridge')
      if (names.size !== tools.length || tools.some(tool => tool.type !== 'function'))
        throw new Error('invalid_definitions')
      let lastUser = history.length - 1
      while (lastUser >= 0 && history[lastUser]?.role !== 'user') lastUser--
      const user = history[lastUser]
      if (!user || typeof user.content !== 'string' || !user.content.trim())
        throw new Error('missing_user_request')
      if (!user.content.toLowerCase().includes(FIXTURE_QUERY))
        throw new Error('unsupported_fixture_task')
      const tail = history.slice(lastUser + 1)
      const calls = tail.filter(row => row.type === 'function_call')
      const outputs = tail.filter(row => row.type === 'function_call_output')
      if (calls.length > 3 || outputs.length !== calls.length)
        throw new Error('incomplete_or_repeated_calls')
      if (new Set(calls.map(call => call.call_id)).size !== calls.length)
        throw new Error('duplicate_call_id')
      const results = calls.map((call, index) => {
        if (call.name !== BRIDGES[index] || typeof call.call_id !== 'string')
          throw new Error('invalid_call_sequence')
        const matched = outputs.filter(output => output.call_id === call.call_id)
        if (matched.length !== 1 || tail.indexOf(matched[0]!) < tail.indexOf(call))
          throw new Error('uncorrelated_result')
        const expectedName = call.name === BRIDGES[2] ? parse(call.arguments).name : call.name
        if (typeof expectedName !== 'string') throw new Error('invalid_envelope_target')
        return textResult(matched[0]!.output, expectedName)
      })
      let candidate: string | undefined
      let denied = false
      if (results[0]) {
        if (parse(calls[0]!.arguments).query !== FIXTURE_QUERY)
          throw new Error('search_query_mismatch')
        if (!Array.isArray(results[0].results)) throw new Error('invalid_search_result')
        denied = results[0].found === 0 && results[0].results.length === 0
        if (!denied) {
          if (results[0].results.length !== 1) throw new Error('search_must_find_one_target')
          const match = record(results[0].results[0])
          if (typeof match.name !== 'string' || BRIDGES.includes(match.name))
            throw new Error('invalid_search_target')
          if ('parameters' in match || 'inputSchema' in match)
            throw new Error('search_leaked_schema')
          candidate = match.name
        }
      }
      if (denied && calls.length !== 1) throw new Error('call_after_denial')
      if (results[1]) {
        if (parse(calls[1]!.arguments).name !== candidate)
          throw new Error('description_target_mismatch')
        if (results[1].found !== true || results[1].name !== candidate)
          throw new Error('description_not_found')
        const schema = record(results[1].parameters)
        if (schema.type !== 'object' || (Array.isArray(schema.required) && schema.required.length))
          throw new Error('fixture_requires_empty_arguments')
      }
      if (results[2]) {
        const args = parse(calls[2]!.arguments)
        if (args.name !== candidate || Object.keys(record(args.arguments)).length)
          throw new Error('invocation_target_mismatch')
        if (
          typeof results[2].businessId !== 'string' ||
          !results[2].businessId ||
          typeof results[2].runId !== 'string' ||
          typeof results[2].callId !== 'string' ||
          typeof results[2].tool !== 'string' ||
          !candidate?.endsWith(`__${results[2].tool}`)
        )
          throw new Error('missing_business_result')
      }
      const stage = denied ? 'denied' : (BRIDGES[calls.length] ?? 'final')
      if (evidence.requests.length >= 512) throw new Error('evidence_capacity_exceeded')
      evidence.completions++
      // This fixture task needs one receipt tool. Other fixture catalog names
      // anywhere in the payload reveal a catalog dump, including in messages.
      const fixtureNames = new Set(
        JSON.stringify(payload).match(/workitem_read_(?:receipt|\d{3})/g) ?? []
      )
      const connectorDefinitionCount = tools.filter(
        tool =>
          typeof tool.name === 'string' &&
          /(?:^|__)workitem_read_(?:receipt|\d{3})$/.test(tool.name)
      ).length
      evidence.requests.push({
        definitionCount: tools.length,
        definitionBytes: Buffer.byteLength(JSON.stringify(tools)),
        inputBytes: Buffer.byteLength(JSON.stringify(payload.input)),
        connectorDefinitionCount,
        leakedSchema: connectorDefinitionCount > 0 || fixtureNames.size > 1,
        stage,
      })
      if (denied) {
        evidence.deniedResponses++
        return stream({ type: 'response.output_text.delta', delta: JSON.stringify(results[0]) })
      }
      if (stage === 'final') {
        evidence.finalResponses++
        return stream({ type: 'response.output_text.delta', delta: JSON.stringify(results[2]) })
      }
      if (!names.has(stage)) throw new Error('unadvertised_function')
      const args =
        stage === BRIDGES[0]
          ? { query: FIXTURE_QUERY, limit: 5 }
          : stage === BRIDGES[1]
            ? { name: candidate }
            : { name: candidate, arguments: {} }
      if (stage === BRIDGES[0]) evidence.searchCalls++
      if (stage === BRIDGES[1]) evidence.describeCalls++
      if (stage === BRIDGES[2]) evidence.businessCalls++
      return stream({
        type: 'response.output_item.done',
        item: {
          type: 'function_call',
          id: randomUUID(),
          call_id: randomUUID(),
          name: stage,
          arguments: JSON.stringify(args),
        },
      })
    } catch {
      evidence.rejected++
      return Response.json({ error: { code: 'fixture_protocol_rejected' } }, { status: 422 })
    }
  }
  return { fetchFn, evidence: () => structuredClone(evidence) }
}
