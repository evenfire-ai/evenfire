/**
 * E2E -- Workflow Endpoints
 *
 * Validates the live admin workflow surface used by Control UI:
 *   - seeded recipes are listed in the UI
 *   - recipe detail resolves through the DB-first workflow route
 *   - removed admin auth/issue route stays unavailable
 *   - admin trigger succeeds with Idempotency-Key
 *   - missing Idempotency-Key is rejected
 *   - replay with the same Idempotency-Key returns the same run
 *   - scheduled recipes render schedule/next-run affordances in the detail page
 *
 * Prerequisites:
 *   1. Port-forwards running (control-ui :3000, control-api :8090)
 *   2. Admin credentials: ADMIN_USER, ADMIN_PASS
 *   3. Cluster seeded with scripts/minikube/seed-workflow-triggers-test-data.sh
 */
import { type Page, expect, test } from '@playwright/test'

const BASE_API = process.env.CONTROL_API_URL || 'http://localhost:8090'
const BASE_UI = process.env.CONTROL_UI_URL || 'http://localhost:3000'
const ADMIN_USER = process.env.ADMIN_USER || 'admin'
const ADMIN_PASS = process.env.ADMIN_PASS || 'changeme123!'

const SIMPLE_RECIPE = 'e2e-ondemand-simple'
const SCHEDULED_RECIPE = 'e2e-scheduled-recipe'

type RecipeRef = {
  metadata?: { name?: string; namespace?: string }
  spec?: { triggers?: Record<string, unknown> }
}

async function getToken(page: Page): Promise<string> {
  return page.evaluate(() => localStorage.getItem('controlUiAdminToken') ?? '')
}

async function api(
  token: string,
  method: string,
  path: string,
  body?: Record<string, unknown>,
  extraHeaders: Record<string, string> = {}
): Promise<{ status: number; data: Record<string, unknown> }> {
  const opts: RequestInit = {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...extraHeaders,
    },
  }
  if (body) opts.body = JSON.stringify(body)
  const resp = await fetch(`${BASE_API}${path}`, opts)
  const text = await resp.text()
  let data: Record<string, unknown> = {}
  try {
    data = JSON.parse(text)
  } catch {
    data = { raw: text }
  }
  return { status: resp.status, data }
}

async function login(page: Page) {
  await page.goto(BASE_UI)
  await page.waitForSelector('text=Sign in', { timeout: 15_000 })
  const inputs = page.locator('input')
  await inputs.nth(0).fill(ADMIN_USER)
  await inputs.nth(1).fill(ADMIN_PASS)
  await page.locator('button:has-text("Sign in")').last().click()
  await page.waitForSelector('text=Marketplace', { timeout: 20_000 })
}

function requireSeededRecipe(recipes: RecipeRef[], recipeName: string): RecipeRef {
  const recipe = recipes.find(r => r.metadata?.name === recipeName)
  if (!recipe?.metadata?.namespace) {
    throw new Error(
      `Seeded recipe "${recipeName}" not found. Run scripts/minikube/seed-workflow-triggers-test-data.sh`
    )
  }
  return recipe
}

test.describe('Workflow Endpoints -- real admin workflow surface', () => {
  test.describe.configure({ mode: 'serial' })

  let page: Page
  let token: string
  let simpleRecipe: RecipeRef
  let scheduledRecipe: RecipeRef

  function recipeRow(name: string) {
    return page.locator('tbody tr').filter({ has: page.getByText(name, { exact: true }) })
  }

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage()
  })

  test.afterAll(async () => {
    await page?.close()
  })

  test('W1. Admin login', async () => {
    await login(page)
    token = await getToken(page)
    expect(token).toBeTruthy()
    expect(token.length).toBeGreaterThan(20)
  })

  test('W2. Seeded recipes are listed in API and UI', async () => {
    test.skip(!token, 'Login failed -- skipping')

    const { status, data } = await api(token, 'GET', '/api/v1/admin/recipes')
    expect(status).toBe(200)

    const recipes = ((data as { items?: RecipeRef[] }).items ?? []) as RecipeRef[]
    expect(recipes.length).toBeGreaterThan(0)

    simpleRecipe = requireSeededRecipe(recipes, SIMPLE_RECIPE)
    scheduledRecipe = requireSeededRecipe(recipes, SCHEDULED_RECIPE)

    await page.goto(`${BASE_UI}/workflow-recipes`)
    await expect(recipeRow(SIMPLE_RECIPE)).toBeVisible({ timeout: 20_000 })
    await expect(recipeRow(SCHEDULED_RECIPE)).toBeVisible({ timeout: 20_000 })
  })

  test('W3. Recipe status modal resolves the seeded recipe', async () => {
    test.skip(!token || !simpleRecipe?.metadata?.namespace, 'Seeded recipe missing')

    const ns = simpleRecipe.metadata.namespace
    const { status, data } = await api(
      token,
      'GET',
      `/api/v1/admin/workflows/${ns}/${SIMPLE_RECIPE}`
    )

    expect(status).toBe(200)
    expect((data as { metadata?: { name?: string; namespace?: string } }).metadata?.name).toBe(
      SIMPLE_RECIPE
    )
    expect((data as { metadata?: { name?: string; namespace?: string } }).metadata?.namespace).toBe(
      ns
    )

    await page.goto(`${BASE_UI}/workflow-recipes`)
    const row = recipeRow(SIMPLE_RECIPE)
    await expect(row).toBeVisible({ timeout: 20_000 })
    await row.getByRole('button', { name: 'Status' }).click()
    await expect(page.getByText(`${ns}/${SIMPLE_RECIPE}`)).toBeVisible({ timeout: 20_000 })
    await expect(page.getByText('Recipe Status')).toBeVisible({ timeout: 20_000 })
  })

  test('W4. Runtime token issuance is not exposed through admin workflow endpoints', async () => {
    test.skip(!token || !simpleRecipe?.metadata?.namespace, 'Seeded recipe missing')

    const ns = simpleRecipe.metadata.namespace
    const removedAdminEndpoint = await api(
      token,
      'POST',
      `/api/v1/admin/workflows/${ns}/${SIMPLE_RECIPE}/auth/issue`
    )
    expect(removedAdminEndpoint.status).toBe(404)

    const canonicalInternalEndpoint = await api(
      token,
      'POST',
      `/api/v1/auth/mcp-host/${ns}/${SIMPLE_RECIPE}/tokens`,
      { includeMcpHostControlToken: true }
    )
    expect(canonicalInternalEndpoint.status).toBe(401)
  })

  test('W5. Authorized admin trigger succeeds on the live endpoint', async () => {
    test.skip(!token || !simpleRecipe?.metadata?.namespace, 'Seeded recipe missing')

    const ns = simpleRecipe.metadata.namespace
    const idempotencyKey = `control-ui-w5-${Date.now()}`
    const { status, data } = await api(
      token,
      'POST',
      `/api/v1/admin/workflows/${ns}/${SIMPLE_RECIPE}/trigger`,
      { inputs: {} },
      { 'Idempotency-Key': idempotencyKey }
    )

    expect(status).toBe(201)
    const runId =
      (data as { id?: string; o?: { id?: string } }).id ?? (data as { o?: { id?: string } }).o?.id
    expect(runId).toBeTruthy()
  })

  test('W6. Missing Idempotency-Key is rejected', async () => {
    test.skip(!token || !simpleRecipe?.metadata?.namespace, 'Seeded recipe missing')

    const ns = simpleRecipe.metadata.namespace
    const { status, data } = await api(
      token,
      'POST',
      `/api/v1/admin/workflows/${ns}/${SIMPLE_RECIPE}/trigger`,
      { inputs: {} }
    )

    expect(status).toBe(400)
    expect((data as { error?: string }).error ?? (data as { message?: string }).message).toContain(
      'Idempotency-Key'
    )
  })

  test('W7. Replay with the same Idempotency-Key returns the same run', async () => {
    test.skip(!token || !simpleRecipe?.metadata?.namespace, 'Seeded recipe missing')

    const ns = simpleRecipe.metadata.namespace
    const idempotencyKey = `control-ui-w7-${Date.now()}`

    const first = await api(
      token,
      'POST',
      `/api/v1/admin/workflows/${ns}/${SIMPLE_RECIPE}/trigger`,
      { inputs: {} },
      { 'Idempotency-Key': idempotencyKey }
    )
    const second = await api(
      token,
      'POST',
      `/api/v1/admin/workflows/${ns}/${SIMPLE_RECIPE}/trigger`,
      { inputs: {} },
      { 'Idempotency-Key': idempotencyKey }
    )

    expect(first.status).toBe(201)
    expect(second.status).toBe(200)

    const firstRunId =
      (first.data as { id?: string; o?: { id?: string } }).id ??
      (first.data as { o?: { id?: string } }).o?.id
    const secondRunId =
      (second.data as { id?: string; o?: { id?: string } }).id ??
      (second.data as { o?: { id?: string } }).o?.id

    expect(firstRunId).toBeTruthy()
    expect(secondRunId).toBe(firstRunId)
  })

  test('W8. Scheduled recipe is visible in the live workflow-recipes table', async () => {
    test.skip(!scheduledRecipe?.metadata?.namespace, 'Scheduled recipe missing')

    await page.goto(`${BASE_UI}/workflow-recipes`)
    const row = recipeRow(SCHEDULED_RECIPE)
    await expect(row).toBeVisible({ timeout: 20_000 })
    await expect(row.getByText('mcp-server', { exact: true })).toBeVisible({ timeout: 20_000 })
  })
})
