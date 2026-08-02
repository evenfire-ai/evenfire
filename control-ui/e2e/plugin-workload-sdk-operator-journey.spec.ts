/**
 * Operator journey (control-ui, camino B) for a Plugin Workload SDK recipe.
 *
 * Mirrors what a real operator does — NOT a kubectl apply — in order:
 *   1. Publish the SDK recipe to the Marketplace (registry-api).
 *   2. Instantiate it from the Marketplace UI  → POST /admin/registry/install-recipe
 *      → a versioned WorkflowRecipe CRD in sandbox-recipes.
 *   3. Wait for the stepless eager mcp-host to validate the SDK capability
 *      (status.pluginWorkloadSdk.state === 'validated'). This is the path that
 *      regressed (configure readiness race) — the operator journey must observe
 *      it self-validate without a keepalive step or manual intervention.
 *   4. Configure the two SDK grants (promptBridge + clientNotifications) from
 *      the grant page UI so an allowed user can receive notifications.
 *   5. Verify both grants are listed and bound to the installed recipe.
 *
 * Runs ONLY against an allowed local profile. Point it at the branch profile
 * port-forwards:
 *   CONTROL_UI baseURL (playwright.config), CONTROL_API_URL, REGISTRY_URL.
 *
 * Required services (port-forwarded): control-ui, control-api, registry-api,
 * workflow-recipes (WRC). The recipe image clerum/workflow-plugin-sdk-e2e:test
 * must be loaded in the profile (built by scripts/minikube/build-images.sh).
 */
import { type Page, expect, test } from '@playwright/test'
import { setTimeout as delay } from 'node:timers/promises'

const BASE_API = process.env.CONTROL_API_URL || 'http://localhost:8090'
const REGISTRY_BASE = process.env.REGISTRY_URL || 'http://localhost:8085'
const ADMIN_USER = process.env.ADMIN_USER || 'admin'
const ADMIN_PASS = process.env.ADMIN_PASS || 'changeme123!'
const PROVIDER = process.env.E2E_WORKFLOW_MODEL_PROVIDER || 'zai'
const MODEL = process.env.E2E_WORKFLOW_MODEL_NAME || 'glm-4.7'
const FALLBACK_PROVIDER = process.env.E2E_PROMPT_FALLBACK_PROVIDER || 'openai'
const FALLBACK_MODEL = process.env.E2E_PROMPT_FALLBACK_MODEL || 'gpt-5.4-mini'
const RECIPE_NS = 'sandbox-recipes'
const EVENT_TYPE = 'e2e.test.notification'
const USER_EMAIL = process.env.E2E_DESKTOP_USER_EMAIL || 'test@clerum.io'
/** When set, the journey writes labelled success screenshots here (evidence/demo only). */
const EVIDENCE_DIR = process.env.E2E_EVIDENCE_DIR

function uniqueName(base: string): string {
  return `${base}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
    .slice(0, 50)
    .replace(/-$/, '')
}

async function api(
  token: string,
  method: string,
  path: string,
  body?: unknown
): Promise<{ status: number; data: Record<string, unknown> }> {
  const resp = await fetch(`${BASE_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await resp.text()
  let data: Record<string, unknown> = {}
  try {
    data = JSON.parse(text)
  } catch {
    data = { raw: text }
  }
  return { status: resp.status, data }
}

async function loginApiToken(): Promise<string> {
  const resp = await fetch(`${BASE_API}/api/v1/admin/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: ADMIN_USER, password: ADMIN_PASS }),
  })
  const text = await resp.text()
  if (!resp.ok) throw new Error(`API login failed: ${resp.status} ${text}`)
  const data = JSON.parse(text) as { token?: string }
  if (!data.token) throw new Error('API login returned no token')
  return data.token
}

/**
 * The "set up your admin email" reminder pops over the top-right of the shell —
 * it overlaps the grants panel's "New grant" button and silently blocks the
 * click. A real operator dismisses it; so does this test.
 */
async function dismissAdminEmailReminder(page: Page): Promise<void> {
  try {
    // "Remind me later" is a session dismissal with no confirm dialog — unlike
    // "Don't show again", which opens a "Hide this alert?" modal that would
    // itself block the page.
    await page.getByRole('button', { name: 'Remind me later' }).click({ timeout: 3_000 })
  } catch {
    // Reminder not shown (admin already has an email) — nothing to dismiss.
  }
}

async function uiLogin(page: Page): Promise<void> {
  await page.goto('/')
  await expect(page.getByRole('button', { name: /^Sign in$/ })).toBeVisible({ timeout: 15_000 })
  await page.getByLabel('Username or email').fill(ADMIN_USER)
  await page.getByLabel('Password').fill(ADMIN_PASS)
  await page.getByRole('button', { name: /^Sign in$/ }).click()
  await expect(page.getByText('Marketplace')).toBeVisible({ timeout: 20_000 })
}

/** Resolve a real platform user UUID so clientNotifications can target a human. */
async function resolveUserRef(token: string): Promise<string> {
  const email = USER_EMAIL
  const { status, data } = await api(
    token,
    'GET',
    `/api/v1/admin/users?q=${encodeURIComponent(email)}`
  )
  if (status !== 200) throw new Error(`user lookup failed: ${status}`)
  const users = (data.data ?? data.items ?? data.users ?? []) as Array<{
    id?: string
    email?: string
  }>
  const match = users.find(u => u.email === email) ?? users[0]
  if (!match?.id) throw new Error(`could not resolve user id for ${email}`)
  return match.id
}

function recipeManifest(name: string, userRef: string): Record<string, unknown> {
  return {
    apiVersion: 'clerum.io/v1alpha1',
    kind: 'WorkflowRecipe',
    metadata: { name },
    spec: {
      agent: { provider: PROVIDER, model: MODEL },
      workloads: [
        {
          id: 'sdk-caller',
          type: 'deployment',
          image: 'clerum/workflow-plugin-sdk-e2e:test',
          env: [
            { name: 'E2E_SDK_CALLER_REF', value: 'sdk-caller' },
            { name: 'E2E_SDK_EVENT_TYPE', value: EVENT_TYPE },
            { name: 'E2E_SDK_USER_REF', value: userRef },
            { name: 'E2E_SDK_QUOTA_LIMIT', value: '3' },
          ],
        },
      ],
      pluginWorkloadSdk: {
        promptBridge: {
          allowedModels: [MODEL],
          maxRequestsPerRun: 10,
          maxInvocationsPerMinute: 60,
        },
        clientNotifications: {
          allowedEventTypes: [EVENT_TYPE],
          allowedUserRefs: true,
          maxNotificationsPerRun: 10,
        },
        allowedCallers: ['sdk-caller'],
      },
    },
  }
}

async function publishRecipeToMarketplace(
  token: string,
  entryName: string,
  manifest: Record<string, unknown>
): Promise<void> {
  // Mirrors PublishToRegistryForm: entryType=recipe, recipe is a YAML string
  // (JSON is valid YAML), published through control-api's admin registry proxy.
  const entry = {
    name: entryName,
    version: '1.0.0',
    entryType: 'recipe',
    description: 'Operator-journey SDK recipe (promptBridge + clientNotifications).',
    author: 'e2e-test',
    origin: 'human-authored',
    category: 'tools',
    tags: ['sdk', 'e2e'],
    contentCreatorTag: 'community',
    configCreatorTag: 'community',
    visibility: 'public',
    recipe: JSON.stringify(manifest),
  }
  const { status, data } = await api(token, 'POST', '/api/v1/admin/registry/entries', entry)
  if (status >= 300) {
    throw new Error(`publish failed: ${status} ${JSON.stringify(data)}`)
  }
}

async function waitForSdkValidated(token: string, recipeName: string): Promise<void> {
  for (let attempt = 1; attempt <= 60; attempt += 1) {
    const { status, data } = await api(token, 'GET', `/api/v1/admin/recipes/${recipeName}`)
    if (status === 200) {
      const sdk = (data as { status?: { pluginWorkloadSdk?: { state?: string } } }).status
        ?.pluginWorkloadSdk
      if (sdk?.state === 'validated') return
    }
    await delay(2_000)
  }
  throw new Error(`recipe ${recipeName} SDK capability did not reach validated`)
}

test.describe('Plugin Workload SDK — operator journey (Marketplace → install → grants)', () => {
  test('operator publishes, installs and grants an SDK recipe end to end', async ({ page }) => {
    test.setTimeout(240_000)
    const entryName = uniqueName('e2e-op-sdk')
    const token = await loginApiToken()
    const userRef = await resolveUserRef(token)
    let installedRecipeName = ''

    try {
      // 1. Publish to the Marketplace (through control-api's admin registry proxy).
      await publishRecipeToMarketplace(token, entryName, recipeManifest(entryName, userRef))

      // 2. Operator instantiates it from the Marketplace UI. Recipe entries install
      //    directly from the catalog, unlike connector entries that open the wizard.
      await uiLogin(page)
      await page.locator('text=Marketplace').first().click()
      await expect(page.getByLabel('Search Marketplace entries')).toBeVisible({ timeout: 15_000 })
      await page.getByLabel('Search Marketplace entries').fill(entryName)
      const row = page.locator('tr', { hasText: entryName })
      await expect(row).toBeVisible({ timeout: 15_000 })
      const installResp = page.waitForResponse(
        r => r.url().includes('/admin/registry/install-recipe') && r.request().method() === 'POST',
        { timeout: 60_000 }
      )
      await row.getByRole('button', { name: /^Install$/ }).click()
      const resp = await installResp
      expect(resp.status()).toBe(201)
      const installedBody = (await resp.json().catch(() => ({}))) as {
        name?: string
        recipeName?: string
      }
      installedRecipeName = installedBody.recipeName || installedBody.name || ''
      expect(installedRecipeName).not.toBe('')
      await expect(row.getByRole('button', { name: 'Installed' })).toBeDisabled()

      // 3. The eager mcp-host self-validates the SDK capability (regression path).
      await waitForSdkValidated(token, installedRecipeName)

      // 4. promptBridge grant — configured through the grant page UI. Add the
      // fallback first, then the bootstrap target, and reorder it visibly so
      // the saved policy proves both providers plus an explicit default/order.
      // Navigate through the visible application shell so this test proves the
      // operator journey rather than jumping directly to the grant route.
      await page.getByRole('link', { name: 'Plugins', exact: true }).click()
      await expect(page.getByRole('button', { name: 'Plugins SDK' })).toBeVisible({
        timeout: 15_000,
      })
      await page.getByRole('button', { name: 'Plugins SDK' }).click()
      await expect(page.getByRole('button', { name: 'New grant' })).toBeVisible({
        timeout: 15_000,
      })
      await dismissAdminEmailReminder(page)
      await page.getByRole('button', { name: 'New grant' }).click()
      await page
        .locator('#sdk-recipe-pick')
        .selectOption({ label: `${installedRecipeName} (${RECIPE_NS})` })
      await expect(page.locator('#sdk-family')).toHaveValue('promptBridge')
      await page.locator('#sdk-callers').fill('sdk-caller')
      const saveGrantButton = page.getByRole('button', { name: 'Save grant' })

      await page.locator('#sdk-provider').selectOption(FALLBACK_PROVIDER)
      await page.locator('#sdk-target-model').selectOption(FALLBACK_MODEL)
      await page.locator('#sdk-credential-slot').selectOption(`${FALLBACK_PROVIDER}-api-key`)
      await page.locator('#sdk-target-ref').fill(`fallback-${FALLBACK_PROVIDER}`)
      await page.getByRole('button', { name: 'Add target' }).click()

      await page.locator('#sdk-provider').selectOption(PROVIDER)
      await page.locator('#sdk-target-model').selectOption(MODEL)
      await page.locator('#sdk-credential-slot').selectOption(`${PROVIDER}-api-key`)
      await page.locator('#sdk-target-ref').fill(`primary-${PROVIDER}`)
      await page.getByRole('button', { name: 'Add target' }).click()

      const orderedTargets = page.getByLabel('Ordered promptBridge targets')
      const primaryTargetRow = orderedTargets
        .locator('div.cu-sdk-custom-model-row')
        .filter({
          hasText: `primary-${PROVIDER}:`,
        })
        .first()
      await expect(primaryTargetRow).toContainText(`fallback 1 · primary-${PROVIDER}`)
      await primaryTargetRow.getByRole('button', { name: 'Up' }).click()
      await expect(orderedTargets).toContainText(`default · primary-${PROVIDER}`)
      await expect(orderedTargets).toContainText(`fallback 1 · fallback-${FALLBACK_PROVIDER}`)
      await expect(saveGrantButton).toBeEnabled()
      await saveGrantButton.click()
      const promptRow = page.locator('tr', { hasText: installedRecipeName }).filter({
        hasText: 'promptBridge',
      })
      await expect(promptRow).toBeVisible({ timeout: 15_000 })
      await expect(promptRow).toContainText(MODEL)

      // 5. clientNotifications grant — pick the same installed recipe, then
      //    choose the allowed user BY EMAIL in the picker. The UUID is never typed.
      await page.getByRole('button', { name: 'New grant' }).click()
      await page
        .locator('#sdk-recipe-pick')
        .selectOption({ label: `${installedRecipeName} (${RECIPE_NS})` })
      await page.locator('#sdk-family').selectOption('clientNotifications')
      await expect(page.locator('#sdk-userrefs')).toBeVisible({ timeout: 10_000 })
      // Defensive against prefill gaps: ensure caller + event type are present.
      await page.locator('#sdk-callers').fill('sdk-caller')
      if (!(await page.locator('#sdk-events').inputValue()).includes(EVENT_TYPE)) {
        await page.locator('#sdk-events').fill(EVENT_TYPE)
      }
      // Open the "Allowed users" picker and select the recipient BY EMAIL.
      const usersDropdown = page.locator('#sdk-userrefs')
      await usersDropdown.click()
      await page.getByPlaceholder('Search by name or email…').fill(USER_EMAIL)
      const userOption = page.getByRole('option').filter({ hasText: USER_EMAIL })
      await expect(userOption.first()).toBeVisible({ timeout: 10_000 })
      if (EVIDENCE_DIR)
        await page.screenshot({ path: `${EVIDENCE_DIR}/operator-1-pick-user-by-email.png` })
      await userOption.first().click()
      await usersDropdown.click() // collapse the menu before saving
      await page.getByRole('button', { name: 'Save grant' }).click()

      // 6. Business signal: the clientNotifications grant row renders for the
      //    recipe and attaches the selected user as a resolved human handle.
      const notifyRow = page
        .locator('tr', { hasText: installedRecipeName })
        .filter({ hasText: 'clientNotifications' })
      await expect(notifyRow).toBeVisible({ timeout: 15_000 })
      await expect(notifyRow).toContainText('users:')
      await expect(notifyRow).not.toContainText(userRef) // resolved to a handle, not the UUID
      if (EVIDENCE_DIR)
        await page.screenshot({ path: `${EVIDENCE_DIR}/operator-2-grant-created.png` })

      // 7. Both grants are bound to the installed recipe (API cross-check).
      const list = await api(
        token,
        'GET',
        `/api/v1/admin/plugin-workload-sdk/grants?recipeNamespace=${RECIPE_NS}&recipeName=${installedRecipeName}`
      )
      expect(list.status).toBe(200)
      const grants = (list.data.data ?? list.data.items ?? list.data.grants ?? []) as Array<{
        capabilityFamily?: string
        allowedModels?: string[]
        provider?: string
        defaultTargetRef?: string
        promptTargets?: Array<{
          targetRef?: string
          provider?: string
          model?: string
          credentialSlot?: string
        }>
        policyRevision?: number
      }>
      const families = grants.map(g => g.capabilityFamily)
      expect(families).toContain('promptBridge')
      expect(families).toContain('clientNotifications')
      const promptGrant = grants.find(g => g.capabilityFamily === 'promptBridge')
      expect(promptGrant?.allowedModels).toContain(MODEL)
      expect(promptGrant).toMatchObject({
        provider: PROVIDER,
        defaultTargetRef: `primary-${PROVIDER}`,
        promptTargets: [
          {
            targetRef: `primary-${PROVIDER}`,
            provider: PROVIDER,
            model: MODEL,
            credentialSlot: `${PROVIDER}-api-key`,
          },
          {
            targetRef: `fallback-${FALLBACK_PROVIDER}`,
            provider: FALLBACK_PROVIDER,
            model: FALLBACK_MODEL,
            credentialSlot: `${FALLBACK_PROVIDER}-api-key`,
          },
        ],
        policyRevision: expect.any(Number),
      })
      expect(JSON.stringify(promptGrant)).not.toMatch(/secret|token/i)
    } finally {
      if (installedRecipeName) {
        await api(
          token,
          'DELETE',
          `/api/v1/admin/registry/uninstall/${installedRecipeName}?type=recipe`
        ).catch(() => undefined)
      }
      await fetch(
        `${REGISTRY_BASE}/api/v1/entries/${encodeURIComponent(entryName)}/versions/1.0.0`,
        { method: 'DELETE' }
      ).catch(() => undefined)
    }
  })
})
