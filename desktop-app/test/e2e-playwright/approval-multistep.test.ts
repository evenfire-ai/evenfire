// desktop-app/test/e2e-playwright/approval-multistep.test.ts
//
// Multi-step approval flow (single user — test@clerum.io):
//   - Two approvals for the same user, different stepIds (step-1 + step-2)
//   - Launch Desktop App, verify bell shows both cards
//   - Approve step-1 → backend status=approved, step-2 stays pending (step-level isolation)
//   - Approve step-2 → backend status=approved
//
// Requires minikube port-forwards: control-api :8090, external-rest-api :8091, rpc-proxy :8094.
import { expect, test } from '@playwright/test'
import { E2E_TEST_EMAIL } from '../../../tests/e2e/testUser'
import { signWrcInternalControlJwt } from './workflowAuth'
import {
  apiRequest,
  launchAndLogin,
  loginAs,
  seedAllowlist as seedWorkflowAllowlist,
} from './workflowUi'

const USER_EMAIL = E2E_TEST_EMAIL
const EXT_API = process.env.EXTERNAL_REST_API_BASE_URL || 'http://127.0.0.1:8091'
const WORKFLOW_API =
  process.env.E2E_WORKFLOW_API_BASE_URL ||
  process.env.CONTROL_API_BASE_URL ||
  'http://127.0.0.1:8090'
const RECIPE_NS = 'sandbox-recipes'
const RECIPE_NAME = 'e2e-ondemand-approval'
const K8S_CONTEXT = process.env.E2E_K8S_CONTEXT || 'clerum-test'
const RUN_ID = `pw-ms-${Date.now()}`

const STEP_1_ID = `step-1-${RUN_ID}`
const STEP_2_ID = `step-2-${RUN_ID}`
const STEP_1_MSG = `E2E multi-step approve ${STEP_1_ID}`
const STEP_2_MSG = `E2E multi-step approve ${STEP_2_ID}`

async function issueWrcToken(): Promise<string> {
  const res = await apiRequest(
    'POST',
    `${WORKFLOW_API}/api/v1/auth/mcp-host/${encodeURIComponent(RECIPE_NS)}/${encodeURIComponent(RECIPE_NAME)}/tokens`,
    JSON.stringify({
      includeMcpHostControlToken: true,
      workflowControlScopes: ['workflow:list', 'workflow:read', 'workflow:trigger'],
    }),
    { Authorization: `Bearer ${signWrcInternalControlJwt(K8S_CONTEXT)}` }
  )
  if (res.status !== 200) {
    throw new Error(`/auth/mcp-host/:ns/:name/tokens failed: HTTP ${res.status} ${res.body}`)
  }
  const data = JSON.parse(res.body)
  const accessToken = data.mcpHostAccessToken || data.o?.mcpHostAccessToken || null
  if (!accessToken) {
    throw new Error(`/auth/mcp-host/:ns/:name/tokens succeeded but returned no mcpHostAccessToken`)
  }
  return accessToken
}

async function createApproval(
  wrcToken: string,
  targetUserId: string,
  stepId: string,
  message: string,
  idempotencyKey: string
): Promise<string> {
  const res = await apiRequest(
    'POST',
    `${WORKFLOW_API}/api/v1/workflow-approvals/request`,
    JSON.stringify({
      recipeNamespace: RECIPE_NS,
      recipeName: RECIPE_NAME,
      target: { userId: targetUserId },
      payload: { message },
      correlation: { taskId: `pw-task-${RUN_ID}`, stepId },
      ttlSeconds: 300,
    }),
    { Authorization: `Bearer ${wrcToken}`, 'Idempotency-Key': idempotencyKey }
  )
  if (res.status !== 200) {
    throw new Error(
      `/workflow-approvals/request failed for ${stepId}: HTTP ${res.status} ${res.body}`
    )
  }
  const data = JSON.parse(res.body)
  const approvalRequestId = data.approvalRequestId || data.o?.approvalRequestId || null
  if (!approvalRequestId) {
    throw new Error(
      `/workflow-approvals/request succeeded for ${stepId} but returned no approvalRequestId`
    )
  }
  return approvalRequestId
}

async function getApprovalStatus(wrcToken: string, approvalId: string): Promise<string> {
  const res = await apiRequest(
    'GET',
    `${WORKFLOW_API}/api/v1/workflow-approvals/${approvalId}/status`,
    undefined,
    { Authorization: `Bearer ${wrcToken}` }
  )
  if (res.status !== 200) {
    throw new Error(
      `/workflow-approvals/${approvalId}/status failed: HTTP ${res.status} ${res.body}`
    )
  }
  const data = JSON.parse(res.body)
  const status = data.status || data.o?.status || null
  if (!status) {
    throw new Error(`/workflow-approvals/${approvalId}/status succeeded but returned no status`)
  }
  return status
}

test('multi-step: approve step-1, step-2 stays pending, then approve step-2 — backend step-level isolation', async () => {
  const login = await loginAs(USER_EMAIL)
  seedWorkflowAllowlist(login.userId, RECIPE_NAME)
  const wrcToken = await issueWrcToken()

  const approval1Id = await createApproval(
    wrcToken,
    login.userId,
    STEP_1_ID,
    STEP_1_MSG,
    `${RUN_ID}-s1`
  )
  const approval2Id = await createApproval(
    wrcToken,
    login.userId,
    STEP_2_ID,
    STEP_2_MSG,
    `${RUN_ID}-s2`
  )

  const { app, page } = await launchAndLogin(USER_EMAIL)

  try {
    const bell = page.getByRole('button', { name: 'Notifications and approvals' })

    // Open bell and verify BOTH cards visible.
    await bell.click()
    const panel = page.getByRole('dialog', { name: 'Notifications and approvals' })
    await expect(panel).toBeVisible({ timeout: 5_000 })

    const card1 = panel.locator('.notification-item').filter({ hasText: STEP_1_MSG })
    const card2 = panel.locator('.notification-item').filter({ hasText: STEP_2_MSG })
    await expect(card1).toBeVisible({ timeout: 40_000 })
    await expect(card2).toBeVisible({ timeout: 40_000 })
    await expect(
      card1.locator('.notification-item-chip', { hasText: `Step: ${STEP_1_ID}` })
    ).toBeVisible()
    await expect(
      card2.locator('.notification-item-chip', { hasText: `Step: ${STEP_2_ID}` })
    ).toBeVisible()

    // Approve step-1; step-2 must remain pending (step-level backend isolation).
    const approve1 = card1.locator('.approval-action-btn.approve')
    await expect(approve1).toBeEnabled()
    await approve1.click()
    await expect(
      page.locator('.toast.tone-success').filter({ hasText: 'Approval accepted' })
    ).toBeVisible({ timeout: 5_000 })
    await expect(card1).not.toBeVisible({ timeout: 20_000 })

    expect(await getApprovalStatus(wrcToken, approval1Id)).toBe('approved')
    expect(await getApprovalStatus(wrcToken, approval2Id)).toBe('pending')

    // Approve step-2.
    await expect(card2).toBeVisible()
    const approve2 = card2.locator('.approval-action-btn.approve')
    await expect(approve2).toBeEnabled()
    await approve2.click()
    await expect(
      page.locator('.toast.tone-success').filter({ hasText: 'Approval accepted' })
    ).toBeVisible({ timeout: 5_000 })
    await expect(card2).not.toBeVisible({ timeout: 20_000 })

    expect(await getApprovalStatus(wrcToken, approval2Id)).toBe('approved')
  } finally {
    await app.close().catch(() => {})
  }
})
