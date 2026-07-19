import type { Page } from '@playwright/test'
import { profilesSql, sqlLiteral } from './workflow-approval-quadrants/cluster.js'
import { CHATLLM_HOST_REF } from './workflowAgentChatTools.js'
import { E2E_EMAIL } from './workflowUi.js'

export type TraceRow = {
  eventType: 'approval' | 'tool_call'
  sessionId: string
  runId: string
  requestId: string
  outcome: string
  decision: string
  decisionActorSub: string | null
  eventHumanSub: string | null
  bindingHumanSub: string
  eventUserId: string | null
  bindingUserId: string
  toolName: string | null
  toolKind: string | null
  toolSourceRef: string | null
}

export type TerminalApproval = {
  requestId: string
  runId: string
  sessionId: string
  userId: string
}

export async function readActiveDesktopSessionId(page: Page): Promise<string> {
  const sessionId = await page.evaluate(
    hostRef => window.clerum.chat.getLastActive(hostRef),
    CHATLLM_HOST_REF
  )
  if (
    !sessionId ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sessionId)
  ) {
    throw new Error(`Desktop did not expose a valid active session ID for ${CHATLLM_HOST_REF}`)
  }
  return sessionId
}

export function readTraceRows(sessionId: string): TraceRow[] {
  const raw = profilesSql(`
    SELECT COALESCE(
      jsonb_agg(to_jsonb(events) ORDER BY events."streamSequence"::bigint),
      '[]'::jsonb
    )::text
      FROM (
        SELECT stream.stream_sequence::text AS "streamSequence",
               event.event_type AS "eventType",
               event.session_id AS "sessionId",
               event.run_id::text AS "runId",
               event.approval_request_id::text AS "requestId",
               event.outcome,
               event.decision,
               event.decision_actor_sub AS "decisionActorSub",
               event.actor_human_sub AS "eventHumanSub",
               binding.actor_human_sub AS "bindingHumanSub",
               event.user_id AS "eventUserId",
               binding.user_id::text AS "bindingUserId",
               event.payload_metadata->>'tool_name' AS "toolName",
               event.payload_metadata->>'tool_kind' AS "toolKind",
               event.payload_metadata->>'tool_source_ref' AS "toolSourceRef"
          FROM governed_event_stream stream
          JOIN agent_run_events event
            ON stream.event_family = 'agent_run' AND stream.event_id = event.event_id
          JOIN governed_run_attribution_bindings binding ON binding.run_id = event.run_id
          JOIN users human ON human.id = binding.user_id
         WHERE event.host_ref = ${sqlLiteral(CHATLLM_HOST_REF)}
           AND event.session_id = ${sqlLiteral(sessionId)}
           AND event.approval_request_id IS NOT NULL
           AND event.event_type IN ('approval', 'tool_call')
           AND lower(human.email) = lower(${sqlLiteral(E2E_EMAIL)})
      ) events;
  `)
  return JSON.parse(raw) as TraceRow[]
}

export function terminalApproval(
  rows: readonly TraceRow[],
  outcome: 'approved' | 'denied'
): TerminalApproval | null {
  const terminal = rows.find(row => row.eventType === 'approval' && row.outcome === outcome)
  if (!terminal) return null
  const requested = rows.find(
    row =>
      row.eventType === 'approval' &&
      row.requestId === terminal.requestId &&
      row.decision === 'require_approval'
  )
  if (
    !requested ||
    !terminal.bindingHumanSub ||
    !terminal.bindingUserId ||
    requested.runId !== terminal.runId ||
    requested.sessionId !== terminal.sessionId ||
    requested.toolName !== 'http_request' ||
    terminal.toolName !== 'http_request' ||
    requested.toolKind !== 'internal_tool' ||
    terminal.toolKind !== 'internal_tool' ||
    requested.toolSourceRef !== 'mcp-host' ||
    terminal.toolSourceRef !== 'mcp-host' ||
    terminal.decisionActorSub !== terminal.bindingHumanSub ||
    terminal.eventHumanSub !== terminal.bindingHumanSub ||
    terminal.eventUserId !== terminal.bindingUserId
  ) {
    return null
  }
  return {
    requestId: terminal.requestId,
    runId: terminal.runId,
    sessionId: terminal.sessionId,
    userId: terminal.bindingUserId,
  }
}
