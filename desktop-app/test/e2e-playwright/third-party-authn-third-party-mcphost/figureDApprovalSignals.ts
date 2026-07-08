import { expect } from '@playwright/test'
import { profilesSql, sqlLiteral } from '../workflow-approval-quadrants/cluster'

export function workflowApprovalTriggerCallerKey(approvalId: string): string {
  return profilesSql(`
    SELECT COALESCE(wati.trigger_caller_key, war.recipe_namespace || '/' || war.recipe_name)
      FROM workflow_approval_requests war
      LEFT JOIN workflow_approval_trigger_intents wati
        ON wati.approval_request_id = war.id
     WHERE war.id::text = ${sqlLiteral(approvalId)};
  `)
}

export function expectApprovalRequestedNotification(params: {
  approvalId: string
  targetUserId: string
  expectedCallerKey: string
}): void {
  const signal = profilesSql(`
    SELECT nd.event_type || ':' || nd.status || ':' ||
           COALESCE(nd.audience->>'userId', '') || ':' ||
           COALESCE(wati.trigger_caller_key, war.recipe_namespace || '/' || war.recipe_name)
      FROM notification_deliveries nd
      JOIN workflow_approval_requests war
        ON war.id::text = nd.payload->>'approvalRequestId'
      LEFT JOIN workflow_approval_trigger_intents wati
        ON wati.approval_request_id = war.id
     WHERE nd.event_type = 'approval.requested'
       AND nd.payload->>'approvalRequestId' = ${sqlLiteral(params.approvalId)}
     ORDER BY nd.created_at DESC
     LIMIT 1;
  `)
  expect(signal).toMatch(
    new RegExp(
      `^approval\\.requested:(queued|retrying|sent):${params.targetUserId}:${params.expectedCallerKey}$`
    )
  )
}

export function providerEventResult(medium: 'telegram' | 'slack', providerEventId: string): string {
  return profilesSql(`
    SELECT result || ':' || count(*)
      FROM workflow_approval_provider_events
     WHERE medium = ${sqlLiteral(medium)}
       AND provider_event_id = ${sqlLiteral(providerEventId)}
     GROUP BY result;
  `)
}

export function providerDecisionCount(approvalId: string): number {
  return Number(
    profilesSql(`
      SELECT count(*)
        FROM workflow_approval_provider_events
       WHERE approval_request_id = ${sqlLiteral(approvalId)}
         AND result = 'decided';
    `)
  )
}

export function latestWorkflowRunSignal(recipeName: string): string {
  return profilesSql(`
    SELECT phase || ':' || COALESCE(inputs->>'marker', '')
      FROM workflow_runs
     WHERE recipe_namespace = 'sandbox-recipes'
       AND recipe_name = ${sqlLiteral(recipeName)}
     ORDER BY created_at DESC
     LIMIT 1;
  `)
}
