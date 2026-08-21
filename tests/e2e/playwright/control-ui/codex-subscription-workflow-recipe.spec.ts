/**
 * Codex subscription — WorkflowRecipe authoring journey.
 *
 * Contract:
 * - Entry point: application root `/` after API fixture creates a placeholder recipe.
 * - Actions: visible login, open Installed plugins, edit the fixture, load Codex template.
 * - Route/state: plugin edit surface with `edit=1`.
 * - UI: manifest validates without LLM secret detection for broker-backed agent.
 * - Business signal: Manifest review passed with codex-subscription agent spec.
 *
 * API calls are limited to fixture setup/cleanup; the Codex template swap is UI-driven.
 */
import { expect, test } from '@playwright/test'
import { loginControlUiVisible } from '../helpers/visible-login'

const BASE_API = process.env.CONTROL_API_URL ?? process.env.CONTROL_API_BASE_URL ?? ''
const ADMIN_USERNAME = process.env.TEST_ADMIN_USERNAME ?? 'admin'
const ADMIN_PASSWORD = process.env.TEST_ADMIN_PASSWORD ?? 'changeme123!'
const RECIPE_NS = 'sandbox-recipes'
const CODEX_TEMPLATE = 'Agentic Workflow (Codex Subscription)'

type ApiResult<T> = { status: number; data: T; text: string }

function uniqueRecipeName(): string {
  return `e2e-codex-wr-${Date.now().toString(36)}`.slice(0, 63).replace(/-$/, '')
}

async function api<T>(
  token: string,
  method: string,
  path: string,
  body?: unknown
): Promise<ApiResult<T>> {
  if (!BASE_API) throw new Error('CONTROL_API_URL is required for workflow-recipe fixture setup')
  const response = await fetch(`${BASE_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  let data = {} as T
  if (text) {
    try {
      data = JSON.parse(text) as T
    } catch {
      data = text as T
    }
  }
  return { status: response.status, data, text }
}

async function loginApiToken(): Promise<string> {
  const result = await api<{ token?: string }>('', 'POST', '/api/v1/admin/auth/login', {
    username: ADMIN_USERNAME,
    password: ADMIN_PASSWORD,
  })
  expect(result.status, result.text).toBe(200)
  expect(result.data.token, 'admin login must return a bearer token').toBeTruthy()
  return result.data.token!
}

async function createPlaceholderRecipe(token: string, name: string): Promise<void> {
  const result = await api<{ metadata?: { name?: string } }>(
    token,
    'POST',
    '/api/v1/admin/recipes',
    {
      metadata: { name, namespace: RECIPE_NS },
      spec: {
        agent: { provider: 'zai', model: 'glm-4.7' },
        triggers: { onDemand: { requiresApproval: false, allowedActors: ['user'] } },
        steps: [{ id: 'noop', instruction: 'Return ok.', timeoutSeconds: 60 }],
        workloads: [],
      },
    }
  )
  expect([200, 201], result.text).toContain(result.status)
  expect(result.data.metadata?.name).toBe(name)
}

async function deleteRecipe(token: string, name: string): Promise<void> {
  const result = await api<Record<string, unknown>>(
    token,
    'DELETE',
    `/api/v1/admin/recipes/${encodeURIComponent(name)}`
  )
  expect([200, 404], result.text).toContain(result.status)
}

test.describe('Codex subscription workflow recipe authoring', () => {
  test('operator can load a Codex subscription template without LLM secrets', async ({ page }) => {
    test.skip(!BASE_API, 'CONTROL_API_URL is required for recipe fixture setup')

    const token = await loginApiToken()
    const recipeName = uniqueRecipeName()
    await deleteRecipe(token, recipeName)
    await createPlaceholderRecipe(token, recipeName)

    try {
      // E2E_GUARDIAN_ENTRY_POINT
      await page.goto('/')
      await loginControlUiVisible(page)

      await page.getByRole('link', { name: 'Installed plugins' }).click()
      await expect(page).toHaveURL(/\/plugins/)

      const listRecipes = page.waitForResponse(
        response =>
          response.url().includes('/api/v1/admin/recipes') && response.request().method() === 'GET'
      )
      await expect(page.getByLabel('Search plugins')).toBeVisible({ timeout: 20_000 })
      await listRecipes

      await page.getByLabel('Search plugins').fill(recipeName)
      const recipeLink = page.getByRole('link', { name: new RegExp(`Open ${recipeName}`, 'i') })
      await expect(recipeLink).toBeVisible({ timeout: 20_000 })
      await recipeLink.click()
      await expect(page).toHaveURL(new RegExp(`/plugins/${RECIPE_NS}/${recipeName}`))

      await page.getByRole('button', { name: 'More plugin actions' }).click()
      await page.getByRole('menuitem', { name: 'Edit' }).click()
      await expect(page).toHaveURL(new RegExp(`edit=1`))

      await page.getByLabel('Load recipe template').selectOption(CODEX_TEMPLATE)
      const manifest = page.getByLabel('Recipe JSON (WorkflowRecipe manifest)')
      await expect(manifest).toContainText('"provider": "codex-subscription"')
      await expect(manifest).not.toContainText('secretRef')

      const validate = page.waitForResponse(
        response =>
          response.url().includes('/api/v1/admin/recipes/validate') &&
          response.request().method() === 'POST',
        { timeout: 30_000 }
      )
      await page.getByRole('button', { name: 'Review manifest' }).click()
      const validateResponse = await validate
      expect(
        validateResponse.ok(),
        `server manifest validation must succeed, got ${validateResponse.status()}`
      ).toBe(true)

      await expect(page.getByText(/Manifest review passed/)).toBeVisible({ timeout: 20_000 })
      await expect(page.getByText(/must not declare an LLM secretRef/i)).toHaveCount(0)
    } finally {
      await deleteRecipe(token, recipeName)
    }
  })
})
