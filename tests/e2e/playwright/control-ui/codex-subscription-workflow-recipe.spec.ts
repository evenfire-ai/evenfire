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
import { adminSessionCookieHeader } from '../helpers/session-cookie'
import { loginControlUiVisible } from '../helpers/visible-login'

const BASE_API = process.env.CONTROL_API_URL ?? process.env.CONTROL_API_BASE_URL ?? ''
const RECIPE_NS = 'sandbox-recipes'
const CODEX_TEMPLATE = 'Agentic Workflow (Codex Subscription)'

type ApiResult<T> = { status: number; data: T; text: string }

function uniqueRecipeName(): string {
  return `e2e-codex-wr-${Date.now().toString(36)}`.slice(0, 63).replace(/-$/, '')
}

async function api<T>(method: string, path: string, body?: unknown): Promise<ApiResult<T>> {
  if (!BASE_API) throw new Error('CONTROL_API_URL is required for workflow-recipe fixture setup')
  const response = await fetch(`${BASE_API}${path}`, {
    method,
    headers: {
      ...adminSessionCookieHeader(),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
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

async function createPlaceholderRecipe(name: string): Promise<void> {
  const result = await api<{ metadata?: { name?: string } }>('POST', '/api/v1/admin/recipes', {
    metadata: { name, namespace: RECIPE_NS },
    spec: {
      agent: { provider: 'codex-subscription', model: 'gpt-5.1' },
      triggers: { onDemand: { requiresApproval: false, allowedActors: ['user'] } },
      steps: [{ id: 'noop', instruction: 'Return ok.', timeoutSeconds: 60 }],
      workloads: [],
    },
  })
  expect([200, 201], result.text).toContain(result.status)
  expect(result.data.metadata?.name).toBe(name)
}

async function deleteRecipe(name: string): Promise<void> {
  const result = await api<Record<string, unknown>>(
    'DELETE',
    `/api/v1/admin/recipes/${encodeURIComponent(name)}`
  )
  expect([200, 404], result.text).toContain(result.status)
}

test.describe('Codex subscription workflow recipe authoring', () => {
  test('operator can load a Codex subscription template without LLM secrets', async ({ page }) => {
    test.skip(!BASE_API, 'CONTROL_API_URL is required for recipe fixture setup')
    test.skip(
      !process.env.PLAYWRIGHT_ADMIN_TOKEN,
      'admin session cookie missing; globalSetup must run first'
    )

    const recipeName = uniqueRecipeName()
    await deleteRecipe(recipeName)
    await createPlaceholderRecipe(recipeName)

    try {
      // E2E_GUARDIAN_ENTRY_POINT
      await page.goto('/')
      await loginControlUiVisible(page)

      const listRecipes = page.waitForResponse(
        response =>
          response.url().includes('/api/v1/admin/recipes') && response.request().method() === 'GET',
        { timeout: 20_000 }
      )
      await page.getByRole('link', { name: 'Installed plugins' }).click()
      await expect(page).toHaveURL(/\/plugins/)
      const recipesResponse = await listRecipes
      expect(
        recipesResponse.ok(),
        `recipe list must succeed, got ${recipesResponse.status()}`
      ).toBe(true)
      await expect(page.getByLabel('Search plugins')).toBeVisible({ timeout: 20_000 })

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

      // L1 validation is client-side on "Review manifest"; server L2 runs only on deploy.
      await page.getByRole('button', { name: 'Review manifest' }).click()
      await expect(page.getByText(/Manifest review passed/)).toBeVisible({ timeout: 20_000 })
      await expect(page.getByText(/must not declare an LLM secretRef/i)).toHaveCount(0)
    } finally {
      await deleteRecipe(recipeName)
    }
  })
})
