/**
 * E2E -- Workflow Auth HostRefs
 *
 * Validates that runtime token issuance is not exposed through the admin UI surface:
 *   - removed /admin/.../auth/issue endpoints stay unavailable
 *   - canonical /auth/mcp-host issuance rejects admin-ui bearer tokens
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

const RECIPE_A = 'e2e-ondemand-simple'
const RECIPE_B = 'e2e-retention-recipe'

type RecipeRef = {
  metadata?: { name?: string; namespace?: string }
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

function requireRecipe(recipes: RecipeRef[], recipeName: string): RecipeRef {
  const recipe = recipes.find(r => r.metadata?.name === recipeName)
  if (!recipe?.metadata?.namespace) {
    throw new Error(
      `Seeded recipe "${recipeName}" not found. Run scripts/minikube/seed-workflow-triggers-test-data.sh`
    )
  }
  return recipe
}

test.describe('Workflow Auth HostRefs -- admin issuance surface removed', () => {
  test.describe.configure({ mode: 'serial' })

  let page: Page
  let token: string
  let recipeA: RecipeRef
  let recipeB: RecipeRef

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage()
  })

  test.afterAll(async () => {
    await page?.close()
  })

  test('H1. Admin login and discover seeded recipes', async () => {
    await login(page)
    token = await getToken(page)
    expect(token).toBeTruthy()

    const { status, data } = await api(token, 'GET', '/api/v1/admin/recipes')
    expect(status).toBe(200)

    const recipes = ((data as { items?: RecipeRef[] }).items ?? []) as RecipeRef[]
    recipeA = requireRecipe(recipes, RECIPE_A)
    recipeB = requireRecipe(recipes, RECIPE_B)
  })

  test('H2. admin auth/issue for recipe A remains removed', async () => {
    test.skip(!token || !recipeA?.metadata?.namespace, 'Seeded recipe A missing')

    const ns = recipeA.metadata.namespace
    const { status } = await api(
      token,
      'POST',
      `/api/v1/admin/workflows/${ns}/${RECIPE_A}/auth/issue`
    )

    expect(status).toBe(404)
  })

  test('H3. canonical auth/mcp-host route rejects admin-ui bearer tokens', async () => {
    test.skip(!token || !recipeA?.metadata?.namespace, 'Seeded recipe A missing')

    const ns = recipeA.metadata.namespace
    const { status } = await api(token, 'POST', `/api/v1/auth/mcp-host/${ns}/${RECIPE_A}/tokens`, {
      includeMcpHostControlToken: true,
    })

    expect(status).toBe(401)
  })

  test('H4. admin auth/issue for recipe B remains removed', async () => {
    test.skip(!token || !recipeB?.metadata?.namespace, 'Seeded recipe B missing')

    const ns = recipeB.metadata.namespace
    const { status } = await api(
      token,
      'POST',
      `/api/v1/admin/workflows/${ns}/${RECIPE_B}/auth/issue`
    )

    expect(status).toBe(404)
  })

  test('H5. canonical auth/mcp-host route rejects admin-ui bearer tokens for recipe B', async () => {
    test.skip(!token || !recipeB?.metadata?.namespace, 'Seeded recipe B missing')

    const ns = recipeB.metadata.namespace
    const { status } = await api(token, 'POST', `/api/v1/auth/mcp-host/${ns}/${RECIPE_B}/tokens`, {
      includeMcpHostControlToken: true,
    })

    expect(status).toBe(401)
  })
})
