/** One provider outage in the isolated E2E proxy image; all other requests use Codex. */
const COMPLETIONS = 'https://chatgpt.com/backend-api/codex/responses'
const HYBRID_TURN = /\bmodel step retry hybrid (r1|r2) ([a-z0-9][a-z0-9-]{7,63})(?![a-z0-9-])/i

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

export function createRealHybridUpstream(forward: typeof fetch) {
  const injected = new Set<string>()
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
    if (requestUrl(input) === COMPLETIONS && init?.method === 'POST' && typeof init.body === 'string') {
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
          const key = `${match[1]!.toLowerCase()}:${match[2]}`
          const ids = observedTools.get(key) ?? new Set<string>()
          for (const id of completedToolResults(history.slice(lastUser + 1))) ids.add(id)
          observedTools.set(key, ids)
          counts[`${match[1]!.toLowerCase()}DistinctToolResults` as
            | 'r1DistinctToolResults'
            | 'r2DistinctToolResults'] = [...observedTools]
            .filter(([name]) => name.startsWith(`${match[1]!.toLowerCase()}:`))
            .reduce((total, [, results]) => total + results.size, 0)
          if (ids.size > 0 && !injected.has(key)) {
            injected.add(key)
            counts.injected503++
            counts[match[1]!.toLowerCase() as 'r1' | 'r2']++
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
