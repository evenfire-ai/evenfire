import { RECIPE_NS } from '../workflowUi'
import { profilesSql, sqlLiteral } from './workflowApprovalJourney'

export function seedWorkflowCompletedNotificationFixture(params: {
  recipeName: string
  userId: string
}): string {
  const recipe = sqlLiteral(params.recipeName)
  const userId = sqlLiteral(params.userId)
  return profilesSql(`
    WITH approval AS (
      INSERT INTO workflow_approval_requests (
        recipe_namespace, recipe_name, expires_at, status, target_user_id, payload,
        idempotency_key, payload_hash, decided_at, decided_by_user_id
      )
      VALUES (
        ${sqlLiteral(RECIPE_NS)}, ${recipe}, NOW() + INTERVAL '1 day', 'consumed',
        ${userId}::uuid,
        jsonb_build_object(
          'message', 'Desktop completion notification fixture',
          'metadata', jsonb_build_object(
            'workflowTrigger', jsonb_build_object(
              'namespace', ${sqlLiteral(RECIPE_NS)},
              'name', ${recipe},
              'caller', 'chatllm'
            )
          )
        ),
        'e2e-desktop-completion-' || ${recipe}, 'e2e-desktop-completion',
        NOW(), ${userId}
      )
      RETURNING id
    ),
    intent AS (
      INSERT INTO workflow_approval_trigger_intents (
        approval_request_id, trigger_namespace, trigger_name, trigger_caller_key
      )
      SELECT id, ${sqlLiteral(RECIPE_NS)}, ${recipe}, 'chatllm'
      FROM approval
      RETURNING approval_request_id
    ),
    run AS (
      INSERT INTO workflow_runs (
        recipe_namespace, recipe_name, phase, actor_type, actor_id, idempotency_key,
        trigger_source, inputs, approval_request_id, idempotency_payload_hash,
        started_at, completed_at, updated_at
      )
      SELECT ${sqlLiteral(RECIPE_NS)}, ${recipe}, 'Succeeded', 'user', ${userId}::uuid,
             'e2e-desktop-completion-run-' || ${recipe}, 'onDemand', '{}'::jsonb,
             approval_request_id, 'e2e-desktop-completion', NOW(), NOW(), NOW()
      FROM intent
      RETURNING run_id, approval_request_id
    )
    INSERT INTO notification_deliveries (
      event_type, dedupe_key, audience, payload, priority, status, expires_at
    )
    SELECT
      'workflow.run.completed',
      'e2e-desktop-completion:' || run_id::text,
      jsonb_build_object('userId', ${userId}),
      jsonb_build_object(
        'workflowRunId', run_id::text,
        'approvalRequestId', approval_request_id::text,
        'recipeNamespace', ${sqlLiteral(RECIPE_NS)},
        'recipeName', ${recipe},
        'phase', 'Succeeded',
        'completedAt', NOW(),
        'message', 'Workflow ' || ${recipe} || ' completed. Results are ready.'
      ),
      'normal',
      'queued',
      NOW() + INTERVAL '1 day'
    FROM run
    RETURNING payload->>'workflowRunId';
  `)
}
