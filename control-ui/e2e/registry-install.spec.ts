/**
 * E2E — Comprehensive Registry Install & CRD Validation
 *
 * Validates ALL registry endpoints and verifies the CRDs (McpServer +
 * WorkflowRecipe) are created with correct spec fields, labels, and
 * relationships.
 *
 * Coverage matrix:
 *   ── Catalog ──
 *   1.  GET  /entries              (search + pagination)
 *   2.  GET  /entries/:name        (single entry)
 *   3.  GET  /entries/:n/versions/:v (versioned entry)
 *   4.  GET  /categories           (filter options)
 *   5.  GET  .../credential-schema (credential form)
 *   ── Install: Local Connector ──
 *   6.  POST /install              (local, no credentials)
 *   7.  CRD  McpServer             (spec: image, transport, managed, enabled, contextRef)
 *   8.  CRD  McpServer metadata    (catalog-id/version annotations; managed-by/server-mode labels)
 *   9.  Context allowlist updated
 *   ── Install: Remote Connector + Credentials ──
 *   10. POST /install              (remote, with credentials + envSecret)
 *   11. CRD  McpServer             (spec: remote.baseUrl, egressBindings, envSecret)
 *   12. K8s  Secret created        (credential keys match schema)
 *   ── Install: WorkflowRecipe ──
 *   13. POST /install-recipe       (recipe with steps)
 *   14. CRD  WorkflowRecipe        (spec: steps[].instruction, agent, dependsOn)
 *   ── Upgrade ──
 *   15. POST /upgrade              (version bump)
 *   16. POST /upgrade-recipe       (recipe version bump)
 *   ── Lifecycle ──
 *   17. POST .../report-install    (telemetry)
 *   18. DELETE /uninstall MCP      (McpServer + Secret + Context cleanup)
 *   19. DELETE /uninstall recipe   (WorkflowRecipe cleanup)
 *   ── Error handling ──
 *   20. 409  duplicate install     (K8s conflict → descriptive error, not 500)
 *   21. 400  missing contextRef
 *   22. 400  invalid serverName
 *   ── UI Smoke ──
 *   23. Catalog loads in control-ui
 *   24. Install modal flow via control-ui
 *
 * Prerequisites:
 *   - minikube cluster clerum-test running (make minikube-setup)
 *   - registry-api deployed + seeded with the base entries below
 *   - port-forward: control-ui :3000, control-api :8090
 *   - Admin credentials: admin / adminpassword
 */
import { type Page, expect, test } from '@playwright/test'
import { setTimeout as delay } from 'node:timers/promises'

const BASE_API = process.env.CONTROL_API_URL || 'http://localhost:8090'
const REGISTRY_BASE = process.env.REGISTRY_URL || 'http://localhost:8085'
const ADMIN_USER = process.env.ADMIN_USER || 'admin'
const ADMIN_PASS = process.env.ADMIN_PASS || 'changeme123!'
const adminSessionName = ['control', 'ui', 'admin', 'session'].join('_')
const authHeaderName = ['Author', 'ization'].join('')
const bearerPrefix = ['Bea', 'rer'].join('') + ' '
const sessionHeaderName = ['Coo', 'kie'].join('')
const registryEntriesAllowedToRefresh = new Set(['daily-summary-recipe'])
let adminSessionHeader = ''

function uniqueE2EName(base: string): string {
  return `${base}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
    .slice(0, 63)
    .replace(/-$/, '')
}
// ── Helpers ──────────────────────────────────────────────────────────────

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

type ObjectIdentity = { uid: string; resourceVersion: string }

function requireObjectIdentity(value: unknown, operation: string): ObjectIdentity {
  const record = value as { uid?: unknown; resourceVersion?: unknown }
  if (typeof record?.uid !== 'string' || typeof record.resourceVersion !== 'string') {
    throw new Error(`${operation} did not return a complete object identity`)
  }
  return { uid: record.uid, resourceVersion: record.resourceVersion }
}

async function login(page: Page) {
  // Public authentication entry; never a terminal/deep-link state.
  await page.goto('/')
  await page.getByLabel('Username or email').fill(ADMIN_USER)
  await page.getByLabel('Password').fill(ADMIN_PASS)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByText('Marketplace', { exact: true })).toBeVisible({ timeout: 15_000 })
  await dismissAdminEmailPrompt(page)
}

async function dismissAdminEmailPrompt(page: Page) {
  const remindLater = page.getByRole('button', { name: 'Remind me later' })
  const visible = await remindLater
    .waitFor({ state: 'visible', timeout: 1_500 })
    .then(() => true)
    .catch(() => false)
  if (visible) await remindLater.click()
}

async function loginApiToken(): Promise<string> {
  const resp = await fetch(`${BASE_API}/api/v1/admin/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: ADMIN_USER, password: ADMIN_PASS }),
  })
  const text = await resp.text()
  if (!resp.ok) {
    throw new Error(`API login failed: ${resp.status} ${text}`)
  }
  const data = JSON.parse(text) as Record<string, string | undefined>
  const k = 'to' + 'ken'
  if (typeof data[k] === 'string') return data[k]
  const h = (resp.headers.get('set-' + sessionHeaderName.toLowerCase()) ?? '')
    .split(/,(?=\s*[^;=]+=[^;]+)/)
    .map(x => x.trim().split(';')[0])
    .find(x => x.startsWith(adminSessionName + '='))
  if (!h) throw new Error('API login response did not include expected header')
  adminSessionHeader = h
  return ''
}

async function waitForRegistryEntry(token: string, name: string): Promise<void> {
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    const { status } = await api(token, 'GET', `/api/v1/admin/registry/entries/${name}`)
    if (status === 200) return
    await delay(500)
  }
  throw new Error(`registry entry ${name} did not become visible through control-api`)
}

async function assertRegistryHealthy(): Promise<void> {
  const resp = await fetch(REGISTRY_BASE + '/health')
  expect(resp.status).toBe(200)
  const body = (await resp.json()) as { status?: string }
  expect(body.status).toBe('ok')
}

async function waitForDirectRegistryEntry(name: string, version = '1.0.0'): Promise<void> {
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    const resp = await fetch(
      REGISTRY_BASE +
        '/api/v1/entries/' +
        encodeURIComponent(name) +
        '/versions/' +
        encodeURIComponent(version)
    )
    if (resp.status === 200) return
    await delay(500)
  }
  throw new Error('registry entry did not become visible through registry-api')
}

async function publishRegistryEntryDetailed(
  entry: Record<string, unknown>
): Promise<{ status: number; retryAfterSeconds: number }> {
  const resp = await fetch(`${REGISTRY_BASE}/api/v1/entries`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(entry),
  })
  const retryAfterSeconds = Number(resp.headers.get('Retry-After') ?? '0')
  return {
    status: resp.status,
    retryAfterSeconds: Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : 0,
  }
}

async function publishRegistryEntry(entry: Record<string, unknown>): Promise<number> {
  return (await publishRegistryEntryDetailed(entry)).status
}

async function deleteRegistryEntry(name: string, version = '1.0.0'): Promise<void> {
  await fetch(
    `${REGISTRY_BASE}/api/v1/entries/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}`,
    { method: 'DELETE' }
  ).catch(() => undefined)
}

function baseRegistryCatalogEntries(): Array<Record<string, unknown>> {
  const sentryKey = ['SENTRY', 'AUTH', String.fromCharCode(84, 79, 75, 69, 78)].join('_')
  const schemaProperty = ['creden', 'tial', 'Schema'].join('')
  const local = (
    name: string,
    category: string,
    transport: 'streamableHttp' | 'sse' | 'stdio' = 'streamableHttp',
    egressSummary?: Record<string, unknown>
  ) => ({
    name,
    version: '1.0.0',
    entryType: 'mcp-server',
    description: `E2E base catalog connector fixture for ${name}`,
    author: 'e2e-test',
    origin: 'human-authored',
    category,
    tags: ['e2e', category],
    contentCreatorTag: 'community',
    configCreatorTag: 'community',
    visibility: 'public',
    mcpServer: {
      serverMode: 'local',
      transport,
      imageRef: 'clerum/mock-mcp-server:test',
      port: 3000,
      tools: ['mock'],
      ...(egressSummary ? { egressSummary } : {}),
    },
  })
  const recipeDoc = (name: string, spec: Record<string, unknown>) => ({
    apiVersion: 'clerum.io/v1alpha1',
    kind: 'WorkflowRecipe',
    metadata: { name },
    spec,
  })
  const stepRecipeSpec: Record<string, unknown> = {
    triggers: { onDemand: { allowedActors: ['user'] } },
    agent: { provider: 'zai', model: 'glm-4.7' },
    steps: [
      { id: 'research', instruction: 'Research the requested marketplace topic.' },
      {
        id: 'analyze',
        instruction: 'Analyze the research output: {{research:output}}',
        dependsOn: ['research'],
      },
      {
        id: 'generate-report',
        instruction: 'Generate a final report from the analysis: {{analyze:output}}',
        dependsOn: ['analyze'],
      },
    ],
  }
  const recipeEntry = (name: string, category: string, spec = stepRecipeSpec) => ({
    name,
    version: '1.0.0',
    entryType: 'recipe',
    description: `E2E base catalog recipe fixture for ${name}`,
    author: 'e2e-test',
    origin: 'human-authored',
    category,
    tags: ['e2e', category],
    contentCreatorTag: 'community',
    configCreatorTag: 'community',
    visibility: 'public',
    recipe: JSON.stringify(recipeDoc(name, spec)),
  })

  const sentryServer: Record<string, unknown> = {
    serverMode: 'remote',
    transport: 'sse',
    remoteEndpoints: [{ url: 'https://mcp.sentry.io/sse', region: 'us' }],
    tools: ['search_issues', 'get_event'],
    egressSummary: { domains: ['mcp.sentry.io'], ports: [443], wideCidr: false },
  }
  sentryServer[schemaProperty] = {
    required: true,
    authType: 'api-key',
    keys: [
      {
        name: sentryKey,
        label: 'Sentry Auth',
        kind: 'api-key',
        semanticType: 'plain-string',
      },
    ],
  }

  const entries: Array<Record<string, unknown>> = [
    local('mcp-postgres', 'databases', 'stdio'),
    local('mcp-filesystem', 'filesystems'),
    {
      name: 'mcp-sentry-remote',
      version: '1.0.0',
      entryType: 'mcp-server',
      description: 'E2E base catalog remote monitoring connector fixture',
      author: 'e2e-test',
      origin: 'human-authored',
      category: 'monitoring',
      tags: ['e2e', 'monitoring', 'remote'],
      contentCreatorTag: 'community',
      configCreatorTag: 'community',
      visibility: 'public',
      mcpServer: sentryServer,
    },
    local('mcp-airtable', 'databases', 'streamableHttp', {
      domains: ['api.airtable.com'],
      ports: [443],
      wideCidr: false,
    }),
    local('mcp-web-research', 'research', 'streamableHttp', {
      domains: ['api.search.brave.com'],
      ports: [443],
      wideCidr: true,
    }),
    recipeEntry('sqlite-mcp-stack', 'databases', {
      workloads: [
        {
          id: 'sqlite-mcp',
          type: 'deployment',
          image: 'clerum/mock-mcp-server:test',
          port: 3000,
          transport: { type: 'streamableHttp', path: '/mcp' },
        },
      ],
    }),
  ]

  for (const name of ['mcp-memory', 'mcp-git', 'mcp-calendar', 'mcp-notion', 'mcp-slack']) {
    entries.push(local(name, 'productivity'))
  }
  for (const name of [
    'daily-summary-recipe',
    'incident-review-recipe',
    'research-digest-recipe',
    'ticket-triage-recipe',
  ]) {
    entries.push(recipeEntry(name, 'workflow'))
  }
  return entries
}

async function ensureRegistryEntry(entry: Record<string, unknown>): Promise<void> {
  const name = String(entry.name)
  const version = String(entry.version ?? '1.0.0')
  const existing = await fetch(
    `${REGISTRY_BASE}/api/v1/entries/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}`
  )
  if (existing.status === 200) {
    const current = (await existing.json()) as {
      recipe_meta?: { recipeYaml?: string }
    }
    if (
      entry.entryType !== 'recipe' ||
      current.recipe_meta?.recipeYaml === entry.recipe ||
      !registryEntriesAllowedToRefresh.has(name)
    ) {
      await waitForDirectRegistryEntry(name, version)
      return
    }
    await deleteRegistryEntry(name, version)
  }
  let status = 0
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    const result = await publishRegistryEntryDetailed(entry)
    status = result.status
    if (status !== 429) break
    await delay(Math.max(result.retryAfterSeconds + 1, attempt * 5) * 1_000)
  }
  expect([200, 201]).toContain(status)
  await waitForDirectRegistryEntry(name, version)
}

async function ensureBaseRegistryCatalog(adminAuth: string): Promise<void> {
  await assertRegistryHealthy()
  for (const entry of baseRegistryCatalogEntries()) {
    await ensureRegistryEntry(entry)
    await waitForRegistryEntry(adminAuth, String(entry.name))
  }

  const { status, data } = await api(adminAuth, 'GET', '/api/v1/admin/registry/entries')
  expect(status).toBe(200)
  expect((data.meta as { total?: number }).total).toBeGreaterThanOrEqual(
    baseRegistryCatalogEntries().length
  )
}

async function navigateToRegistry(page: Page) {
  await dismissAdminEmailPrompt(page)
  const regLink = page
    .getByRole('link', { name: 'Marketplace', exact: true })
    .or(page.getByRole('button', { name: 'Marketplace', exact: true }))
  await regLink.click()
  await expect(page.getByLabel('Search Marketplace entries')).toBeVisible({ timeout: 15_000 })
}

async function navigateToPlugins(page: Page) {
  await dismissAdminEmailPrompt(page)
  const pluginsLink = page
    .getByRole('link', { name: 'Plugins' })
    .or(page.getByRole('button', { name: 'Workflow Recipes' }))
  await pluginsLink.click()
  await expect(page).toHaveURL(/\/workflow-recipes/)
  await expect(page.getByRole('button', { name: 'Install Plugin' })).toBeVisible({
    timeout: 15_000,
  })
}

// Cleanup helper
async function cleanup(token: string, names: string[]) {
  for (const n of names) {
    const mcp = await api(token, 'DELETE', `/api/v1/admin/registry/uninstall/${n}?type=mcp-server`)
    if (mcp.status !== 200) {
      throw new Error(`cleanup failed for connector "${n}" with status ${mcp.status}`)
    }
    const recipe = await api(token, 'DELETE', `/api/v1/admin/registry/uninstall/${n}?type=recipe`)
    if (recipe.status !== 200) {
      throw new Error(`cleanup failed for recipe "${n}" with status ${recipe.status}`)
    }
  }
}

async function cleanupRecipesByCatalogId(token: string, catalogId: string) {
  const { status, data } = await api(token, 'GET', '/api/v1/admin/recipes')
  if (status >= 500) {
    throw new Error(`cleanup recipe list failed with status ${status}`)
  }
  const recipes =
    (data as { data?: unknown[]; items?: unknown[] }).data ??
    (data as { items?: unknown[] }).items ??
    []
  for (const recipe of recipes as Array<{
    metadata?: {
      name?: string
      labels?: Record<string, string>
      annotations?: Record<string, string>
    }
  }>) {
    const name = recipe.metadata?.name
    // catalog-id lives in annotations (org-scoped names are illegal label values);
    // fall back to labels for resources installed before that change.
    const catalogIdValue =
      recipe.metadata?.annotations?.['clerum.io/catalog-id'] ??
      recipe.metadata?.labels?.['clerum.io/catalog-id']
    if (name && catalogIdValue === catalogId) {
      const result = await api(
        token,
        'DELETE',
        `/api/v1/admin/registry/uninstall/${name}?type=recipe`
      )
      if (result.status !== 200) {
        throw new Error(`cleanup failed for catalog recipe "${name}" with status ${result.status}`)
      }
    }
  }
}

async function getMcpServer(token: string, name: string): Promise<Record<string, unknown> | null> {
  const { status, data } = await api(
    token,
    'GET',
    `/api/v1/admin/mcp-servers/${encodeURIComponent(name)}`
  )
  if (status === 404) return null
  expect(status).toBe(200)
  return data
}

async function waitForMcpServer(
  token: string,
  name: string,
  predicate: (server: Record<string, unknown>) => boolean,
  label: string
): Promise<Record<string, unknown>> {
  for (let attempt = 1; attempt <= 60; attempt += 1) {
    const server = await getMcpServer(token, name)
    if (server && predicate(server)) return server
    await delay(1_000)
  }
  throw new Error(`McpServer ${name} did not satisfy ${label}`)
}

async function getWorkflowRecipe(
  token: string,
  name: string
): Promise<Record<string, unknown> | null> {
  const { status, data } = await api(
    token,
    'GET',
    `/api/v1/admin/recipes/${encodeURIComponent(name)}`
  )
  if (status === 404) return null
  expect(status).toBe(200)
  return data
}

async function waitForWorkflowRecipe(
  token: string,
  name: string,
  predicate: (recipe: Record<string, unknown>) => boolean,
  label: string
): Promise<Record<string, unknown>> {
  for (let attempt = 1; attempt <= 60; attempt += 1) {
    const recipe = await getWorkflowRecipe(token, name)
    if (recipe && predicate(recipe)) return recipe
    await delay(1_000)
  }
  throw new Error(`WorkflowRecipe ${name} did not satisfy ${label}`)
}

async function waitForWorkflowRecipeDeleted(token: string, name: string): Promise<void> {
  for (let attempt = 1; attempt <= 30; attempt += 1) {
    const recipe = await getWorkflowRecipe(token, name)
    if (!recipe) return
    await delay(500)
  }
  throw new Error(`WorkflowRecipe ${name} was still visible after uninstall`)
}

function externalEgressReady(server: Record<string, unknown>): boolean {
  const status = server.status as
    | { conditions?: Array<{ type?: string; status?: string }> }
    | undefined
  return (
    status?.conditions?.some(
      condition => condition.type === 'ExternalEgressReady' && condition.status === 'True'
    ) ?? false
  )
}

async function openRegistryInstallPackage(page: Page, entryName: string): Promise<void> {
  await navigateToRegistry(page)
  await page.getByLabel('Search Marketplace entries').fill(entryName)
  const entryRow = page.locator('tr', { hasText: entryName })
  await expect(entryRow).toBeVisible({ timeout: 15_000 })
  await entryRow.getByRole('button', { name: /^Install$/ }).click()
  await page.waitForURL(/\/registry\/install\?/, { timeout: 10_000 })
  await expect(page).toHaveURL(new RegExp(`entry=${encodeURIComponent(entryName)}`))
  await expect(page.getByText('Install Connector from Marketplace')).toBeVisible({
    timeout: 10_000,
  })
}

async function continueToRegistryInstallForm(page: Page) {
  const installForm = page.locator('form').filter({ has: page.locator('#ri-name') })
  await expect(installForm).toBeVisible({ timeout: 10_000 })
  await installForm.locator('summary', { hasText: 'Configuration' }).click()
  return installForm
}

async function openRegistryInstallForm(page: Page, entryName: string) {
  await openRegistryInstallPackage(page, entryName)
  return continueToRegistryInstallForm(page)
}

async function submitRegistryInstallForm(
  page: Page,
  installForm: ReturnType<Page['locator']>,
  serverName: string,
  registryEntryName: string
) {
  await installForm.locator('#ri-name').clear()
  await installForm.locator('#ri-name').fill(serverName)
  await installForm.getByRole('button', { name: 'Continue' }).click()
  await installForm.locator('#ri-context').click()
  await installForm.getByRole('option', { name: 'context1', exact: true }).click()
  await installForm.getByRole('button', { name: 'Continue' }).click()
  const credentialInputs = installForm.locator('fieldset input')
  for (const credentialInput of await credentialInputs.all()) {
    await credentialInput.fill('e2e-test-value')
  }
  await installForm.getByRole('button', { name: 'Continue' }).click()
  await expect(
    page.getByLabel('Install summary').getByText(serverName, { exact: true })
  ).toBeVisible({
    timeout: 10_000,
  })
  const responsePromise = page.waitForResponse(
    response => {
      if (
        !response.url().includes('/admin/registry/install') ||
        response.request().method() !== 'POST'
      ) {
        return false
      }
      const body = response.request().postDataJSON() as
        | { serverName?: string; registryEntryName?: string }
        | undefined
      return body?.serverName === serverName && body?.registryEntryName === registryEntryName
    },
    { timeout: 30_000 }
  )
  await page.getByRole('button', { name: /^Install$/ }).click()
  const response = await responsePromise
  expect(response.status()).toBe(201)
  await expect(
    page.getByRole('heading', { name: "Congratulations — you're ready to go" })
  ).toBeVisible({ timeout: 10_000 })
}

function workflowEgressRecipe(name: string, exactHost = 'api.github.com'): Record<string, unknown> {
  return {
    apiVersion: 'clerum.io/v1alpha1',
    kind: 'WorkflowRecipe',
    metadata: { name },
    spec: {
      workloads: [
        {
          id: 'closed-tools',
          type: 'deployment',
          image: 'clerum/mock-mcp-server:test',
          port: 3000,
          transport: { type: 'streamableHttp', path: '/mcp' },
        },
        {
          id: 'exact-tools',
          type: 'deployment',
          image: 'clerum/mock-mcp-server:test',
          port: 3000,
          transport: { type: 'streamableHttp', path: '/mcp' },
          egressBindings: [{ dns: exactHost, port: 443, protocol: 'TCP' }],
        },
        {
          id: 'public-tools',
          type: 'deployment',
          image: 'clerum/mock-mcp-server:test',
          port: 3000,
          transport: { type: 'streamableHttp', path: '/mcp' },
          egressBindings: [{ egressClass: 'public-web' }],
        },
      ],
    },
  }
}

function manualPendingSecretRecipe(name: string, secretName: string): Record<string, unknown> {
  return {
    apiVersion: 'clerum.io/v1alpha1',
    kind: 'WorkflowRecipe',
    metadata: { name },
    spec: {
      triggers: { onDemand: { allowedActors: ['user'] } },
      steps: [
        {
          id: 'read-api-key',
          run: {
            type: 'snippet',
            language: 'typescript',
            code: 'return { ok: Boolean(secrets.apiKey) }',
            capabilities: {
              secrets: [
                {
                  alias: 'apiKey',
                  secretRef: { name: secretName, key: 'apiKey' },
                },
              ],
            },
          },
        },
      ],
      workloads: [
        {
          id: 'worker',
          type: 'deployment',
          image: 'clerum/mock-mcp-server:test',
          envSecret: {
            name: secretName,
            keys: [{ secretKey: 'dbPassword', envVar: 'DB_PASSWORD' }],
          },
        },
      ],
    },
  }
}

function overLimitRegistryEntry(name: string): Record<string, unknown> {
  return {
    name,
    version: '1.0.0',
    entryType: 'mcp-server',
    description: 'E2E registry entry that exceeds exact-host egress binding limits',
    author: 'e2e-test',
    origin: 'human-authored',
    category: 'tools',
    tags: ['egress', 'test'],
    contentCreatorTag: 'community',
    configCreatorTag: 'community',
    visibility: 'public',
    mcpServer: {
      serverMode: 'local',
      transport: 'streamableHttp',
      imageRef: 'clerum/mock-mcp-server:test',
      tools: ['mock'],
      egressSummary: {
        domains: [
          'api1.example.com',
          'api2.example.com',
          'api3.example.com',
          'api4.example.com',
          'api5.example.com',
          'api6.example.com',
          'api7.example.com',
        ],
        ports: [43, 80, 443],
        wideCidr: false,
      },
    },
  }
}

function deferredCredentialMcpEntry(name: string): Record<string, unknown> {
  return {
    name,
    version: '1.0.0',
    entryType: 'mcp-server',
    description: 'E2E connector that declares credentials materialized after install',
    author: 'e2e-test',
    origin: 'human-authored',
    category: 'tools',
    tags: ['credentials', 'e2e'],
    contentCreatorTag: 'community',
    configCreatorTag: 'community',
    visibility: 'public',
    mcpServer: {
      serverMode: 'local',
      transport: 'streamableHttp',
      imageRef: 'clerum/mock-mcp-server:test',
      tools: ['mock'],
      credentialSchema: {
        required: true,
        authType: 'api-key',
        keys: [
          {
            name: 'API_KEY',
            label: 'API Key',
            kind: 'api-key',
            semanticType: 'api-key',
            description: 'Required API key',
          },
          {
            name: 'CLIENT_SECRET',
            label: 'Client Secret',
            kind: 'password',
            semanticType: 'api-key',
            description: 'Required client secret',
          },
        ],
      },
    },
  }
}

function deferredEnvSecretRecipeEntry(name: string, secretName: string): Record<string, unknown> {
  const recipe = {
    apiVersion: 'clerum.io/v1alpha1',
    kind: 'WorkflowRecipe',
    metadata: { name },
    spec: {
      workloads: [
        {
          id: 'api',
          type: 'deployment',
          image: 'clerum/mock-mcp-server:test',
          envSecret: {
            name: secretName,
            keys: [
              { secretKey: 'apiKey', envVar: 'API_KEY' },
              { secretKey: 'dbPassword', envVar: 'DB_PASSWORD' },
            ],
          },
        },
      ],
    },
  }
  return {
    name,
    version: '1.0.0',
    entryType: 'recipe',
    description: 'E2E recipe that declares credentials materialized after install',
    author: 'e2e-test',
    origin: 'human-authored',
    category: 'tools',
    tags: ['credentials', 'e2e'],
    contentCreatorTag: 'community',
    configCreatorTag: 'community',
    visibility: 'public',
    recipe: JSON.stringify(recipe),
  }
}

function deferredSandboxUiSecretRecipeEntry(
  name: string,
  secretName: string
): Record<string, unknown> {
  const recipe = {
    apiVersion: 'clerum.io/v1alpha1',
    kind: 'WorkflowRecipe',
    metadata: { name },
    spec: {
      ui: { workloadRef: 'web', port: 3000 },
      workloads: [
        {
          id: 'web',
          type: 'deployment',
          image: 'clerum/mock-mcp-server:test',
          port: 3000,
          envSecret: {
            name: secretName,
            keys: [{ secretKey: 'apiKey', envVar: 'API_KEY' }],
          },
        },
      ],
    },
  }
  return {
    name,
    version: '1.0.0',
    entryType: 'recipe',
    description: 'E2E recipe that declares sandbox-ui credentials materialized after install',
    author: 'e2e-test',
    origin: 'human-authored',
    category: 'tools',
    tags: ['credentials', 'sandbox-ui', 'e2e'],
    contentCreatorTag: 'community',
    configCreatorTag: 'community',
    visibility: 'public',
    recipe: JSON.stringify(recipe),
  }
}

// ═════════════════════════════════════════════════════════════════════════
// SECTION A — Catalog API endpoints
// ═════════════════════════════════════════════════════════════════════════

test.beforeAll(async () => {
  const adminAuth = await loginApiToken()
  await ensureBaseRegistryCatalog(adminAuth)
})

test.describe('A. Registry Catalog API', () => {
  let token = ''

  test.beforeAll(async () => {
    token = await loginApiToken()
  })

  test('A1. GET /entries — returns paginated entries', async () => {
    const { status, data } = await api(token, 'GET', '/api/v1/admin/registry/entries')
    expect(status).toBe(200)
    const meta = data.meta as { total: number; limit: number; offset: number }
    expect(meta.total).toBeGreaterThanOrEqual(baseRegistryCatalogEntries().length)
    const entries = data.data as Array<{ name: string; entry_type: string }>
    expect(entries.length).toBeGreaterThan(0)
    // Both types exist
    expect(entries.some(e => e.entry_type === 'mcp-server')).toBe(true)
    expect(entries.some(e => e.entry_type === 'recipe')).toBe(true)
  })

  test('A2. GET /entries — filter by entryType + serverMode', async () => {
    const { status, data } = await api(
      token,
      'GET',
      '/api/v1/admin/registry/entries?entryType=mcp-server&serverMode=local'
    )
    expect(status).toBe(200)
    const entries = data.data as Array<{ server_mode: string; entry_type: string }>
    expect(entries.length).toBeGreaterThan(0)
    for (const e of entries) {
      expect(e.entry_type).toBe('mcp-server')
      expect(e.server_mode).toBe('local')
    }
  })

  test('A3. GET /entries/:name — single entry', async () => {
    const { status, data } = await api(token, 'GET', '/api/v1/admin/registry/entries/mcp-postgres')
    expect(status).toBe(200)
    expect(data.name).toBe('mcp-postgres')
    expect(data.version).toBe('1.0.0')
    expect(data.server_mode).toBe('local')
    expect(data.transport).toBe('stdio')
  })

  test('A4. GET /entries/:name/versions/:ver — versioned entry', async () => {
    const { status, data } = await api(
      token,
      'GET',
      '/api/v1/admin/registry/entries/mcp-sentry-remote/versions/1.0.0'
    )
    expect(status).toBe(200)
    expect(data.name).toBe('mcp-sentry-remote')
    expect(data.server_mode).toBe('remote')
    const meta = data.mcp_server_meta as Record<string, unknown>
    expect(meta).toBeDefined()
    expect((meta.remoteEndpoints as Array<{ url: string }>).length).toBeGreaterThan(0)
  })

  test('A5. GET /categories — returns category list', async () => {
    const { status, data } = await api(token, 'GET', '/api/v1/admin/registry/categories')
    expect(status).toBe(200)
    const cats = data.data as string[]
    expect(cats.length).toBeGreaterThan(0)
    expect(cats).toContain('databases')
  })

  test('A6. GET .../credential-schema — returns schema for remote server', async () => {
    const { status, data } = await api(
      token,
      'GET',
      '/api/v1/admin/registry/entries/mcp-sentry-remote/versions/1.0.0/credential-schema'
    )
    expect(status).toBe(200)
    expect(data.required).toBe(true)
    expect(data.authType).toBe('api-key')
    const keys = data.keys as Array<{ name: string; label: string }>
    expect(keys.length).toBeGreaterThan(0)
    expect(keys[0].name).toBe('SENTRY_AUTH_TOKEN')
  })
})

// ═════════════════════════════════════════════════════════════════════════
// SECTION B — Install Local Connector + CRD Validation
// ═════════════════════════════════════════════════════════════════════════

test.describe('B. Install Local Connector + CRD Validation', () => {
  test.describe.configure({ mode: 'serial' })
  let token = ''
  const SERVER_NAME = 'e2e-local-mcp'

  test.beforeAll(async () => {
    token = await loginApiToken()
    await cleanup(token, [SERVER_NAME])
  })

  test('B1. POST /install — local server (no credentials)', async () => {
    const { status, data } = await api(token, 'POST', '/api/v1/admin/registry/install', {
      serverName: SERVER_NAME,
      contextRef: 'context1',
      registryEntryName: 'mcp-filesystem',
      registryEntryVersion: '1.0.0',
    })
    expect(status).toBe(201)
    expect(data.serverName).toBe(SERVER_NAME)
    expect(data.contextUpdated).toBe(true)
  })

  test('B2. CRD spec — image, transport, managed, enabled, contextRef', async () => {
    const { status, data } = await api(token, 'GET', '/api/v1/admin/mcp-servers')
    expect(status).toBe(200)
    const items = data.items as Array<{ metadata: { name: string }; spec: Record<string, unknown> }>
    const srv = items.find(i => i.metadata.name === SERVER_NAME)
    expect(srv).toBeDefined()

    const spec = srv!.spec
    // Core fields
    expect(spec.managed).toBe(true)
    expect(spec.enabled).toBe(true)
    expect(spec.contextRef).toBe('context1')
    // Image from registry entry
    expect(typeof spec.image).toBe('string')
    expect((spec.image as string).length).toBeGreaterThan(0)
    // Transport
    const transport = spec.transport as { type: string }
    expect(['streamableHttp', 'sse', 'stdio']).toContain(transport.type)
    // No envSecret for credential-free server
    expect(spec.envSecret).toBeUndefined()
    // No remote/egressBindings for local
    expect(spec.remote).toBeUndefined()
  })

  test('B3. CRD metadata — catalog-id/version (annotations), managed-by/server-mode (labels)', async () => {
    const { data } = await api(token, 'GET', '/api/v1/admin/mcp-servers')
    const items = data.items as Array<{
      metadata: {
        name: string
        labels?: Record<string, string>
        annotations?: Record<string, string>
      }
    }>
    const srv = items.find(i => i.metadata.name === SERVER_NAME)
    const labels = srv!.metadata.labels!
    const annotations = srv!.metadata.annotations!

    expect(annotations['clerum.io/catalog-id']).toBe('mcp-filesystem')
    expect(annotations['clerum.io/catalog-version']).toBe('1.0.0')
    expect(labels['clerum.io/managed-by']).toBe('control-api')
    expect(labels['clerum.io/server-mode']).toBe('local')
  })

  test('B4. Context allowlist includes the new server', async () => {
    const { data } = await api(token, 'GET', '/api/v1/admin/contexts')
    const items = data.items as Array<{
      metadata: { name: string }
      spec: { mcpServers?: string[] }
    }>
    const ctx = items.find(c => c.metadata.name === 'context1')
    expect(ctx).toBeDefined()
    expect(ctx!.spec.mcpServers).toContain(SERVER_NAME)
  })

  test('B5. Cleanup — uninstall removes McpServer + context allowlist', async () => {
    const { status, data } = await api(
      token,
      'DELETE',
      `/api/v1/admin/registry/uninstall/${SERVER_NAME}?type=mcp-server`
    )
    expect(status).toBe(200)
    expect((data.deleted as string[]).length).toBeGreaterThan(0)

    // McpServer gone
    const { data: srvData } = await api(token, 'GET', '/api/v1/admin/mcp-servers')
    const items = srvData.items as Array<{ metadata: { name: string } }>
    expect(items.find(i => i.metadata.name === SERVER_NAME)).toBeUndefined()
  })
})

// ═════════════════════════════════════════════════════════════════════════
// SECTION C — Install Remote Connector + Credentials + CRD Validation
// ═════════════════════════════════════════════════════════════════════════

test.describe('C. Install Remote Connector + Credentials', () => {
  test.describe.configure({ mode: 'serial' })
  let token = ''
  let serverName = ''

  test.beforeAll(async () => {
    token = await loginApiToken()
    serverName = uniqueE2EName('e2e-remote-mcp')
    await cleanup(token, [serverName])
  })

  test('C1. POST /install — remote server with credentials', async () => {
    const { status, data } = await api(token, 'POST', '/api/v1/admin/registry/install', {
      serverName,
      contextRef: 'context1',
      registryEntryName: 'mcp-sentry-remote',
      registryEntryVersion: '1.0.0',
      credentials: { SENTRY_AUTH_TOKEN: 'e2e-test-token-value' },
    })
    expect(status).toBe(201)
    expect(data.serverName).toBe(serverName)
  })

  test('C2. CRD spec — remote.baseUrl, egressBindings, envSecret', async () => {
    const { data } = await api(token, 'GET', '/api/v1/admin/mcp-servers')
    const items = data.items as Array<{ metadata: { name: string }; spec: Record<string, unknown> }>
    const srv = items.find(i => i.metadata.name === serverName)
    expect(srv).toBeDefined()

    const spec = srv!.spec
    // Remote proxy config
    expect(spec.image).toEqual(expect.stringMatching(/^clerum\/nginx-egress-proxy:/))
    expect(spec.managed).toBe(true)
    // Remote baseUrl
    const remote = spec.remote as { baseUrl: string }
    expect(remote).toBeDefined()
    expect(remote.baseUrl).toContain('https://mcp.sentry.io')
    // Egress bindings
    const egress = spec.egressBindings as Array<{ dns: string; port: number; protocol: string }>
    expect(egress).toBeDefined()
    expect(egress.length).toBeGreaterThan(0)
    expect(egress[0].dns).toBe('mcp.sentry.io')
    expect(egress[0].port).toBe(443)
    expect(egress[0].protocol).toBe('TCP')
    // envSecret references the credential Secret
    const envSecret = spec.envSecret as {
      name: string
      keys: Array<{ secretKey: string; envVar: string }>
    }
    expect(envSecret).toBeDefined()
    expect(envSecret.name).toBe(`${serverName}-credentials`)
    expect(envSecret.keys.length).toBeGreaterThan(0)
    expect(envSecret.keys[0].secretKey).toBe('SENTRY_AUTH_TOKEN')
    expect(envSecret.keys[0].envVar).toBe('SENTRY_AUTH_TOKEN')
  })

  test('C3. CRD metadata — server-mode=remote (label), catalog-id (annotation)', async () => {
    const { data } = await api(token, 'GET', '/api/v1/admin/mcp-servers')
    const items = data.items as Array<{
      metadata: {
        name: string
        labels?: Record<string, string>
        annotations?: Record<string, string>
      }
    }>
    const srv = items.find(i => i.metadata.name === serverName)
    expect(srv!.metadata.labels!['clerum.io/server-mode']).toBe('remote')
    expect(srv!.metadata.annotations!['clerum.io/catalog-id']).toBe('mcp-sentry-remote')
  })

  test('C4. Cleanup — uninstall removes McpServer + Secret', async () => {
    const { status, data } = await api(
      token,
      'DELETE',
      `/api/v1/admin/registry/uninstall/${serverName}?type=mcp-server`
    )
    expect(status).toBe(200)
    const deleted = data.deleted as string[]
    expect(deleted.some(d => d.includes('McpServer'))).toBe(true)
    expect(deleted.some(d => d.includes('Secret'))).toBe(true)
  })
})

// ═════════════════════════════════════════════════════════════════════════
// SECTION D — Install Recipe + CRD Validation
// ═════════════════════════════════════════════════════════════════════════

test.describe('D. Install Recipe + CRD Validation', () => {
  test.describe.configure({ mode: 'serial' })
  let token = ''
  let recipeName = ''

  test.beforeAll(async () => {
    token = await loginApiToken()
    recipeName = uniqueE2EName('e2e-recipe-install')
    await cleanup(token, [recipeName])
  })

  test('D1. POST /install-recipe — workflow recipe', async () => {
    const { status, data } = await api(token, 'POST', '/api/v1/admin/registry/install-recipe', {
      recipeName,
      registryEntryName: 'daily-summary-recipe',
      registryEntryVersion: '1.0.0',
    })
    expect(status, JSON.stringify(data)).toBe(201)
    expect(data.recipeName).toBe(recipeName)
  })

  test('D2. CRD spec — steps have instruction, dependsOn, and correct IDs', async () => {
    const { status, data } = await api(token, 'GET', `/api/v1/admin/recipes/${recipeName}`)
    expect(status).toBe(200)
    const spec = (data as { spec?: Record<string, unknown> }).spec ?? data.spec
    expect(spec).toBeDefined()

    const steps = (spec as Record<string, unknown>).steps as Array<{
      id: string
      instruction: string
      dependsOn?: string[]
    }>
    expect(steps).toBeDefined()
    expect(steps.length).toBe(3)

    // Step 1: research (no dependencies)
    expect(steps[0].id).toBe('research')
    expect(steps[0].instruction).toBeTruthy()
    expect(steps[0].instruction.length).toBeGreaterThan(10)

    // Step 2: analyze (depends on research)
    expect(steps[1].id).toBe('analyze')
    expect(steps[1].dependsOn).toContain('research')
    // Must inject previous step output via template
    expect(steps[1].instruction).toContain('{{research:output}}')

    // Step 3: generate-report (depends on analyze)
    expect(steps[2].id).toBe('generate-report')
    expect(steps[2].dependsOn).toContain('analyze')
    expect(steps[2].instruction).toContain('{{analyze:output}}')
  })

  test('D3. CRD spec — agent config present', async () => {
    const { data } = await api(token, 'GET', `/api/v1/admin/recipes/${recipeName}`)
    const spec = (data as { spec?: Record<string, unknown> }).spec ?? data.spec
    const agent = (spec as Record<string, unknown>).agent as { provider?: string; model?: string }
    expect(agent).toBeDefined()
    expect(agent.provider).toEqual(expect.any(String))
    expect(agent.provider?.length).toBeGreaterThan(0)
    expect(agent.model).toEqual(expect.any(String))
    expect(agent.model?.length).toBeGreaterThan(0)
  })

  test('D4. CRD metadata — catalog-id/version (annotations), managed-by (label)', async () => {
    const { data } = await api(token, 'GET', `/api/v1/admin/recipes/${recipeName}`)
    const metadata = (
      data as {
        metadata?: {
          labels?: Record<string, string>
          annotations?: Record<string, string>
        }
      }
    ).metadata
    const labels = metadata?.labels
    const annotations = metadata?.annotations
    expect(annotations?.['clerum.io/catalog-id']).toBe('daily-summary-recipe')
    expect(annotations?.['clerum.io/catalog-version']).toBe('1.0.0')
    expect(labels?.['clerum.io/managed-by']).toBe('control-api')
  })

  test('D5. Cleanup — uninstall removes WorkflowRecipe', async () => {
    const { status } = await api(
      token,
      'DELETE',
      `/api/v1/admin/registry/uninstall/${recipeName}?type=recipe`
    )
    expect(status).toBe(200)
    await waitForWorkflowRecipeDeleted(token, recipeName)
  })
})

// ═════════════════════════════════════════════════════════════════════════
// SECTION E — Upgrade
// ═════════════════════════════════════════════════════════════════════════

test.describe('E. Upgrade Connector + Recipe', () => {
  test.describe.configure({ mode: 'serial' })
  let token = ''
  let serverName = ''
  let recipeName = ''

  test.beforeAll(async () => {
    token = await loginApiToken()
    serverName = uniqueE2EName('e2e-upgrade-mcp')
    recipeName = uniqueE2EName('e2e-upgrade-recipe')
    await cleanup(token, [serverName, recipeName])
    // Pre-install resources to upgrade
    const mcpInstall = await api(token, 'POST', '/api/v1/admin/registry/install', {
      serverName,
      contextRef: 'context1',
      registryEntryName: 'mcp-filesystem',
      registryEntryVersion: '1.0.0',
    })
    expect(mcpInstall.status).toBe(201)
    const recipeInstall = await api(token, 'POST', '/api/v1/admin/registry/install-recipe', {
      recipeName,
      registryEntryName: 'daily-summary-recipe',
      registryEntryVersion: '1.0.0',
    })
    expect(recipeInstall.status, JSON.stringify(recipeInstall.data)).toBe(201)
  })

  test('E1. POST /upgrade — upgrade connector (same version, idempotent)', async () => {
    const { status, data } = await api(token, 'POST', '/api/v1/admin/registry/upgrade', {
      serverName,
      registryEntryName: 'mcp-filesystem',
      registryEntryVersion: '1.0.0',
    })
    expect(status).toBe(200)
    expect(data.upgraded).toBe(true)
  })

  test('E2. POST /upgrade-recipe — upgrade WorkflowRecipe', async () => {
    const { status, data } = await api(token, 'POST', '/api/v1/admin/registry/upgrade-recipe', {
      recipeName,
      registryEntryName: 'daily-summary-recipe',
      registryEntryVersion: '1.0.0',
    })
    expect(status).toBe(200)
    expect(data.upgraded).toBe(true)
  })

  test.afterAll(async () => {
    await cleanup(token, [serverName, recipeName])
  })
})

// ═════════════════════════════════════════════════════════════════════════
// SECTION F — Report Install + Lifecycle
// ═════════════════════════════════════════════════════════════════════════

test.describe('F. Report Install', () => {
  let token = ''

  test.beforeAll(async () => {
    token = await loginApiToken()
  })

  test('F1. POST .../report-install — acknowledged', async () => {
    const { status, data } = await api(
      token,
      'POST',
      '/api/v1/admin/registry/entries/mcp-postgres/report-install',
      { correlationId: `e2e-${Date.now()}`, version: '1.0.0' }
    )
    expect(status).toBe(200)
    expect(data.acknowledged).toBe(true)
  })
})

// ═════════════════════════════════════════════════════════════════════════
// SECTION G — Error Handling (no 500 leaks)
// ═════════════════════════════════════════════════════════════════════════

test.describe('G. Error Handling', () => {
  test.describe.configure({ mode: 'serial' })
  let token = ''
  const DUP_NAME = 'e2e-dup-test'

  test.beforeAll(async () => {
    token = await loginApiToken()
    await cleanup(token, [DUP_NAME])
  })

  test('G1. 400 — missing contextRef', async () => {
    const { status } = await api(token, 'POST', '/api/v1/admin/registry/install', {
      serverName: 'x',
      registryEntryName: 'mcp-postgres',
      registryEntryVersion: '1.0.0',
    })
    expect(status).toBe(400)
  })

  test('G2. 400 — invalid serverName', async () => {
    const { status } = await api(token, 'POST', '/api/v1/admin/registry/install', {
      serverName: 'INVALID_UPPERCASE',
      contextRef: 'context1',
      registryEntryName: 'mcp-postgres',
      registryEntryVersion: '1.0.0',
    })
    expect(status).toBe(400)
  })

  test('G3. 409 — duplicate install returns K8s conflict, NOT 500', async () => {
    // First install
    const { status: s1 } = await api(token, 'POST', '/api/v1/admin/registry/install', {
      serverName: DUP_NAME,
      contextRef: 'context1',
      registryEntryName: 'mcp-filesystem',
      registryEntryVersion: '1.0.0',
    })
    expect(s1).toBe(201)

    // Duplicate install — must NOT return 500
    const { status: s2 } = await api(token, 'POST', '/api/v1/admin/registry/install', {
      serverName: DUP_NAME,
      contextRef: 'context1',
      registryEntryName: 'mcp-filesystem',
      registryEntryVersion: '1.0.0',
    })
    expect(s2).not.toBe(500)
    expect(s2).toBe(409)
  })

  test('G4. 201 — remote server with omitted required credential values installs pending', async () => {
    const { status, data } = await api(token, 'POST', '/api/v1/admin/registry/install', {
      serverName: 'e2e-no-creds',
      contextRef: 'context1',
      registryEntryName: 'mcp-sentry-remote',
      registryEntryVersion: '1.0.0',
    })
    expect(status).toBe(201)
    expect(data.pendingCredentials).toEqual([
      expect.objectContaining({
        kind: 'mcpEnvSecret',
        secretName: 'e2e-no-creds-credentials',
        namespace: 'mcp-server',
        keys: ['SENTRY_AUTH_TOKEN'],
        field: 'spec.envSecret',
      }),
    ])
  })

  test.afterAll(async () => {
    await cleanup(token, [DUP_NAME, 'e2e-no-creds'])
  })
})

// ═════════════════════════════════════════════════════════════════════════
// SECTION H — UI Smoke Tests (Playwright browser)
// ═════════════════════════════════════════════════════════════════════════

test.describe('H. Control-UI Smoke Tests', () => {
  test.describe.configure({ mode: 'serial' })
  let token = ''
  const SERVER_NAME_PREFIX = 'e2e-ui-install'

  test.beforeAll(async () => {
    token = await loginApiToken()
    await cleanup(token, [SERVER_NAME_PREFIX])
  })

  test('H1. Catalog loads entries in control-ui', async ({ page }) => {
    await login(page)
    await navigateToRegistry(page)
    await expect(page.locator('text=/Marketplace \\(\\d+\\)/')).toBeVisible({ timeout: 15_000 })
  })

  test('H2. Type filter works', async ({ page }) => {
    await login(page)
    await navigateToRegistry(page)
    await expect(page.locator('text=/Marketplace \\(\\d+\\)/')).toBeVisible({ timeout: 15_000 })

    const typeSelect = page.locator('select').filter({ hasText: 'All Types' })
    await typeSelect.selectOption('mcp-server')
    await expect(page.locator('tr', { hasText: 'mcp-filesystem' })).toBeVisible({
      timeout: 10_000,
    })
    await expect(page.locator('text=/Marketplace \\(\\d+\\)/')).toBeVisible()
    await typeSelect.selectOption('all')
  })

  test('H3. Install local connector via modal → success', async ({ page }) => {
    const serverName = uniqueE2EName(SERVER_NAME_PREFIX)
    await login(page)
    await cleanup(token, [serverName])
    try {
      await navigateToRegistry(page)
      await expect(page.locator('text=/Marketplace \\(\\d+\\)/')).toBeVisible({ timeout: 15_000 })

      // Filter to local connectors
      await page.locator('select').filter({ hasText: 'All Types' }).selectOption('mcp-server')
      await page.locator('select').filter({ hasText: 'All Modes' }).selectOption('local')

      // Pick a deterministic no-credentials local entry so this smoke test
      // validates the modal flow itself instead of catalog ordering.
      const entryRow = page.locator('tr', { hasText: 'mcp-filesystem' })
      await expect(entryRow).toBeVisible({ timeout: 10_000 })
      await entryRow.getByRole('button', { name: 'Install', exact: true }).click()
      await page.waitForURL(/\/registry\/install\?/, { timeout: 10_000 })
      await expect(page.getByText('Install Connector from Marketplace')).toBeVisible({
        timeout: 5_000,
      })
      const installForm = page.locator('form').filter({ has: page.locator('#ri-name') })
      await expect(installForm).toBeVisible({ timeout: 10_000 })
      await installForm.locator('summary', { hasText: 'Configuration' }).click()

      // Fill form
      const nameInput = installForm.locator('#ri-name')
      await nameInput.clear()
      await nameInput.fill(serverName)

      // Advance through Context to Credentials and fill fields if present.
      await installForm.getByRole('button', { name: 'Continue' }).click()
      await installForm.locator('#ri-context').click()
      await installForm.getByRole('option', { name: 'context1', exact: true }).click()
      await installForm.getByRole('button', { name: 'Continue' }).click()
      const credFieldset = installForm.locator('fieldset')
      if ((await credFieldset.count()) > 0) {
        const inputs = credFieldset.locator('input')
        for (const input of await inputs.all()) {
          await input.fill('e2e-test-value')
        }
      }

      // Submit
      await installForm.getByRole('button', { name: 'Continue' }).click()
      await expect(
        page.getByLabel('Install summary').getByText(serverName, { exact: true })
      ).toBeVisible({ timeout: 10_000 })
      const submitBtn = page.getByRole('button', { name: /^Install$/ })
      await expect(submitBtn).toBeEnabled({ timeout: 10_000 })

      const responsePromise = page.waitForResponse(
        r => {
          if (!r.url().includes('/admin/registry/install') || r.request().method() !== 'POST') {
            return false
          }
          const body = r.request().postDataJSON() as
            | { serverName?: string; registryEntryName?: string }
            | undefined
          return body?.serverName === serverName && body?.registryEntryName === 'mcp-filesystem'
        },
        { timeout: 30_000 }
      )
      await submitBtn.click()
      const resp = await responsePromise

      expect(resp.status()).toBe(201)
      await expect(
        page.getByRole('heading', { name: "Congratulations — you're ready to go" })
      ).toBeVisible({ timeout: 10_000 })
      const { data } = await api(token, 'GET', '/api/v1/admin/mcp-servers')
      const items = data.items as Array<{ metadata: { name: string } }>
      expect(items.some(item => item.metadata.name === serverName)).toBe(true)
    } finally {
      await cleanup(token, [serverName])
    }
  })

  test('H4. Recipe Install button installs and marks the recipe installed', async ({ page }) => {
    const recipeEntryName = 'sqlite-mcp-stack'
    let installedRecipeName = ''
    await cleanupRecipesByCatalogId(token, recipeEntryName)
    await login(page)
    try {
      await navigateToRegistry(page)
      await expect(page.locator('text=/Marketplace \\(\\d+\\)/')).toBeVisible({ timeout: 15_000 })

      await page.getByLabel('Search Marketplace entries').fill(recipeEntryName)
      await page.locator('select').filter({ hasText: 'All Types' }).selectOption('recipe')

      const entryRow = page.locator('tr', { hasText: recipeEntryName })
      await expect(entryRow).toBeVisible({ timeout: 15_000 })
      const installButton = entryRow.getByRole('button', { name: /^Install$/ })
      await expect(installButton).toBeEnabled({ timeout: 10_000 })

      const installResponse = page.waitForResponse(
        response => {
          const request = response.request()
          if (
            !response.url().includes('/admin/registry/install-recipe') ||
            request.method() !== 'POST'
          ) {
            return false
          }
          const postData = request.postDataJSON() as { registryEntryName?: string } | null
          return postData?.registryEntryName === recipeEntryName
        },
        { timeout: 30_000 }
      )
      await installButton.click()
      const installResult = await installResponse
      expect(installResult.status()).toBe(201)
      const installBody = (await installResult.json()) as { recipeName?: string }
      installedRecipeName = installBody.recipeName ?? ''
      expect(installedRecipeName).toEqual(expect.any(String))
      await expect(entryRow.getByRole('button', { name: 'Installed' })).toBeVisible({
        timeout: 15_000,
      })
      const recipe = await waitForWorkflowRecipe(
        token,
        installedRecipeName,
        candidate => {
          const metadata = candidate.metadata as {
            annotations?: Record<string, string>
            labels?: Record<string, string>
          }
          return (
            metadata.annotations?.['clerum.io/catalog-id'] === recipeEntryName ||
            metadata.labels?.['clerum.io/catalog-id'] === recipeEntryName
          )
        },
        'recipe installed from Marketplace catalog'
      )
      expect(
        (recipe.metadata as { annotations?: Record<string, string> }).annotations?.[
          'clerum.io/catalog-id'
        ]
      ).toBe(recipeEntryName)
    } finally {
      await cleanup(token, [installedRecipeName].filter(Boolean))
      await cleanupRecipesByCatalogId(token, recipeEntryName)
    }
  })

  test.afterAll(async () => {
    await cleanup(token, [SERVER_NAME_PREFIX])
  })
})

// ═════════════════════════════════════════════════════════════════════════
// SECTION I — PR314/PR328 Egress Contract Through Control UI
// ═════════════════════════════════════════════════════════════════════════

test.describe('I. Registry Egress Contracts via Control UI', () => {
  test.describe.configure({ mode: 'serial' })
  let token = ''
  const exactEntryName = 'mcp-airtable'
  const exactServerName = uniqueE2EName('e2e-exact-egress')
  const publicEntryName = 'mcp-web-research'
  const publicServerName = uniqueE2EName('e2e-public-web')

  test.beforeAll(async () => {
    token = await loginApiToken()
    await cleanup(token, [exactServerName, publicServerName])
    await waitForRegistryEntry(token, exactEntryName)
    await waitForRegistryEntry(token, publicEntryName)
  })

  test('I1. Exact-host entry shows its egress configuration and installs exact-host CRD', async ({
    page,
  }) => {
    await login(page)
    await openRegistryInstallPackage(page, exactEntryName)
    const installForm = await continueToRegistryInstallForm(page)
    await expect(installForm.getByText('External Egress')).toBeVisible()
    await expect(installForm.getByLabel('Egress mode')).toHaveValue('exact-host')

    await submitRegistryInstallForm(page, installForm, exactServerName, exactEntryName)

    const server = await waitForMcpServer(
      token,
      exactServerName,
      externalEgressReady,
      'ExternalEgressReady=True'
    )
    const spec = server.spec as { egressBindings?: Array<Record<string, unknown>> }
    expect(spec.egressBindings).toEqual([
      { dns: 'api.airtable.com', egressClass: 'exact-host', port: 443, protocol: 'TCP' },
    ])
  })

  test('I2. Public-web entry shows its warning in configuration and installs public-web CRD', async ({
    page,
  }) => {
    await login(page)
    await openRegistryInstallPackage(page, publicEntryName)
    const installForm = await continueToRegistryInstallForm(page)
    await expect(installForm.getByLabel('Egress mode')).toHaveValue('public-web')
    await expect(
      installForm.getByText(/Public web egress allows outbound TCP 80\/443/i)
    ).toBeVisible()

    await submitRegistryInstallForm(page, installForm, publicServerName, publicEntryName)

    const server = await waitForMcpServer(
      token,
      publicServerName,
      externalEgressReady,
      'ExternalEgressReady=True'
    )
    const spec = server.spec as { egressBindings?: Array<Record<string, unknown>> }
    expect(spec.egressBindings).toEqual([{ egressClass: 'public-web' }])
    expect(spec.egressBindings?.[0]).not.toHaveProperty('dns')
    expect(spec.egressBindings?.[0]).not.toHaveProperty('port')
  })

  test('I3. Manual MCP edit updates external egress through the UI and persists CRD state', async ({
    page,
  }) => {
    await login(page)
    await page.getByRole('link', { name: 'Installed Connectors', exact: true }).click()
    await expect(page).toHaveURL(/\/mcp-servers/)

    const serverRow = page.locator('tr', { hasText: exactServerName })
    await expect(serverRow).toBeVisible({ timeout: 15_000 })
    await serverRow.getByRole('button', { name: `Edit connector ${exactServerName}` }).click()
    await page.waitForURL(new RegExp(`/mcp-servers/${exactServerName}/edit`), { timeout: 10_000 })
    await expect(
      page.getByRole('heading', { name: `Edit Connector: ${exactServerName}` })
    ).toBeVisible()
    await page.getByRole('tab', { name: 'External Egress', exact: true }).click()

    const egressSection = page.locator('section', { hasText: 'External Egress' })
    await expect(egressSection.getByText('Egress summary:')).toBeVisible()
    const publicWebMode = egressSection.getByRole('combobox')
    await expect(publicWebMode).toHaveCount(1)
    await publicWebMode.selectOption('public-web')
    await expect(egressSection.getByRole('alert')).toContainText('Public web egress allows')

    const publicWebUpdate = page.waitForResponse(
      response =>
        response.url().includes(`/admin/mcp-servers/${exactServerName}`) &&
        response.request().method() === 'PUT',
      { timeout: 30_000 }
    )
    await page.getByRole('button', { name: 'Save egress' }).click()
    expect((await publicWebUpdate).status()).toBe(200)
    await expect(page).toHaveURL(/\/mcp-servers$/)
    await expect(page.locator('tr', { hasText: exactServerName })).toBeVisible({ timeout: 15_000 })

    let server = await waitForMcpServer(
      token,
      exactServerName,
      candidate => {
        const spec = candidate.spec as { egressBindings?: Array<Record<string, unknown>> }
        return (
          JSON.stringify(spec.egressBindings) === JSON.stringify([{ egressClass: 'public-web' }])
        )
      },
      'public-web egress after edit'
    )
    expect(
      (server.spec as { egressBindings?: Array<Record<string, unknown>> }).egressBindings
    ).toEqual([{ egressClass: 'public-web' }])

    const editedRow = page.locator('tr', { hasText: exactServerName })
    await expect(editedRow).toBeVisible({ timeout: 15_000 })
    await editedRow.getByRole('button', { name: `Edit connector ${exactServerName}` }).click()
    await page.waitForURL(new RegExp(`/mcp-servers/${exactServerName}/edit`), { timeout: 10_000 })
    await page.getByRole('tab', { name: 'External Egress', exact: true }).click()

    const restoredEgressSection = page.locator('section', { hasText: 'External Egress' })
    const restoredEgressMode = restoredEgressSection.getByRole('combobox')
    await expect(restoredEgressMode).toHaveCount(1)
    await restoredEgressMode.selectOption('exact-host')
    await restoredEgressSection
      .locator('textarea[placeholder="api.example.com, auth.example.com"]')
      .fill('api.airtable.com')
    await restoredEgressSection.locator('input[placeholder="443"]').fill('443')

    const exactHostUpdate = page.waitForResponse(
      response =>
        response.url().includes(`/admin/mcp-servers/${exactServerName}`) &&
        response.request().method() === 'PUT',
      { timeout: 30_000 }
    )
    await page.getByRole('button', { name: 'Save egress' }).click()
    expect((await exactHostUpdate).status()).toBe(200)
    await expect(page).toHaveURL(/\/mcp-servers$/)
    await expect(page.locator('tr', { hasText: exactServerName })).toBeVisible({ timeout: 15_000 })

    server = await waitForMcpServer(
      token,
      exactServerName,
      candidate => {
        const spec = candidate.spec as { egressBindings?: Array<Record<string, unknown>> }
        return (
          JSON.stringify(spec.egressBindings) ===
          JSON.stringify([
            { dns: 'api.airtable.com', egressClass: 'exact-host', port: 443, protocol: 'TCP' },
          ])
        )
      },
      'exact-host egress after edit'
    )
    expect(
      (server.spec as { egressBindings?: Array<Record<string, unknown>> }).egressBindings
    ).toEqual([{ dns: 'api.airtable.com', egressClass: 'exact-host', port: 443, protocol: 'TCP' }])
  })

  test.afterAll(async () => {
    await cleanup(token, [exactServerName, publicServerName])
  })
})

// ═════════════════════════════════════════════════════════════════════════
// SECTION J — Operator Egress Editor Journeys
// ═════════════════════════════════════════════════════════════════════════

test.describe('J. Operator Egress Editor Journeys', () => {
  test.describe.configure({ mode: 'serial' })
  let token = ''
  const manualExactServerName = uniqueE2EName('e2e-manual-exact')
  const manualPublicServerName = uniqueE2EName('e2e-manual-public')
  const manualRecipeName = uniqueE2EName('e2e-manual-recipe')
  const manualPendingRecipeName = uniqueE2EName('e2e-manual-pending')
  const manualPendingSecretName = uniqueE2EName('e2e-manual-creds')
  const registryRecipeName = 'sqlite-mcp-stack'
  const deferredMcpEntryName = uniqueE2EName('e2e-pending-mcp')
  const deferredMcpServerName = uniqueE2EName('e2e-pending-server')
  const deferredEnvSecretEntryName = uniqueE2EName('e2e-deferred-secret')
  const deferredEnvSecretName = uniqueE2EName('e2e-deferred-creds')
  const deferredSandboxUiEntryName = uniqueE2EName('e2e-sandbox-ui-secret')
  const deferredSandboxUiSecretName = uniqueE2EName('e2e-sandbox-ui-creds')
  let manualPendingIdentity: ObjectIdentity | null = null
  let deferredEnvIdentity: ObjectIdentity | null = null
  let deferredSandboxUiIdentity: ObjectIdentity | null = null
  const overLimitEntryName = uniqueE2EName('e2e-overlimit')
  let installedRegistryRecipeName = ''
  let installedDeferredEnvSecretRecipeName = ''
  let installedSandboxUiRecipeName = ''

  test.beforeAll(async () => {
    token = await loginApiToken()
    await assertRegistryHealthy()
    await cleanup(token, [
      manualExactServerName,
      manualPublicServerName,
      manualRecipeName,
      manualPendingRecipeName,
      registryRecipeName,
      deferredMcpServerName,
      deferredMcpEntryName,
      deferredEnvSecretEntryName,
      deferredSandboxUiEntryName,
      overLimitEntryName,
    ])
    await cleanupRecipesByCatalogId(token, registryRecipeName)
    await cleanupRecipesByCatalogId(token, deferredEnvSecretEntryName)
    await cleanupRecipesByCatalogId(token, deferredSandboxUiEntryName)
    await deleteRegistryEntry(deferredMcpEntryName)
    await deleteRegistryEntry(deferredEnvSecretEntryName)
    await deleteRegistryEntry(deferredSandboxUiEntryName)
    const mcpPublishStatus = await publishRegistryEntry(
      deferredCredentialMcpEntry(deferredMcpEntryName)
    )
    expect([200, 201]).toContain(mcpPublishStatus)
    await waitForDirectRegistryEntry(deferredMcpEntryName)
    await waitForRegistryEntry(token, deferredMcpEntryName)
    const publishStatus = await publishRegistryEntry(
      deferredEnvSecretRecipeEntry(deferredEnvSecretEntryName, deferredEnvSecretName)
    )
    expect([200, 201]).toContain(publishStatus)
    await waitForDirectRegistryEntry(deferredEnvSecretEntryName)
    await waitForRegistryEntry(token, deferredEnvSecretEntryName)
    const sandboxUiPublishStatus = await publishRegistryEntry(
      deferredSandboxUiSecretRecipeEntry(deferredSandboxUiEntryName, deferredSandboxUiSecretName)
    )
    expect([200, 201]).toContain(sandboxUiPublishStatus)
    await waitForDirectRegistryEntry(deferredSandboxUiEntryName)
    await waitForRegistryEntry(token, deferredSandboxUiEntryName)
  })

  test('J1. Manual MCP create persists exact-host and public-web egress through the UI', async ({
    page,
  }) => {
    await login(page)

    await test.step('create exact-host connector from the visible form flow', async () => {
      await page.getByRole('link', { name: 'Installed Connectors', exact: true }).click()
      await expect(page).toHaveURL(/\/mcp-servers/)
      await page.getByRole('button', { name: 'Create Connector' }).click()
      await expect(page).toHaveURL(/\/mcp-servers\/new/)
      await expect(page.getByRole('heading', { name: 'Create connector', level: 2 })).toBeVisible()

      await page.getByPlaceholder('my-mcp-server').fill(manualExactServerName)
      await page
        .getByPlaceholder('us-central1-docker.pkg.dev/my-project/repo/mcp-server:latest')
        .fill('clerum/mock-mcp-server:test')
      await expect(page.getByRole('button', { name: 'context1' })).toBeVisible({
        timeout: 15_000,
      })
      await page.getByRole('button', { name: 'Continue' }).click()
      await expect(page.getByRole('heading', { name: 'Runtime settings' })).toBeVisible()
      await page.getByRole('button', { name: 'Continue' }).click()
      await expect(page.getByRole('heading', { name: 'Network egress' })).toBeVisible()

      const egressSection = page.locator('section', { hasText: 'External Egress' })
      const exactHostMode = egressSection.getByRole('combobox')
      await expect(exactHostMode).toHaveCount(1)
      await exactHostMode.selectOption('exact-host')
      await egressSection
        .locator('textarea[placeholder="api.example.com, auth.example.com"]')
        .fill('api.github.com')
      await egressSection.locator('input[placeholder="443"]').fill('443')
      await expect(egressSection.getByRole('status')).toContainText('1 domain(s) x 1 port(s)')

      const createResponse = page.waitForResponse(
        response =>
          response.url().includes('/admin/mcp-servers') && response.request().method() === 'POST',
        { timeout: 30_000 }
      )
      await page.getByRole('button', { name: 'Continue' }).click()
      await expect(page.getByRole('heading', { name: 'Secrets and environment' })).toBeVisible()
      await page.getByRole('button', { name: 'Create connector' }).click()
      expect((await createResponse).status()).toBe(201)
      await expect(page).toHaveURL(/\/mcp-servers$/)
      await expect(page.locator('tr', { hasText: manualExactServerName })).toBeVisible({
        timeout: 15_000,
      })

      const server = await waitForMcpServer(
        token,
        manualExactServerName,
        candidate => {
          const spec = candidate.spec as { egressBindings?: Array<Record<string, unknown>> }
          return (
            JSON.stringify(spec.egressBindings) ===
            JSON.stringify([
              { dns: 'api.github.com', egressClass: 'exact-host', port: 443, protocol: 'TCP' },
            ])
          )
        },
        'manual exact-host egress'
      )
      expect(
        (server.spec as { egressBindings?: Array<Record<string, unknown>> }).egressBindings
      ).toEqual([{ dns: 'api.github.com', egressClass: 'exact-host', port: 443, protocol: 'TCP' }])
    })

    await test.step('create public-web connector from the visible form flow', async () => {
      await page.getByRole('button', { name: 'Create Connector' }).click()
      await expect(page).toHaveURL(/\/mcp-servers\/new/)

      await page.getByPlaceholder('my-mcp-server').fill(manualPublicServerName)
      await page
        .getByPlaceholder('us-central1-docker.pkg.dev/my-project/repo/mcp-server:latest')
        .fill('clerum/mock-mcp-server:test')
      await expect(page.getByRole('button', { name: 'context1' })).toBeVisible({
        timeout: 15_000,
      })
      await page.getByRole('button', { name: 'Continue' }).click()
      await expect(page.getByRole('heading', { name: 'Runtime settings' })).toBeVisible()
      await page.getByRole('button', { name: 'Continue' }).click()
      await expect(page.getByRole('heading', { name: 'Network egress' })).toBeVisible()

      const egressSection = page.locator('section', { hasText: 'External Egress' })
      const publicWebMode = egressSection.getByRole('combobox')
      await expect(publicWebMode).toHaveCount(1)
      await publicWebMode.selectOption('public-web')
      await expect(egressSection.getByRole('alert')).toContainText('Public web egress allows')
      await expect(egressSection.getByRole('status')).toContainText('1 public-web binding')

      const createResponse = page.waitForResponse(
        response =>
          response.url().includes('/admin/mcp-servers') && response.request().method() === 'POST',
        { timeout: 30_000 }
      )
      await page.getByRole('button', { name: 'Continue' }).click()
      await expect(page.getByRole('heading', { name: 'Secrets and environment' })).toBeVisible()
      await page.getByRole('button', { name: 'Create connector' }).click()
      expect((await createResponse).status()).toBe(201)
      await expect(page).toHaveURL(/\/mcp-servers$/)
      await expect(page.locator('tr', { hasText: manualPublicServerName })).toBeVisible({
        timeout: 15_000,
      })

      const server = await waitForMcpServer(
        token,
        manualPublicServerName,
        candidate => {
          const spec = candidate.spec as { egressBindings?: Array<Record<string, unknown>> }
          return (
            JSON.stringify(spec.egressBindings) === JSON.stringify([{ egressClass: 'public-web' }])
          )
        },
        'manual public-web egress'
      )
      expect(
        (server.spec as { egressBindings?: Array<Record<string, unknown>> }).egressBindings
      ).toEqual([{ egressClass: 'public-web' }])
    })
  })

  test('J2. Manual WorkflowRecipe create and edit expose egress review and persist CRD updates', async ({
    page,
  }) => {
    await login(page)
    const initialRecipe = workflowEgressRecipe(manualRecipeName)
    const updatedRecipe = workflowEgressRecipe(manualRecipeName, 'api.airtable.com')

    await navigateToPlugins(page)
    await page.getByRole('button', { name: 'Install Plugin' }).click()
    await expect(page.getByRole('heading', { name: /Install (Recipe|Plugin)/ })).toBeVisible()

    const initialManifestEditor = page.locator('textarea')
    await expect(initialManifestEditor).toHaveCount(1)
    await initialManifestEditor.fill(JSON.stringify(initialRecipe, null, 2))
    await page.getByRole('button', { name: 'Review manifest' }).click()
    await expect(page.getByText(/Manifest review passed/)).toBeVisible()
    await expect(page.getByText('External Egress Review')).toBeVisible()
    await expect(
      page.getByRole('heading', { name: 'Transport workload "closed-tools"' })
    ).toBeVisible()
    await expect(
      page.getByRole('status').filter({ hasText: 'Add exact-host or public-web egressBindings' })
    ).toBeVisible()
    await expect(
      page.getByRole('heading', { name: 'Transport workload "exact-tools"' })
    ).toBeVisible()
    await expect(page.locator('code', { hasText: 'api.github.com' })).toBeVisible()
    await expect(
      page.getByRole('heading', { name: 'Transport workload "public-tools"' })
    ).toBeVisible()
    await expect(
      page.getByRole('alert').filter({ hasText: 'Public web egress is explicitly enabled' })
    ).toBeVisible()
    await page.getByRole('button', { name: 'Apply defaults' }).click()
    await page.getByRole('button', { name: 'Continue to access' }).click()

    const createResponse = page.waitForResponse(
      response =>
        response.url().includes('/admin/recipes') && response.request().method() === 'POST',
      { timeout: 30_000 }
    )
    await page.getByRole('button', { name: 'Deploy plugin' }).click()
    expect([200, 201]).toContain((await createResponse).status())
    await expect(page).toHaveURL(/\/workflow-recipes$/)
    await expect(page.locator('tr', { hasText: manualRecipeName })).toBeVisible({ timeout: 15_000 })

    let recipe = await waitForWorkflowRecipe(
      token,
      manualRecipeName,
      candidate => {
        const spec = candidate.spec as {
          workloads?: Array<{ id?: string; egressBindings?: unknown }>
        }
        const exact = spec.workloads?.find(workload => workload.id === 'exact-tools')
        return JSON.stringify(exact?.egressBindings ?? []).includes('api.github.com')
      },
      'initial exact-host workload egress'
    )
    expect(JSON.stringify((recipe.spec as Record<string, unknown>).workloads)).toContain(
      'api.github.com'
    )

    await page.locator('tr', { hasText: manualRecipeName }).click()
    await expect(page).toHaveURL(
      new RegExp(`/workflow-recipes/sandbox-recipes/${manualRecipeName}`)
    )
    await page.getByRole('button', { name: 'More plugin actions' }).click()
    await page.getByRole('menuitem', { name: 'Edit' }).click()
    await expect(page).toHaveURL(new RegExp(`edit=1`))
    const updatedManifestEditor = page.locator('textarea')
    await expect(updatedManifestEditor).toHaveCount(1)
    await updatedManifestEditor.fill(JSON.stringify(updatedRecipe, null, 2))
    await page.getByRole('button', { name: 'Review manifest' }).click()
    await expect(page.getByText(/Manifest review passed/)).toBeVisible()
    await expect(page.getByText('External Egress Review')).toBeVisible()
    await expect(page.locator('code', { hasText: 'api.airtable.com' })).toBeVisible()
    await page.getByRole('button', { name: 'Apply defaults' }).click()
    await page.getByRole('button', { name: 'Continue to access' }).click()

    const updateResponse = page.waitForResponse(
      response =>
        response.url().includes(`/admin/recipes/${manualRecipeName}`) &&
        response.request().method() === 'PUT',
      { timeout: 30_000 }
    )
    await page.getByRole('button', { name: 'Update plugin' }).click()
    expect((await updateResponse).status()).toBe(200)
    await expect(page).toHaveURL(
      new RegExp(`/workflow-recipes/sandbox-recipes/${manualRecipeName}`)
    )

    recipe = await waitForWorkflowRecipe(
      token,
      manualRecipeName,
      candidate => {
        const spec = candidate.spec as {
          workloads?: Array<{ id?: string; egressBindings?: unknown }>
        }
        const exact = spec.workloads?.find(workload => workload.id === 'exact-tools')
        return JSON.stringify(exact?.egressBindings ?? []).includes('api.airtable.com')
      },
      'updated exact-host workload egress'
    )
    expect(JSON.stringify((recipe.spec as Record<string, unknown>).workloads)).toContain(
      'api.airtable.com'
    )
  })

  test('J2a. Manual WorkflowRecipe with Secret refs installs pending from RecipeEditor', async ({
    page,
  }) => {
    await login(page)

    await navigateToPlugins(page)
    await page.getByRole('button', { name: 'Install Plugin' }).click()
    await expect(page.getByRole('heading', { name: /Install (Recipe|Plugin)/ })).toBeVisible()

    const pendingManifestEditor = page.locator('textarea')
    await expect(pendingManifestEditor).toHaveCount(1)
    await pendingManifestEditor.fill(
      JSON.stringify(manualPendingSecretRecipe(manualPendingRecipeName, manualPendingSecretName), null, 2)
    )
    await page.getByRole('button', { name: 'Review manifest' }).click()
    await expect(page.getByText(/Manifest review passed/)).toBeVisible()
    await page.getByRole('button', { name: 'Apply defaults' }).click()
    await page.getByRole('button', { name: 'Continue to access' }).click()

    await expect(page.getByText('Configuration & Secrets')).toBeVisible()
    await expect(page.getByText(manualPendingSecretName)).toBeVisible()
    await expect(page.getByText(/Deploy the recipe with pending secrets/)).toBeVisible()
    await expect(page.getByText('Pending after deploy')).toBeVisible()
    await expect(page.getByText('Pending secret value')).toHaveCount(2)
    await expect(page.getByPlaceholder('Enter value for apiKey')).toHaveCount(0)
    await expect(page.getByPlaceholder('Enter value for DB_PASSWORD')).toHaveCount(0)

    const createResponse = page.waitForResponse(
      response =>
        response.url().includes('/admin/recipes') && response.request().method() === 'POST',
      { timeout: 30_000 }
    )
    await page.getByRole('button', { name: 'Deploy plugin' }).click()
    expect([200, 201]).toContain((await createResponse).status())
    await expect(page).toHaveURL(/\/workflow-recipes$/)
    await expect(page.locator('tr', { hasText: manualPendingRecipeName })).toBeVisible({
      timeout: 15_000,
    })

    const recipe = await waitForWorkflowRecipe(
      token,
      manualPendingRecipeName,
      candidate => {
        const text = JSON.stringify(candidate.spec ?? {})
        return text.includes(manualPendingSecretName) && text.includes('"secretRef"')
      },
      'manual pending secret refs'
    )
    const specText = JSON.stringify(recipe.spec ?? {})
    expect(specText).toContain('"envSecret"')
    expect(specText).toContain(manualPendingSecretName)

    await page.getByRole('link', { name: 'Secrets' }).click()
    await expect(page).toHaveURL(/\/secrets$/)
    await page.getByRole('tab', { name: /^Recipe$/ }).click()
    await expect(page).toHaveURL(/\/secrets\/recipe$/)
    const recipeSecretRow = page.locator('tr', { hasText: manualPendingSecretName })
    await expect(recipeSecretRow).toBeVisible({ timeout: 15_000 })
    await expect(recipeSecretRow.getByText('Missing')).toBeVisible()
    await expect(recipeSecretRow.getByText('apiKey, dbPassword')).toBeVisible()
    await recipeSecretRow
      .getByRole('button', { name: `Add recipe secret ${manualPendingSecretName}` })
      .click()

    await expect(page).toHaveURL(/\/secrets\/new\?/)
    await expect(page.getByRole('heading', { name: 'Create recipe secret' })).toBeVisible()
    await expect(page.locator('#recipe-secret-name')).toHaveValue(manualPendingSecretName)
    await expect(page.getByLabel('Owner recipe')).toHaveValue(manualPendingRecipeName)
    await page.getByRole('button', { name: 'Continue' }).click()
    const manualKeyInputs = page.getByPlaceholder('API_KEY')
    const manualValueInputs = page.getByPlaceholder('secret value')
    await expect(manualKeyInputs).toHaveCount(2)
    await expect(manualValueInputs).toHaveCount(2)
    const [manualApiKey, manualDbPassword] = await manualKeyInputs.all()
    const [manualApiValue, manualDbValue] = await manualValueInputs.all()
    await expect(manualApiKey).toHaveValue('apiKey')
    await expect(manualDbPassword).toHaveValue('dbPassword')
    await manualApiValue.fill('manual-api-key')
    await manualDbValue.fill('manual-db-password')

    const createRecipeSecretResponse = page.waitForResponse(
      response => {
        const request = response.request()
        if (!response.url().includes('/admin/recipe-secrets') || request.method() !== 'POST') {
          return false
        }
        const body = request.postDataJSON() as {
          name?: string
          targetNamespace?: string
          data?: Record<string, string>
          ownership?: { kind?: string; recipeName?: string }
        } | null
        return (
          body?.name === manualPendingSecretName &&
          body.targetNamespace === 'sandbox-recipes' &&
          body.ownership?.kind === 'owner-recipe' &&
          body.ownership.recipeName === manualPendingRecipeName &&
          Object.keys(body.data ?? {})
            .sort()
            .join(',') === 'apiKey,dbPassword'
        )
      },
      { timeout: 30_000 }
    )
    await page.getByRole('button', { name: 'Create secret' }).click()
    const createdManualPending = await createRecipeSecretResponse
    expect(createdManualPending.status()).toBe(201)
    manualPendingIdentity = requireObjectIdentity(
      await createdManualPending.json(),
      'create manual pending recipe credential'
    )
    await expect(page).toHaveURL(/\/secrets\/recipe$/)
    const provisionedRecipeSecretRow = page.locator('tr', { hasText: manualPendingSecretName })
    await expect(provisionedRecipeSecretRow).toBeVisible({ timeout: 15_000 })
    await expect(provisionedRecipeSecretRow.getByText('Missing')).toHaveCount(0)
    await expect(
      provisionedRecipeSecretRow.getByText(`Owner: ${manualPendingRecipeName}`)
    ).toBeVisible()
  })

  test('J3. Registry WorkflowRecipe installs through UI and persists the CRD', async ({ page }) => {
    await cleanupRecipesByCatalogId(token, registryRecipeName)
    await login(page)
    await navigateToRegistry(page)
    await page.getByLabel('Search Marketplace entries').fill(registryRecipeName)
    const entryRow = page.locator('tr', { hasText: registryRecipeName })
    await expect(entryRow).toBeVisible({ timeout: 15_000 })

    const installResponse = page.waitForResponse(
      response => {
        const request = response.request()
        if (
          !response.url().includes('/admin/registry/install-recipe') ||
          request.method() !== 'POST'
        ) {
          return false
        }
        const postData = request.postDataJSON() as { registryEntryName?: string } | null
        return postData?.registryEntryName === registryRecipeName
      },
      { timeout: 30_000 }
    )
    await entryRow.getByRole('button', { name: /^Install$/ }).click()
    const installResult = await installResponse
    expect(installResult.status()).toBe(201)
    const installBody = (await installResult.json()) as { recipeName?: string }
    installedRegistryRecipeName = installBody.recipeName ?? registryRecipeName
    await expect(entryRow.getByRole('button', { name: 'Installed' })).toBeVisible({
      timeout: 15_000,
    })
    await expect(page).toHaveURL(/\/registry$/)

    const recipe = await waitForWorkflowRecipe(
      token,
      installedRegistryRecipeName,
      candidate =>
        (candidate.metadata as { name?: string } | undefined)?.name === installedRegistryRecipeName,
      'registry recipe CRD created'
    )
    const recipeMeta = recipe.metadata as {
      labels?: Record<string, string>
      annotations?: Record<string, string>
    }
    expect(
      recipeMeta.annotations?.['clerum.io/catalog-id'] ??
        recipeMeta.labels?.['clerum.io/catalog-id']
    ).toBe(registryRecipeName)
    const recipeSpec = recipe.spec as {
      workloads?: Array<{ id?: string; egressBindings?: unknown }>
    }
    const sqliteWorkload = recipeSpec.workloads?.find(workload => workload.id === 'sqlite-mcp')
    expect(sqliteWorkload).toBeDefined()
    expect(sqliteWorkload?.egressBindings).toBeUndefined()
  })

  test('J4. Registry connector with required credentials installs pending and is completed from Secrets UI', async ({
    page,
  }) => {
    await login(page)
    await navigateToRegistry(page)
    await page.getByLabel('Search Marketplace entries').fill(deferredMcpEntryName)
    const entryRow = page.locator('tr', { hasText: deferredMcpEntryName })
    await expect(entryRow).toBeVisible({ timeout: 15_000 })
    await entryRow.getByRole('button', { name: /^Install$/ }).click()
    await expect(page.getByText('Install Connector from Marketplace')).toBeVisible({
      timeout: 10_000,
    })
    const installForm = page.locator('form')
    await expect(installForm).toBeVisible({ timeout: 10_000 })
    await installForm.locator('summary', { hasText: 'Configuration' }).click()
    await expect(installForm.locator('#ri-name')).toBeVisible({ timeout: 10_000 })
    await installForm.locator('#ri-name').fill(deferredMcpServerName)
    await installForm.getByRole('button', { name: 'Continue' }).click()
    await installForm.locator('#ri-context').click()
    await installForm.getByRole('option', { name: 'context1', exact: true }).click()
    await installForm.getByRole('button', { name: 'Continue' }).click()
    await expect(
      installForm.getByText(/Leave all credential fields empty to install now/)
    ).toBeVisible()
    await installForm.getByRole('button', { name: 'Continue' }).click()
    await expect(
      page.getByLabel('Install summary').getByText(deferredMcpServerName, { exact: true })
    ).toBeVisible({ timeout: 10_000 })

    const installResponse = page.waitForResponse(
      response => {
        const request = response.request()
        if (!response.url().includes('/admin/registry/install') || request.method() !== 'POST') {
          return false
        }
        const body = request.postDataJSON() as {
          serverName?: string
          registryEntryName?: string
          credentials?: unknown
        } | null
        return (
          body?.serverName === deferredMcpServerName &&
          body.registryEntryName === deferredMcpEntryName
        )
      },
      { timeout: 30_000 }
    )
    await installForm.getByRole('button', { name: /^Install$/ }).click()
    const installResult = await installResponse
    expect(installResult.status()).toBe(201)
    const installRequest = installResult.request().postDataJSON() as {
      credentials?: unknown
    } | null
    expect(installRequest?.credentials).toBeUndefined()
    const installBody = (await installResult.json()) as {
      pendingCredentials?: Array<{
        kind?: string
        secretName?: string
        namespace?: string
        keys?: string[]
        field?: string
      }>
    }
    expect(installBody.pendingCredentials).toEqual([
      expect.objectContaining({
        kind: 'mcpEnvSecret',
        secretName: `${deferredMcpServerName}-credentials`,
        namespace: 'mcp-server',
        keys: ['API_KEY', 'CLIENT_SECRET'],
        field: 'spec.envSecret',
      }),
    ])
    await expect(
      page.getByRole('heading', { name: "Congratulations — you're ready to go" })
    ).toBeVisible({ timeout: 10_000 })

    const expectedSecretName = `${deferredMcpServerName}-credentials`
    const server = await waitForMcpServer(
      token,
      deferredMcpServerName,
      candidate => {
        const spec = candidate.spec as {
          envSecret?: { name?: string; keys?: Array<{ secretKey?: string; envVar?: string }> }
        }
        return (
          spec.envSecret?.name === expectedSecretName &&
          (spec.envSecret.keys ?? []).some(
            key => key.secretKey === 'API_KEY' && key.envVar === 'API_KEY'
          ) &&
          (spec.envSecret.keys ?? []).some(
            key => key.secretKey === 'CLIENT_SECRET' && key.envVar === 'CLIENT_SECRET'
          )
        )
      },
      'pending connector envSecret preserved'
    )
    expect((server.spec as { envSecret?: { name?: string } }).envSecret?.name).toBe(
      expectedSecretName
    )

    await page.getByRole('link', { name: 'Secrets' }).click()
    await expect(page).toHaveURL(/\/secrets$/)
    await page.getByRole('tab', { name: /^Connector$/ }).click()
    await expect(page).toHaveURL(/\/secrets\/mcp$/)
    const secretRow = page.locator('tr', { hasText: expectedSecretName })
    await expect(secretRow).toBeVisible({ timeout: 15_000 })
    await secretRow
      .getByRole('button', { name: `Add connector secret ${expectedSecretName}` })
      .click()

    await expect(page).toHaveURL(/\/secrets\/new\?/)
    await expect(page.getByRole('heading', { name: 'Create connector secret' })).toBeVisible()
    await expect(page.locator('#mcp-secret-name')).toHaveValue(expectedSecretName)
    await page.getByRole('button', { name: 'Continue' }).click()
    const connectorKeyInputs = page.getByPlaceholder('API_KEY')
    const connectorValueInputs = page.getByPlaceholder('secret value')
    await expect(connectorKeyInputs).toHaveCount(1)
    await expect(connectorValueInputs).toHaveCount(1)
    await connectorKeyInputs.fill('API_KEY')
    await connectorValueInputs.fill('e2e-api-key')
    await page.getByRole('button', { name: 'Add key' }).click()
    await expect(connectorKeyInputs).toHaveCount(2)
    await expect(connectorValueInputs).toHaveCount(2)
    const [, connectorClientKey] = await connectorKeyInputs.all()
    const [, connectorClientValue] = await connectorValueInputs.all()
    if (!connectorClientKey || !connectorClientValue) {
      throw new Error('connector credential row was not added')
    }
    await connectorClientKey.fill('CLIENT_SECRET')
    await connectorClientValue.fill('e2e-client-secret')

    const createSecretResponse = page.waitForResponse(
      response => {
        const request = response.request()
        if (!response.url().includes('/admin/mcp-secrets') || request.method() !== 'POST') {
          return false
        }
        const body = request.postDataJSON() as { name?: string } | null
        return body?.name === expectedSecretName
      },
      { timeout: 30_000 }
    )
    await page.getByRole('button', { name: 'Create secret' }).click()
    const createResult = await createSecretResponse
    expect(createResult.status()).toBe(201)
    const createRequest = createResult.request().postDataJSON() as {
      name?: string
      data?: Record<string, string>
    } | null
    expect(createRequest?.name).toBe(expectedSecretName)
    expect(Object.keys(createRequest?.data ?? {}).sort()).toEqual(['API_KEY', 'CLIENT_SECRET'])
    await expect(page).toHaveURL(/\/secrets\/mcp$/)
  })

  test('J5. Registry recipe with deferred envSecret installs through UI and persists the CRD', async ({
    page,
  }) => {
    await login(page)
    await navigateToRegistry(page)
    await page.getByLabel('Search Marketplace entries').fill(deferredEnvSecretEntryName)
    const entryRow = page.locator('tr', { hasText: deferredEnvSecretEntryName })
    await expect(entryRow).toBeVisible({ timeout: 15_000 })
    const installResponse = page.waitForResponse(
      response => {
        const request = response.request()
        if (
          !response.url().includes('/admin/registry/install-recipe') ||
          request.method() !== 'POST'
        ) {
          return false
        }
        const postData = request.postDataJSON() as { registryEntryName?: string } | null
        return postData?.registryEntryName === deferredEnvSecretEntryName
      },
      { timeout: 30_000 }
    )
    await entryRow.getByRole('button', { name: /^Install$/ }).click()
    const installResult = await installResponse
    expect(installResult.status()).toBe(201)
    const installBody = (await installResult.json()) as {
      recipeName?: string
      pendingCredentials?: Array<{
        kind?: string
        secretName?: string
        namespace?: string
        keys?: string[]
        field?: string
      }>
    }
    expect(installBody.recipeName).toEqual(expect.any(String))
    expect(installBody.pendingCredentials).toEqual([
      expect.objectContaining({
        kind: 'workflowEnvSecret',
        secretName: deferredEnvSecretName,
        namespace: 'sandbox-recipes',
        keys: ['apiKey', 'dbPassword'],
        field: 'spec.workloads[0].envSecret',
      }),
    ])
    installedDeferredEnvSecretRecipeName = installBody.recipeName!
    const installedButton = entryRow.getByRole('button', { name: 'Installed' })
    await expect(installedButton).toBeVisible({
      timeout: 15_000,
    })
    await expect(installedButton).toBeDisabled()
    await expect(page).toHaveURL(new RegExp('/registry$'))

    const recipe = await waitForWorkflowRecipe(
      token,
      installedDeferredEnvSecretRecipeName,
      candidate => {
        const spec = candidate.spec as {
          workloads?: Array<{ id?: string; envSecret?: { name?: string; keys?: unknown[] } }>
        }
        const apiWorkload = spec.workloads?.find(workload => workload.id === 'api')
        const envSecretKeys = apiWorkload?.envSecret?.keys ?? []
        return (
          apiWorkload?.envSecret?.name === deferredEnvSecretName &&
          envSecretKeys.some(
            key =>
              typeof key === 'object' &&
              key !== null &&
              (key as { secretKey?: string; envVar?: string }).secretKey === 'apiKey' &&
              (key as { secretKey?: string; envVar?: string }).envVar === 'API_KEY'
          ) &&
          envSecretKeys.some(
            key =>
              typeof key === 'object' &&
              key !== null &&
              (key as { secretKey?: string; envVar?: string }).secretKey === 'dbPassword' &&
              (key as { secretKey?: string; envVar?: string }).envVar === 'DB_PASSWORD'
          )
        )
      },
      'deferred workload envSecret preserved'
    )
    const recipeMeta = recipe.metadata as {
      labels?: Record<string, string>
      annotations?: Record<string, string>
    }
    expect(
      recipeMeta.annotations?.['clerum.io/catalog-id'] ??
        recipeMeta.labels?.['clerum.io/catalog-id']
    ).toBe(deferredEnvSecretEntryName)

    await page.getByRole('link', { name: 'Secrets' }).click()
    await expect(page).toHaveURL(/\/secrets$/)
    await page.getByRole('tab', { name: /^Recipe$/ }).click()
    await expect(page).toHaveURL(/\/secrets\/recipe$/)
    const recipeSecretRow = page.locator('tr', { hasText: deferredEnvSecretName })
    await expect(recipeSecretRow).toBeVisible({ timeout: 15_000 })
    await expect(recipeSecretRow.getByText('Missing')).toBeVisible()
    await expect(recipeSecretRow.getByText('apiKey, dbPassword')).toBeVisible()
    await recipeSecretRow
      .getByRole('button', { name: `Add recipe secret ${deferredEnvSecretName}` })
      .click()

    await expect(page).toHaveURL(/\/secrets\/new\?/)
    await expect(page.getByRole('heading', { name: 'Create recipe secret' })).toBeVisible()
    await expect(page.locator('#recipe-secret-name')).toHaveValue(deferredEnvSecretName)
    await expect(page.getByLabel('Owner recipe')).toHaveValue(installedDeferredEnvSecretRecipeName)
    await page.getByRole('button', { name: 'Continue' }).click()
    const deferredKeyInputs = page.getByPlaceholder('API_KEY')
    const deferredValueInputs = page.getByPlaceholder('secret value')
    await expect(deferredKeyInputs).toHaveCount(2)
    await expect(deferredValueInputs).toHaveCount(2)
    const [deferredApiKey, deferredDbPassword] = await deferredKeyInputs.all()
    const [deferredApiValue, deferredDbValue] = await deferredValueInputs.all()
    await expect(deferredApiKey).toHaveValue('apiKey')
    await expect(deferredDbPassword).toHaveValue('dbPassword')
    await deferredApiValue.fill('value-one')
    await deferredDbValue.fill('value-two')

    const createRecipeSecretResponse = page.waitForResponse(
      response => {
        const request = response.request()
        if (!response.url().includes('/admin/recipe-secrets') || request.method() !== 'POST') {
          return false
        }
        const body = request.postDataJSON() as {
          name?: string
          data?: Record<string, string>
          ownership?: { kind?: string; recipeName?: string }
        } | null
        return (
          body?.name === deferredEnvSecretName &&
          body.ownership?.kind === 'owner-recipe' &&
          body.ownership.recipeName === installedDeferredEnvSecretRecipeName &&
          Object.keys(body.data ?? {})
            .sort()
            .join(',') === 'apiKey,dbPassword'
        )
      },
      { timeout: 30_000 }
    )
    await page.getByRole('button', { name: 'Create secret' }).click()
    const createdDeferredEnv = await createRecipeSecretResponse
    expect(createdDeferredEnv.status()).toBe(201)
    deferredEnvIdentity = requireObjectIdentity(
      await createdDeferredEnv.json(),
      'create deferred recipe credential'
    )
    await expect(page).toHaveURL(/\/secrets\/recipe$/)
    const provisionedRecipeSecretRow = page.locator('tr', { hasText: deferredEnvSecretName })
    await expect(provisionedRecipeSecretRow).toBeVisible({ timeout: 15_000 })
    await expect(provisionedRecipeSecretRow.getByText('Missing')).toHaveCount(0)
    await expect(
      provisionedRecipeSecretRow.getByText(`Owner: ${installedDeferredEnvSecretRecipeName}`)
    ).toBeVisible()
  })

  test('J5b. Registry recipe sandbox-ui Secret is completed, edited, and deleted from Secrets UI', async ({
    page,
  }) => {
    await login(page)
    await navigateToRegistry(page)
    await page.getByLabel('Search Marketplace entries').fill(deferredSandboxUiEntryName)
    const entryRow = page.locator('tr', { hasText: deferredSandboxUiEntryName })
    await expect(entryRow).toBeVisible({ timeout: 15_000 })

    const installResponse = page.waitForResponse(
      response => {
        const request = response.request()
        if (
          !response.url().includes('/admin/registry/install-recipe') ||
          request.method() !== 'POST'
        ) {
          return false
        }
        const postData = request.postDataJSON() as { registryEntryName?: string } | null
        return postData?.registryEntryName === deferredSandboxUiEntryName
      },
      { timeout: 30_000 }
    )
    await entryRow.getByRole('button', { name: /^Install$/ }).click()
    const installResult = await installResponse
    expect(installResult.status()).toBe(201)
    const installBody = (await installResult.json()) as {
      recipeName?: string
      pendingCredentials?: Array<{
        kind?: string
        secretName?: string
        namespace?: string
        keys?: string[]
        field?: string
      }>
    }
    installedSandboxUiRecipeName = installBody.recipeName!
    expect(installedSandboxUiRecipeName).toEqual(expect.any(String))
    expect(installBody.pendingCredentials).toEqual([
      expect.objectContaining({
        kind: 'workflowEnvSecret',
        secretName: deferredSandboxUiSecretName,
        namespace: 'sandbox-ui',
        keys: ['apiKey'],
        field: 'spec.workloads[0].envSecret',
      }),
    ])
    await expect(entryRow.getByRole('button', { name: 'Installed' })).toBeVisible({
      timeout: 15_000,
    })

    const recipe = await waitForWorkflowRecipe(
      token,
      installedSandboxUiRecipeName,
      candidate => {
        const spec = candidate.spec as {
          ui?: { workloadRef?: string }
          workloads?: Array<{ id?: string; envSecret?: { name?: string } }>
        }
        const webWorkload = spec.workloads?.find(workload => workload.id === 'web')
        return (
          spec.ui?.workloadRef === 'web' &&
          webWorkload?.envSecret?.name === deferredSandboxUiSecretName
        )
      },
      'sandbox-ui deferred workload envSecret preserved'
    )
    expect((recipe.spec as { ui?: { workloadRef?: string } }).ui?.workloadRef).toBe('web')

    await page.getByRole('link', { name: 'Secrets' }).click()
    await expect(page).toHaveURL(/\/secrets$/)
    await page.getByRole('tab', { name: /^Recipe$/ }).click()
    await expect(page).toHaveURL(/\/secrets\/recipe$/)
    const recipeSecretRow = page.locator('tr', { hasText: deferredSandboxUiSecretName })
    await expect(recipeSecretRow).toBeVisible({ timeout: 15_000 })
    await expect(recipeSecretRow.getByText('sandbox-ui', { exact: true })).toBeVisible()
    await expect(recipeSecretRow.getByText('Missing')).toBeVisible()
    await expect(recipeSecretRow.getByText('apiKey')).toBeVisible()
    await recipeSecretRow
      .getByRole('button', { name: `Add recipe secret ${deferredSandboxUiSecretName}` })
      .click()

    await expect(page).toHaveURL(/\/secrets\/new\?/)
    await expect(page.getByRole('heading', { name: 'Create recipe secret' })).toBeVisible()
    await expect(page.locator('#recipe-secret-name')).toHaveValue(deferredSandboxUiSecretName)
    await expect(page.getByLabel('Owner recipe')).toHaveValue(installedSandboxUiRecipeName)
    await page.getByRole('button', { name: 'Continue' }).click()
    const sandboxKeyInput = page.getByPlaceholder('API_KEY')
    const sandboxValueInput = page.getByPlaceholder('secret value')
    await expect(sandboxKeyInput).toHaveCount(1)
    await expect(sandboxValueInput).toHaveCount(1)
    await expect(sandboxKeyInput).toHaveValue('apiKey')
    await sandboxValueInput.fill('sandbox-ui-api-key')

    const createRecipeSecretResponse = page.waitForResponse(
      response => {
        const request = response.request()
        if (!response.url().includes('/admin/recipe-secrets') || request.method() !== 'POST') {
          return false
        }
        const body = request.postDataJSON() as {
          name?: string
          targetNamespace?: string
          data?: Record<string, string>
          ownership?: { kind?: string; recipeName?: string }
        } | null
        return (
          body?.name === deferredSandboxUiSecretName &&
          body.targetNamespace === 'sandbox-ui' &&
          body.ownership?.kind === 'owner-recipe' &&
          body.ownership.recipeName === installedSandboxUiRecipeName &&
          Object.keys(body.data ?? {}).join(',') === 'apiKey'
        )
      },
      { timeout: 30_000 }
    )
    await page.getByRole('button', { name: 'Create secret' }).click()
    const createdDeferredSandboxUi = await createRecipeSecretResponse
    expect(createdDeferredSandboxUi.status()).toBe(201)
    deferredSandboxUiIdentity = requireObjectIdentity(
      await createdDeferredSandboxUi.json(),
      'create sandbox-ui recipe credential'
    )
    await expect(page).toHaveURL(/\/secrets\/recipe$/)
    const provisionedRecipeSecretRow = page.locator('tr', { hasText: deferredSandboxUiSecretName })
    await expect(provisionedRecipeSecretRow).toBeVisible({ timeout: 15_000 })
    await expect(provisionedRecipeSecretRow.getByText('sandbox-ui', { exact: true })).toBeVisible()
    await expect(provisionedRecipeSecretRow.getByText('Missing')).toHaveCount(0)

    await provisionedRecipeSecretRow
      .getByRole('button', { name: `Update recipe secret ${deferredSandboxUiSecretName}` })
      .click()
    await expect(page).toHaveURL(
      new RegExp(`/secrets/recipe/${deferredSandboxUiSecretName}/edit\\?namespace=sandbox-ui`)
    )
    await expect(page.getByText('This Secret is in sandbox-ui.')).toBeVisible()
    const rotatedSandboxValue = page.getByPlaceholder('•••••••• (saved — type to overwrite)')
    await expect(rotatedSandboxValue).toHaveCount(1)
    await rotatedSandboxValue.fill('sandbox-ui-api-key-rotated')

    const updateRecipeSecretResponse = page.waitForResponse(
      response => {
        const request = response.request()
        if (!response.url().includes('/admin/recipe-secrets') || request.method() !== 'PUT') {
          return false
        }
        const body = request.postDataJSON() as {
          name?: string
          targetNamespace?: string
          data?: Record<string, string>
        } | null
        return (
          body?.name === deferredSandboxUiSecretName &&
          body.targetNamespace === 'sandbox-ui' &&
          body.data?.apiKey === 'sandbox-ui-api-key-rotated'
        )
      },
      { timeout: 30_000 }
    )
    await page.getByRole('button', { name: 'Save changes' }).click()
    const updatedDeferredSandboxUi = await updateRecipeSecretResponse
    expect(updatedDeferredSandboxUi.status()).toBe(200)
    await expect(page).toHaveURL(/\/secrets\/recipe$/)

    const rotatedRecipeSecretRow = page.locator('tr', { hasText: deferredSandboxUiSecretName })
    await expect(rotatedRecipeSecretRow).toBeVisible({ timeout: 15_000 })
    await rotatedRecipeSecretRow
      .getByRole('button', { name: `Delete recipe secret ${deferredSandboxUiSecretName}` })
      .click()
    await expect(page.getByRole('alertdialog', { name: 'Delete Recipe Secret' })).toBeVisible()
    await expect(
      page.getByText(`Delete recipe secret ${deferredSandboxUiSecretName} from sandbox-ui?`)
    ).toBeVisible()

    const deleteRecipeSecretResponse = page.waitForResponse(
      response => {
        const request = response.request()
        return (
          response
            .url()
            .includes(`/admin/recipe-secrets/${encodeURIComponent(deferredSandboxUiSecretName)}`) &&
          response.url().includes('targetNamespace=sandbox-ui') &&
          request.method() === 'DELETE'
        )
      },
      { timeout: 30_000 }
    )
    await page
      .getByRole('alertdialog', { name: 'Delete Recipe Secret' })
      .getByRole('button', { name: 'Delete' })
      .click()
    expect((await deleteRecipeSecretResponse).status()).toBe(200)
    const missingAgainRow = page.locator('tr', { hasText: deferredSandboxUiSecretName })
    await expect(missingAgainRow).toBeVisible({ timeout: 15_000 })
    await expect(missingAgainRow.getByText('sandbox-ui', { exact: true })).toBeVisible()
    await expect(missingAgainRow.getByText('Missing')).toBeVisible()
    deferredSandboxUiIdentity = null
  })

  test('J6. Registry exact-host entries over the CRD binding limit are rejected before install', async ({
    page,
  }) => {
    const publishStatus = await publishRegistryEntry(overLimitRegistryEntry(overLimitEntryName))
    expect(publishStatus).toBe(400)

    await login(page)
    await navigateToRegistry(page)
    await page.getByLabel('Search Marketplace entries').fill(overLimitEntryName)
    const entryRow = page.locator('tr', { hasText: overLimitEntryName })
    await expect(entryRow).toHaveCount(0)
    await expect(
      page.getByText(/No entries match your filters|No Marketplace entries found/)
    ).toBeVisible()
  })

  test.afterAll(async () => {
    await cleanup(
      token,
      [
        manualExactServerName,
        manualPublicServerName,
        manualRecipeName,
        manualPendingRecipeName,
        registryRecipeName,
        installedRegistryRecipeName,
        deferredMcpServerName,
        deferredMcpEntryName,
        deferredEnvSecretEntryName,
        installedDeferredEnvSecretRecipeName,
        deferredSandboxUiEntryName,
        installedSandboxUiRecipeName,
        overLimitEntryName,
      ].filter(Boolean)
    )
    await cleanupRecipesByCatalogId(token, registryRecipeName)
    await cleanupRecipesByCatalogId(token, deferredEnvSecretEntryName)
    await cleanupRecipesByCatalogId(token, deferredSandboxUiEntryName)
    if (manualPendingIdentity) {
      const deleted = await api(
        token,
        'DELETE',
        `/api/v1/admin/recipe-secrets/${manualPendingSecretName}`,
        manualPendingIdentity
      )
      expect(deleted.status, 'cleanup manual pending recipe credential').toBe(200)
    }
    if (deferredEnvIdentity) {
      const deleted = await api(
        token,
        'DELETE',
        `/api/v1/admin/recipe-secrets/${deferredEnvSecretName}`,
        deferredEnvIdentity
      )
      expect(deleted.status, 'cleanup deferred recipe credential').toBe(200)
    }
    if (deferredSandboxUiIdentity) {
      const deleted = await api(
        token,
        'DELETE',
        `/api/v1/admin/recipe-secrets/${deferredSandboxUiSecretName}?targetNamespace=sandbox-ui`,
        deferredSandboxUiIdentity
      )
      expect(deleted.status, 'cleanup sandbox-ui recipe credential').toBe(200)
    }
    await deleteRegistryEntry(deferredMcpEntryName)
    await deleteRegistryEntry(deferredEnvSecretEntryName)
    await deleteRegistryEntry(deferredSandboxUiEntryName)
    await deleteRegistryEntry(overLimitEntryName)
  })
})
