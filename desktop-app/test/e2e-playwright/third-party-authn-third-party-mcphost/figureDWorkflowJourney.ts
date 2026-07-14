import { expect } from '@playwright/test'
import { approvalStatus } from '../workflow-approval-quadrants/approvalApi'
import { kubectlOut, profilesSql, sqlLiteral } from '../workflow-approval-quadrants/cluster'
import { WORKFLOW_RECIPE_NS } from '../workflow-approval-quadrants/constants'
import { EXT_API, apiRequest } from '../workflowUi'
import { mediumAccountIds } from './figureDTestHelpers'

export function applyWorkflowManifest(manifest: Record<string, unknown>): void {
  kubectlOut(['apply', '-f', '-'], JSON.stringify(manifest), 30_000)
}

export function triggerApprovalId(actionValue: string): string {
  const legacyId =
    actionValue.match(
      /^[a-z]+:([0-9a-f-]{36}):sandbox-recipes\/[a-z0-9.-]+(?::[a-f0-9]{16})?$/i
    )?.[1] || ''
  if (legacyId) return legacyId
  const compactId =
    actionValue.match(/^[ad]:([A-Za-z0-9_-]{22}):~[a-f0-9]{16}(?::[a-f0-9]{16})?$/i)?.[1] || ''
  const bytes = Buffer.from(
    compactId
      .replace(/-/g, '+')
      .replace(/_/g, '/')
      .padEnd(Math.ceil(compactId.length / 4) * 4, '='),
    'base64'
  )
  expect(bytes.length).toBe(16)
  const hex = bytes.toString('hex')
  const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(
    16,
    20
  )}-${hex.slice(20)}`
  expect(id).toMatch(/^[0-9a-f-]{36}$/i)
  return id
}

export function triggerRuntimeMcpHostRef(actionValue: string): string {
  const legacyHostRef =
    actionValue.match(
      /^[a-z]+:[0-9a-f-]{36}:(sandbox-recipes\/[a-z0-9.-]+)(?::[a-f0-9]{16})?$/i
    )?.[1] || ''
  const compactAlias =
    actionValue.match(/^[ad]:[A-Za-z0-9_-]{22}:(~[a-f0-9]{16})(?::[a-f0-9]{16})?$/i)?.[1] || ''
  const hostRef = legacyHostRef || (compactAlias ? `sandbox-recipes/${compactAlias}` : '')
  expect(hostRef).toMatch(/^sandbox-recipes\/(?:[a-z0-9]([a-z0-9.-]*[a-z0-9])?|~[a-f0-9]{16})$/)
  expect(hostRef).not.toBe('chatllm')
  return hostRef
}

export function workflowRunCountForRecipe(recipeName: string): number {
  return Number(
    profilesSql(`
      SELECT COUNT(*)
        FROM workflow_runs
       WHERE recipe_namespace = ${sqlLiteral(WORKFLOW_RECIPE_NS)}
         AND recipe_name = ${sqlLiteral(recipeName)};
    `)
  )
}

export function latestWorkflowRunPhase(recipeName: string): string {
  return profilesSql(`
    SELECT phase
      FROM workflow_runs
     WHERE recipe_namespace = ${sqlLiteral(WORKFLOW_RECIPE_NS)}
       AND recipe_name = ${sqlLiteral(recipeName)}
     ORDER BY created_at DESC
     LIMIT 1;
  `)
}

export async function waitForWorkflowRunPhase(recipeName: string, phase: string): Promise<void> {
  await expect
    .poll(() => latestWorkflowRunPhase(recipeName), {
      timeout: 300_000,
      intervals: [1_000, 2_000, 5_000],
      message: `waiting for ${WORKFLOW_RECIPE_NS}/${recipeName} to reach ${phase}`,
    })
    .toBe(phase)
}

export async function waitForApprovalStatus(approvalId: string, status: string): Promise<void> {
  await expect
    .poll(() => approvalStatus(approvalId), {
      timeout: 240_000,
      intervals: [500, 1_000, 2_000, 5_000],
      message: `waiting for approval ${approvalId} to reach ${status}`,
    })
    .toBe(status)
}

export async function triggerWorkflowAsUser(
  sessionToken: string,
  recipeName: string
): Promise<string> {
  const res = await apiRequest(
    'POST',
    `${EXT_API}/api/v1/workflows/${encodeURIComponent(WORKFLOW_RECIPE_NS)}/${encodeURIComponent(recipeName)}/trigger`,
    JSON.stringify({ inputs: { marker: recipeName } }),
    {
      Authorization: `Bearer ${sessionToken}`,
      'Idempotency-Key': `${recipeName}-${Date.now()}`,
    }
  )
  expect(res.status, res.body).toBe(201)
  const body = JSON.parse(res.body) as { id?: string }
  expect(body.id).toMatch(/^[0-9a-f-]{36}$/i)
  return body.id as string
}

export function seedVerifiedApprovalMediumBinding(params: {
  userId: string
  medium: 'telegram' | 'slack'
  providerUserId: string
  providerChannelId: string
  providerWorkspaceId?: string | null
  communicationChannelRef?: string | null
}): void {
  const providerWorkspaceSql = params.providerWorkspaceId
    ? sqlLiteral(params.providerWorkspaceId)
    : 'NULL'
  const communicationChannelRefSql = params.communicationChannelRef
    ? sqlLiteral(params.communicationChannelRef)
    : 'NULL'
  profilesSql(`
    INSERT INTO workflow_approval_medium_accounts
      (user_id, medium, provider_user_id, provider_workspace_id, provider_channel_id, communication_channel_ref, verified_at)
    VALUES (
      ${sqlLiteral(params.userId)},
      ${sqlLiteral(params.medium)},
      ${sqlLiteral(params.providerUserId)},
      ${providerWorkspaceSql},
      ${sqlLiteral(params.providerChannelId)},
      ${communicationChannelRefSql},
      NOW()
    );
  `)
  expect(mediumAccountIds([params.providerUserId])).toHaveLength(1)
}

export function preferVerifiedApprovalMediumBinding(providerUserId: string): void {
  profilesSql(`
    UPDATE workflow_approval_medium_accounts
       SET updated_at = NOW()
     WHERE provider_user_id = ${sqlLiteral(providerUserId)}
       AND disabled_at IS NULL;
  `)
  expect(mediumAccountIds([providerUserId])).toHaveLength(1)
}
