/**
 * E2E - Workflow access operator journey
 *
 * Validates the Control UI operator surface for the three separate contracts:
 *   - trigger user grants
 *   - trigger team grants
 *   - approval target teams
 *
 * The test uses API calls only for fixture setup, cleanup, and business-signal
 * assertions. It does not grant or revoke workflow access through API shortcuts.
 */
import { type Page, expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'

const BASE_API = process.env.CONTROL_API_URL || 'http://localhost:8090'
const BASE_UI = process.env.CONTROL_UI_URL || 'http://localhost:3000'
const ADMIN_USER = process.env.ADMIN_USER || 'admin'
const ADMIN_PASS = process.env.ADMIN_PASS || 'changeme123!'
const RECIPE_NS = 'sandbox-recipes'

type ApiResult<T> = {
  status: number
  data: T
  text: string
}

type AdminUser = {
  id: string
  email: string
  name?: string | null
  displayName?: string | null
}

type Team = {
  id: string
  name: string
}

type WorkflowRecipeResource = {
  metadata?: { name?: string; namespace?: string }
  spec?: Record<string, unknown>
}

type DeleteResult = {
  deleted?: boolean
  error?: string
}

function uniqueName(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
    .slice(0, 63)
    .replace(/-$/, '')
}

function userDisplayName(user: AdminUser): string {
  return user.displayName || user.name || user.email
}

function userPickerLabel(user: AdminUser): string {
  return `${userDisplayName(user)} (${user.email})`
}

function kubectlContext(): string | null {
  return (
    process.env.E2E_K8S_CONTEXT ||
    process.env.KUBECONTEXT ||
    process.env.K8S_CONTEXT ||
    process.env.CONTEXT ||
    null
  )
}

function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function runControlPostgresSql(sql: string): void {
  const context = kubectlContext()
  if (!context) {
    throw new Error(
      'team fixture cleanup requires E2E_K8S_CONTEXT, KUBECONTEXT, K8S_CONTEXT, or CONTEXT'
    )
  }

  const pod = execFileSync(
    'kubectl',
    [
      '--context',
      context,
      '-n',
      'control-plane',
      'get',
      'pod',
      '-l',
      'app=control-postgres',
      '-o',
      'jsonpath={.items[0].metadata.name}',
    ],
    { encoding: 'utf8' }
  ).trim()
  if (!pod) {
    throw new Error(`control-postgres pod not found in context ${context}`)
  }

  execFileSync(
    'kubectl',
    [
      '--context',
      context,
      '-n',
      'control-plane',
      'exec',
      pod,
      '--',
      'psql',
      '-U',
      'postgres',
      '-d',
      'profiles',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      sql,
    ],
    { encoding: 'utf8', stdio: 'pipe' }
  )
}

async function api<T>(
  token: string,
  method: string,
  path: string,
  body?: unknown
): Promise<ApiResult<T>> {
  const response = await fetch(`${BASE_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  let data = {} as T
  try {
    data = JSON.parse(text) as T
  } catch {
    data = { raw: text } as T
  }
  return { status: response.status, data, text }
}

async function loginApiToken(): Promise<string> {
  const response = await fetch(`${BASE_API}/api/v1/admin/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: ADMIN_USER, password: ADMIN_PASS }),
  })
  const text = await response.text()
  if (!response.ok) {
    throw new Error(`admin API login failed: HTTP ${response.status} ${text}`)
  }
  const data = JSON.parse(text) as { token?: string }
  if (!data.token) throw new Error('admin API login returned no token')
  return data.token
}

async function loginControlUi(page: Page): Promise<void> {
  await page.goto(BASE_UI)
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible({ timeout: 15_000 })
  const inputs = page.locator('input')
  await inputs.nth(0).fill(ADMIN_USER)
  await inputs.nth(1).fill(ADMIN_PASS)
  await page.getByRole('button', { name: 'Sign in' }).last().click()
  await expect(page.getByText('Workflow Recipes')).toBeVisible({ timeout: 20_000 })
}

async function requireUser(token: string): Promise<AdminUser> {
  const result = await api<{ items?: AdminUser[] }>(token, 'GET', '/api/v1/admin/users')
  expect(result.status, result.text).toBe(200)
  const user = result.data.items?.find(item => item.email) ?? result.data.items?.[0]
  if (!user?.id || !user.email) {
    throw new Error('admin users directory returned no selectable user')
  }
  return user
}

async function createTeam(token: string, name: string): Promise<Team> {
  const result = await api<Team>(token, 'POST', '/api/v1/admin/teams', { name })
  expect([200, 201], result.text).toContain(result.status)
  expect(result.data.id, result.text).toMatch(/^[0-9a-f-]{36}$/i)
  expect(result.data.name).toBe(name)
  return result.data
}

async function createRecipe(token: string, name: string): Promise<void> {
  const result = await api<WorkflowRecipeResource>(token, 'POST', '/api/v1/admin/recipes', {
    metadata: { name, namespace: RECIPE_NS },
    spec: {
      agent: { provider: 'zai', model: 'glm-4.7' },
      triggers: { onDemand: { requiresApproval: false, allowedActors: ['user'] } },
      steps: [
        {
          id: 'noop',
          instruction: 'Return ok.',
          timeoutSeconds: 60,
        },
      ],
      workloads: [],
    },
  })
  expect([200, 201], result.text).toContain(result.status)
  expect(result.data.metadata?.name).toBe(name)
}

async function deleteRecipe(token: string, name: string): Promise<void> {
  const result = await api<Record<string, unknown>>(
    token,
    'DELETE',
    `/api/v1/admin/recipes/${encodeURIComponent(name)}`
  )
  if (![200, 404].includes(result.status)) {
    throw new Error(`recipe cleanup failed: HTTP ${result.status} ${result.text}`)
  }
}

async function deleteTeam(token: string, teamId: string): Promise<ApiResult<DeleteResult>> {
  return api<DeleteResult>(token, 'DELETE', `/api/v1/admin/teams/${encodeURIComponent(teamId)}`)
}

function cleanupWorkflowAccessTeamRows(recipeName: string, teamId: string): void {
  const recipeNs = sqlLiteral(RECIPE_NS)
  const recipe = sqlLiteral(recipeName)
  const team = sqlLiteral(teamId)

  runControlPostgresSql(`
    BEGIN;
    DELETE FROM workflow_recipe_allowed_teams
      WHERE recipe_namespace = ${recipeNs}
        AND recipe_name = ${recipe}
        AND team_id = ${team};
    DELETE FROM team_workflow_triggers
      WHERE recipe_namespace = ${recipeNs}
        AND recipe_name = ${recipe}
        AND team_id = ${team};
    DELETE FROM workflow_recipe_allowed_teams_audit
      WHERE recipe_namespace = ${recipeNs}
        AND recipe_name = ${recipe}
        AND target_team_id = ${team};
    DELETE FROM team_workflow_grants_audit
      WHERE recipe_namespace = ${recipeNs}
        AND recipe_name = ${recipe}
        AND target_team_id = ${team};
    COMMIT;
  `)
}

async function deleteFixtureTeam(token: string, recipeName: string, teamId: string): Promise<void> {
  const first = await deleteTeam(token, teamId)
  if ([200, 404].includes(first.status)) return

  if (first.status !== 409 || first.data.error !== 'team_has_audit_history') {
    throw new Error(`team cleanup failed: HTTP ${first.status} ${first.text}`)
  }

  // Product deletion must retain real audit history. This E2E owns the fixture
  // recipe/team ids, so cleanup removes only those test audit rows before retry.
  cleanupWorkflowAccessTeamRows(recipeName, teamId)
  const second = await deleteTeam(token, teamId)
  if (![200, 404].includes(second.status)) {
    throw new Error(`team cleanup after audit cleanup failed: HTTP ${second.status} ${second.text}`)
  }
}

async function listUserGrantIds(token: string, recipeName: string): Promise<string[]> {
  const result = await api<{ items?: AdminUser[] }>(
    token,
    'GET',
    `/api/v1/admin/workflows/${encodeURIComponent(RECIPE_NS)}/${encodeURIComponent(recipeName)}/grants`
  )
  expect(result.status, result.text).toBe(200)
  return (result.data.items ?? []).map(item => item.id)
}

async function listTeamGrantIds(token: string, recipeName: string): Promise<string[]> {
  const result = await api<{ items?: Team[] }>(
    token,
    'GET',
    `/api/v1/admin/workflows/${encodeURIComponent(RECIPE_NS)}/${encodeURIComponent(recipeName)}/team-grants`
  )
  expect(result.status, result.text).toBe(200)
  return (result.data.items ?? []).map(item => item.id)
}

async function listApprovalTargetTeamIds(token: string, recipeName: string): Promise<string[]> {
  const result = await api<{ items?: Array<Team & { createdAt?: string }> }>(
    token,
    'GET',
    `/api/v1/admin/workflow-recipes/${encodeURIComponent(RECIPE_NS)}/${encodeURIComponent(recipeName)}/allowed-teams`
  )
  expect(result.status, result.text).toBe(200)
  return (result.data.items ?? []).map(item => item.id)
}

async function openRecipeEditorFromList(page: Page, recipeName: string): Promise<void> {
  await page.goto(`${BASE_UI}/workflow-recipes`)
  await expect(page).toHaveURL(/\/workflow-recipes/)
  const recipeSearch = page.getByLabel('Search workflow recipes')
  await expect(recipeSearch).toBeVisible({ timeout: 20_000 })
  await recipeSearch.fill(recipeName)
  const row = page.locator('tbody tr').filter({ hasText: recipeName }).first()
  await expect(row).toBeVisible({ timeout: 20_000 })
  await row.click()
  await expect(page).toHaveURL(new RegExp(`/workflow-recipes/${RECIPE_NS}/${recipeName}`))
  await expect(page.getByRole('button', { name: 'More plugin actions' })).toBeVisible({
    timeout: 20_000,
  })

  await page.getByRole('button', { name: 'More plugin actions' }).click()
  await page.getByRole('menuitem', { name: 'Edit' }).click()
  await expect(page).toHaveURL(new RegExp(`/workflow-recipes/${RECIPE_NS}/${recipeName}.*edit=1`))
  await page.getByRole('button', { name: 'Review manifest' }).click()
  await expect(page.getByText(/Manifest review passed/)).toBeVisible({ timeout: 20_000 })
  await page.getByRole('button', { name: 'Apply defaults' }).click()
  await page.getByRole('button', { name: 'Continue to access' }).click()
  await expect(page.getByTestId('workflow-access-panel')).toBeVisible({ timeout: 20_000 })
}

test('Control UI operator manages workflow access contracts without implicit coupling', async ({
  page,
}) => {
  test.setTimeout(180_000)

  const token = await loginApiToken()
  const recipeName = uniqueName('e2e-access-ui')
  const triggerTeam = await createTeam(token, `${recipeName}-trigger-team`)
  const approvalTeam = await createTeam(token, `${recipeName}-approval-team`)
  const user = await requireUser(token)

  try {
    await deleteRecipe(token, recipeName)
    await createRecipe(token, recipeName)
    await loginControlUi(page)
    await openRecipeEditorFromList(page, recipeName)

    const triggerUsers = page.getByTestId('workflow-access-trigger-users')
    const triggerTeams = page.getByTestId('workflow-access-trigger-teams')
    const approvalTargetTeams = page.getByTestId('workflow-access-approval-target-teams')

    await test.step('grant a trigger user through visible Control UI', async () => {
      await expect(triggerUsers).toContainText('Trigger users')
      await triggerUsers
        .getByLabel('Pick a user to grant trigger access')
        .selectOption({ label: userPickerLabel(user) })
      await triggerUsers.getByRole('button', { name: 'Grant user' }).click()
      await expect(
        triggerUsers.getByRole('button', { name: `Revoke user trigger access: ${user.email}` })
      ).toBeVisible()
      await expect
        .poll(() => listUserGrantIds(token, recipeName), {
          timeout: 20_000,
          message: 'user trigger grant must persist through admin API',
        })
        .toContain(user.id)
    })

    await test.step('grant a trigger team through visible Control UI', async () => {
      await expect(triggerTeams).toContainText('Trigger teams')
      await triggerTeams
        .getByLabel('Pick a team to grant trigger access')
        .selectOption({ label: triggerTeam.name })
      await triggerTeams.getByRole('button', { name: 'Grant team' }).click()
      await expect(
        triggerTeams.getByRole('button', {
          name: `Revoke team trigger access: ${triggerTeam.name}`,
        })
      ).toBeVisible()
      await expect
        .poll(() => listTeamGrantIds(token, recipeName), {
          timeout: 20_000,
          message: 'team trigger grant must persist through admin API',
        })
        .toContain(triggerTeam.id)
    })

    await test.step('allow an approval target team without granting trigger access', async () => {
      await expect(approvalTargetTeams).toContainText('Approval target teams')
      await approvalTargetTeams
        .getByLabel('Pick a team to allow as approval target')
        .selectOption({ label: approvalTeam.name })
      await approvalTargetTeams.getByRole('button', { name: 'Allow team' }).click()
      await expect(
        approvalTargetTeams.getByRole('button', {
          name: `Remove approval target team: ${approvalTeam.name}`,
        })
      ).toBeVisible()
      await expect
        .poll(() => listApprovalTargetTeamIds(token, recipeName), {
          timeout: 20_000,
          message: 'approval target team must persist through admin API',
        })
        .toContain(approvalTeam.id)
      await expect
        .poll(() => listTeamGrantIds(token, recipeName), {
          timeout: 20_000,
          message: 'approval target team must not become a trigger team grant',
        })
        .not.toContain(approvalTeam.id)
    })

    await test.step('reopen read-only status and verify the three visible lists', async () => {
      await page.getByRole('button', { name: 'Close editor' }).click()
      await expect(page).toHaveURL(new RegExp(`/workflow-recipes/${RECIPE_NS}/${recipeName}$`))
      await page.getByRole('tab', { name: 'Users' }).click()
      const readonlyPanel = page.getByTestId('grants-readonly-panel')
      await expect(readonlyPanel).toBeVisible({ timeout: 20_000 })
      await expect(readonlyPanel).toContainText('Trigger users (1)')
      await expect(readonlyPanel).toContainText('Trigger teams (1)')
      await expect(readonlyPanel).toContainText('Approval target teams (1)')
      await expect(readonlyPanel).toContainText(userDisplayName(user))
      await expect(readonlyPanel).toContainText(triggerTeam.name)
      await expect(readonlyPanel).toContainText(approvalTeam.name)
    })

    await test.step('revoke team trigger and approval-target access through visible Control UI', async () => {
      await openRecipeEditorFromList(page, recipeName)

      const refreshedTriggerTeams = page.getByTestId('workflow-access-trigger-teams')
      const refreshedApprovalTargetTeams = page.getByTestId('workflow-access-approval-target-teams')

      await refreshedTriggerTeams
        .getByRole('button', { name: `Revoke team trigger access: ${triggerTeam.name}` })
        .click()
      await expect(
        refreshedTriggerTeams.getByRole('button', {
          name: `Revoke team trigger access: ${triggerTeam.name}`,
        })
      ).not.toBeVisible()
      await expect
        .poll(() => listTeamGrantIds(token, recipeName), {
          timeout: 20_000,
          message: 'team trigger grant must be revoked through admin API',
        })
        .not.toContain(triggerTeam.id)

      await refreshedApprovalTargetTeams
        .getByRole('button', { name: `Remove approval target team: ${approvalTeam.name}` })
        .click()
      await expect(
        refreshedApprovalTargetTeams.getByRole('button', {
          name: `Remove approval target team: ${approvalTeam.name}`,
        })
      ).not.toBeVisible()
      await expect
        .poll(() => listApprovalTargetTeamIds(token, recipeName), {
          timeout: 20_000,
          message: 'approval target team must be revoked through admin API',
        })
        .not.toContain(approvalTeam.id)
    })
  } finally {
    const cleanupErrors: string[] = []
    await deleteRecipe(token, recipeName).catch(error =>
      cleanupErrors.push(`recipe: ${errorMessage(error)}`)
    )
    await deleteFixtureTeam(token, recipeName, triggerTeam.id).catch(error =>
      cleanupErrors.push(`trigger team: ${errorMessage(error)}`)
    )
    await deleteFixtureTeam(token, recipeName, approvalTeam.id).catch(error =>
      cleanupErrors.push(`approval team: ${errorMessage(error)}`)
    )
    if (cleanupErrors.length > 0) {
      throw new Error(`workflow access fixture cleanup failed:\n${cleanupErrors.join('\n')}`)
    }
  }
})
