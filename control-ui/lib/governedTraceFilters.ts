export const TRACE_TIME_WINDOWS = ['24h', '7d', '30d', 'custom'] as const

export type TraceTimeWindow = (typeof TRACE_TIME_WINDOWS)[number]
export type TraceExplorationFamily = 'sessions' | 'administrative' | 'infrastructure'
export type TraceFilterValues = Record<string, readonly string[]>

export type TraceExplorationState = {
  window: TraceTimeWindow
  from: string | null
  to: string | null
  filters: TraceFilterValues
}

export type TraceApiQuery = Record<string, string | undefined>

const TRACE_TIME_WINDOW_SET = new Set<string>(TRACE_TIME_WINDOWS)
const MAX_CUSTOM_WINDOW_MS = 30 * 24 * 60 * 60 * 1000

export const TRACE_FILTER_KEYS: Record<TraceExplorationFamily, readonly string[]> = {
  sessions: [
    'outcome',
    'sourceService',
    'sessionId',
    'hostRef',
    'humanUserId',
    'agentSub',
    'origin',
    'toolName',
    'approvalState',
  ],
  administrative: [
    'outcome',
    'sourceService',
    'operatorUserId',
    'delegatedActorSub',
    'action',
    'targetType',
    'targetRef',
    'targetUserId',
    'teamId',
  ],
  infrastructure: [
    'outcome',
    'sourceService',
    'telemetryType',
    'workloadKind',
    'workloadRef',
    'namespace',
    'clusterName',
    'controller',
    'reasonCode',
  ],
}

function normalizedValues(values: readonly string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))].sort()
}

export function parseTraceExplorationState(
  searchParams: Pick<URLSearchParams, 'get' | 'getAll'>,
  family: TraceExplorationFamily
): TraceExplorationState {
  const requestedWindow = searchParams.get('window')
  const window = TRACE_TIME_WINDOW_SET.has(requestedWindow ?? '')
    ? (requestedWindow as TraceTimeWindow)
    : '24h'
  const filters: TraceFilterValues = {}

  for (const key of TRACE_FILTER_KEYS[family]) {
    const values = searchParams.getAll(key).flatMap(value => value.split(','))
    const normalized = normalizedValues(values)
    if (normalized.length) filters[key] = normalized
  }

  return {
    window,
    from: window === 'custom' ? searchParams.get('from') : null,
    to: window === 'custom' ? searchParams.get('to') : null,
    filters,
  }
}

export function traceExplorationStateKey(state: TraceExplorationState): string {
  return JSON.stringify({
    window: state.window,
    from: state.from,
    to: state.to,
    filters: Object.fromEntries(
      Object.entries(state.filters)
        .filter(([, values]) => values.length)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, values]) => [key, normalizedValues(values)])
    ),
  })
}

export function buildTraceExplorationUrl(pathname: string, state: TraceExplorationState): string {
  const params = new URLSearchParams()
  params.set('window', state.window)
  if (state.window === 'custom') {
    if (state.from) params.set('from', state.from)
    if (state.to) params.set('to', state.to)
  }
  for (const [key, values] of Object.entries(state.filters).sort(([left], [right]) =>
    left.localeCompare(right)
  )) {
    const normalized = normalizedValues(values)
    if (normalized.length) params.set(key, normalized.join(','))
  }
  return `${pathname}?${params.toString()}`
}

export function withTraceFilter(
  state: TraceExplorationState,
  key: string,
  values: readonly string[]
): TraceExplorationState {
  const filters = { ...state.filters }
  const normalized = normalizedValues(values)
  if (normalized.length) filters[key] = normalized
  else delete filters[key]
  return { ...state, filters }
}

export function withoutTraceFilter(
  state: TraceExplorationState,
  key: string
): TraceExplorationState {
  return withTraceFilter(state, key, [])
}

export function clearTraceFilters(state: TraceExplorationState): TraceExplorationState {
  return { ...state, filters: {} }
}

export function traceActiveFilterCount(state: TraceExplorationState): number {
  return Object.values(state.filters).filter(values => values.length).length
}

export function traceWindowLabel(window: TraceTimeWindow): string {
  if (window === '24h') return 'Last 24 hours'
  if (window === '7d') return 'Last 7 days'
  if (window === '30d') return 'Last 30 days'
  return 'Custom UTC range'
}

export function traceApiQuery(
  state: TraceExplorationState,
  capturedNow = new Date()
): { query: TraceApiQuery | null; error: string | null } {
  let occurredFrom: Date
  let occurredTo: Date

  if (state.window === 'custom') {
    occurredFrom = new Date(state.from ?? '')
    occurredTo = new Date(state.to ?? '')
    if (!Number.isFinite(occurredFrom.getTime()) || !Number.isFinite(occurredTo.getTime())) {
      return { query: null, error: 'Choose both start and end values for the custom UTC range.' }
    }
    if (occurredFrom >= occurredTo) {
      return { query: null, error: 'The custom UTC start must be earlier than the end.' }
    }
    if (occurredTo.getTime() - occurredFrom.getTime() > MAX_CUSTOM_WINDOW_MS) {
      return { query: null, error: 'The custom UTC range cannot exceed 30 days.' }
    }
  } else {
    occurredTo = capturedNow
    const hours = state.window === '24h' ? 24 : state.window === '7d' ? 7 * 24 : 30 * 24
    occurredFrom = new Date(occurredTo.getTime() - hours * 60 * 60 * 1000)
  }

  const query: TraceApiQuery = {
    occurredFrom: occurredFrom.toISOString(),
    occurredTo: occurredTo.toISOString(),
  }
  for (const [key, values] of Object.entries(state.filters)) {
    const normalized = normalizedValues(values)
    if (normalized.length) query[key] = normalized.join(',')
  }
  return { query, error: null }
}
