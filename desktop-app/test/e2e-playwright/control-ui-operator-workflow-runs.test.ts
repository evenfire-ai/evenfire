import { type Page, expect, test } from '@playwright/test'
import { profilesSql, sqlLiteral } from './workflow-approval-quadrants/cluster'
import { WORKFLOW_RECIPE_NS } from './workflow-approval-quadrants/constants'
import {
  applyRecipe,
  cleanupRecipe,
  grantUserThroughAdminRoute,
} from './workflow-approval-quadrants/recipes'
import {
  E2E_EMAIL,
  clearSession,
  launchAndLogin,
  loginAs,
  openWorkflowsPage,
  selectWorkflow,
  workflowRow,
} from './workflowUi'

const CONTROL_UI = process.env.CONTROL_UI_URL || 'http://127.0.0.1:3000'
const ADMIN_USER = process.env.E2E_ADMIN_USERNAME || process.env.ADMIN_USER || 'admin'
const ADMIN_PASSWORD =
  process.env.E2E_ADMIN_PASSWORD ||
  process.env.ADMIN_PASSWORD ||
  process.env.ADMIN_PASS ||
  'changeme123!'

const OPERATOR_INPUT_CONTRACT = `
type: object
required:
  - packet
properties:
  packet:
    type: string
    default: baseline
    description: Diligence packet name
`

function workflowRunCount(recipeName: string): number {
  return Number(
    profilesSql(`
      SELECT COUNT(*)
        FROM workflow_runs
       WHERE recipe_namespace = ${sqlLiteral(WORKFLOW_RECIPE_NS)}
         AND recipe_name = ${sqlLiteral(recipeName)};
    `)
  )
}

function approvalRequestCount(recipeName: string): number {
  return Number(
    profilesSql(`
      SELECT COUNT(*)
        FROM workflow_approval_requests
       WHERE recipe_namespace = ${sqlLiteral(WORKFLOW_RECIPE_NS)}
         AND recipe_name = ${sqlLiteral(recipeName)};
    `)
  )
}

function triggerGrantCount(
  table: 'user_workflow_triggers' | 'team_workflow_triggers',
  recipeName: string
): number {
  return Number(
    profilesSql(`
      SELECT COUNT(*)
        FROM ${table}
       WHERE recipe_namespace = ${sqlLiteral(WORKFLOW_RECIPE_NS)}
         AND recipe_name = ${sqlLiteral(recipeName)};
    `)
  )
}

async function waitForLatestRun(recipeName: string): Promise<{
  runId: string
  actorType: string
  usageTeamId: string
  approvalRequestId: string
  inputs: Record<string, unknown> | null
}> {
  let raw = ''
  await expect
    .poll(
      () => {
        raw = profilesSql(`
          SELECT run_id::text || '|' ||
                 actor_type || '|' ||
                 COALESCE(usage_team_id, '<none>') || '|' ||
                 COALESCE(approval_request_id::text, '<none>') || '|' ||
                 COALESCE(inputs::text, 'null')
            FROM workflow_runs
           WHERE recipe_namespace = ${sqlLiteral(WORKFLOW_RECIPE_NS)}
             AND recipe_name = ${sqlLiteral(recipeName)}
           ORDER BY created_at DESC
           LIMIT 1;
        `)
        return raw
      },
      {
        timeout: 60_000,
        intervals: [500, 1_000, 2_000],
        message: `timed out waiting for workflow run for ${WORKFLOW_RECIPE_NS}/${recipeName}`,
      }
    )
    .toMatch(/^[0-9a-f-]{36}\|/)

  const [runId, actorType, usageTeamId, approvalRequestId, inputsRaw] = raw.split('|')
  return {
    runId,
    actorType,
    usageTeamId,
    approvalRequestId,
    inputs: JSON.parse(inputsRaw) as Record<string, unknown> | null,
  }
}

async function waitForLatestApproval(recipeName: string): Promise<{
  id: string
  status: string
}> {
  let raw = ''
  await expect
    .poll(
      () => {
        raw = profilesSql(`
          SELECT id::text || '|' || status
            FROM workflow_approval_requests
           WHERE recipe_namespace = ${sqlLiteral(WORKFLOW_RECIPE_NS)}
             AND recipe_name = ${sqlLiteral(recipeName)}
           ORDER BY requested_at DESC
           LIMIT 1;
        `)
        return raw
      },
      {
        timeout: 60_000,
        intervals: [500, 1_000, 2_000],
        message: `timed out waiting for approval request for ${WORKFLOW_RECIPE_NS}/${recipeName}`,
      }
    )
    .toMatch(/^[0-9a-f-]{36}\|/)

  const [id, status] = raw.split('|')
  return { id, status }
}

async function loginControlUi(page: Page): Promise<void> {
  await page.goto(CONTROL_UI)
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible({ timeout: 20_000 })
  const inputs = page.locator('input')
  await inputs.nth(0).fill(ADMIN_USER)
  await inputs.nth(1).fill(ADMIN_PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).last().click()
  await expect(page.getByRole('button', { name: 'Workflow Recipes' })).toBeVisible({
    timeout: 30_000,
  })
  await expect(page.getByRole('button', { name: 'Log out' })).toBeVisible({
    timeout: 30_000,
  })
}

async function openControlUiRecipeFromList(page: Page, recipeName: string): Promise<void> {
  await page.goto(`${CONTROL_UI}/workflow-recipes`)
  await expect(page.getByLabel('Search workflow recipes')).toBeVisible({
    timeout: 30_000,
  })
  await expect(page.getByRole('button', { name: 'Install Recipe' })).toBeVisible({
    timeout: 30_000,
  })

  const search = page.getByLabel('Search workflow recipes')
  await expect(search).toBeVisible({ timeout: 20_000 })
  await search.fill(recipeName)

  const row = page.getByRole('link', { name: `Open ${recipeName}` })
  await expect(row).toBeVisible({ timeout: 45_000 })
  await expect(row).toContainText(WORKFLOW_RECIPE_NS)
  await row.click()

  await expect(page).toHaveURL(
    new RegExp(
      `/workflow-recipes/${WORKFLOW_RECIPE_NS}/${recipeName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`
    ),
    { timeout: 30_000 }
  )
  await expect(page.getByRole('heading', { name: recipeName })).toBeVisible({ timeout: 30_000 })
}

async function triggerControlUiOperatorRun(
  page: Page,
  recipeName: string,
  packet: string
): Promise<string> {
  await openControlUiRecipeFromList(page, recipeName)
  const runsBefore = workflowRunCount(recipeName)

  const runButton = page.getByRole('button', { name: /^Run/ }).first()
  await expect(runButton).toBeEnabled({ timeout: 90_000 })
  await runButton.click()

  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible({ timeout: 15_000 })
  await expect(
    dialog.getByRole('heading', { name: new RegExp(`Run .*${recipeName}`) })
  ).toBeVisible()
  await expect(dialog.getByText(/Starts an on-demand operator run in/i)).toBeVisible()

  const packetInput = dialog.getByLabel('packet')
  await expect(packetInput).toBeVisible()
  await packetInput.fill(packet)

  await dialog.getByRole('button', { name: /^Run as operator$/ }).click()
  await expect
    .poll(() => workflowRunCount(recipeName), {
      timeout: 60_000,
      intervals: [500, 1_000, 2_000],
      message: `Control UI operator trigger should create a workflow run for ${recipeName}`,
    })
    .toBeGreaterThan(runsBefore)

  const { runId } = await waitForLatestRun(recipeName)
  await page.goto(
    `${CONTROL_UI}/workflow-recipes/${encodeURIComponent(WORKFLOW_RECIPE_NS)}/${encodeURIComponent(recipeName)}/runs/${encodeURIComponent(runId)}`
  )
  await expect(page).toHaveURL(new RegExp(`/runs/${runId}$`), { timeout: 30_000 })
  await expect(page.getByRole('heading', { name: `Run ${runId.slice(0, 8)}` })).toBeVisible({
    timeout: 30_000,
  })
  return runId
}

async function triggerDesktopWorkflowThroughUi(
  page: Page,
  recipeName: string,
  packet?: string
): Promise<void> {
  await openWorkflowsPage(page)
  const detailCard = await selectWorkflow(page, recipeName, WORKFLOW_RECIPE_NS)
  if (packet !== undefined) {
    const packetInput = detailCard.getByLabel('packet *')
    await expect(packetInput).toBeVisible({ timeout: 20_000 })
    await packetInput.fill(packet)
  }
  const triggerButton = detailCard.getByRole('button', { name: /^Trigger$/ })
  await expect(triggerButton).toBeEnabled({ timeout: 30_000 })
  await triggerButton.click()
}

async function approvePendingApprovalThroughDesktopUi(
  page: Page,
  recipeName: string
): Promise<void> {
  const bell = page.getByRole('button', { name: 'Notifications and approvals' })
  await expect(bell).toBeVisible({ timeout: 20_000 })
  await bell.click()

  const panel = page.getByRole('dialog', { name: 'Notifications and approvals' })
  await expect(panel).toBeVisible({ timeout: 10_000 })

  const card = panel.locator('.notification-item').filter({ hasText: recipeName }).first()
  await expect(card).toBeVisible({ timeout: 60_000 })
  await expect(card).toContainText(`Approve ${WORKFLOW_RECIPE_NS}/${recipeName}`)
  await expect(card.getByRole('button', { name: 'Deny' })).toBeVisible()

  const approveButton = card.getByRole('button', { name: 'Approve' })
  await expect(approveButton).toBeEnabled()
  await approveButton.click()

  await expect(page.getByRole('status').filter({ hasText: /Approval accepted/ })).toBeVisible({
    timeout: 20_000,
  })
  await expect(card).not.toBeVisible({ timeout: 30_000 })
}

test.describe.serial('Control UI operator workflow runs and Desktop approval boundaries', () => {
  test('Control UI admin runs approval-gated workflow as operator without user/team grants', async ({
    page,
  }) => {
    test.setTimeout(240_000)
    const recipeName = `e2e-quadrant-operator-${Date.now()}`
    const packet = `operator-packet-${Date.now()}`

    await cleanupRecipe(recipeName)
    applyRecipe(recipeName, {
      requiresApproval: true,
      allowedActors: ['user'],
      inputContract: OPERATOR_INPUT_CONTRACT,
      instruction: 'Record the operator packet {{inputs.packet}} for E2E validation.',
    })

    try {
      expect(triggerGrantCount('user_workflow_triggers', recipeName)).toBe(0)
      expect(triggerGrantCount('team_workflow_triggers', recipeName)).toBe(0)

      await loginControlUi(page)
      const runIdFromUi = await triggerControlUiOperatorRun(page, recipeName, packet)

      const run = await waitForLatestRun(recipeName)
      expect(run.runId).toBe(runIdFromUi)
      expect(run.actorType).toBe('admin')
      expect(run.usageTeamId).toBe('control-plane-admin-ui')
      expect(run.approvalRequestId).toBe('<none>')
      expect(run.inputs).toMatchObject({ packet })
      expect(approvalRequestCount(recipeName)).toBe(0)
      expect(triggerGrantCount('user_workflow_triggers', recipeName)).toBe(0)
      expect(triggerGrantCount('team_workflow_triggers', recipeName)).toBe(0)
    } finally {
      await cleanupRecipe(recipeName)
    }
  })

  test('Control UI blocks on-demand recipe whose allowedActors excludes user', async ({ page }) => {
    test.setTimeout(180_000)
    const recipeName = `e2e-quadrant-wrong-actor-${Date.now()}`

    await cleanupRecipe(recipeName)
    applyRecipe(recipeName, {
      requiresApproval: true,
      allowedActors: ['autonomous'],
      instruction: 'This fixture must not be runnable from human on-demand UI.',
    })

    try {
      await loginControlUi(page)
      await openControlUiRecipeFromList(page, recipeName)

      const runButton = page.getByRole('button', { name: /^Run/ }).first()
      await expect(runButton).toBeDisabled({ timeout: 60_000 })
      await expect(
        page.getByText(
          /does not allow user actors|Add "user" to spec\.triggers\.onDemand\.allowedActors/
        )
      ).toBeVisible()
      expect(workflowRunCount(recipeName)).toBe(0)
      expect(approvalRequestCount(recipeName)).toBe(0)
    } finally {
      await cleanupRecipe(recipeName)
    }
  })

  test('Desktop user trigger still requires visible approval and creates approval-bound user run', async () => {
    test.setTimeout(300_000)
    await clearSession()

    const recipeName = `e2e-quadrant-desktop-approval-${Date.now()}`
    const packet = `desktop-approved-${Date.now()}`
    const { userId } = await loginAs(E2E_EMAIL)

    await cleanupRecipe(recipeName)
    applyRecipe(recipeName, {
      requiresApproval: true,
      allowedActors: ['user'],
      inputContract: OPERATOR_INPUT_CONTRACT,
      instruction: 'Record the Desktop packet {{inputs.packet}} for E2E validation.',
    })
    await grantUserThroughAdminRoute(WORKFLOW_RECIPE_NS, recipeName, userId)

    const { app, page } = await launchAndLogin(E2E_EMAIL)
    try {
      await triggerDesktopWorkflowThroughUi(page, recipeName, packet)
      await expect(
        page
          .getByRole('status')
          .filter({ hasText: 'Approval requested. Open notifications to approve.' })
      ).toBeVisible({ timeout: 30_000 })

      const approval = await waitForLatestApproval(recipeName)
      expect(approval.status).toBe('pending')
      expect(workflowRunCount(recipeName)).toBe(0)

      await approvePendingApprovalThroughDesktopUi(page, recipeName)

      await expect
        .poll(
          () =>
            profilesSql(`
              SELECT status
                FROM workflow_approval_requests
               WHERE id = ${sqlLiteral(approval.id)};
            `),
          { timeout: 45_000, intervals: [500, 1_000, 2_000] }
        )
        .toBe('consumed')

      const run = await waitForLatestRun(recipeName)
      expect(run.actorType).toBe('user')
      expect(run.approvalRequestId).toBe(approval.id)
      expect(run.inputs).toMatchObject({ packet })
    } finally {
      await app.close().catch(() => undefined)
      await cleanupRecipe(recipeName)
    }
  })

  test('Desktop user cannot trigger an approval-gated workflow without user or team grants', async () => {
    test.setTimeout(240_000)
    await clearSession()

    const recipeName = `e2e-quadrant-desktop-no-grant-${Date.now()}`
    const packet = `desktop-denied-${Date.now()}`

    await cleanupRecipe(recipeName)
    applyRecipe(recipeName, {
      requiresApproval: true,
      allowedActors: ['user'],
      inputContract: OPERATOR_INPUT_CONTRACT,
      instruction: 'This fixture must fail closed without trigger grants.',
    })

    const { app, page } = await launchAndLogin(E2E_EMAIL)
    try {
      expect(triggerGrantCount('user_workflow_triggers', recipeName)).toBe(0)
      expect(triggerGrantCount('team_workflow_triggers', recipeName)).toBe(0)

      await openWorkflowsPage(page)
      const row = workflowRow(page, recipeName)
      if (await row.isVisible().catch(() => false)) {
        const detailCard = await selectWorkflow(page, recipeName, WORKFLOW_RECIPE_NS)
        const packetInput = detailCard.getByLabel('packet *')
        await expect(packetInput).toBeVisible({ timeout: 20_000 })
        await packetInput.fill(packet)
        await detailCard.getByRole('button', { name: /^Trigger$/ }).click()

        const failureStatus = page.getByRole('alert').filter({ hasText: /Trigger failed:/ })
        await expect(failureStatus).toBeVisible({
          timeout: 30_000,
        })
        await expect(failureStatus).toContainText(/not authorized|forbidden|grant|approval/i)
      } else {
        await expect(row).not.toBeVisible()
      }

      expect(workflowRunCount(recipeName)).toBe(0)
      expect(approvalRequestCount(recipeName)).toBe(0)
    } finally {
      await app.close().catch(() => undefined)
      await cleanupRecipe(recipeName)
    }
  })
})
