import type { Request } from 'express'
import {
  GOVERNED_EVENT_FAMILIES,
  INFRASTRUCTURE_TELEMETRY_TYPES,
} from '../../../services/tracing/contracts.js'
import type {
  GovernedEventFamily,
  GovernedEventReadFiltersV1,
  GovernedEventReadQueryV1,
  GovernedReadScope,
} from '../../../services/tracing/contracts.js'

const MAX_LIMIT = 200
const MAX_CURSOR_LENGTH = 4096
const MAX_REFERENCE_LENGTH = 512
const MAX_WINDOW_MS = 31 * 24 * 60 * 60 * 1000
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const OUTCOMES = new Set([
  'started',
  'succeeded',
  'failed',
  'cancelled',
  'approved',
  'denied',
  'unknown',
  'attempted',
  'committed',
  'rejected',
  'healthy',
  'unhealthy',
  'stopped',
])
const ADMIN_ACTIONS = new Set([
  'agent_mutation',
  'host_mutation',
  'permission_grant',
  'permission_revoke',
  'delegated_resource_mutation',
  'folder_mutation',
  'resource_mutation',
  'configuration_mutation',
  'service_maintenance',
  'control_admin_deleted',
])
const ADMIN_TARGET_TYPES = new Set([
  'agent',
  'host',
  'permission',
  'delegated_resource',
  'folder',
  'resource',
  'configuration',
  'service',
  'control_admin',
])
const INFRA_WORKLOAD_KINDS = new Set([
  'Host',
  'McpServer',
  'WorkflowRecipe',
  'Deployment',
  'Service',
  'NetworkPolicy',
])
const INFRA_CONTROLLERS = new Set(['host-context-controller', 'workflow-recipes', 'control-api'])

type ParseError = { error: 'invalid_query'; detail: string }

export type QueryParseResult = GovernedEventReadQueryV1 | ParseError

function invalid(detail: string): ParseError {
  return { error: 'invalid_query', detail }
}

function isParseError(value: unknown): value is ParseError {
  return value !== null && typeof value === 'object' && 'error' in value
}

export function isInvalidTracingQuery(value: QueryParseResult): value is ParseError {
  return isParseError(value)
}

function singleQueryValue(req: Request, key: string): string | undefined | ParseError {
  const value = req.query[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string') return invalid(`${key} must be a single string`)
  return value
}

function parseFamilies(
  raw: string | undefined
): readonly GovernedEventFamily[] | undefined | ParseError {
  if (raw === undefined) return undefined
  const values = raw.split(',').map(value => value.trim())
  if (
    values.length === 0 ||
    values.length > GOVERNED_EVENT_FAMILIES.length ||
    values.some(value => !value)
  ) {
    return invalid('families must contain between one and three values')
  }
  if (values.some(value => !GOVERNED_EVENT_FAMILIES.includes(value as GovernedEventFamily))) {
    return invalid(`families must be drawn from: ${GOVERNED_EVENT_FAMILIES.join(', ')}`)
  }
  return [...new Set(values)] as GovernedEventFamily[]
}

function parseList(req: Request, key: string): readonly string[] | undefined | ParseError {
  const raw = singleQueryValue(req, key)
  if (isParseError(raw)) return raw
  if (raw === undefined) return undefined
  const values = [...new Set(raw.split(',').map(value => value.trim()))].sort()
  if (
    values.length < 1 ||
    values.length > 20 ||
    values.some(value => !value || value.length > MAX_REFERENCE_LENGTH || value.includes('\0'))
  ) {
    return invalid(`${key} must contain between one and twenty bounded values`)
  }
  return values
}

function parseTimeBounds(
  occurredFrom: string | undefined,
  occurredTo: string | undefined
): Pick<GovernedEventReadQueryV1, 'occurredFrom' | 'occurredTo'> | ParseError {
  if (occurredFrom === undefined && occurredTo === undefined) return {}
  if (!occurredFrom || !occurredTo) {
    return invalid('occurredFrom and occurredTo must be provided together')
  }
  const from = new Date(occurredFrom)
  const to = new Date(occurredTo)
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime())) {
    return invalid('occurredFrom and occurredTo must be ISO timestamps')
  }
  if (from >= to || to.getTime() - from.getTime() > MAX_WINDOW_MS) {
    return invalid('occurredFrom and occurredTo must describe a positive window of at most 31 days')
  }
  return { occurredFrom: from.toISOString(), occurredTo: to.toISOString() }
}

function validateCatalog(
  filters: GovernedEventReadFiltersV1,
  key: keyof GovernedEventReadFiltersV1,
  allowed: ReadonlySet<string>
): ParseError | null {
  const values = filters[key]
  return values?.some(value => !allowed.has(value))
    ? invalid(`${key} contains a value outside the supported catalog`)
    : null
}

export function requireBoundedPathValue(
  raw: string | undefined,
  field: string
): string | ParseError {
  const value = raw?.trim()
  if (!value) return invalid(`${field} is required`)
  if (value.length > MAX_REFERENCE_LENGTH)
    return invalid(`${field} exceeds ${MAX_REFERENCE_LENGTH} characters`)
  return value
}

export function parseBoundedReadQuery(
  req: Request,
  scope: GovernedReadScope,
  options: {
    defaultFamilies?: readonly GovernedEventFamily[]
    allowWorkloadRef?: boolean
    allowExplorationFilters?: boolean
  } = {}
): QueryParseResult {
  const allowedKeys = new Set([
    'limit',
    'cursor',
    'occurredFrom',
    'occurredTo',
    'families',
    'order',
  ])
  if (options.allowWorkloadRef) allowedKeys.add('workloadRef')
  const explorationKeys = [
    'outcome',
    'sourceService',
    'operatorUserId',
    'delegatedActorSub',
    'action',
    'targetType',
    'targetRef',
    'targetUserId',
    'teamId',
    'telemetryType',
    'workloadKind',
    'namespace',
    'clusterName',
    'controller',
    'reasonCode',
  ] as const
  if (options.allowExplorationFilters) explorationKeys.forEach(key => allowedKeys.add(key))
  const unexpectedKey = Object.keys(req.query).find(key => !allowedKeys.has(key))
  if (unexpectedKey) return invalid(`unsupported query parameter: ${unexpectedKey}`)

  const limitRaw = singleQueryValue(req, 'limit')
  if (isParseError(limitRaw)) return limitRaw
  let limit: number | undefined
  if (limitRaw !== undefined) {
    if (!/^\d+$/.test(limitRaw)) return invalid('limit must be an integer between 1 and 200')
    limit = Number(limitRaw)
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      return invalid('limit must be an integer between 1 and 200')
    }
  }

  const cursor = singleQueryValue(req, 'cursor')
  if (isParseError(cursor)) return cursor
  if (cursor !== undefined && (cursor.length === 0 || cursor.length > MAX_CURSOR_LENGTH)) {
    return invalid(`cursor must be between 1 and ${MAX_CURSOR_LENGTH} characters`)
  }

  const familiesRaw = singleQueryValue(req, 'families')
  if (isParseError(familiesRaw)) return familiesRaw
  const families = parseFamilies(familiesRaw)
  if (isParseError(families)) return families

  const order = singleQueryValue(req, 'order')
  if (isParseError(order)) return order
  if (order !== undefined && order !== 'oldest' && order !== 'latest') {
    return invalid('order must be oldest or latest')
  }

  const occurredFrom = singleQueryValue(req, 'occurredFrom')
  if (isParseError(occurredFrom)) return occurredFrom
  const occurredTo = singleQueryValue(req, 'occurredTo')
  if (isParseError(occurredTo)) return occurredTo
  const timeBounds = parseTimeBounds(occurredFrom, occurredTo)
  if ('error' in timeBounds) return timeBounds
  if (options.allowExplorationFilters && !timeBounds.occurredFrom) {
    return invalid('occurredFrom and occurredTo are required for event exploration')
  }

  const filters: GovernedEventReadFiltersV1 = {}
  if (options.allowExplorationFilters) {
    for (const key of explorationKeys) {
      const values = parseList(req, key)
      if (isParseError(values)) return values
      if (values) filters[key] = values
    }
    const effectiveFamilies = families ?? options.defaultFamilies ?? GOVERNED_EVENT_FAMILIES
    const adminKeys: Array<keyof GovernedEventReadFiltersV1> = [
      'operatorUserId',
      'delegatedActorSub',
      'action',
      'targetType',
      'targetRef',
      'targetUserId',
      'teamId',
    ]
    const infraKeys: Array<keyof GovernedEventReadFiltersV1> = [
      'telemetryType',
      'workloadKind',
      'workloadRef',
      'namespace',
      'clusterName',
      'controller',
      'reasonCode',
    ]
    if (
      adminKeys.some(key => filters[key]) &&
      (effectiveFamilies.length !== 1 || effectiveFamilies[0] !== 'administrative')
    ) {
      return invalid('administrative filters require families=administrative')
    }
    if (
      infraKeys.some(key => filters[key]) &&
      (effectiveFamilies.length !== 1 || effectiveFamilies[0] !== 'infrastructure_telemetry')
    ) {
      return invalid('infrastructure filters require families=infrastructure_telemetry')
    }
    for (const [key, catalog] of [
      ['outcome', OUTCOMES],
      ['action', ADMIN_ACTIONS],
      ['targetType', ADMIN_TARGET_TYPES],
      ['telemetryType', new Set<string>(INFRASTRUCTURE_TELEMETRY_TYPES)],
      ['workloadKind', INFRA_WORKLOAD_KINDS],
      ['controller', INFRA_CONTROLLERS],
    ] as const) {
      const catalogError = validateCatalog(filters, key, catalog)
      if (catalogError) return catalogError
    }
    for (const key of ['operatorUserId', 'targetUserId'] as const) {
      if (filters[key]?.some(value => !UUID_RE.test(value))) {
        return invalid(`${key} must contain canonical UUID values`)
      }
    }
  }

  return {
    scope,
    ...(limit === undefined ? {} : { limit }),
    ...(cursor === undefined ? {} : { cursor }),
    ...(order === undefined ? {} : { order }),
    ...((families ?? options.defaultFamilies)
      ? { families: families ?? options.defaultFamilies }
      : {}),
    ...timeBounds,
    ...(Object.keys(filters).length > 0 ? { filters } : {}),
  }
}

export function resolveEventsScope(req: Request): GovernedReadScope | ParseError {
  const workloadRef = singleQueryValue(req, 'workloadRef')
  if (isParseError(workloadRef)) return workloadRef
  if (workloadRef === undefined) return { kind: 'stream' }
  const bounded = requireBoundedPathValue(workloadRef, 'workloadRef')
  if (typeof bounded !== 'string') return bounded
  return { kind: 'workload', workloadRef: bounded }
}
