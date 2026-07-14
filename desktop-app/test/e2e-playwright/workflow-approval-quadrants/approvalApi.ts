import { type APIRequestContext, expect } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { EXT_API, apiRequest } from '../workflowUi'
import { internalControlJwt, readerWebhookRequest } from './auth'
import { profilesSql, sqlLiteral } from './cluster'
import { CONTROL_API, type Medium, READER_API, type RuntimeTokens } from './constants'

type JsonRecord = Record<string, unknown>
type HttpResult = { status: number; body: string }

function expectJsonResponse(result: HttpResult, expectedStatus: number): JsonRecord {
  expect(result.status, result.body).toBe(expectedStatus)
  try {
    return JSON.parse(result.body) as JsonRecord
  } catch {
    throw new Error(`Expected JSON response for HTTP ${expectedStatus}, received: ${result.body}`)
  }
}

export async function expectHttpHealth(url: string): Promise<void> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 2_000)
  try {
    const response = await fetch(url, { signal: controller.signal })
    const body = response.status === 200 ? '' : await response.text().catch(() => '')
    expect(response.status, `${url} health response ${body}`.trim()).toBe(200)
  } finally {
    clearTimeout(timeout)
  }
}

export async function issueRuntimeTokens(
  _request: APIRequestContext,
  issuer: 'wrc' | 'hcc',
  namespace: string,
  name: string
): Promise<RuntimeTokens> {
  const routeName = issuer === 'hcc' ? 'standalone' : name
  const workflowControlScopes = ['workflow:list', 'workflow:read', 'workflow:trigger']
  const requestBody =
    issuer === 'hcc'
      ? { includeMcpHostControlToken: true, host: name, workflowControlScopes }
      : { includeMcpHostControlToken: true, workflowControlScopes }
  const res = await apiRequest(
    'POST',
    `${CONTROL_API}/api/v1/auth/mcp-host/${encodeURIComponent(namespace)}/${encodeURIComponent(routeName)}/tokens`,
    JSON.stringify(requestBody),
    { Authorization: `Bearer ${internalControlJwt(issuer)}` }
  )

  const body = expectJsonResponse(res, 200) as RuntimeTokens
  expect(body.mcpHostAccessToken).toBeTruthy()
  expect(body.mcpHostControlToken).toBeTruthy()
  return body
}

export async function createApproval(
  _request: APIRequestContext,
  tokens: RuntimeTokens,
  namespace: string,
  name: string,
  userId: string,
  caller = `${namespace}/${name}`
): Promise<string> {
  const res = await apiRequest(
    'POST',
    `${CONTROL_API}/api/v1/workflow-approvals/request`,
    JSON.stringify({
      recipeNamespace: namespace,
      recipeName: name,
      target: { userId },
      payload: {
        message: `Approve ${namespace}/${name}`,
        metadata: { workflowTrigger: { namespace, name, caller } },
      },
      ttlSeconds: 300,
    }),
    {
      Authorization: `Bearer ${tokens.mcpHostAccessToken}`,
      'Idempotency-Key': `${name}-${randomUUID()}`,
    }
  )

  const body = expectJsonResponse(res, 200) as { approvalRequestId: string }
  expect(body.approvalRequestId).toMatch(/^[0-9a-f-]{36}$/)
  return body.approvalRequestId
}

export async function createTeamApproval(
  _request: APIRequestContext,
  tokens: RuntimeTokens,
  namespace: string,
  name: string,
  teamId: string,
  caller = `${namespace}/${name}`
): Promise<string> {
  const res = await apiRequest(
    'POST',
    `${CONTROL_API}/api/v1/workflow-approvals/request`,
    JSON.stringify({
      recipeNamespace: namespace,
      recipeName: name,
      target: { teamId },
      payload: {
        message: `Approve ${namespace}/${name}`,
        metadata: { workflowTrigger: { namespace, name, caller } },
      },
      ttlSeconds: 300,
    }),
    {
      Authorization: `Bearer ${tokens.mcpHostAccessToken}`,
      'Idempotency-Key': `${name}-${randomUUID()}`,
    }
  )

  const body = expectJsonResponse(res, 200) as { approvalRequestId: string }
  expect(body.approvalRequestId).toMatch(/^[0-9a-f-]{36}$/)
  return body.approvalRequestId
}

export async function externalDecision(
  sessionToken: string,
  approvalRequestId: string,
  decision: 'approve' | 'deny'
): Promise<void> {
  const list = await apiRequest('GET', `${EXT_API}/api/v1/workflow-approvals?limit=50`, undefined, {
    Authorization: `Bearer ${sessionToken}`,
  })
  expect(list.status, list.body).toBe(200)

  const items = (JSON.parse(list.body) as { items?: Array<{ id: string }> }).items ?? []
  expect(items.some(item => item.id === approvalRequestId)).toBeTruthy()

  const decide = await apiRequest(
    'POST',
    `${EXT_API}/api/v1/workflow-approvals/${approvalRequestId}/decide`,
    JSON.stringify({ decision }),
    { Authorization: `Bearer ${sessionToken}` }
  )
  expect(decide.status, decide.body).toBe(200)
  expect(JSON.parse(decide.body)).toEqual({ ok: true })
}

export async function enrollMedium(
  sessionToken: string,
  userId: string,
  medium: Medium,
  providerUserId: string,
  providerWorkspaceId?: string
): Promise<string> {
  const challenge = await apiRequest(
    'POST',
    `${EXT_API}/api/v1/workflow-approval-mediums/challenges`,
    JSON.stringify({ medium, providerUserId, providerWorkspaceId }),
    { Authorization: `Bearer ${sessionToken}` }
  )
  expect(challenge.status, challenge.body).toBe(202)

  const challengeId = (JSON.parse(challenge.body) as { challengeId: string }).challengeId
  const code = profilesSql(`
    SELECT payload->>'code'
      FROM notification_deliveries
     WHERE dedupe_key = ${sqlLiteral(`${challengeId}:workflow_approval_medium.challenge`)}
       AND audience->>'userId' = ${sqlLiteral(userId)}
     ORDER BY created_at DESC
     LIMIT 1;
  `)
  expect(code).toMatch(/^\d{6}$/)

  const confirm = await apiRequest(
    'POST',
    `${EXT_API}/api/v1/workflow-approval-mediums/challenges/${challengeId}/confirm`,
    JSON.stringify({ code }),
    { Authorization: `Bearer ${sessionToken}` }
  )
  expect(confirm.status, confirm.body).toBe(200)
  return challengeId
}

export async function readerDecision(
  _request: APIRequestContext,
  approvalRequestId: string,
  medium: Medium,
  providerUserId: string,
  providerEventId: string,
  decision: 'approve' | 'deny',
  providerWorkspaceId?: string
): Promise<{ ok: boolean; duplicate: boolean }> {
  const { bodyText, headers } = readerWebhookRequest(
    approvalRequestId,
    medium,
    providerUserId,
    providerEventId,
    decision,
    providerWorkspaceId
  )
  const res = await apiRequest('POST', `${READER_API}/webhooks/${medium}`, bodyText, headers)
  const body = expectJsonResponse(res, 200)
  expect(body).toEqual({
    ok: true,
    duplicate: expect.any(Boolean),
  })
  return body as { ok: boolean; duplicate: boolean }
}

export async function expectReaderDecisionRejected(
  _request: APIRequestContext,
  approvalRequestId: string,
  medium: Medium,
  providerUserId: string,
  providerEventId: string,
  decision: 'approve' | 'deny',
  expectedStatus: number,
  expectedError?: string
): Promise<void> {
  const { bodyText, headers } = readerWebhookRequest(
    approvalRequestId,
    medium,
    providerUserId,
    providerEventId,
    decision
  )
  const res = await apiRequest('POST', `${READER_API}/webhooks/${medium}`, bodyText, headers)
  const body = expectJsonResponse(res, expectedStatus)
  if (expectedError) {
    expect(body).toEqual({ ok: false, error: expectedError })
  }
}

export async function expectTelegramDecisionInvalidSignature(
  _request: APIRequestContext,
  approvalRequestId: string,
  providerUserId: string,
  providerEventId: string,
  decision: 'approve' | 'deny'
): Promise<void> {
  const { bodyText, headers } = readerWebhookRequest(
    approvalRequestId,
    'telegram',
    providerUserId,
    providerEventId,
    decision
  )
  headers['x-telegram-bot-api-secret-token'] = 'invalid-e2e-provider-signature'

  const res = await apiRequest('POST', `${READER_API}/webhooks/telegram`, bodyText, headers)
  const body = expectJsonResponse(res, 401)
  expect(body).toEqual({ error: 'invalid_provider_signature' })
}

export async function triggerWorkflow(
  _request: APIRequestContext,
  tokens: RuntimeTokens,
  namespace: string,
  name: string,
  approvalRequestId: string
): Promise<string> {
  const res = await apiRequest(
    'POST',
    `${CONTROL_API}/api/v1/workflows/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/trigger`,
    JSON.stringify({ approvalRequestId }),
    {
      Authorization: `Bearer ${tokens.mcpHostControlToken}`,
      'Idempotency-Key': `${name}-${randomUUID()}`,
    }
  )

  const body = expectJsonResponse(res, 201) as {
    id?: string
    actor?: { type?: string; hostRef?: string }
  }
  expect(body.id).toBeTruthy()
  expect(body.actor).toMatchObject({ type: 'mcp-host', hostRef: `${namespace}/${name}` })

  const runSignal = profilesSql(`
    SELECT phase || ':' || actor_type || ':' || approval_request_id::text
      FROM workflow_runs
     WHERE run_id::text = ${sqlLiteral(String(body.id))}
     LIMIT 1;
  `)
  expect(runSignal).toMatch(
    new RegExp(`^(Pending|Running|Succeeded):autonomous:${approvalRequestId}$`)
  )
  return String(body.id)
}

export async function expectTriggerRejected(
  _request: APIRequestContext,
  tokens: RuntimeTokens,
  namespace: string,
  name: string,
  approvalRequestId: string | undefined,
  expectedStatus: number,
  expectedError?: string
): Promise<void> {
  const res = await apiRequest(
    'POST',
    `${CONTROL_API}/api/v1/workflows/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/trigger`,
    JSON.stringify(approvalRequestId ? { approvalRequestId } : {}),
    {
      Authorization: `Bearer ${tokens.mcpHostControlToken}`,
      'Idempotency-Key': `${name}-reject-${randomUUID()}`,
    }
  )
  const body = expectJsonResponse(res, expectedStatus)
  if (expectedError) {
    expect(body).toMatchObject({ error: expectedError })
  }
}

export function approvalStatus(approvalRequestId: string): string {
  return profilesSql(
    `SELECT status FROM workflow_approval_requests WHERE id = ${sqlLiteral(approvalRequestId)};`
  )
}

export function readerEventResult(medium: Medium, providerEventId: string): string {
  return profilesSql(`
    SELECT result || ':' || count(*)
      FROM workflow_approval_reader_events
     WHERE medium = ${sqlLiteral(medium)}
       AND provider_event_id = ${sqlLiteral(providerEventId)}
     GROUP BY result;
  `)
}

export function readerDecisionCount(approvalRequestId: string): number {
  return Number(
    profilesSql(`
      SELECT count(*)
        FROM workflow_approval_reader_events
       WHERE approval_request_id = ${sqlLiteral(approvalRequestId)}
         AND result = 'decided';
    `)
  )
}

export function workflowRunCountForApproval(approvalRequestId: string): number {
  return Number(
    profilesSql(`
      SELECT count(*)
        FROM workflow_runs
       WHERE approval_request_id = ${sqlLiteral(approvalRequestId)};
    `)
  )
}
