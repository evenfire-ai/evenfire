/** External model boundary for the isolated approved-tools E2E image only. */
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'

type Row = Record<string, unknown>
const COMPLETIONS = 'https://cli-chat-proxy.grok.com/v1/responses'
const CATALOG = 'https://cli-chat-proxy.grok.com/v1/models'
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
  // Real tool failures can be plain sanitized text; preserve that failure as
  // data rather than inventing a successful result or retrying an approval.
  if (typeof value === 'string' && !value.trim().startsWith('{')) return { error: value }
  const result = parse(value)
  if (result.isError === true || result.is_error === true) return result
  if (Array.isArray(result.content)) {
    const blocks = result.content.map(record)
    if (blocks.length !== 1 || blocks[0]?.type !== 'text')
      throw new Error('expected_single_text_result')
    return parse(blocks[0].text)
  }
  return result
}

type Exchange = { call: Row; args: Row; result: Row }
type Decision = { stage: string; args?: Row; result?: Row }

function expectedCall(exchange: Exchange, decision: Decision): void {
  if (
    exchange.call.name !== decision.stage ||
    !isDeepStrictEqual(exchange.args, decision.args)
  ) {
    throw new Error('unexpected_fixture_call')
  }
}

function exchanges(rows: Row[]): Exchange[] {
  const calls = rows.filter(row => row.type === 'function_call')
  const outputs = rows.filter(row => row.type === 'function_call_output')
  if (calls.length > 12 || calls.length !== outputs.length)
    throw new Error('incomplete_or_repeated_calls')
  if (new Set(calls.map(call => call.call_id)).size !== calls.length)
    throw new Error('duplicate_call_id')
  return calls.map(call => {
    if (typeof call.call_id !== 'string' || typeof call.name !== 'string')
      throw new Error('invalid_call')
    const matched = outputs.filter(output => output.call_id === call.call_id)
    if (matched.length !== 1 || rows.indexOf(matched[0]!) < rows.indexOf(call))
      throw new Error('uncorrelated_result')
    const args = parse(call.arguments)
    const expectedName = call.name === BRIDGES[2] ? args.name : call.name
    if (typeof expectedName !== 'string') throw new Error('invalid_envelope_target')
    return { call, args, result: textResult(matched[0]!.output, expectedName) }
  })
}

function failed(result: Row): boolean {
  return result.isError === true || result.is_error === true || Boolean(result.error)
}

function described(exchange: Exchange): string {
  if (
    exchange.call.name !== BRIDGES[1] ||
    exchange.result.found !== true ||
    exchange.result.name !== exchange.args.name ||
    typeof exchange.args.name !== 'string'
  )
    throw new Error('description_target_mismatch')
  const schema = record(exchange.result.parameters)
  if (schema.type !== 'object' || (Array.isArray(schema.required) && schema.required.length))
    throw new Error('fixture_requires_empty_arguments')
  return exchange.args.name
}

function receipt(exchange: Exchange, candidate: string): Row {
  if (
    exchange.call.name !== BRIDGES[2] ||
    exchange.args.name !== candidate ||
    Object.keys(record(exchange.args.arguments)).length
  )
    throw new Error('invocation_target_mismatch')
  const value = exchange.result
  if (
    typeof value.businessId !== 'string' ||
    !value.businessId ||
    typeof value.runId !== 'string' ||
    typeof value.callId !== 'string' ||
    typeof value.tool !== 'string' ||
    !candidate.endsWith(`__${value.tool}`)
  )
    throw new Error('missing_business_result')
  return value
}

function reusableDescription(history: Row[]): string | undefined {
  let previousUser = history.length - 1
  while (previousUser >= 0 && history[previousUser]?.role !== 'user') previousUser--
  if (previousUser < 0) return undefined
  try {
    // A canceled or denied previous task invalidates reuse; an ordinary new
    // request must recover via discovery, not continue its interrupted call.
    const previous = exchanges(history.slice(previousUser + 1))
    const last = previous.at(-1)
    if (
      !last ||
      last.call.name !== BRIDGES[2] ||
      failed(last.result) ||
      typeof last.args.name !== 'string'
    )
      return undefined
    receipt(last, last.args.name)
    const allCalls = history.filter(row => row.type === 'function_call' && row.name === BRIDGES[1])
    for (const call of allCalls.reverse()) {
      const result = history.find(
        row => row.type === 'function_call_output' && row.call_id === call.call_id
      )
      if (!result) continue
      const candidate = described(exchanges([call, result])[0]!)
      if (candidate === last.args.name) return candidate
    }
  } catch {
    // Historical partial results are expected after genuine user cancellation.
    // They cannot supply a reusable schema, but never block the new task.
  }
  return undefined
}

function receiptDecision(current: Exchange[], known?: string): Decision {
  const last = current.at(-1)
  if (!last)
    return known
      ? { stage: BRIDGES[2]!, args: { name: known, arguments: {} } }
      : { stage: BRIDGES[0]!, args: { query: FIXTURE_QUERY, limit: 5 } }
  expectedCall(last, receiptDecision(current.slice(0, -1), known))
  if (failed(last.result)) {
    // An obsolete cached target can be rediscovered. Approval denial/cancel
    // remains terminal and must never cause an automatic business retry.
    if (
      last.call.name === BRIDGES[2] &&
      /not found|not available|unavailable|not .*catalog/i.test(JSON.stringify(last.result)) &&
      !/approval|denied|cancel|reject/i.test(JSON.stringify(last.result))
    )
      return { stage: BRIDGES[0]!, args: { query: FIXTURE_QUERY, limit: 5 } }
    return { stage: 'denied', result: last.result }
  }
  if (last.call.name === BRIDGES[0]) {
    if (last.args.query !== FIXTURE_QUERY || !Array.isArray(last.result.results))
      throw new Error('invalid_search_result')
    if (last.result.found === 0 && last.result.results.length === 0)
      return { stage: 'denied', result: last.result }
    if (last.result.results.length !== 1) throw new Error('search_must_find_one_target')
    const match = record(last.result.results[0])
    if (
      typeof match.name !== 'string' ||
      BRIDGES.includes(match.name) ||
      'parameters' in match ||
      'inputSchema' in match
    )
      throw new Error('invalid_search_target')
    return { stage: BRIDGES[1]!, args: { name: match.name } }
  }
  if (last.call.name === BRIDGES[1]) {
    if (last.result.found === false)
      return { stage: BRIDGES[0]!, args: { query: FIXTURE_QUERY, limit: 5 } }
    const candidate = described(last)
    const search = current.at(-2)
    if (
      !search ||
      search.call.name !== BRIDGES[0] ||
      !Array.isArray(search.result.results) ||
      record(search.result.results[0]).name !== candidate
    )
      throw new Error('description_without_search')
    return { stage: BRIDGES[2]!, args: { name: candidate, arguments: {} } }
  }
  if (last.call.name === BRIDGES[2]) {
    const prior = current.at(-2)
    const candidate = prior?.call.name === BRIDGES[1] ? described(prior) : known
    if (!candidate) throw new Error('invocation_without_schema')
    return { stage: 'final', result: receipt(last, candidate) }
  }
  throw new Error('unsupported_receipt_transition')
}

function workflowDecision(current: Exchange[], prompt: string): Decision {
  if (!current.length) return { stage: 'workflow_list', args: {} }
  expectedCall(current.at(-1)!, workflowDecision(current.slice(0, -1), prompt))
  const listed = current[0]!
  if (
    listed.call.name !== 'workflow_list' ||
    failed(listed.result) ||
    !Array.isArray(listed.result.items)
  )
    throw new Error('workflow_list_required')
  const matches = listed.result.items
    .map(record)
    .filter(item => typeof item.name === 'string' && prompt.includes(item.name))
  if (matches.length !== 1 || matches[0]!.requiresInput === true)
    throw new Error('workflow_not_uniquely_resolved')
  const selected = matches[0]!
  const args: Row = { name: selected.name }
  if (Array.isArray(selected.targets)) {
    const targets = selected.targets.map(record)
    const matching =
      targets.length === 1
        ? targets
        : targets.filter(
            target => typeof target.label === 'string' && prompt.includes(target.label)
          )
    if (matching.length !== 1 || typeof matching[0]!.label !== 'string')
      throw new Error('ambiguous_workflow_target')
    args.targetLabel = matching[0]!.label
  }
  const last = current.at(-1)!
  if (failed(last.result)) return { stage: 'denied', result: last.result }
  if (current.length === 1) return { stage: 'workflow_trigger', args }
  for (const item of current.slice(1)) {
    if (item.args.name !== selected.name) throw new Error('workflow_target_mismatch')
  }
  if (last.call.name === 'workflow_trigger' && current.length === 2) {
    if (last.result.workflowName !== selected.name) throw new Error('trigger_binding_missing')
    return { stage: 'workflow_status', args }
  }
  if (last.call.name === 'workflow_status' && current.length === 3) {
    if (last.result.name !== selected.name) throw new Error('status_binding_missing')
    const latest = last.result.latestRun ? record(last.result.latestRun) : undefined
    if (
      ['failed', 'cancelled', 'canceled'].includes(
        String(latest?.phase ?? last.result.workflowPhase)
      )
    )
      return { stage: 'denied', result: last.result }
    // workflow_result performs the real bounded artifact-readiness polling.
    return { stage: 'workflow_result', args }
  }
  if (last.call.name === 'workflow_result' && current.length === 4) {
    if (
      last.result.workflowName !== selected.name ||
      last.result.artifactAvailable !== true ||
      typeof record(last.result.result).businessId !== 'string'
    )
      throw new Error('workflow_artifact_missing')
    return { stage: 'final', result: last.result }
  }
  throw new Error('unsupported_workflow_transition')
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
          models: [{ slug: 'gpt-5.3-grok', display_name: 'Grok isolated tool test' }],
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
      const isWorkflow = /\bworkflow\b/i.test(user.content)
      if (!isWorkflow && !user.content.toLowerCase().includes(FIXTURE_QUERY))
        throw new Error('unsupported_fixture_task')
      const current = exchanges(history.slice(lastUser + 1))
      const decision = isWorkflow
        ? workflowDecision(current, user.content)
        : receiptDecision(current, reusableDescription(history.slice(0, lastUser)))
      const { stage } = decision
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
      if (stage === 'denied') {
        evidence.deniedResponses++
        return stream({
          type: 'response.output_text.delta',
          delta: JSON.stringify(decision.result),
        })
      }
      if (stage === 'final') {
        evidence.finalResponses++
        return stream({
          type: 'response.output_text.delta',
          delta: JSON.stringify(decision.result),
        })
      }
      if (!names.has(stage)) throw new Error('unadvertised_function')
      const args = decision.args
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
