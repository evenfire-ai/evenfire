import type { DbClient } from '../../db.js'
import { GOVERNED_EVENT_FAMILIES } from './contracts.js'
import type {
  GovernedEventFamily,
  GovernedEventReadRepositoryQueryV1,
  GovernedEventReadRepositoryV1,
  GovernedEventReadRowV1,
} from './contracts.js'

function rowPayload(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      return {}
    }
  }
  return {}
}

function nullableText(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value)
}

function mapRow(row: Record<string, unknown>): GovernedEventReadRowV1 {
  const family = String(row.event_family) as GovernedEventFamily
  if (!GOVERNED_EVENT_FAMILIES.includes(family)) {
    throw new Error(`unknown governed event family from database: ${family}`)
  }
  return {
    streamSequence: String(row.stream_sequence),
    eventFamily: family,
    eventId: String(row.event_id),
    schemaVersion: Number(row.schema_version),
    occurredAt: new Date(row.occurred_at as string).toISOString(),
    ingestedAt: new Date(row.ingested_at as string).toISOString(),
    correlationRef: row.correlation_ref === null ? null : String(row.correlation_ref),
    sessionId:
      row.session_id === null || row.session_id === undefined ? null : String(row.session_id),
    actorKind: row.actor_kind === null ? null : String(row.actor_kind),
    actorSub: row.actor_sub === null ? null : String(row.actor_sub),
    serviceOrAgentSub: row.service_or_agent_sub === null ? null : String(row.service_or_agent_sub),
    initiatingHumanSub: row.initiating_human_sub === null ? null : String(row.initiating_human_sub),
    actingAgentSub: row.acting_agent_sub === null ? null : String(row.acting_agent_sub),
    resourceAud: row.resource_aud === null ? null : String(row.resource_aud),
    effectiveScopes: Array.isArray(row.effective_scopes)
      ? row.effective_scopes.map(scope => String(scope))
      : [],
    authorizationDecision:
      row.authorization_decision === null ? null : String(row.authorization_decision),
    decisionActorSub: row.decision_actor_sub === null ? null : String(row.decision_actor_sub),
    tokenExchangeId: row.token_exchange_id === null ? null : String(row.token_exchange_id),
    eventType: String(row.event_type),
    outcome: row.outcome === null ? null : String(row.outcome),
    targetType: row.target_type === null ? null : String(row.target_type),
    targetRef: row.target_ref === null ? null : String(row.target_ref),
    recipeNamespace: row.recipe_namespace === null ? null : String(row.recipe_namespace),
    recipeName: row.recipe_name === null ? null : String(row.recipe_name),
    hostRef: row.host_ref === null ? null : String(row.host_ref),
    operatorUserId: nullableText(row.operator_user_id),
    operatorPrincipalId: nullableText(row.operator_principal_id),
    operatorPrincipalKind: String(
      row.operator_principal_kind ?? 'unresolved'
    ) as GovernedEventReadRowV1['operatorPrincipalKind'],
    operatorDisplayName: nullableText(row.operator_display_name),
    delegatedActorSub: nullableText(row.delegated_actor_sub),
    sourceKind: nullableText(row.source_kind),
    sourceService: nullableText(row.source_service),
    serviceSub: nullableText(row.service_sub),
    targetUserId: nullableText(row.target_user_id),
    targetUserSub: nullableText(row.target_user_sub),
    targetUserDisplayName: nullableText(row.target_user_display_name),
    teamId: nullableText(row.team_id),
    targetTeamDisplayName: nullableText(row.target_team_display_name),
    telemetryType: nullableText(row.telemetry_type),
    reasonCode: nullableText(row.reason_code),
    clusterName: nullableText(row.cluster_name),
    namespace: nullableText(row.namespace),
    workloadKind: nullableText(row.workload_kind),
    workloadRef: nullableText(row.workload_ref),
    controller: nullableText(row.controller),
    payload: rowPayload(row.payload),
  }
}

function requirePositiveSequence(value: string, field: string, allowZero = false): void {
  if (!/^\d+$/.test(value) || (!allowZero && BigInt(value) < 1n)) {
    throw new Error(`${field} must be a decimal stream sequence`)
  }
}

export class PostgresGovernedEventReadRepository implements GovernedEventReadRepositoryV1 {
  constructor(private readonly db: DbClient) {}

  async captureHighWatermark(): Promise<string> {
    const result = await this.db.query(
      'SELECT COALESCE(MAX(stream_sequence), 0)::text AS high_watermark FROM governed_event_stream'
    )
    return String((result.rows[0] as Record<string, unknown> | undefined)?.high_watermark ?? '0')
  }

  async readAfter(query: GovernedEventReadRepositoryQueryV1): Promise<GovernedEventReadRowV1[]> {
    requirePositiveSequence(query.afterSequence, 'afterSequence', true)
    requirePositiveSequence(query.highWatermark, 'highWatermark', true)
    if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 200) {
      throw new Error('governed event read limit must be between 1 and 200')
    }

    const values: unknown[] = [query.afterSequence, query.highWatermark]
    const sequenceOperator = query.order === 'latest' ? '<' : '>'
    const orderDirection = query.order === 'latest' ? 'DESC' : 'ASC'
    const predicates = [
      `s.stream_sequence ${sequenceOperator} $1::bigint`,
      's.stream_sequence <= $2::bigint',
    ]
    const bind = (value: unknown): string => {
      values.push(value)
      return `$${values.length}`
    }

    if (query.families.length > 0) {
      predicates.push(`s.event_family = ANY(${bind(query.families)}::text[])`)
    }
    if (query.occurredFrom) predicates.push(`s.occurred_at >= ${bind(query.occurredFrom)}`)
    if (query.occurredTo) predicates.push(`s.occurred_at <= ${bind(query.occurredTo)}`)
    const filter = (
      values: readonly string[] | undefined,
      expression: (placeholder: string) => string
    ) => {
      if (values && values.length > 0) predicates.push(expression(bind(values)))
    }
    const filters = query.filters ?? {}
    filter(
      filters.outcome,
      p =>
        `EXISTS (SELECT 1 FROM governed_event_read_v1 f WHERE f.event_family=s.event_family AND f.event_id=s.event_id AND f.outcome=ANY(${p}::text[]))`
    )
    filter(
      filters.sourceService,
      p =>
        `EXISTS (SELECT 1 FROM governed_event_read_v1 f WHERE f.event_family=s.event_family AND f.event_id=s.event_id AND f.service_or_agent_ref=ANY(${p}::text[]))`
    )
    const adminFilter = (values: readonly string[] | undefined, expression: string) =>
      filter(
        values,
        p =>
          `EXISTS (SELECT 1 FROM administrative_events f WHERE s.event_family='administrative' AND f.event_id=s.event_id AND ${expression}=ANY(${p}::text[]))`
      )
    adminFilter(filters.operatorUserId, 'COALESCE(f.operator_user_id::text, f.operator_sub)')
    adminFilter(filters.delegatedActorSub, 'f.delegated_actor_sub')
    adminFilter(filters.action, 'f.action')
    adminFilter(filters.targetType, 'f.target_type')
    adminFilter(filters.targetRef, 'f.target_ref')
    adminFilter(filters.targetUserId, 'f.target_user_id::text')
    adminFilter(filters.teamId, 'f.team_id')
    const infraFilter = (values: readonly string[] | undefined, column: string) =>
      filter(
        values,
        p =>
          `EXISTS (SELECT 1 FROM infrastructure_telemetry_events f WHERE s.event_family='infrastructure_telemetry' AND f.event_id=s.event_id AND f.${column}=ANY(${p}::text[]))`
      )
    infraFilter(filters.telemetryType, 'telemetry_type')
    infraFilter(filters.workloadKind, 'workload_kind')
    infraFilter(filters.workloadRef, 'workload_ref')
    infraFilter(filters.namespace, 'namespace')
    infraFilter(filters.clusterName, 'cluster_name')
    infraFilter(filters.controller, 'source_service')
    infraFilter(filters.reasonCode, 'reason_code')

    switch (query.scope.kind) {
      case 'stream':
        break
      case 'workflow_run':
      case 'host_run':
        predicates.push(`s.run_id = ${bind(query.scope.runId)}`)
        break
      case 'workload':
        predicates.push(`s.workload_ref = ${bind(query.scope.workloadRef)}`)
        break
      default:
        throw new Error('run reads require a workflow_run or host_run scope')
    }
    values.push(query.limit)
    const limitPlaceholder = `$${values.length}`

    const result = await this.db.query(
      `WITH stream_page AS MATERIALIZED (
         SELECT s.stream_sequence, s.event_family, s.event_id
           FROM governed_event_stream s
          WHERE ${predicates.join('\n            AND ')}
          ORDER BY s.stream_sequence ${orderDirection}
          LIMIT ${limitPlaceholder}
       )
       SELECT p.stream_sequence, v.event_family, v.event_id, v.schema_version,
              v.occurred_at, v.ingested_at, v.correlation_ref, agent.session_id,
              v.actor_kind, v.actor_sub, v.service_or_agent_ref AS service_or_agent_sub,
              v.initiating_human_sub, v.acting_agent_sub, v.resource_aud,
              v.effective_scopes, v.authorization_decision, v.token_exchange_id,
              v.decision_actor_sub,
              v.event_type, v.outcome, admin.target_type, v.target_ref,
              agent.recipe_namespace, agent.recipe_name, agent.host_ref,
              admin.operator_user_id::text,
              CASE
                WHEN operator_user.id IS NOT NULL AND operator_admin.id IS NULL
                  THEN COALESCE(operator_profile.display_name, operator_user.name, operator_user.email)
                WHEN operator_admin.id IS NOT NULL AND operator_user.id IS NULL
                  THEN COALESCE(operator_admin.username, operator_admin.email)
                ELSE NULL
              END AS operator_display_name,
              CASE
                WHEN operator_user.id IS NOT NULL AND operator_admin.id IS NULL THEN 'platform_user'
                WHEN operator_admin.id IS NOT NULL AND operator_user.id IS NULL THEN 'control_admin'
                WHEN admin.operator_sub IS NULL AND admin.operator_user_id IS NULL THEN 'system'
                ELSE 'unresolved'
              END AS operator_principal_kind,
              CASE
                WHEN (operator_user.id IS NOT NULL) <> (operator_admin.id IS NOT NULL)
                  THEN COALESCE(admin.operator_user_id::text, admin.operator_sub)
                ELSE NULL
              END AS operator_principal_id,
              admin.delegated_actor_sub,
              COALESCE(agent.source_kind, admin.source_kind, telemetry.source_kind) AS source_kind,
              COALESCE(agent.source_service, admin.source_service, telemetry.source_service) AS source_service,
              admin.service_sub,
              admin.target_user_id::text, admin.target_human_sub AS target_user_sub, admin.team_id,
              COALESCE(
                target_profile.display_name,
                target_user.name,
                target_user.email,
                target_admin.username,
                target_admin.email
              ) AS target_user_display_name,
              target_team.name AS target_team_display_name,
              telemetry.telemetry_type, telemetry.reason_code, telemetry.cluster_name,
              telemetry.namespace, telemetry.workload_kind, telemetry.workload_ref,
              telemetry.source_service AS controller,
              CASE
                WHEN p.event_family = 'infrastructure_telemetry' THEN
                  COALESCE(v.safe_payload, '{}'::jsonb) || jsonb_strip_nulls(jsonb_build_object(
                    'trigger_kind', telemetry.trigger_kind,
                    'reason_code', telemetry.reason_code,
                    'environment', telemetry.environment,
                    'cluster_name', telemetry.cluster_name,
                    'namespace', telemetry.namespace,
                    'workload_kind', telemetry.workload_kind,
                    'workload_ref', telemetry.workload_ref,
                    'kubernetes_kind', telemetry.kubernetes_kind,
                    'kubernetes_name', telemetry.kubernetes_name,
                    'interval_start', telemetry.interval_start,
                    'interval_end', telemetry.interval_end,
                    'desired_replicas', telemetry.desired_replicas,
                    'observed_replicas', telemetry.observed_replicas,
                    'ready_replicas', telemetry.ready_replicas,
                    'cpu_request_cores', telemetry.cpu_request_cores::text,
                    'cpu_limit_cores', telemetry.cpu_limit_cores::text,
                    'memory_request_bytes', telemetry.memory_request_bytes::text,
                    'memory_limit_bytes', telemetry.memory_limit_bytes::text,
                    'cpu_usage_core_seconds', telemetry.cpu_usage_core_seconds::text,
                    'memory_usage_byte_seconds', telemetry.memory_usage_byte_seconds::text
                  ))
                ELSE v.safe_payload
              END AS payload
         FROM stream_page p
         JOIN governed_event_read_v1 v
           ON v.event_family = p.event_family AND v.event_id = p.event_id
         LEFT JOIN agent_run_events agent
           ON p.event_family = 'agent_run' AND agent.event_id = p.event_id
         LEFT JOIN administrative_events admin
           ON p.event_family = 'administrative' AND admin.event_id = p.event_id
         LEFT JOIN users operator_user ON operator_user.id = COALESCE(
           admin.operator_user_id,
           CASE
             WHEN admin.operator_sub ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
               THEN admin.operator_sub::uuid
             ELSE NULL
           END
         )
         LEFT JOIN profiles operator_profile ON operator_profile.user_id = operator_user.id
         LEFT JOIN control_admin_users operator_admin ON operator_admin.id = COALESCE(
           admin.operator_user_id,
           CASE
             WHEN admin.operator_sub ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
               THEN admin.operator_sub::uuid
             ELSE NULL
           END
         )
         LEFT JOIN users target_user ON target_user.id = admin.target_user_id
         LEFT JOIN profiles target_profile ON target_profile.user_id = target_user.id
         LEFT JOIN control_admin_users target_admin ON target_admin.id = CASE
           WHEN admin.target_type = 'control_admin'
            AND admin.target_human_sub ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
             THEN admin.target_human_sub::uuid
           ELSE NULL
         END
         LEFT JOIN teams target_team ON target_team.id = CASE
           WHEN admin.team_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
             THEN admin.team_id::uuid
           ELSE NULL
         END
         LEFT JOIN infrastructure_telemetry_events telemetry
           ON p.event_family = 'infrastructure_telemetry' AND telemetry.event_id = p.event_id
        ORDER BY p.stream_sequence ${orderDirection}`,
      values
    )
    return (result.rows as Record<string, unknown>[]).map(mapRow)
  }
}
