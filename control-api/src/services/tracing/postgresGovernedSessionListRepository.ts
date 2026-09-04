import type { DbClient } from '../../db.js'
import type {
  GovernedTraceOrigin,
  GovernedTraceSessionSummaryV1,
  GovernedTraceSessionTokenUsageV1,
} from './contracts.js'

export type SessionReplayFilters = {
  occurredFrom: string
  occurredTo: string
  outcome: string[]
  sourceService: string[]
  sessionId: string[]
  hostRef: string[]
  humanUserId: string[]
  agentSub: string[]
  origin: GovernedTraceOrigin[]
  toolName: string[]
  approvalState: Array<'requested' | 'approved' | 'denied'>
}

export type SessionPageAnchor = { occurredAt: string; hostRef: string; sessionId: string }
export type SessionRepositoryPage = {
  summaries: GovernedTraceSessionSummaryV1[]
  anchors: SessionPageAnchor[]
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : []
}

function tokenCoverage(
  observedLlmCalls: number,
  meteredCalls: number
): GovernedTraceSessionTokenUsageV1['coverage'] {
  if (observedLlmCalls === 0 && meteredCalls === 0) return 'not_applicable'
  if (meteredCalls === 0) return 'unavailable'
  return meteredCalls >= observedLlmCalls && observedLlmCalls > 0 ? 'complete' : 'partial'
}

function cacheReporting(
  meteredCalls: number,
  cacheReportedCalls: number
): GovernedTraceSessionTokenUsageV1['cacheReporting'] {
  if (meteredCalls === 0) return 'not_applicable'
  if (cacheReportedCalls === 0) return 'unavailable'
  return cacheReportedCalls >= meteredCalls ? 'complete' : 'partial'
}

export class PostgresGovernedSessionListRepository {
  constructor(private readonly db: DbClient) {}

  async captureHighWatermark(): Promise<string> {
    const result = await this.db.query(
      'SELECT COALESCE(MAX(stream_sequence), 0)::text AS high_watermark FROM governed_event_stream'
    )
    return String(
      (result.rows[0] as { high_watermark?: string } | undefined)?.high_watermark ?? '0'
    )
  }

  async list(params: {
    filters: SessionReplayFilters
    highWatermark: string
    after: SessionPageAnchor | null
    limit: number
    promptState: 'enabled' | 'disabled' | 'unavailable'
    order: 'oldest' | 'latest'
  }): Promise<SessionRepositoryPage> {
    const values: unknown[] = [
      params.highWatermark,
      params.filters.occurredFrom,
      params.filters.occurredTo,
    ]
    const basePredicates = [
      's.stream_sequence <= $1::bigint',
      'a.occurred_at >= $2::timestamptz',
      'a.occurred_at <= $3::timestamptz',
      'a.host_ref IS NOT NULL',
      'a.session_id IS NOT NULL',
    ]
    const candidatePredicates: string[] = []
    const bind = (value: unknown) => {
      values.push(value)
      return `$${values.length}`
    }
    const any = (column: string, value: string[]) => {
      if (value.length > 0) {
        candidatePredicates.push(`bool_or(${column} = ANY(${bind(value)}::text[]))`)
      }
    }
    any('a.outcome', params.filters.outcome)
    any('a.source_service', params.filters.sourceService)
    any('a.session_id', params.filters.sessionId)
    any('a.host_ref', params.filters.hostRef)
    any('COALESCE(a.user_id, b.user_id::text)', params.filters.humanUserId)
    any('a.agent_sub', params.filters.agentSub)
    any('a.origin', params.filters.origin)
    any("a.payload_metadata->>'tool_name'", params.filters.toolName)
    if (params.filters.approvalState.length > 0) {
      const statePredicates: string[] = []
      if (params.filters.approvalState.includes('requested')) {
        statePredicates.push("a.decision = 'require_approval'")
      }
      if (params.filters.approvalState.includes('approved')) {
        statePredicates.push("a.outcome = 'approved'")
      }
      if (params.filters.approvalState.includes('denied')) {
        statePredicates.push("a.outcome = 'denied'")
      }
      candidatePredicates.push(
        `bool_or(a.event_type = 'approval' AND (${statePredicates.join(' OR ')}))`
      )
    }
    let pagePredicate = ''
    const pageOperator = params.order === 'latest' ? '<' : '>'
    const orderDirection = params.order === 'latest' ? 'DESC' : 'ASC'
    if (params.after) {
      pagePredicate = `WHERE (last_occurred_at, host_ref, session_id) ${pageOperator}
        (${bind(params.after.occurredAt)}::timestamptz, ${bind(params.after.hostRef)}, ${bind(params.after.sessionId)})`
    }
    values.push(params.limit)
    const result = await this.db.query(
      `WITH candidate_sessions AS MATERIALIZED (
         SELECT a.host_ref, a.session_id
           FROM governed_event_stream s
           JOIN agent_run_events a
             ON s.event_family = 'agent_run' AND s.event_id = a.event_id
      LEFT JOIN governed_run_attribution_bindings b ON b.run_id = a.run_id
          WHERE ${basePredicates.join('\n            AND ')}
          GROUP BY a.host_ref, a.session_id
          ${candidatePredicates.length > 0 ? `HAVING ${candidatePredicates.join('\n             AND ')}` : ''}
       ), grouped AS (
         SELECT a.host_ref, a.session_id,
                MIN(a.occurred_at) AS first_occurred_at,
                MAX(a.occurred_at) AS last_occurred_at,
                array_agg(DISTINCT a.origin ORDER BY a.origin) AS origins,
                COUNT(DISTINCT a.run_id)::int AS run_count,
                COUNT(*)::int AS event_count,
                COALESCE(
                  (array_agg(a.outcome ORDER BY a.occurred_at DESC, a.ingest_sequence DESC)
                    FILTER (WHERE a.event_type = 'run_end'))[1],
                  (array_agg(a.outcome ORDER BY a.occurred_at DESC, a.ingest_sequence DESC)
                    FILTER (WHERE a.event_type = 'run_start'))[1],
                  'unknown'
                ) AS latest_run_outcome,
                array_remove(array_agg(DISTINCT a.agent_sub), NULL) AS agent_subjects,
                array_remove(array_agg(DISTINCT COALESCE(a.actor_human_sub, b.actor_human_sub)), NULL) AS human_subjects,
                array_remove(array_agg(DISTINCT COALESCE(a.user_id, b.user_id::text)), NULL) AS human_user_ids,
                array_remove(array_agg(DISTINCT COALESCE(a.identity_issuer, b.identity_issuer)), NULL) AS identity_issuers,
                MAX(COALESCE(p.display_name, u.name, u.email)) AS human_display_name,
                bool_or(a.actor_human_sub IS NOT NULL) AS event_human_verified,
                COUNT(*) FILTER (WHERE a.event_type = 'tool_call')::int AS tool_calls,
                COUNT(DISTINCT a.payload_metadata->>'tool_name')
                  FILTER (WHERE a.event_type = 'tool_call')::int AS distinct_tools,
                COUNT(*) FILTER (WHERE a.event_type = 'tool_call' AND a.payload_metadata->>'tool_kind' = 'internal_tool')::int AS internal_tool_calls,
                COUNT(*) FILTER (WHERE a.event_type = 'tool_call' AND a.payload_metadata->>'tool_kind' = 'mcp_server_tool')::int AS mcp_server_tool_calls,
                COUNT(*) FILTER (WHERE a.event_type = 'tool_call' AND a.payload_metadata->>'tool_kind' = 'workflow')::int AS workflow_tool_calls,
                COUNT(*) FILTER (
                  WHERE a.event_type = 'tool_call'
                    AND COALESCE(a.payload_metadata->>'tool_kind', '') NOT IN ('internal_tool', 'mcp_server_tool', 'workflow')
                )::int AS unclassified_tool_calls,
                COUNT(*) FILTER (WHERE a.event_type = 'llm_call')::int AS observed_llm_calls,
                COUNT(*) FILTER (WHERE a.event_type = 'token_usage')::int AS metered_token_calls,
                COUNT(*) FILTER (
                  WHERE a.event_type = 'token_usage'
                    AND a.payload_metadata->>'cache_tokens_reported' = 'true'
                )::int AS cache_reported_calls,
                COALESCE(SUM((a.payload_metadata->>'input_tokens')::bigint)
                  FILTER (WHERE a.event_type = 'token_usage'), 0)::text AS input_tokens,
                COALESCE(SUM((a.payload_metadata->>'output_tokens')::bigint)
                  FILTER (WHERE a.event_type = 'token_usage'), 0)::text AS output_tokens,
                COALESCE(SUM((a.payload_metadata->>'cache_read_tokens')::bigint)
                  FILTER (WHERE a.event_type = 'token_usage'), 0)::text AS cache_read_tokens,
                COALESCE(SUM((a.payload_metadata->>'cache_write_tokens')::bigint)
                  FILTER (WHERE a.event_type = 'token_usage'), 0)::text AS cache_write_tokens,
                COUNT(*) FILTER (WHERE a.event_type = 'approval' AND a.decision = 'require_approval')::int AS approvals_requested,
                COUNT(*) FILTER (WHERE a.event_type = 'approval' AND a.outcome = 'approved')::int AS approvals_approved,
                COUNT(*) FILTER (WHERE a.event_type = 'approval' AND a.outcome = 'denied')::int AS approvals_denied,
                COUNT(ph.approval_request_id) FILTER (WHERE ph.expires_at > clock_timestamp())::int AS prompt_count
           FROM candidate_sessions candidates
           JOIN agent_run_events a
             ON a.host_ref = candidates.host_ref AND a.session_id = candidates.session_id
           JOIN governed_event_stream s
             ON s.event_family = 'agent_run' AND s.event_id = a.event_id
      LEFT JOIN governed_run_attribution_bindings b ON b.run_id = a.run_id
      LEFT JOIN users u ON u.id = COALESCE(
        CASE
          WHEN a.user_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            THEN a.user_id::uuid
          ELSE NULL
        END,
        b.user_id
      )
      LEFT JOIN profiles p ON p.user_id = u.id
      LEFT JOIN governed_approval_prompt_history ph ON ph.approval_request_id = a.approval_request_id
          WHERE ${basePredicates.join('\n            AND ')}
          GROUP BY a.host_ref, a.session_id
       )
       SELECT * FROM grouped ${pagePredicate}
       ORDER BY last_occurred_at ${orderDirection}, host_ref ${orderDirection}, session_id ${orderDirection}
       LIMIT $${values.length}`,
      values
    )
    const summaries: GovernedTraceSessionSummaryV1[] = []
    const anchors: SessionPageAnchor[] = []
    for (const row of result.rows as Array<Record<string, unknown>>) {
      const agents = strings(row.agent_subjects)
      const humans = strings(row.human_subjects)
      const userIds = strings(row.human_user_ids)
      const issuers = strings(row.identity_issuers)
      const promptHistory =
        params.promptState === 'disabled'
          ? 'disabled'
          : params.promptState === 'unavailable'
            ? 'unavailable'
            : Number(row.prompt_count) > 0
              ? 'available'
              : 'none'
      const lastOccurredAt = new Date(String(row.last_occurred_at)).toISOString()
      const observedLlmCalls = Number(row.observed_llm_calls)
      const meteredCalls = Number(row.metered_token_calls)
      const cacheReportedCalls = Number(row.cache_reported_calls)
      const inputTokens = Number(row.input_tokens)
      const outputTokens = Number(row.output_tokens)
      summaries.push({
        hostRef: String(row.host_ref),
        sessionId: String(row.session_id),
        origins: strings(row.origins) as GovernedTraceOrigin[],
        firstOccurredAt: new Date(String(row.first_occurred_at)).toISOString(),
        lastOccurredAt,
        runCount: Number(row.run_count),
        eventCount: Number(row.event_count),
        latestRunOutcome:
          row.latest_run_outcome as GovernedTraceSessionSummaryV1['latestRunOutcome'],
        agent: {
          status: agents.length === 0 ? 'unavailable' : agents.length === 1 ? 'verified' : 'mixed',
          subject: agents.length === 1 ? agents[0]! : null,
          displayName: agents.length === 1 ? String(row.host_ref) : null,
        },
        human: {
          status:
            humans.length === 0
              ? 'unavailable'
              : humans.length > 1
                ? 'mixed'
                : row.event_human_verified
                  ? 'verified'
                  : 'verified_late',
          subject: humans.length === 1 ? humans[0]! : null,
          userId: userIds.length === 1 ? userIds[0]! : null,
          displayName:
            userIds.length === 1 && row.human_display_name ? String(row.human_display_name) : null,
          identityIssuer: issuers.length === 1 ? issuers[0]! : null,
        },
        tools: {
          totalCalls: Number(row.tool_calls),
          distinctTools: Number(row.distinct_tools),
          byKind: {
            internal_tool: Number(row.internal_tool_calls),
            mcp_server_tool: Number(row.mcp_server_tool_calls),
            workflow: Number(row.workflow_tool_calls),
            unclassified: Number(row.unclassified_tool_calls),
          },
        },
        tokenUsage: {
          observedLlmCalls,
          meteredCalls,
          coverage: tokenCoverage(observedLlmCalls, meteredCalls),
          inputTokens,
          outputTokens,
          cacheReadTokens: Number(row.cache_read_tokens),
          cacheWriteTokens: Number(row.cache_write_tokens),
          cacheReporting: cacheReporting(meteredCalls, cacheReportedCalls),
          totalTokens: inputTokens + outputTokens,
        },
        approvals: {
          requested: Number(row.approvals_requested),
          approved: Number(row.approvals_approved),
          denied: Number(row.approvals_denied),
          promptHistory,
        },
      })
      anchors.push({
        occurredAt: lastOccurredAt,
        hostRef: String(row.host_ref),
        sessionId: String(row.session_id),
      })
    }
    return { summaries, anchors }
  }
}
