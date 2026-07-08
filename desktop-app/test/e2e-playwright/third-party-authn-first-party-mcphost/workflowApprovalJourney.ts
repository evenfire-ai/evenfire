import { expect } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { EXT_API, K8S_CONTEXT, RECIPE_NS, apiRequest } from '../workflowUi'
import {
  TELEGRAM_CHANNEL_NAME,
  TELEGRAM_CHAT_ID,
  TELEGRAM_PROVIDER_USER_ID,
  pushFakeTelegramUpdate,
} from './fakeTelegramProvider'

const CONTROL_API = process.env.CONTROL_API_BASE_URL || 'http://127.0.0.1:8090'
const ADMIN_USERNAME = process.env.E2E_ADMIN_USERNAME || process.env.ADMIN_USER || 'admin'
export const HUMAN_READABLE_E2E_RECIPE_NAME = 'e2e-telegram-risk-review'
export type TelegramMediumBinding = {
  providerUserId: string
  providerChannelId: string
}
const DEFAULT_TELEGRAM_BINDING: TelegramMediumBinding = {
  providerUserId: TELEGRAM_PROVIDER_USER_ID,
  providerChannelId: TELEGRAM_CHAT_ID,
}
const SAFE_DYNAMIC_E2E_RECIPE_RE = /^e2e-risk-review-[a-z0-9-]+$/

type ApprovalChannelTarget = {
  id: string
  medium: 'telegram'
  agentName?: string
  channelName?: string
}

type TelegramProviderEventChallenge = {
  challengeId: string
  code: string
}

export function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

export function kubectl(args: string[], input?: string, timeout = 30_000): string {
  return execFileSync('kubectl', ['--context', K8S_CONTEXT, ...args], {
    encoding: 'utf-8',
    input,
    timeout,
  })
}

export function profilesSql(sql: string, timeout = 20_000): string {
  return kubectl(
    [
      '-n',
      'control-plane',
      'exec',
      'deploy/control-postgres',
      '--',
      'psql',
      '-v',
      'ON_ERROR_STOP=1',
      '-U',
      'postgres',
      '-d',
      'profiles',
      '-tA',
      '-c',
      sql,
    ],
    undefined,
    timeout
  ).trim()
}

function requireAdminPassword(): string {
  const password =
    process.env.E2E_ADMIN_PASSWORD ||
    process.env.ADMIN_PASSWORD ||
    process.env.ADMIN_PASS ||
    process.env.TEST_ADMIN_PASSWORD ||
    'changeme123!'
  if (!password) {
    throw new Error(
      'E2E_ADMIN_PASSWORD, ADMIN_PASSWORD, or ADMIN_PASS is required for workflow grant setup'
    )
  }
  return password
}

async function adminLogin(): Promise<string> {
  const response = await fetch(`${CONTROL_API}/api/v1/admin/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: ADMIN_USERNAME, password: requireAdminPassword() }),
  })
  const body = await response.text()
  expect(response.status, body).toBe(200)
  const parsed = JSON.parse(body) as { token?: string; o?: { token?: string } }
  const token = parsed.token || parsed.o?.token
  expect(token, 'admin login must return a token').toBeTruthy()
  return token as string
}

export function buildWorkflowRecipe(name: string, marker: string): string {
  const artifactProof = `artifact-output-${marker}`
  return `
apiVersion: clerum.io/v1alpha1
kind: WorkflowRecipe
metadata:
  name: ${name}
  namespace: ${RECIPE_NS}
  labels:
    clerum.io/e2e: "true"
    clerum.io/third-party-authn-first-party-mcphost: "true"
spec:
  description: 3rd-party AuthN, 1st-party MCP-host target workflow.
  inputContract:
    type: object
    properties:
      marker:
        type: string
        default: "${marker}"
  triggers:
    onDemand:
      requiresApproval: true
      allowedActors:
        - autonomous
  runRetention:
    maxRunDurationSeconds: 600
    ttlSecondsAfterFinished: 7200
  output:
    destination: pvc
    name: ${name}
    format: json
    storageSize: 64Mi
  steps:
    - id: emit-third-party-authn-first-party-mcphost-result
      timeoutSeconds: 120
      run:
        type: snippet
        language: typescript
        code: |
          const payload = {
            route: "third-party-authn-first-party-mcphost",
            marker: sdk.inputs.marker,
            artifactProof: "${artifactProof}"
          }
          await sdk.artifacts.writeJson("third-party-authn-first-party-mcphost-result.json", payload)
          return payload
        capabilities:
          artifacts:
            maxCount: 1
`
}

export async function installWorkflowRecipeForUser(params: {
  recipeName: string
  marker: string
  userId: string
}): Promise<void> {
  installWorkflowRecipe({ recipeName: params.recipeName, marker: params.marker })
  await grantWorkflowRecipeToUsers(params.recipeName, [params.userId])
}

export function installWorkflowRecipe(params: { recipeName: string; marker: string }): void {
  kubectl(['apply', '-f', '-'], buildWorkflowRecipe(params.recipeName, params.marker), 30_000)
}

export async function grantWorkflowRecipeToUsers(
  recipeName: string,
  userIds: string[]
): Promise<void> {
  const token = await adminLogin()
  const response = await fetch(
    `${CONTROL_API}/api/v1/admin/workflows/${encodeURIComponent(RECIPE_NS)}/${encodeURIComponent(recipeName)}/grants`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ userIds }),
    }
  )
  const body = await response.text()
  expect(response.status, body).toBe(200)
}

export function createE2ETeamForUser(params: { teamName: string; userId: string }): string {
  if (!/^e2e-[a-z0-9-]+$/.test(params.teamName)) {
    throw new Error(`refusing to create non-E2E team ${params.teamName}`)
  }
  const out = profilesSql(`
    WITH team AS (
      INSERT INTO teams(name)
      VALUES (${sqlLiteral(params.teamName)})
      RETURNING id
    ), membership AS (
      INSERT INTO team_members(team_id, user_id, role, status)
      SELECT id, ${sqlLiteral(params.userId)}, 'member', 'active'
        FROM team
      RETURNING team_id
    )
    SELECT team_id::text FROM membership;
  `)
  expect(out).toMatch(/^[0-9a-f-]{36}$/i)
  return out
}

export function grantWorkflowRecipeToTeam(recipeName: string, teamId: string): void {
  profilesSql(
    `
    INSERT INTO team_workflow_triggers (team_id, recipe_namespace, recipe_name)
    VALUES (${sqlLiteral(teamId)}, ${sqlLiteral(RECIPE_NS)}, ${sqlLiteral(recipeName)})
    ON CONFLICT DO NOTHING;
    INSERT INTO workflow_recipe_allowed_teams (recipe_namespace, recipe_name, team_id)
    VALUES (${sqlLiteral(RECIPE_NS)}, ${sqlLiteral(recipeName)}, ${sqlLiteral(teamId)})
    ON CONFLICT DO NOTHING;
    `,
    20_000
  )
}

export function cleanupE2ETeam(teamId: string | undefined): void {
  if (!teamId) return
  if (!/^[0-9a-f-]{36}$/i.test(teamId)) {
    throw new Error(`refusing to clean non-E2E team id ${teamId}`)
  }
  const team = sqlLiteral(teamId)
  profilesSql(
    `
    DELETE FROM team_workflow_grants_audit
     WHERE target_team_id = ${team};
    DELETE FROM workflow_recipe_allowed_teams_audit
     WHERE target_team_id = ${team};
    DELETE FROM team_workflow_triggers
     WHERE team_id = ${team};
    DELETE FROM workflow_recipe_allowed_teams
     WHERE team_id = ${team};
    DELETE FROM team_members
     WHERE team_id = ${team};
    DELETE FROM teams
     WHERE id = ${team};
    `,
    20_000
  )
}

export function cleanupWorkflowRecipe(recipeName: string): void {
  if (
    recipeName !== HUMAN_READABLE_E2E_RECIPE_NAME &&
    !SAFE_DYNAMIC_E2E_RECIPE_RE.test(recipeName)
  ) {
    throw new Error(`refusing to clean non-E2E recipe ${recipeName}`)
  }

  try {
    kubectl(
      [
        '-n',
        RECIPE_NS,
        'delete',
        'workflowrecipe',
        recipeName,
        '--ignore-not-found=true',
        '--wait=false',
      ],
      undefined,
      30_000
    )
  } catch {
    // Preserve the original failure; database cleanup below is still test-scoped.
  }

  const ns = sqlLiteral(RECIPE_NS)
  const recipe = sqlLiteral(recipeName)
  profilesSql(
    `
    DELETE FROM workflow_approval_provider_events
     WHERE approval_request_id IN (
       SELECT id
         FROM workflow_approval_requests
        WHERE recipe_namespace = ${ns}
          AND recipe_name = ${recipe}
     );
    DELETE FROM workflow_runs
     WHERE recipe_namespace = ${ns}
       AND recipe_name = ${recipe};
    DELETE FROM workflow_runs_audit
     WHERE recipe_namespace = ${ns}
       AND recipe_name = ${recipe};
    DELETE FROM workflow_approval_requests
     WHERE recipe_namespace = ${ns}
       AND recipe_name = ${recipe};
    DELETE FROM workflow_approval_requests_archive
     WHERE recipe_namespace = ${ns}
       AND recipe_name = ${recipe};
    DELETE FROM notification_deliveries
     WHERE payload->>'recipeNamespace' = ${ns}
       AND payload->>'recipeName' = ${recipe};
    DELETE FROM user_workflow_triggers
     WHERE recipe_namespace = ${ns}
       AND recipe_name = ${recipe};
    DELETE FROM team_workflow_triggers
     WHERE recipe_namespace = ${ns}
       AND recipe_name = ${recipe};
    DELETE FROM workflow_recipe_allowed_teams
     WHERE recipe_namespace = ${ns}
       AND recipe_name = ${recipe};
    `,
    30_000
  )
}

export function cleanupTelegramMediumBinding(
  binding: TelegramMediumBinding = DEFAULT_TELEGRAM_BINDING
): void {
  const provider = sqlLiteral(binding.providerUserId)
  const channel = sqlLiteral(binding.providerChannelId)
  profilesSql(
    `
    DELETE FROM notification_deliveries
     WHERE payload->>'providerUserId' = ${provider};
    DELETE FROM workflow_approval_medium_challenges
     WHERE provider_user_id = ${provider}
       AND provider_channel_id = ${channel};
    DELETE FROM workflow_approval_medium_accounts
     WHERE medium = 'telegram'
       AND provider_user_id = ${provider}
       AND provider_channel_id = ${channel};
    `,
    20_000
  )
}

export async function enrollTelegramMedium(
  sessionToken: string,
  userId: string,
  binding: TelegramMediumBinding = DEFAULT_TELEGRAM_BINDING
): Promise<void> {
  void userId
  if (binding.providerUserId !== binding.providerChannelId) {
    throw new Error(
      'enrollTelegramMedium requires providerUserId === providerChannelId for private Telegram /verify enrollment'
    )
  }
  const { code } = await createTelegramMediumChallenge(sessionToken)
  pushFakeTelegramUpdate({
    chatId: binding.providerChannelId,
    userId: binding.providerUserId,
    text: `/verify ${code}`,
    chatType: 'private',
  })
  const started = Date.now()
  while (Date.now() - started < 90_000) {
    const count = Number(
      profilesSql(`
        SELECT COUNT(*)
          FROM workflow_approval_medium_accounts
         WHERE medium = 'telegram'
           AND provider_user_id = ${sqlLiteral(binding.providerUserId)}
           AND provider_channel_id = ${sqlLiteral(binding.providerChannelId)}
           AND disabled_at IS NULL;
      `)
    )
    if (count >= 1) return
    execFileSync('sleep', ['2'])
  }
  throw new Error(
    `Telegram medium enrollment did not complete for providerUserId=${binding.providerUserId}`
  )
}

export async function createTelegramMediumChallenge(
  sessionToken: string
): Promise<TelegramProviderEventChallenge> {
  const targets = await apiRequest(
    'GET',
    `${EXT_API}/api/v1/workflow-approval-mediums/targets`,
    undefined,
    { Authorization: `Bearer ${sessionToken}` }
  )
  expect(targets.status, targets.body).toBe(200)
  const targetItems = (JSON.parse(targets.body) as { items?: ApprovalChannelTarget[] }).items ?? []
  const target =
    targetItems.find(
      item => item.medium === 'telegram' && item.channelName === TELEGRAM_CHANNEL_NAME
    ) ?? targetItems.find(item => item.medium === 'telegram')
  expect(target?.id, 'user should have an accessible Telegram approval target').toBeTruthy()

  const challenge = await apiRequest(
    'POST',
    `${EXT_API}/api/v1/workflow-approval-mediums/challenges`,
    JSON.stringify({
      medium: 'telegram',
      targetId: target!.id,
    }),
    { Authorization: `Bearer ${sessionToken}` }
  )
  expect(challenge.status, challenge.body).toBe(202)
  const parsed = JSON.parse(challenge.body) as {
    challengeId?: string
    code?: string
  }
  expect(parsed.challengeId).toMatch(/^[0-9a-f-]{36}$/)
  expect(parsed.code).toMatch(/^\d{6}$/)
  return {
    challengeId: parsed.challengeId!,
    code: parsed.code!,
  }
}

export function latestPendingApprovalId(recipeName: string): string {
  const approvalId = profilesSql(`
    SELECT id::text
      FROM workflow_approval_requests
     WHERE recipe_namespace = ${sqlLiteral(RECIPE_NS)}
       AND recipe_name = ${sqlLiteral(recipeName)}
       AND status = 'pending'
     ORDER BY requested_at DESC
     LIMIT 1;
  `)
  expect(approvalId).toMatch(/^[0-9a-f-]{36}$/)
  return approvalId
}

export function latestPendingApprovalIdOrNull(recipeName: string): string {
  return profilesSql(`
    SELECT id::text
      FROM workflow_approval_requests
     WHERE recipe_namespace = ${sqlLiteral(RECIPE_NS)}
       AND recipe_name = ${sqlLiteral(recipeName)}
       AND status = 'pending'
     ORDER BY requested_at DESC
     LIMIT 1;
  `)
}

export function approvalStatus(approvalRequestId: string): string {
  return profilesSql(
    `SELECT status FROM workflow_approval_requests WHERE id = ${sqlLiteral(approvalRequestId)};`
  )
}

export function workflowRunCountForApproval(approvalRequestId: string): number {
  return Number(
    profilesSql(`
      SELECT COUNT(*)
        FROM workflow_runs
       WHERE approval_request_id = ${sqlLiteral(approvalRequestId)};
    `)
  )
}

export function approvalRequestCountForRecipe(recipeName: string): number {
  return Number(
    profilesSql(`
      SELECT COUNT(*)
        FROM workflow_approval_requests
       WHERE recipe_namespace = ${sqlLiteral(RECIPE_NS)}
         AND recipe_name = ${sqlLiteral(recipeName)};
    `)
  )
}

export function pendingApprovalCountForRecipe(recipeName: string): number {
  return Number(
    profilesSql(`
      SELECT COUNT(*)
        FROM workflow_approval_requests
       WHERE recipe_namespace = ${sqlLiteral(RECIPE_NS)}
         AND recipe_name = ${sqlLiteral(recipeName)}
         AND status = 'pending';
    `)
  )
}

export function workflowRunCountForRecipe(recipeName: string): number {
  return Number(
    profilesSql(`
      SELECT COUNT(*)
        FROM workflow_runs
       WHERE recipe_namespace = ${sqlLiteral(RECIPE_NS)}
         AND recipe_name = ${sqlLiteral(recipeName)};
    `)
  )
}

export function workflowRunIdForApproval(approvalRequestId: string): string {
  const runId = profilesSql(`
    SELECT run_id::text
      FROM workflow_runs
     WHERE approval_request_id = ${sqlLiteral(approvalRequestId)}
     ORDER BY created_at DESC
     LIMIT 1;
  `)
  expect(runId).toMatch(/^[0-9a-f-]{36}$/)
  return runId
}

export function workflowRunSignalForApproval(approvalRequestId: string): string {
  return profilesSql(`
    SELECT actor_type || ':' || trigger_source || ':' || recipe_namespace || '/' || recipe_name
      FROM workflow_runs
     WHERE approval_request_id = ${sqlLiteral(approvalRequestId)}
     ORDER BY created_at DESC
     LIMIT 1;
  `)
}

export function workflowRunTypedIntentSignalForApproval(approvalRequestId: string): string {
  return profilesSql(`
    SELECT CASE
             WHEN watri.idempotency_key = wr.idempotency_key THEN 'matched'
             ELSE 'mismatch'
           END || ':' || COUNT(wr2.run_id)::text
      FROM workflow_approval_trigger_run_intents watri
      JOIN workflow_runs wr
        ON wr.approval_request_id = watri.approval_request_id
      LEFT JOIN workflow_runs wr2
        ON wr2.recipe_namespace = wr.recipe_namespace
       AND wr2.recipe_name = wr.recipe_name
       AND wr2.idempotency_key = wr.idempotency_key
     WHERE watri.approval_request_id = ${sqlLiteral(approvalRequestId)}
     GROUP BY watri.idempotency_key, wr.idempotency_key;
  `)
}

export function workflowRunPhaseForApproval(approvalRequestId: string): string {
  return profilesSql(`
    SELECT phase
      FROM workflow_runs
     WHERE approval_request_id = ${sqlLiteral(approvalRequestId)}
     ORDER BY created_at DESC
     LIMIT 1;
  `)
}

export function workflowRunCompletedNotificationCount(runId: string, phase = 'Succeeded'): number {
  return Number(
    profilesSql(`
      SELECT COUNT(*)
        FROM notification_deliveries
       WHERE event_type = 'workflow.run.completed'
         AND payload->>'workflowRunId' = ${sqlLiteral(runId)}
         AND payload->>'phase' = ${sqlLiteral(phase)};
    `)
  )
}

export function sentWorkflowRunCompletedNotificationCount(
  runId: string,
  phase = 'Succeeded'
): number {
  return Number(
    profilesSql(`
      SELECT COUNT(*)
        FROM notification_deliveries
       WHERE event_type = 'workflow.run.completed'
         AND status = 'sent'
         AND payload->>'workflowRunId' = ${sqlLiteral(runId)}
         AND payload->>'phase' = ${sqlLiteral(phase)};
    `)
  )
}

export function sentApprovalUpdatedNotificationCountForApproval(
  approvalRequestId: string,
  status: 'approved' | 'denied' | 'cancelled' | 'expired' | 'consumed'
): number {
  return Number(
    profilesSql(`
      SELECT COUNT(*)
        FROM notification_deliveries
       WHERE event_type = 'approval.updated'
         AND status = 'sent'
         AND payload->>'approvalRequestId' = ${sqlLiteral(approvalRequestId)}
         AND payload->>'status' = ${sqlLiteral(status)};
    `)
  )
}

export function workflowApprovalTriggerCaller(approvalRequestId: string): string {
  return profilesSql(`
    SELECT trigger_caller_key
      FROM workflow_approval_trigger_intents
     WHERE approval_request_id = ${sqlLiteral(approvalRequestId)};
  `)
}

export function markWorkflowApprovalCancelledByHost(
  approvalRequestId: string,
  hostRef: string
): void {
  profilesSql(
    `
    UPDATE workflow_approval_requests
       SET status = 'cancelled',
           cancelled_at = NOW(),
           cancelled_by = ${sqlLiteral(hostRef)}
     WHERE id = ${sqlLiteral(approvalRequestId)}
       AND status = 'pending';

    INSERT INTO notification_deliveries
      (event_type, dedupe_key, audience, payload, priority, status, expires_at)
    SELECT 'approval.updated',
           id::text || ':approval.updated:cancelled',
           CASE
             WHEN target_user_id IS NOT NULL THEN jsonb_build_object('userId', target_user_id::text)
             ELSE jsonb_build_object('teamId', target_team_id::text)
           END,
           jsonb_build_object(
             'approvalRequestId', id::text,
             'recipeNamespace', recipe_namespace,
             'recipeName', recipe_name,
             'status', 'cancelled'
           ),
           'normal',
           'queued',
           NOW() + INTERVAL '5 minutes'
      FROM workflow_approval_requests
     WHERE id = ${sqlLiteral(approvalRequestId)}
       AND status = 'cancelled'
    ON CONFLICT (dedupe_key) DO NOTHING;
    `,
    20_000
  )
}

export function replayWorkflowTerminalPhase(runId: string, phase = 'Succeeded'): void {
  profilesSql(
    `
    UPDATE workflow_runs
       SET phase = ${sqlLiteral(phase)},
           updated_at = NOW()
     WHERE run_id = ${sqlLiteral(runId)};
    `,
    20_000
  )
}

export function providerDecisionEventSignal(providerEventId: string): string {
  return profilesSql(`
    SELECT result || ':' || COUNT(*)
      FROM workflow_approval_provider_events
     WHERE medium = 'telegram'
       AND provider_event_id = ${sqlLiteral(providerEventId)}
     GROUP BY result;
  `)
}

export function providerDecisionEventSignalForApproval(approvalRequestId: string): string {
  return profilesSql(`
    SELECT result || ':' || COUNT(*)
      FROM workflow_approval_provider_events
     WHERE medium = 'telegram'
       AND approval_request_id = ${sqlLiteral(approvalRequestId)}
     GROUP BY result;
  `)
}

export function makeE2ERecipeName(): string {
  return HUMAN_READABLE_E2E_RECIPE_NAME
}

export function makeScopedE2ERecipeName(suffix: string): string {
  const normalized = suffix
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
  const name = `e2e-risk-review-${normalized}-${Date.now().toString(36)}`
  if (!SAFE_DYNAMIC_E2E_RECIPE_RE.test(name)) {
    throw new Error(`unsafe generated E2E recipe name ${name}`)
  }
  return name
}
