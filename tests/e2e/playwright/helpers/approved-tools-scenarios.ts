// E2E_GUARDIAN_IPC_FLOW: configuration and read-only fixture evidence only.
export const catalogSizes = [83, 150, 250] as const

/**
 * The Control UI does not call control-api directly from the browser: every
 * request goes through its own Next.js proxy route, so `control-ui/lib/api.ts`
 * prepends `API_BASE`, which defaults to `/control-api` and is only overridden
 * by `NEXT_PUBLIC_CONTROL_API_BASE_URL`, which this deployment does not set.
 * A `page.waitForResponse` predicate therefore sees `/control-api/api/v1/...`
 * in `response.url()`, never the bare control-api path.
 *
 * That mismatch does not surface as a failed assertion but as a waiter that
 * never resolves, which reports as a timeout while the product flow succeeds —
 * the most expensive failure shape to read. Routing every browser-side matcher
 * through this helper keeps the prefix in one place.
 *
 * Direct HTTP callers (`helpers/api-client.ts`, `global-setup.ts`) talk to
 * control-api itself and correctly stay unprefixed; they must not use this.
 */
export const CONTROL_UI_API_PREFIX = '/control-api'

export function browserApiPath(path: string): string {
  if (!path.startsWith('/api/'))
    throw new Error(`browserApiPath expects a control-api path starting with /api/, got: ${path}`)
  return `${CONTROL_UI_API_PREFIX}${path}`
}
export type Scenario = {
  catalogSize: number
  runId: string
  agentName: string
  agentDisplayName: string
  connectorName: string
  contextName: string
  subscriptionName: string
  connectionKey: string
  modelName: string
  fixtureUrl: string
  upstreamEvidenceUrl: string
}
export type Evidence = {
  runId: string
  catalogSize: number
  calls: Array<{ runId: string; tool: string; callId: string | number; businessId: string }>
}
export type UpstreamEvidence = {
  rejected: number
  searchCalls: number
  describeCalls: number
  businessCalls: number
  finalResponses: number
  deniedResponses: number
  limitProbe: { turns: number; completions: number; unexpectedRetries: number }
  limitBoundary: {
    turns: number
    completions: number
    toolResults: number
    finalResponses: number
    unexpectedRetries: number
  }
  requests: Array<{
    definitionCount: number
    explicitNonStrictCount: number
    definitionBytes: number
    inputBytes: number
    connectorDefinitionCount: number
    leakedSchema: boolean
    stage: string
  }>
}
export function required(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`Missing required isolated-profile precondition: ${name}`)
  return value
}
export function localUrl(value: string): string {
  const url = new URL(value)
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    !url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  ) {
    throw new Error('Expected an explicit profile-owned loopback origin with port')
  }
  return url.origin
}
export function scenarios(): Scenario[] {
  const parsed: unknown = JSON.parse(required('APPROVED_TOOLS_SCENARIOS'))
  if (!Array.isArray(parsed) || parsed.length !== 3)
    throw new Error('Exactly three approved-tools scenarios required')
  const fields = [
    'runId',
    'agentName',
    'agentDisplayName',
    'connectorName',
    'contextName',
    'subscriptionName',
    'connectionKey',
    'modelName',
    'fixtureUrl',
  ] as const
  const rows = parsed as Scenario[]
  for (const row of rows) {
    for (const key of fields)
      if (typeof row[key] !== 'string' || !row[key].trim())
        throw new Error(`Scenario missing ${key}`)
    for (const key of ['runId', 'agentName', 'connectorName', 'contextName'] as const) {
      if (!/^[a-zA-Z0-9_-]{1,80}$/.test(row[key])) throw new Error(`Invalid scenario ${key}`)
    }
    localUrl(row.fixtureUrl)
    if (process.env.APPROVED_TOOLS_UPSTREAM_MODE === 'deterministic')
      localUrl(row.upstreamEvidenceUrl)
  }
  if (catalogSizes.some(size => rows.filter(row => row.catalogSize === size).length !== 1))
    throw new Error('Scenarios must cover 83, 150, 250 exactly once')
  for (const key of ['runId', 'agentName', 'contextName', 'connectorName', 'fixtureUrl'] as const) {
    if (new Set(rows.map(row => row[key])).size !== 3)
      throw new Error(`Scenarios must isolate ${key}`)
  }
  if (
    process.env.APPROVED_TOOLS_UPSTREAM_MODE === 'deterministic' &&
    new Set(rows.map(row => row.subscriptionName)).size !== 3
  )
    throw new Error('Deterministic UI-created subscriptions require unique names')
  return rows.sort((a, b) => a.catalogSize - b.catalogSize)
}
export async function readEvidence(scenario: Scenario): Promise<Evidence> {
  // Observes the external test MCP service; never creates business state.
  const url = new URL('/evidence', localUrl(scenario.fixtureUrl))
  url.searchParams.set('runId', scenario.runId)
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) })
  if (!response.ok) throw new Error(`Fixture evidence returned ${response.status}`)
  const evidence = (await response.json()) as Evidence
  if (
    evidence.runId !== scenario.runId ||
    evidence.catalogSize !== scenario.catalogSize ||
    !Array.isArray(evidence.calls)
  )
    throw new Error('Evidence scenario mismatch')
  return evidence
}

export async function readUpstreamEvidence(scenario: Scenario): Promise<UpstreamEvidence> {
  const response = await fetch(
    new URL('/approved-tools/evidence', localUrl(scenario.upstreamEvidenceUrl)),
    {
      signal: AbortSignal.timeout(10_000),
    }
  )
  if (!response.ok) throw new Error(`Isolated proxy evidence returned ${response.status}`)
  const evidence = (await response.json()) as UpstreamEvidence
  for (const field of [
    'rejected',
    'searchCalls',
    'describeCalls',
    'businessCalls',
    'finalResponses',
    'deniedResponses',
  ] as const) {
    if (!Number.isSafeInteger(evidence[field]) || evidence[field] < 0)
      throw new Error(`Missing upstream evidence ${field}`)
  }
  for (const field of ['turns', 'completions', 'unexpectedRetries'] as const) {
    const value = evidence.limitProbe?.[field]
    if (!Number.isSafeInteger(value) || value < 0)
      throw new Error(`Missing upstream limit probe evidence ${field}`)
  }
  for (const field of [
    'turns',
    'completions',
    'toolResults',
    'finalResponses',
    'unexpectedRetries',
  ] as const) {
    const value = evidence.limitBoundary?.[field]
    if (!Number.isSafeInteger(value) || value < 0)
      throw new Error(`Missing upstream limit boundary evidence ${field}`)
  }
  if (!Array.isArray(evidence.requests)) throw new Error('Missing upstream request evidence')
  return evidence
}
