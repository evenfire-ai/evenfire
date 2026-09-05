// control-ui/e2e/qa-recorder-create-form-smoke.spec.ts
//
// Read-only create-form availability smoke tour. Opens every mutating create
// wizard directly via its canonical route, asserts the CreatePageHeader title +
// subtitle render, asserts step 0's primary field, and — where it is safe to do
// so without a real prerequisite resource — clicks Continue/Next once to prove
// step progression. No test clicks a final Create/Submit/Install action, so
// nothing is mutated and there is no confirm flag or cleanup.
import { type Page, expect, test } from '@playwright/test'
import {
  CONTROL_API_URL,
  CONTROL_UI_URL,
  adminCredentials,
  assertAllowedTarget,
  loginThroughUi,
  screenshotAndLog,
} from './qa-recorder-helpers'

test.describe('optional QA recorder: Control UI create-form smoke', () => {
  async function openCreatePage(page: Page, path: string): Promise<void> {
    assertAllowedTarget('CONTROL_UI_URL', CONTROL_UI_URL)
    assertAllowedTarget('CONTROL_API_URL', CONTROL_API_URL)
    await loginThroughUi(page, adminCredentials())
    await page.goto(path)
  }

  async function expectShell(page: Page, title: string, subtitle: string): Promise<void> {
    await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible({
      timeout: 20_000,
    })
    await expect(page.getByText(subtitle, { exact: true })).toBeVisible({ timeout: 20_000 })
  }

  async function clickContinue(page: Page): Promise<void> {
    const continueButton = page
      .locator('.cu-create-actions')
      .getByRole('button', { name: 'Continue', exact: true })
    await expect(continueButton).toBeEnabled()
    await continueButton.click()
  }

  test('Create connector form mounts on the identity step', async ({ page }, testInfo) => {
    await openCreatePage(page, '/connectors/new')
    await expectShell(
      page,
      'Create connector',
      'Register a new connector and optionally create its managed deployment metadata.'
    )
    // Step 0 panel title (CreateStepFlow header) renders with the step body.
    await expect(page.getByText('Connector identity', { exact: true })).toBeVisible({
      timeout: 20_000,
    })

    await screenshotAndLog(page, testInfo, 'control-ui-create-connector')
  })

  test('Create agent form mounts and steps to model & credentials', async ({ page }, testInfo) => {
    await openCreatePage(page, '/agents/new')
    await expectShell(
      page,
      'Create agent',
      'Provision a new agent with connectors, credentials, and access.'
    )
    await expect(page.getByPlaceholder('agent-name')).toBeVisible({ timeout: 20_000 })

    await page.getByPlaceholder('agent-name').fill('qa-smoke-agent')
    const next = page
      .locator('.cu-create-actions')
      .getByRole('button', { name: 'Next', exact: true })
    await expect(next).toBeEnabled()
    await next.click()
    await expect(page.getByText('Model & credentials', { exact: true })).toBeVisible({
      timeout: 20_000,
    })

    await screenshotAndLog(page, testInfo, 'control-ui-create-agent')
  })

  test('Add allowed model form mounts', async ({ page }, testInfo) => {
    await openCreatePage(page, '/llm-models/new')
    await expectShell(
      page,
      'Add allowed model',
      'Allow a provider/model so agents and runtime can select it.'
    )
    await expect(page.locator('#llm-model-provider')).toBeVisible({ timeout: 20_000 })

    await screenshotAndLog(page, testInfo, 'control-ui-create-llm-model')
  })

  test('Create LLM secret form mounts', async ({ page }, testInfo) => {
    await openCreatePage(page, '/secrets/new?scope=llm')
    await expectShell(
      page,
      'Create LLM secret',
      'Store provider credentials for agent host secrets.'
    )
    await expect(page.locator('#llm-secret-name')).toBeVisible({ timeout: 20_000 })

    await screenshotAndLog(page, testInfo, 'control-ui-create-secret-llm')
  })

  test('Create connector secret form mounts', async ({ page }, testInfo) => {
    await openCreatePage(page, '/secrets/new?scope=mcp')
    await expectShell(
      page,
      'Create connector secret',
      'Create a Kubernetes secret for connector credential injection.'
    )
    await expect(page.locator('#mcp-secret-name')).toBeVisible({ timeout: 20_000 })

    await screenshotAndLog(page, testInfo, 'control-ui-create-secret-mcp')
  })

  test('Create recipe secret form mounts', async ({ page }, testInfo) => {
    await openCreatePage(page, '/secrets/new?scope=recipe')
    await expectShell(
      page,
      'Create recipe secret',
      'Create a Kubernetes secret in sandbox-recipes for recipe credential injection.'
    )
    await expect(page.locator('#recipe-secret-name')).toBeVisible({ timeout: 20_000 })

    await screenshotAndLog(page, testInfo, 'control-ui-create-secret-recipe')
  })

  test('New token budget form mounts', async ({ page }, testInfo) => {
    await openCreatePage(page, '/cost-and-usage/token-budgets/new')
    await expectShell(
      page,
      'New token budget',
      'Cap LLM spend per dimension and watch it against live usage. P0c runs in observation mode.'
    )
    await expect(page.locator('#budget-name')).toBeVisible({ timeout: 20_000 })

    await screenshotAndLog(page, testInfo, 'control-ui-create-token-budget')
  })

  test('Add LLM price form mounts', async ({ page }, testInfo) => {
    await openCreatePage(page, '/cost-and-usage/llm-prices/new')
    await expectShell(
      page,
      'Add LLM price',
      'Set per-1M-token prices for a provider/model so cost budgets can price usage.'
    )
    await expect(page.locator('#llm-price-provider')).toBeVisible({ timeout: 20_000 })

    await screenshotAndLog(page, testInfo, 'control-ui-create-llm-price')
  })

  test('Create team form mounts and steps to the members step', async ({ page }, testInfo) => {
    await openCreatePage(page, '/users-and-teams/teams/new')
    await expectShell(page, 'Create team', 'Create a team now. Add members and roles next.')
    await expect(page.locator('#new-team-name')).toBeVisible({ timeout: 20_000 })

    await page.locator('#new-team-name').fill('QA Smoke Team')
    await clickContinue(page)
    await expect(
      page.getByText('Choose initial team members and roles.', { exact: true })
    ).toBeVisible({ timeout: 20_000 })

    await screenshotAndLog(page, testInfo, 'control-ui-create-team')
  })

  test('Create member form mounts and steps to the team step', async ({ page }, testInfo) => {
    await openCreatePage(page, '/users-and-teams/users/new')
    await expectShell(
      page,
      'Create member',
      'Create a pending invitation and send the invitation email.'
    )
    await expect(page.locator('#new-user-name')).toBeVisible({ timeout: 20_000 })

    await page.locator('#new-user-name').fill('QA Smoke')
    await page.locator('#new-user-email').fill('qa-smoke@example.com')
    await clickContinue(page)
    await expect(
      page.getByText('Place the invited member on a team now, or leave them unassigned.', {
        exact: true,
      })
    ).toBeVisible({ timeout: 20_000 })

    await screenshotAndLog(page, testInfo, 'control-ui-create-member')
  })

  test('Invite admin form mounts and steps to the review step', async ({ page }, testInfo) => {
    await openCreatePage(page, '/users-and-teams/admins/new')
    await expectShell(page, 'Invite admin', 'Invite a new Control UI admin.')
    await expect(page.locator('#control-admin-email')).toBeVisible({ timeout: 20_000 })

    await page.locator('#control-admin-email').fill('qa-smoke@example.com')
    await clickContinue(page)
    await expect(
      page.getByText(
        'The invitee will set their username and password after accepting the email.',
        { exact: true }
      )
    ).toBeVisible({ timeout: 20_000 })

    await screenshotAndLog(page, testInfo, 'control-ui-create-admin')
  })

  test('Create SharedFileSystem form mounts and steps to the access step', async ({
    page,
  }, testInfo) => {
    await openCreatePage(page, '/agent-files/new')
    await expectShell(
      page,
      'Create SharedFileSystem',
      'Provision workspace storage that agents can mount read-only into their pods.'
    )
    await expect(page.locator('#shared-filesystem-name')).toBeVisible({ timeout: 20_000 })

    await page.locator('#shared-filesystem-name').fill('qa-smoke-fs')
    await clickContinue(page)
    await expect(
      page.getByText('Pick the access mode, storage class, and deletion behavior.', { exact: true })
    ).toBeVisible({ timeout: 20_000 })

    await screenshotAndLog(page, testInfo, 'control-ui-create-shared-filesystem')
  })

  test('Publish to Marketplace form mounts', async ({ page }, testInfo) => {
    await openCreatePage(page, '/marketplace/publish')
    await expectShell(
      page,
      'Publish to Marketplace',
      'Publish connectors or plugins to the Marketplace with versioned metadata.'
    )
    // The publish wizard's step-0 panel title renders with the step body.
    await expect(page.getByText('Marketplace entry', { exact: true })).toBeVisible({
      timeout: 20_000,
    })

    await screenshotAndLog(page, testInfo, 'control-ui-marketplace-publish')
  })

  test('Install from Marketplace shell mounts without entry query params', async ({
    page,
  }, testInfo) => {
    await openCreatePage(page, '/marketplace/install')
    await expectShell(
      page,
      'Install from Marketplace',
      'Install a Marketplace entry into your cluster.'
    )
    // Without entry/version query params the page renders a graceful error
    // state beneath the header instead of a form.
    await expect(
      page.getByText('Missing Marketplace entry identifiers.', { exact: false })
    ).toBeVisible({ timeout: 20_000 })

    await screenshotAndLog(page, testInfo, 'control-ui-marketplace-install')
  })
})
