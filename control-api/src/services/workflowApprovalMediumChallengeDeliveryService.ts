import { pool } from '../db.js'
import type { WorkflowApprovalMedium } from './workflowApprovalMediumIdentityService.js'

export async function enqueueWorkflowApprovalMediumChallengeDelivery(params: {
  challengeId: string
  userId: string
  medium: WorkflowApprovalMedium
  providerUserId: string
  code: string
  expiresAt: string
}): Promise<void> {
  await pool.query(
    `INSERT INTO notification_deliveries
       (event_type, dedupe_key, audience, payload, priority, status, expires_at)
     VALUES ($1, $2, $3::jsonb, $4::jsonb, 'high', 'queued', $5)`,
    [
      'workflow_approval_medium.challenge',
      `${params.challengeId}:workflow_approval_medium.challenge`,
      JSON.stringify({ userId: params.userId }),
      JSON.stringify({
        challengeId: params.challengeId,
        medium: params.medium,
        providerUserId: params.providerUserId,
        code: params.code,
        title: 'Workflow approval identity verification',
        body: `Use this 6 digit code to verify your ${params.medium} identity.`,
      }),
      params.expiresAt,
    ]
  )
}
