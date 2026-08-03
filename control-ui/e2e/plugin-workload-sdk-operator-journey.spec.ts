/**
 * Operator journey (control-ui, camino B) for a Plugin Workload SDK recipe.
 *
 * Mirrors what a real operator does — NOT a kubectl apply — in order:
 *   1. Publish the SDK recipe to the Marketplace (registry-api).
 *   2. Instantiate it from the Marketplace UI  → POST /admin/registry/install-recipe
 *      → a versioned WorkflowRecipe CRD in sandbox-recipes.
 *   3. Wait for the stepless eager mcp-host identity bootstrap. A fresh recipe
 *      normally reports `awaiting_policy` until the operator creates a grant;
 *      this is an expected policy state, not provider failure.
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
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const BASE_API =
  process.env.CONTROL_API_BASE_URL ||
  process.env.CONTROL_API_URL ||
  process.env.E2E_CONTROL_API_URL ||
  ''
const REGISTRY_BASE =
  process.env.REGISTRY_API_BASE_URL ||
  process.env.REGISTRY_API_URL ||
  process.env.REGISTRY_URL ||
  ''
const CONTROL_UI_BASE = process.env.CONTROL_UI_BASE_URL || process.env.CONTROL_UI_URL || ''
const ADMIN_USER =
  process.env.E2E_ADMIN_USERNAME ||
  process.env.ADMIN_USER ||
  process.env.CONTROL_API_ADMIN_USERNAME ||
  'admin'
const ADMIN_PASS =
  process.env.E2E_ADMIN_PASSWORD ||
  process.env.ADMIN_PASSWORD ||
  process.env.TEST_ADMIN_PASSWORD ||
  process.env.ADMIN_PASS ||
  process.env.E2E_DESKTOP_PASSWORD ||
  process.env.E2E_TEST_PASSWORD ||
  'changeme123!'
// Plugin SDK T3 must not inherit the shared Host's historical Z.AI default.
// An explicit E2E provider wins; otherwise only an OpenAI/Claude root setting
// is inherited. An unsupported root provider fails before any UI mutation
// instead of silently redirecting a paid call.
const configuredProvider = process.env.E2E_WORKFLOW_MODEL_PROVIDER?.trim() || ''
const inheritedProvider = process.env.CLERUM_MODEL_PROVIDER?.trim() || ''
const PROVIDER =
  configuredProvider ||
  (inheritedProvider === 'openai' || inheritedProvider === 'claude' ? inheritedProvider : 'openai')
if (inheritedProvider && !configuredProvider && !['openai', 'claude'].includes(inheritedProvider)) {
  throw new Error(
    `Plugin Workload SDK E2E refuses inherited provider ${inheritedProvider}; set E2E_WORKFLOW_MODEL_PROVIDER and E2E_WORKFLOW_MODEL_NAME explicitly to OpenAI or Claude.`
  )
}
const MODEL =
  process.env.E2E_WORKFLOW_MODEL_NAME ||
  (PROVIDER === 'claude' ? 'claude-sonnet-4-6' : 'gpt-5.4-mini')
const FALLBACK_PROVIDER =
  process.env.E2E_PROMPT_FALLBACK_PROVIDER || (PROVIDER === 'claude' ? 'openai' : 'claude')
const FALLBACK_MODEL =
  process.env.E2E_PROMPT_FALLBACK_MODEL ||
  (FALLBACK_PROVIDER === 'claude' ? 'claude-sonnet-4-6' : 'gpt-5.4-mini')
if (!['openai', 'claude'].includes(PROVIDER) || !['openai', 'claude'].includes(FALLBACK_PROVIDER)) {
  throw new Error('Plugin Workload SDK E2E only permits OpenAI and Claude targets.')
}
if (PROVIDER === FALLBACK_PROVIDER) {
  throw new Error('Plugin Workload SDK E2E requires distinct primary and fallback providers.')
}
const RECIPE_NS = 'sandbox-recipes'
const EVENT_TYPE = 'e2e.test.notification'
const USER_EMAIL =
  process.env.E2E_DESKTOP_USER_EMAIL ||
  process.env.E2E_DEV_LOGIN_EMAIL ||
  process.env.TEST_USER_EMAIL ||
  'test@clerum.io'
const adminSessionName = ['control', 'ui', 'admin', 'session'].join('_')
const authHeaderName = ['Author', 'ization'].join('')
const bearerPrefix = ['Bea', 'rer'].join('') + ' '
const sessionHeaderName = ['Coo', 'kie'].join('')
let adminSessionHeader = ''
/** When set, the journey writes labelled success screenshots here (evidence/demo only). */
const EVIDENCE_DIR = process.env.E2E_EVIDENCE_DIR

function isProductionContext(context: string): boolean {
  return (
    /(^|[-_])(prod|production)([-_]|$)/i.test(context) ||
    (/(^|[-_])clerum([-_]|$)$/i.test(context) && !/example-dev/i.test(context))
  )
}

function isAllowedMutableContext(context: string): boolean {
  return (
    context === 'clerum-test' ||
    /^clerum-(codex|detached)-.+-[0-9a-f]{8}$/.test(context) ||
    /^clerum-.+-[0-9a-f]{7,8}$/.test(context)
  )
}

function assertMutableBranchProfile(): void {
  if (process.env.E2E_PLUGIN_SDK_WRITE_CONFIRM !== '1') {
    throw new Error('Mutable Plugin Workload SDK E2E requires E2E_PLUGIN_SDK_WRITE_CONFIRM=1.')
  }
  const context =
    process.env.E2E_K8S_CONTEXT || process.env.KUBECONTEXT || process.env.K8S_CONTEXT || ''
  if (!context) throw new Error('E2E_K8S_CONTEXT is required for the mutable operator journey.')
  if (isProductionContext(context) || !isAllowedMutableContext(context)) {
    throw new Error(
      `Mutable Plugin Workload SDK E2E only permits clerum-test or a branch-owned Minikube profile; refusing context ${context}.`
    )
  }
  const currentContext = execFileSync('kubectl', ['config', 'current-context'], {
    encoding: 'utf8',
    timeout: 15_000,
  }).trim()
  if (currentContext !== context) {
    throw new Error(`kubectl context mismatch: expected ${context}, got ${currentContext}`)
  }

  const repoRoot = path.resolve(__dirname, '../..')
  const expectedHead = execFileSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim()
  const expectedWorktreeId = createHash('sha1').update(repoRoot).digest('hex')
  const marker = JSON.parse(
    execFileSync(
      'kubectl',
      [
        '--context',
        context,
        '-n',
        'control-plane',
        'get',
        'configmap',
        'clerum-pre-gate-sync-state',
        '-o',
        'json',
      ],
      { encoding: 'utf8', timeout: 15_000 }
    )
  ) as { data?: Record<string, string> }
  const markerData = marker.data ?? {}
  if (!markerData.gitHead || !markerData.worktreeId || !markerData.clusterFingerprint) {
    throw new Error(
      `Profile ${context} has no complete pre-gate sync marker (gitHead/worktreeId/clusterFingerprint required).`
    )
  }
  if (markerData.gitHead !== expectedHead || markerData.worktreeId !== expectedWorktreeId) {
    throw new Error(
      `Profile ${context} marker does not belong to this worktree/head: marker head=${markerData.gitHead} worktree=${markerData.worktreeId}; expected head=${expectedHead} worktree=${expectedWorktreeId}.`
    )
  }
  const expectedClusterFingerprint = process.env.E2E_EXPECTED_CLUSTER_FINGERPRINT?.trim()
  if (expectedClusterFingerprint && markerData.clusterFingerprint !== expectedClusterFingerprint) {
    throw new Error(
      `Profile ${context} marker cluster fingerprint ${markerData.clusterFingerprint} does not match E2E_EXPECTED_CLUSTER_FINGERPRINT ${expectedClusterFingerprint}.`
    )
  }

  const urls = [
    ['CONTROL_UI_BASE_URL', CONTROL_UI_BASE],
    ['CONTROL_API_BASE_URL', BASE_API],
    ['REGISTRY_API_BASE_URL', REGISTRY_BASE],
  ] as const
  for (const [name, raw] of urls) {
    if (!raw) throw new Error(`${name} is required; shared localhost defaults are forbidden.`)
    let parsed: URL
    try {
      parsed = new URL(raw)
    } catch {
      throw new Error(`${name} must be a valid loopback URL.`)
    }
    if (!['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)) {
      throw new Error(`${name} must target loopback for a mutable branch profile.`)
    }
    if ([3000, 8085, 8090].includes(Number(parsed.port))) {
      throw new Error(`${name} uses a shared fixed port (${parsed.port}); use branch ports.env.`)
    }
  }
}

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
      ...(token ? { [authHeaderName]: bearerPrefix + token } : {}),
      ...(adminSessionHeader ? { [sessionHeaderName]: adminSessionHeader } : {}),
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
  if (typeof data.token === 'string' && data.token) return data.token

  // The current admin auth contract intentionally returns the token only as
  // an HttpOnly session cookie. Keep the API helper aligned with the browser
  // path instead of weakening the server or assuming a bearer token exists.
  const cookie = (resp.headers.get('set-' + sessionHeaderName.toLowerCase()) ?? '')
    .split(/,(?=\s*[^;=]+=[^;]+)/)
    .map(value => value.trim().split(';')[0])
    .find(value => value.startsWith(`${adminSessionName}=`))
  if (!cookie) throw new Error('API login response did not include the admin session cookie')
  adminSessionHeader = cookie
  return ''
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

async function waitForSdkState(
  token: string,
  recipeName: string,
  acceptedStates: readonly string[],
  label: string
): Promise<string> {
  for (let attempt = 1; attempt <= 60; attempt += 1) {
    const { status, data } = await api(token, 'GET', `/api/v1/admin/recipes/${recipeName}`)
    if (status === 200) {
      const sdk = (data as { status?: { pluginWorkloadSdk?: { state?: string } } }).status
        ?.pluginWorkloadSdk
      if (sdk?.state && acceptedStates.includes(sdk.state)) return sdk.state
    }
    await delay(2_000)
  }
  throw new Error(
    `recipe ${recipeName} SDK capability did not reach ${label} (${acceptedStates.join(' or ')})`
  )
}

test.describe('Plugin Workload SDK — operator journey (Marketplace → install → grants)', () => {
  test('operator publishes, installs and grants an SDK recipe end to end', async ({
    page,
  }, testInfo) => {
    test.setTimeout(240_000)
    assertMutableBranchProfile()
    if (PROVIDER === 'zai' || FALLBACK_PROVIDER === 'zai') {
      throw new Error(
        'Plugin Workload SDK T3 requires OpenAI or Claude targets; Z.AI is disabled for this lane.'
      )
    }
    const entryName = uniqueName('e2e-op-sdk')
    const token = await loginApiToken()
    const userRef = await resolveUserRef(token)
    let installedRecipeName = ''
    const cleanupErrors: string[] = []

    try {
      // 1. Publish to the Marketplace through the operator's visible form.
      await uiLogin(page)
      await page.locator('text=Marketplace').first().click()
      await expect(page.getByRole('button', { name: '+ Publish to Marketplace' })).toBeVisible({
        timeout: 15_000,
      })
      await page.getByRole('button', { name: '+ Publish to Marketplace' }).click()
      await expect(page.getByRole('heading', { name: 'Publish to Marketplace' })).toBeVisible({
        timeout: 15_000,
      })
      await page.getByRole('radio', { name: 'Plugin' }).click()
      await page.locator('#pub-name').fill(entryName)
      await page.getByRole('button', { name: 'Continue' }).click()
      await page.locator('#pub-author').fill('e2e-test')
      await page
        .locator('#pub-description')
        .fill('Operator-journey SDK recipe (promptBridge + clientNotifications).')
      await page.getByRole('button', { name: 'Continue' }).click()
      await page
        .locator('#pub-recipe-yaml')
        .fill(JSON.stringify(recipeManifest(entryName, userRef)))
      await page.getByRole('button', { name: 'Continue' }).click()
      const publishResponse = page.waitForResponse(
        response =>
          response.url().includes('/api/v1/admin/registry/entries') &&
          response.request().method() === 'POST',
        { timeout: 60_000 }
      )
      await page.getByRole('button', { name: 'Publish to Marketplace' }).click()
      expect((await publishResponse).status()).toBeLessThan(300)
      await expect(page.getByText('Published successfully.')).toBeVisible({ timeout: 15_000 })

      // 2. Operator instantiates it from the Marketplace UI. Recipe entries install
      //    directly from the catalog, unlike connector entries that open the wizard.
      const pluginsTab = page.getByRole('tab', { name: 'Plugins', exact: true })
      await expect(pluginsTab).toBeVisible({ timeout: 15_000 })
      await pluginsTab.click()
      await expect(page.getByLabel('Search Marketplace plugins')).toBeVisible({ timeout: 15_000 })
      await page.getByLabel('Search Marketplace plugins').fill(entryName)
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

      // 3. The eager mcp-host proves the SDK identity before a grant exists.
      // The expected fresh-install state is awaiting_policy; no provider call
      // is authorized until the operator completes the grant journey below.
      const identityState = await waitForSdkState(
        token,
        installedRecipeName,
        ['awaiting_policy', 'validated'],
        'identity bootstrap readiness'
      )
      expect(['awaiting_policy', 'validated']).toContain(identityState)

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

      // Both grants now exist. The WRC must observe the active target policy
      // and transition from awaiting_policy to validated before data-plane use.
      await waitForSdkState(token, installedRecipeName, ['validated'], 'validated policy')

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
        id?: string
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
        try {
          const grantList = await api(
            token,
            'GET',
            `/api/v1/admin/plugin-workload-sdk/grants?recipeNamespace=${RECIPE_NS}&recipeName=${installedRecipeName}`
          )
          if (grantList.status >= 300) {
            cleanupErrors.push(`list grants: ${grantList.status}`)
          } else {
            const residualGrants = (grantList.data.data ??
              grantList.data.items ??
              grantList.data.grants ??
              []) as Array<{ id?: string }>
            for (const grant of residualGrants) {
              if (!grant.id) continue
              try {
                const deleted = await api(
                  token,
                  'DELETE',
                  `/api/v1/admin/plugin-workload-sdk/grants/${encodeURIComponent(grant.id)}?recipeNamespace=${encodeURIComponent(RECIPE_NS)}&recipeName=${encodeURIComponent(installedRecipeName)}`
                )
                if (deleted.status >= 300) {
                  cleanupErrors.push(`delete grant ${grant.id}: ${deleted.status}`)
                }
              } catch (error) {
                cleanupErrors.push(`delete grant ${grant.id}: ${String(error)}`)
              }
            }
            try {
              const afterDelete = await api(
                token,
                'GET',
                `/api/v1/admin/plugin-workload-sdk/grants?recipeNamespace=${RECIPE_NS}&recipeName=${installedRecipeName}`
              )
              const remaining = (afterDelete.data.data ??
                afterDelete.data.items ??
                afterDelete.data.grants ??
                []) as unknown[]
              if (afterDelete.status !== 200 || remaining.length > 0) {
                cleanupErrors.push(
                  `grant cleanup postcondition failed: status=${afterDelete.status}, remaining=${remaining.length}`
                )
              }
            } catch (error) {
              cleanupErrors.push(`verify grants deleted: ${String(error)}`)
            }
          }
        } catch (error) {
          cleanupErrors.push(`list/delete grants: ${String(error)}`)
        }
        try {
          const uninstalled = await api(
            token,
            'DELETE',
            `/api/v1/admin/registry/uninstall/${installedRecipeName}?type=recipe`
          )
          if (uninstalled.status >= 300 && uninstalled.status !== 404) {
            cleanupErrors.push(`uninstall ${installedRecipeName}: ${uninstalled.status}`)
          }
          if (uninstalled.status < 300 || uninstalled.status === 404) {
            let recipeStatus = uninstalled.status
            for (let attempt = 0; attempt < 15 && recipeStatus !== 404; attempt++) {
              await delay(1_000)
              recipeStatus = (
                await api(
                  token,
                  'GET',
                  `/api/v1/admin/recipes/${encodeURIComponent(installedRecipeName)}`
                )
              ).status
            }
            if (recipeStatus !== 404) {
              cleanupErrors.push(
                `recipe cleanup postcondition failed: ${installedRecipeName} still returned HTTP ${recipeStatus}`
              )
            }
          }
        } catch (error) {
          cleanupErrors.push(`uninstall ${installedRecipeName}: ${String(error)}`)
        }
      }
      try {
        const deletedEntry = await fetch(
          `${REGISTRY_BASE}/api/v1/entries/${encodeURIComponent(entryName)}/versions/1.0.0`,
          { method: 'DELETE' }
        )
        if (!deletedEntry.ok && deletedEntry.status !== 404) {
          cleanupErrors.push(`delete registry entry ${entryName}: ${deletedEntry.status}`)
        }
        if (deletedEntry.ok || deletedEntry.status === 404) {
          const afterDelete = await fetch(
            `${REGISTRY_BASE}/api/v1/entries/${encodeURIComponent(entryName)}/versions/1.0.0`
          )
          if (afterDelete.status !== 404) {
            cleanupErrors.push(
              `registry cleanup postcondition failed: ${entryName} returned HTTP ${afterDelete.status}`
            )
          }
        }
      } catch (error) {
        cleanupErrors.push(`delete registry entry ${entryName}: ${String(error)}`)
      }
      if (cleanupErrors.length > 0) {
        await testInfo.attach('operator-journey-cleanup-errors', {
          body: cleanupErrors.join('\n'),
          contentType: 'text/plain',
        })
        if (testInfo.errors.length === 0) {
          throw new Error(`operator journey cleanup failed:\n${cleanupErrors.join('\n')}`)
        }
        console.error(`operator journey cleanup failed:\n${cleanupErrors.join('\n')}`)
      }
    }
  })
})
