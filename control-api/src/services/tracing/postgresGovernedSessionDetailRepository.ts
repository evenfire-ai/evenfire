import type { DbClient } from '../../db.js'
import type {
  GovernedToolKindRead,
  GovernedTraceOrigin,
  GovernedTraceSessionApprovalV1,
  GovernedTraceSessionInteractionV1,
  GovernedTraceSessionRunV1,
  GovernedTraceSessionTokenUsageV1,
  GovernedTraceSessionToolV1,
} from './contracts.js'
import { projectTraceSafeFields } from './traceSafeFieldProjection.js'

function toolKind(value: unknown): GovernedToolKindRead {
  return value === 'internal_tool' || value === 'mcp_server_tool' || value === 'workflow'
    ? value
    : 'unclassified'
}

export class PostgresGovernedSessionDetailRepository {
  constructor(private readonly db: DbClient) {}

  async readRuns(
    hostRef: string,
    sessionId: string,
    highWatermark: string
  ): Promise<GovernedTraceSessionRunV1[]> {
    const result = await this.db.query(
      `SELECT a.run_id::text AS run_id, MIN(a.occurred_at) AS started_at,
              MAX(a.occurred_at) FILTER (WHERE a.event_type = 'run_end') AS ended_at,
              COALESCE(
                (array_agg(a.outcome ORDER BY a.occurred_at DESC, a.ingest_sequence DESC)
                  FILTER (WHERE a.event_type='run_end'))[1],
                (array_agg(a.outcome ORDER BY a.occurred_at DESC, a.ingest_sequence DESC)
                  FILTER (WHERE a.event_type='run_start'))[1],
                'unknown'
              ) AS outcome,
              (array_agg(a.origin ORDER BY a.occurred_at))[1] AS origin,
              COUNT(*)::int AS event_count
         FROM governed_event_stream s
         JOIN agent_run_events a
           ON s.event_family='agent_run' AND s.event_id=a.event_id
        WHERE s.stream_sequence <= $3::bigint AND a.host_ref=$1 AND a.session_id=$2
        GROUP BY a.run_id ORDER BY MIN(a.occurred_at) DESC LIMIT 200`,
      [hostRef, sessionId, highWatermark]
    )
    return (result.rows as Array<Record<string, unknown>>).map(row => ({
      runId: String(row.run_id),
      startedAt: new Date(String(row.started_at)).toISOString(),
      endedAt: row.ended_at ? new Date(String(row.ended_at)).toISOString() : null,
      outcome: String(row.outcome),
      origin: String(row.origin) as GovernedTraceOrigin,
      eventCount: Number(row.event_count),
    }))
  }

  async readTools(
    hostRef: string,
    sessionId: string,
    highWatermark: string
  ): Promise<GovernedTraceSessionToolV1[]> {
    const result = await this.db.query(
      `SELECT a.payload_metadata->>'tool_name' AS tool_name,
              a.payload_metadata->>'tool_kind' AS tool_kind,
              a.payload_metadata->>'tool_source_ref' AS tool_source_ref,
              COUNT(*)::int AS total_calls,
              COUNT(*) FILTER (WHERE a.outcome='succeeded')::int AS succeeded,
              COUNT(*) FILTER (WHERE a.outcome='failed')::int AS failed,
              MIN(a.occurred_at) AS first_at, MAX(a.occurred_at) AS last_at
         FROM governed_event_stream s
         JOIN agent_run_events a
           ON s.event_family='agent_run' AND s.event_id=a.event_id
        WHERE s.stream_sequence <= $3::bigint AND a.host_ref=$1 AND a.session_id=$2
          AND a.event_type='tool_call' AND a.payload_metadata ? 'tool_name'
        GROUP BY a.payload_metadata->>'tool_name', a.payload_metadata->>'tool_kind',
                 a.payload_metadata->>'tool_source_ref'
        ORDER BY MAX(a.occurred_at) DESC LIMIT 200`,
      [hostRef, sessionId, highWatermark]
    )
    return (result.rows as Array<Record<string, unknown>>).map(row => ({
      toolName: String(row.tool_name),
      toolKind: toolKind(row.tool_kind),
      toolSourceRef: row.tool_source_ref ? String(row.tool_source_ref) : null,
      totalCalls: Number(row.total_calls),
      succeeded: Number(row.succeeded),
      failed: Number(row.failed),
      firstOccurredAt: new Date(String(row.first_at)).toISOString(),
      lastOccurredAt: new Date(String(row.last_at)).toISOString(),
    }))
  }

  async readApprovals(
    hostRef: string,
    sessionId: string,
    highWatermark: string,
    promptState: 'enabled' | 'disabled' | 'unavailable'
  ): Promise<GovernedTraceSessionApprovalV1[]> {
    const toolResult = await this.db.query(
      `SELECT a.approval_request_id::text, a.run_id::text,
              a.payload_metadata->>'tool_name' AS tool_name,
              a.payload_metadata->>'tool_kind' AS tool_kind,
              a.payload_metadata->>'tool_source_ref' AS tool_source_ref,
              MIN(a.occurred_at) FILTER (WHERE a.decision='require_approval') AS requested_at,
              MAX(a.occurred_at) FILTER (WHERE a.outcome IN ('approved','denied')) AS decided_at,
              (array_remove(array_agg(a.outcome ORDER BY a.occurred_at DESC, a.ingest_sequence DESC), NULL))[1] AS state,
              (array_remove(array_agg(a.decision_actor_sub ORDER BY a.occurred_at DESC, a.ingest_sequence DESC), NULL))[1] AS decision_actor_sub,
              bool_or(ph.approval_request_id IS NOT NULL AND ph.expires_at > clock_timestamp()) AS has_prompt,
              bool_or(ph.approval_request_id IS NOT NULL) AS has_prompt_record,
              bool_or(tc.outcome='succeeded') AS executed_succeeded,
              bool_or(tc.outcome='failed') AS executed_failed
         FROM governed_event_stream s
         JOIN agent_run_events a
           ON s.event_family='agent_run' AND s.event_id=a.event_id
    LEFT JOIN governed_approval_prompt_history ph
           ON ph.approval_request_id=a.approval_request_id
    LEFT JOIN (
              SELECT tc.*
                FROM governed_event_stream tcs
                JOIN agent_run_events tc
                  ON tcs.event_family='agent_run' AND tcs.event_id=tc.event_id
               WHERE tcs.stream_sequence <= $3::bigint
             ) tc ON tc.run_id=a.run_id
                  AND tc.host_ref=a.host_ref
                  AND tc.session_id=a.session_id
                  AND tc.event_type='tool_call'
                  AND tc.approval_request_id=a.approval_request_id
        WHERE s.stream_sequence <= $3::bigint
          AND a.host_ref=$1 AND a.session_id=$2 AND a.event_type='approval'
        GROUP BY a.approval_request_id, a.run_id, a.payload_metadata->>'tool_name',
                 a.payload_metadata->>'tool_kind', a.payload_metadata->>'tool_source_ref'
        ORDER BY MIN(a.occurred_at) DESC LIMIT 200`,
      [hostRef, sessionId, highWatermark]
    )
    const toolApprovals = (toolResult.rows as Array<Record<string, unknown>>).map(row => {
      const state =
        row.state === 'approved' || row.state === 'denied'
          ? row.state
          : row.requested_at
            ? 'requested'
            : 'unavailable'
      return {
        approvalRequestId: row.approval_request_id ? String(row.approval_request_id) : null,
        runId: String(row.run_id),
        source: 'tool',
        toolName: row.tool_name ? String(row.tool_name) : null,
        toolKind: toolKind(row.tool_kind),
        toolSourceRef: row.tool_source_ref ? String(row.tool_source_ref) : null,
        state,
        requestedAt: row.requested_at ? new Date(String(row.requested_at)).toISOString() : null,
        decidedAt: row.decided_at ? new Date(String(row.decided_at)).toISOString() : null,
        decisionActorSub: row.decision_actor_sub ? String(row.decision_actor_sub) : null,
        observedExecution: row.executed_failed
          ? 'failed'
          : row.executed_succeeded
            ? 'succeeded'
            : 'not_observed',
        promptHistory:
          promptState === 'disabled'
            ? 'disabled'
            : promptState === 'unavailable'
              ? 'unavailable'
              : row.has_prompt
                ? 'available'
                : row.has_prompt_record
                  ? 'expired'
                  : 'none',
      } as GovernedTraceSessionApprovalV1
    })
    const workflowResult = await this.db.query(
      `WITH session_runs AS MATERIALIZED (
         SELECT DISTINCT a.run_id
           FROM governed_event_stream s
           JOIN agent_run_events a
             ON s.event_family='agent_run' AND s.event_id=a.event_id
          WHERE s.stream_sequence <= $3::bigint
            AND a.host_ref=$1 AND a.session_id=$2
       )
       SELECT war.id::text AS approval_request_id, session_runs.run_id::text,
              war.requested_at, war.decided_at,
              war.decided_by_user_id AS decision_actor_sub, war.status,
              ph.approval_request_id IS NOT NULL AS has_prompt_record,
              ph.expires_at > clock_timestamp() AS has_prompt,
              wr.phase AS run_phase
         FROM session_runs
         JOIN workflow_approval_requests war
           ON war.bound_workflow_run_id=session_runs.run_id
           OR EXISTS (
                SELECT 1 FROM workflow_runs linked_run
                 WHERE linked_run.run_id=session_runs.run_id
                   AND linked_run.approval_request_id=war.id
              )
    LEFT JOIN workflow_runs wr
           ON wr.run_id=session_runs.run_id AND wr.approval_request_id=war.id
    LEFT JOIN governed_approval_prompt_history ph ON ph.approval_request_id=war.id
        ORDER BY war.requested_at DESC
        LIMIT 200`,
      [hostRef, sessionId, highWatermark]
    )
    const workflowApprovals = (workflowResult.rows as Array<Record<string, unknown>>).map(row => ({
      approvalRequestId: String(row.approval_request_id),
      runId: String(row.run_id),
      source: 'workflow' as const,
      toolName: null,
      toolKind: 'workflow' as const,
      toolSourceRef: 'workflow-control',
      state:
        row.status === 'approved' || row.status === 'consumed'
          ? ('approved' as const)
          : row.status === 'denied'
            ? ('denied' as const)
            : row.status === 'pending'
              ? ('requested' as const)
              : ('unavailable' as const),
      requestedAt: row.requested_at ? new Date(String(row.requested_at)).toISOString() : null,
      decidedAt: row.decided_at ? new Date(String(row.decided_at)).toISOString() : null,
      decisionActorSub: row.decision_actor_sub ? String(row.decision_actor_sub) : null,
      observedExecution:
        row.run_phase === 'Succeeded'
          ? ('succeeded' as const)
          : row.run_phase === 'Failed'
            ? ('failed' as const)
            : ('not_observed' as const),
      promptHistory:
        promptState === 'disabled'
          ? ('disabled' as const)
          : promptState === 'unavailable'
            ? ('unavailable' as const)
            : row.has_prompt
              ? ('available' as const)
              : row.has_prompt_record
                ? ('expired' as const)
                : ('none' as const),
    }))
    return [...toolApprovals, ...workflowApprovals]
      .sort((left, right) =>
        String(right.requestedAt ?? '').localeCompare(String(left.requestedAt ?? ''))
      )
      .slice(0, 200)
  }

  async readInteractions(params: {
    hostRef: string
    sessionId: string
    highWatermark: string
    after: string
    limit: number
  }): Promise<GovernedTraceSessionInteractionV1[]> {
    const result = await this.db.query(
      `SELECT s.stream_sequence::text, a.event_id::text, a.run_id::text, a.event_type,
              a.occurred_at, a.outcome, a.payload_metadata->>'tool_name' AS tool_name,
              a.payload_metadata->>'tool_kind' AS tool_kind,
              a.payload_metadata->>'tool_source_ref' AS tool_source_ref,
              a.approval_request_id::text, a.decision, a.decision_actor_sub,
              jsonb_strip_nulls(jsonb_build_object(
                'reason_code', a.payload_metadata->'reason_code',
                'error_class', a.payload_metadata->'error_class',
                'phase', a.payload_metadata->'phase',
                'state', a.payload_metadata->'state',
                'status', a.payload_metadata->'status',
                'transition', a.payload_metadata->'transition',
                'resource_class', a.payload_metadata->'resource_class',
                'unit', a.payload_metadata->'unit',
                'tool_name', a.payload_metadata->'tool_name',
                'tool_kind', a.payload_metadata->'tool_kind',
                'tool_source_ref', a.payload_metadata->'tool_source_ref',
                'model', a.payload_metadata->'model',
                'attempt', a.payload_metadata->'attempt',
                'count', a.payload_metadata->'count',
                'config_hash', a.payload_metadata->'config_hash'
              )) AS safe_fields
         FROM governed_event_stream s
         JOIN agent_run_events a
           ON s.event_family='agent_run' AND s.event_id=a.event_id
        WHERE s.stream_sequence > $3::bigint AND s.stream_sequence <= $4::bigint
          AND a.host_ref=$1 AND a.session_id=$2
        ORDER BY s.stream_sequence ASC LIMIT $5`,
      [params.hostRef, params.sessionId, params.after, params.highWatermark, params.limit]
    )
    return (result.rows as Array<Record<string, unknown>>).map(row => ({
      streamSequence: String(row.stream_sequence),
      eventId: String(row.event_id),
      runId: String(row.run_id),
      eventType: row.event_type as GovernedTraceSessionInteractionV1['eventType'],
      occurredAt: new Date(String(row.occurred_at)).toISOString(),
      outcome: String(row.outcome),
      toolName: row.tool_name ? String(row.tool_name) : null,
      toolKind: row.tool_name ? toolKind(row.tool_kind) : null,
      toolSourceRef: row.tool_source_ref ? String(row.tool_source_ref) : null,
      approvalRequestId: row.approval_request_id ? String(row.approval_request_id) : null,
      decision: String(row.decision),
      decisionActorSub: row.decision_actor_sub ? String(row.decision_actor_sub) : null,
      safeFields: projectTraceSafeFields(row.safe_fields, 'session'),
    }))
  }

  async readTokenUsagePoints(
    hostRef: string,
    sessionId: string,
    highWatermark: string
  ): Promise<Pick<GovernedTraceSessionTokenUsageV1, 'points' | 'pointsTruncated'>> {
    const result = await this.db.query(
      `SELECT s.stream_sequence::text, a.event_id::text, a.run_id::text,
              a.occurred_at, a.payload_metadata->>'provider' AS provider,
              a.payload_metadata->>'model' AS model,
              a.payload_metadata->>'source_kind' AS source_kind,
              a.payload_metadata->>'iteration' AS iteration,
              a.payload_metadata->>'input_tokens' AS input_tokens,
              a.payload_metadata->>'output_tokens' AS output_tokens,
              a.payload_metadata->>'cache_read_tokens' AS cache_read_tokens,
              a.payload_metadata->>'cache_write_tokens' AS cache_write_tokens,
              a.payload_metadata->>'cache_tokens_reported' AS cache_tokens_reported
         FROM governed_event_stream s
         JOIN agent_run_events a
           ON s.event_family='agent_run' AND s.event_id=a.event_id
        WHERE s.stream_sequence <= $3::bigint
          AND a.host_ref=$1 AND a.session_id=$2 AND a.event_type='token_usage'
        ORDER BY a.occurred_at DESC, a.ingest_sequence DESC
        LIMIT 201`,
      [hostRef, sessionId, highWatermark]
    )
    const pointsTruncated = result.rows.length > 200
    const points = (result.rows as Array<Record<string, unknown>>)
      .slice(0, 200)
      .map(row => ({
        streamSequence: String(row.stream_sequence),
        eventId: String(row.event_id),
        runId: String(row.run_id),
        occurredAt: new Date(String(row.occurred_at)).toISOString(),
        provider: String(row.provider),
        model: String(row.model),
        sourceKind: String(row.source_kind),
        iteration: row.iteration === null ? null : Number(row.iteration),
        inputTokens: Number(row.input_tokens),
        outputTokens: Number(row.output_tokens),
        cacheReadTokens: Number(row.cache_read_tokens),
        cacheWriteTokens: Number(row.cache_write_tokens),
        cacheTokensReported: row.cache_tokens_reported === 'true',
      }))
      .reverse()
    return { points, pointsTruncated }
  }
}
