// desktop-app/test/e2e-playwright/approval-flow.test.ts
//
// Full E2E: create approval → launch Desktop App → approve from UI → verify backend.
// Requires minikube port-forwards: control-api :8090, external-rest-api :8091, rpc-proxy :8094.
import { expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { E2E_TEST_EMAIL } from '../../../tests/e2e/testUser'
import { signWrcInternalControlJwt } from './workflowAuth'
import { apiRequest, clearSession, launchAndLogin, loginAs } from './workflowUi'

const E2E_EMAIL = process.env.E2E_DEV_LOGIN_EMAIL || E2E_TEST_EMAIL
const EXT_API = process.env.EXTERNAL_REST_API_BASE_URL || 'http://localhost:8091'
const WORKFLOW_API =
  process.env.E2E_WORKFLOW_API_BASE_URL ||
  process.env.CONTROL_API_BASE_URL ||
  'http://localhost:8090'
const RECIPE_NS = 'sandbox-recipes'
const RECIPE_NAME = 'pw-e2e-approval'
const K8S_CONTEXT = process.env.E2E_K8S_CONTEXT || 'clerum-test'
const RUN_ID = `pw-${Date.now()}`
const APPROVAL_MSG = `E2E approve ${RUN_ID}`

function seedAllowlist(userId: string): boolean {
  try {
    const pgPod = execFileSync(
      'kubectl',
      [
        '--context',
        K8S_CONTEXT,
        '-n',
        'control-plane',
        'get',
        'pod',
        '-l',
        'app=control-postgres',
        '-o',
        'jsonpath={.items[0].metadata.name}',
      ],
      { encoding: 'utf-8', timeout: 10_000 }
    ).trim()
    const sql = `INSERT INTO user_workflow_triggers (recipe_namespace, recipe_name, user_id) VALUES ('${RECIPE_NS}', '${RECIPE_NAME}', '${userId}') ON CONFLICT DO NOTHING;`
    execFileSync(
      'kubectl',
      [
        '--context',
        K8S_CONTEXT,
        '-n',
        'control-plane',
        'exec',
        pgPod,
        '--',
        'psql',
        '-U',
        'postgres',
        '-d',
        'profiles',
        '-c',
        sql,
      ],
      { encoding: 'utf-8', timeout: 10_000 }
    )
    return true
  } catch {
    return false
  }
}

async function setupApproval(
  runId: string,
  msg: string
): Promise<{ userId: string; wrcAccessToken: string; approvalId: string }> {
  const { userId, userToken } = await loginAs(E2E_EMAIL)

  if (!seedAllowlist(userId)) {
    throw new Error(`failed to seed approval allowlist for ${RECIPE_NS}/${RECIPE_NAME}`)
  }

  const issueRes = await apiRequest(
    'POST',
    `${WORKFLOW_API}/api/v1/auth/mcp-host/${encodeURIComponent(RECIPE_NS)}/${encodeURIComponent(RECIPE_NAME)}/tokens`,
    JSON.stringify({
      includeMcpHostControlToken: true,
      workflowControlScopes: ['workflow:list', 'workflow:read', 'workflow:trigger'],
    }),
    { Authorization: `Bearer ${signWrcInternalControlJwt(K8S_CONTEXT)}` }
  )
  if (issueRes.status !== 200) {
    throw new Error(
      `/auth/mcp-host/:ns/:name/tokens failed: HTTP ${issueRes.status} ${issueRes.body}`
    )
  }
  const issued = JSON.parse(issueRes.body)
  const wrcAccessToken: string = issued.mcpHostAccessToken || issued.o?.mcpHostAccessToken || ''
  if (!wrcAccessToken) {
    throw new Error(`/auth/mcp-host/:ns/:name/tokens returned no mcpHostAccessToken`)
  }

  const approvalRes = await apiRequest(
    'POST',
    `${WORKFLOW_API}/api/v1/workflow-approvals/request`,
    JSON.stringify({
      recipeNamespace: RECIPE_NS,
      recipeName: RECIPE_NAME,
      target: { userId },
      payload: { message: msg },
      correlation: { taskId: `pw-task-${runId}`, stepId: `pw-step-${runId}` },
      ttlSeconds: 300,
    }),
    { Authorization: `Bearer ${wrcAccessToken}`, 'Idempotency-Key': runId }
  )
  if (approvalRes.status !== 200) {
    throw new Error(
      `/workflow-approvals/request failed: HTTP ${approvalRes.status} ${approvalRes.body}`
    )
  }
  const created = JSON.parse(approvalRes.body)
  const approvalId: string = created.approvalRequestId || created.o?.approvalRequestId || ''
  if (!approvalId) {
    throw new Error(`/workflow-approvals/request returned no approvalRequestId`)
  }

  return { userId, wrcAccessToken, approvalId }
}

test('full approval flow: create → bell → approve → verify', async () => {
  await clearSession()

  const setup = await setupApproval(RUN_ID, APPROVAL_MSG)
  const { wrcAccessToken, approvalId } = setup

  const { app, page } = await launchAndLogin(E2E_EMAIL)

  try {
    const bell = page.getByRole('button', { name: 'Notifications and approvals' })
    await bell.click()
    const panel = page.getByRole('dialog', { name: 'Notifications and approvals' })
    await expect(panel).toBeVisible({ timeout: 5_000 })

    const card = panel.locator('.notification-item').filter({ hasText: APPROVAL_MSG })
    await expect(card).toBeVisible({ timeout: 40_000 })

    await expect(
      card.locator('.notification-item-chip', { hasText: `Step: pw-step-${RUN_ID}` })
    ).toBeVisible()

    const approveBtn = card.locator('.approval-action-btn.approve')
    await expect(approveBtn).toBeEnabled()
    await approveBtn.click()

    const toast = page.locator('.toast.tone-success').filter({ hasText: 'Approval accepted' })
    await expect(toast).toBeVisible({ timeout: 5_000 })

    await expect(card).not.toBeVisible({ timeout: 20_000 })

    const statusRes = await apiRequest(
      'GET',
      `${WORKFLOW_API}/api/v1/workflow-approvals/${approvalId}/status`,
      undefined,
      { Authorization: `Bearer ${wrcAccessToken}` }
    )
    expect(statusRes.status, statusRes.body).toBe(200)
    const statusData = JSON.parse(statusRes.body)
    expect(statusData.status || statusData.o?.status).toBe('approved')
  } finally {
    await app.close()
  }
})

test('deny flow: create → bell → deny → verify backend status=denied', async () => {
  await clearSession()

  const denyRunId = `pw-deny-${Date.now()}`
  const denyMsg = `E2E deny ${denyRunId}`
  const setup = await setupApproval(denyRunId, denyMsg)
  const { wrcAccessToken, approvalId } = setup

  const { app, page } = await launchAndLogin(E2E_EMAIL)

  try {
    const bell = page.getByRole('button', { name: 'Notifications and approvals' })
    await bell.click()
    const panel = page.getByRole('dialog', { name: 'Notifications and approvals' })
    await expect(panel).toBeVisible({ timeout: 5_000 })

    const card = panel.locator('.notification-item').filter({ hasText: denyMsg })
    await expect(card).toBeVisible({ timeout: 40_000 })

    const denyBtn = card.locator('.approval-action-btn.deny')
    await expect(denyBtn).toBeEnabled()
    await denyBtn.click()

    const toast = page.locator('.toast.tone-success').filter({ hasText: 'Approval denied' })
    await expect(toast).toBeVisible({ timeout: 5_000 })

    await expect(card).not.toBeVisible({ timeout: 20_000 })

    const statusRes = await apiRequest(
      'GET',
      `${WORKFLOW_API}/api/v1/workflow-approvals/${approvalId}/status`,
      undefined,
      { Authorization: `Bearer ${wrcAccessToken}` }
    )
    expect(statusRes.status, statusRes.body).toBe(200)
    const statusData = JSON.parse(statusRes.body)
    expect(statusData.status || statusData.o?.status).toBe('denied')
  } finally {
    await app.close()
  }
})
