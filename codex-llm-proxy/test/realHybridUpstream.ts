/** Provider outages in the isolated E2E proxy image; all other requests use Codex. */
const COMPLETIONS = 'https://chatgpt.com/backend-api/codex/responses'
const HYBRID_TURN = /\bmodel step retry hybrid (r1|r2) ([a-z0-9][a-z0-9-]{7,63})(?![a-z0-9-])/i
// The Host retries one failed model step by itself when that failure would leave
// a resumable checkpoint (`CLERUM_MODEL_STEP_AUTO_RETRIES` defaults to 1). R1 and
// R2 must end on the resumable notice, so each fails the step after the fixture
// read twice: the automatic retry absorbs the first outage and the second stands.
const HYBRID_OUTAGES = 2

type Row = Record<string, unknown>

function object(value: unknown): value is Row {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
}

function completedToolResults(input: Row[]): string[] {
  const calls = new Set(
    input
      .filter(row => row.type === 'function_call' && typeof row.call_id === 'string')
      .map(row => row.call_id)
  )
  return input
    .filter(
      row =>
        row.type === 'function_call_output' &&
        typeof row.call_id === 'string' &&
        calls.has(row.call_id)
    )
    .map(row => row.call_id as string)
}

// Both hybrid journeys read this fixture tool before the outage. The MCP
// service records its physical executions; discovery alone is not a witness.
function confirmedFixtureRead(rows: Row[]): boolean {
  return rows.some(call => {
    if (
      call.type !== 'function_call' ||
      call.name !== 'clerum__tool_call' ||
      typeof call.call_id !== 'string' ||
      typeof call.arguments !== 'string'
    )
      return false
    const outputs = rows.filter(
      row => row.type === 'function_call_output' && row.call_id === call.call_id
    )
    if (outputs.length !== 1 || rows.indexOf(outputs[0]!) < rows.indexOf(call)) return false
    try {
      const args: unknown = JSON.parse(call.arguments)
      if (
        !object(args) ||
        typeof args.name !== 'string' ||
        !args.name.endsWith('__workitem_read_000')
      )
        return false
      const raw = outputs[0]!.output
      if (typeof raw !== 'string') return false
      let text = raw
      if (text.startsWith('<tool_output')) {
        const wrapped =
          /^<tool_output name="([^"]+)" sanitized="(?:true|false)">\n([\s\S]*)\n<\/tool_output>$/.exec(
            text
          )
        if (!wrapped || wrapped[1] !== args.name) return false
        text = wrapped[2]!
      }
      let value: unknown = JSON.parse(text)
      if (!object(value) || value.isError === true || value.is_error === true) return false
      if (Array.isArray(value.content)) {
        const block = value.content[0]
        if (
          value.content.length !== 1 ||
          !object(block) ||
          block.type !== 'text' ||
          typeof block.text !== 'string'
        )
          return false
        value = JSON.parse(block.text)
      }
      return (
        object(value) &&
        value.tool === 'workitem_read_000' &&
        typeof value.runId === 'string' &&
        Boolean(value.runId) &&
        (typeof value.callId === 'string' || typeof value.callId === 'number') &&
        typeof value.businessId === 'string' &&
        Boolean(value.businessId)
      )
    } catch {
      // An unconfirmed or malformed result must reach the real provider unchanged.
      return false
    }
  })
}

export function createRealHybridUpstream(forward: typeof fetch) {
  // Outages served per turn, so a replayed request cannot widen the outage.
  const injected = new Map<string, number>()
  const observedTools = new Map<string, Set<string>>()
  const counts = {
    forwarded: 0,
    injected503: 0,
    r1: 0,
    r2: 0,
    r1DistinctToolResults: 0,
    r2DistinctToolResults: 0,
  }
  const fetchFn: typeof fetch = async (input, init) => {
    if (
      requestUrl(input) === COMPLETIONS &&
      init?.method === 'POST' &&
      typeof init.body === 'string'
    ) {
      let payload: unknown
      try {
        payload = JSON.parse(init.body)
      } catch {
        // Preserve the original provider response for any unexpected body shape.
      }
      if (object(payload) && Array.isArray(payload.input) && payload.input.every(object)) {
        const history = payload.input
        const lastUser = history.findLastIndex(row => row.role === 'user')
        const prompt = history[lastUser]?.content
        const match = typeof prompt === 'string' ? HYBRID_TURN.exec(prompt) : null
        if (match) {
          const kind = match[1]!.toLowerCase() as 'r1' | 'r2'
          const key = `${kind}:${match[2]}`
          const ids = observedTools.get(key) ?? new Set<string>()
          for (const id of completedToolResults(history.slice(lastUser + 1))) ids.add(id)
          observedTools.set(key, ids)
          counts[
            `${kind}DistinctToolResults` as 'r1DistinctToolResults' | 'r2DistinctToolResults'
          ] = [...observedTools]
            .filter(([name]) => name.startsWith(`${kind}:`))
            .reduce((total, [, results]) => total + results.size, 0)
          const served = injected.get(key) ?? 0
          if (confirmedFixtureRead(history.slice(lastUser + 1)) && served < HYBRID_OUTAGES) {
            injected.set(key, served + 1)
            // Both counters move per injected response: the journey measured two
            // outages, however many attempts the Host needed to outlast them.
            counts.injected503++
            counts[kind]++
            return Response.json(
              { error: { code: 'server_is_overloaded', message: 'fixture provider unavailable' } },
              { status: 503 }
            )
          }
        }
      }
    }
    counts.forwarded++
    return forward(input, init)
  }
  return { fetchFn, evidence: () => ({ ...counts }) }
}
