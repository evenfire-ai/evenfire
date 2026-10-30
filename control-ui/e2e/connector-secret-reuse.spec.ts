import { type Page, type Route, expect, test } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'

// ─── Connector Secret reuse — mocked-API frontend E2E ───────────────────────
//
// These specs drive the REAL Control UI (built app served by `next start`,
// real routes /connectors/new and /connectors/:name/edit/credentials, real
// Chromium) while the Control API is replaced at the browser network layer
// with `page.route`. They prove what a live browser actually sends and
// renders for the Secret-reuse flows; they are NOT live-backend E2E and NOT
// T2 certification — no cluster, no real credentials, no shared state.
//
// Secret values are never part of these flows: the mocks only ever carry
// names, key names, and UIDs, mirroring the production listing contract.

const EVIDENCE_DIR = path.resolve(
  __dirname,
  '../../.local-notes/infra/runs/connector-secrets-ui/playwright'
)

/** Provisioned connector Secrets as GET /admin/mcp-secrets returns them:
 *  names, key names, and UIDs only — never values. */
const LEGACY_SECRET = {
  name: 'linear-legacy',
  uid: 'uid-legacy',
  keys: ['api-key', 'workspace-id'],
}
const SHARED_SECRET = {
  name: 'team-shared-credentials',
  uid: 'uid-shared',
  keys: ['api-key', 'workspace-id'],
}
const PARTIAL_SECRET = { name: 'partial-shared', uid: 'uid-partial', keys: ['api-key'] }

const LINEAR_REFERENCE = {
  name: LEGACY_SECRET.name,
  keys: [
    { secretKey: 'api-key', envVar: 'LINEAR_API_KEY' },
    { secretKey: 'workspace-id', envVar: 'LINEAR_WORKSPACE' },
  ],
}

/** An McpServerResource as the page and the change flow read it. */
function connectorResource(
  name: string,
  envSecret: { name: string; keys: Array<{ secretKey: string; envVar: string }> } | undefined,
  overrides: {
    uid?: string
    resourceVersion?: string
    generation?: number
    image?: string
  } = {}
) {
  return {
    metadata: {
      name,
      namespace: 'mcp-server',
      uid: overrides.uid ?? `${name}-uid`,
      resourceVersion: overrides.resourceVersion ?? '10',
      generation: overrides.generation ?? 2,
    },
    spec: {
      image: overrides.image ?? 'ghcr.io/example/linear-mcp:1.4.0',
      contextRef: `ctx-${name}`,
      managed: true,
      enabled: true,
      ...(envSecret ? { envSecret } : {}),
    },
    status: { conditions: [] },
  }
}

/** The PUT answer for an accepted assignment: new reference, bumped
 *  generation, and a fresh DeploymentReady the poll can correlate. */
function reassignedConnector(name: string, atIso: string) {
  const saved = connectorResource(name, LINEAR_REFERENCE, {
    resourceVersion: '11',
    generation: 3,
  })
  return {
    ...saved,
    spec: {
      ...saved.spec,
      envSecret: { name: SHARED_SECRET.name, keys: LINEAR_REFERENCE.keys },
    },
    status: {
      conditions: [
        {
          type: 'DeploymentReady',
          status: 'True',
          reason: 'RolloutComplete',
          message: 'ready',
          lastTransitionTime: atIso,
          observedGeneration: 3,
        },
      ],
    },
  }
}
type RecordedRequest = { method: string; pathname: string; body?: unknown }

type Mocks = {
  /** Every admin API request the browser actually made. */
  requests: RecordedRequest[]
  /** Every non-GET request whose path is the Secret collection or anything
   *  under it (mcp-secrets and mcp-secrets/:name), recorded before any
   *  per-endpoint handling — so a named PUT/DELETE can never bypass the
   *  no-mutation assertions. */
  secretWrites: RecordedRequest[]
  /** GET /admin/mcp-secrets fails this many times before succeeding. */
  listSecretsFailures: number
  /** The catalog GET /admin/mcp-secrets answers with. */
  secretsItems: Array<{ name: string; uid: string; keys: string[] }>
  /** Supplies GET /admin/mcp-servers/:name responses in order; the last
   *  supplier repeats once the queue is exhausted. */
  serverReads: Array<() => unknown>
}

function mocks(initialServer: () => unknown): Mocks {
  return {
    requests: [],
    secretWrites: [],
    listSecretsFailures: 0,
    secretsItems: [LEGACY_SECRET, SHARED_SECRET, PARTIAL_SECRET],
    serverReads: [initialServer],
  }
}

/** Installs the browser-level Control API replacement. Only metadata ever
 *  crosses: names, key names, UIDs, and spec references — no values. */
async function installApiMocks(page: Page, state: Mocks, serverName: string) {
  async function handle(route: Route) {
    const request = route.request()
    const url = new URL(request.url())
    const pathname = url.pathname
    const method = request.method()
    let body: unknown
    if (method !== 'GET' && request.postData()) {
      try {
        body = request.postDataJSON()
      } catch {
        body = request.postData()
      }
    }
    state.requests.push({ method, pathname, body })

    const marker = '/api/v1/admin/'
    const index = pathname.indexOf(marker)
    const adminPath = index === -1 ? '' : pathname.slice(index + marker.length)

    // Write capture comes FIRST, before any endpoint dispatch: the collection
    // AND every named child (mcp-secrets/:name) must be recorded so the
    // reference-only journeys can prove no Secret was created, updated, or
    // deleted under any path shape.
    if (adminPath === 'mcp-secrets' || adminPath.startsWith('mcp-secrets/')) {
      if (method !== 'GET') {
        state.secretWrites.push({ method, pathname, body })
      }
    }

    const json = (status: number, payload: unknown) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(payload) })

    if (adminPath === 'auth/me') {
      await json(200, { me: { id: 'e2e-admin', username: 'e2e-admin', role: 'admin' } })
      return
    }
    if (adminPath === 'hosts') {
      await json(200, { items: [] })
      return
    }
    if (adminPath === 'contexts' && method === 'GET') {
      await json(200, { items: [] })
      return
    }
    if (adminPath === 'contexts' && method === 'POST') {
      await json(201, { metadata: { name: body?.metadata?.name ?? 'ctx-fallback' } })
      return
    }
    if (adminPath === 'registry/images') {
      await json(200, { org: 'evenfire-dev', images: [] })
      return
    }
    if (adminPath === 'mcp-secrets') {
      if (method === 'GET') {
        if (state.listSecretsFailures > 0) {
          state.listSecretsFailures -= 1
          await json(500, { message: 'simulated listing outage' })
          return
        }
        await json(200, { items: state.secretsItems })
        return
      }
      // Answer 201 so a bug does not cascade before the assertion; the
      // capture above has already recorded it.
      await json(201, { name: body?.name ?? 'unexpected', namespace: 'mcp-server' })
      return
    }
    if (adminPath === 'mcp-servers' && method === 'POST') {
      await json(201, { metadata: { name: body?.metadata?.name ?? 'connector' }, spec: body?.spec })
      return
    }
    if (adminPath === `mcp-servers/${serverName}`) {
      if (method === 'GET') {
        const supplier =
          state.serverReads.length > 1 ? state.serverReads.shift()! : state.serverReads[0]
        await json(200, supplier())
        return
      }
      if (method === 'PUT') {
        await json(200, reassignedConnector(serverName, new Date().toISOString()))
        return
      }
    }
    await json(404, {})
  }

  await page.route('**/api/v1/admin/**', route => void handle(route))
}

/** Authenticates AuthGate through the same localStorage contract the other
 *  mocked specs use, before any page script runs. */
async function authenticate(page: Page) {
  await page.addInitScript(() => {
    window.localStorage.setItem('controlUiAdminToken', 'e2e-mock-only-token')
  })
}

function evidencePath(fileName: string): string {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true })
  return path.join(EVIDENCE_DIR, fileName)
}

async function requestsFor(state: Mocks, method: string, suffix: string) {
  await expect
    .poll(
      () => state.requests.filter(r => r.method === method && r.pathname.endsWith(suffix)).length,
      { message: `expected a ${method} request ending in ${suffix}` }
    )
    .toBeGreaterThan(0)
  return state.requests.filter(r => r.method === method && r.pathname.endsWith(suffix))
}

/** The app's own alert region, excluding Next.js's route announcer, which
 *  also exposes role="alert". */
function appAlert(page: Page) {
  return page.locator('[role="alert"]:not([id="__next-route-announcer__"])')
}

/** Drives the three-step create flow to a connector referencing the shared
 *  Secret, with no credential value ever typed. */

/** The picker is a custom single-select dropdown: open, then click the option. */
async function chooseExistingSecret(page: Page, name: string) {
  await page.getByLabel(/^Existing Secret/).click()
  await page.getByRole('option', { name }).click()
}

async function createConnectorUsingSharedSecret(page: Page, name: string) {
  await page.goto('/connectors/new')
  await page.getByPlaceholder('my-mcp-server').fill(name)
  await page
    .getByPlaceholder('us-central1-docker.pkg.dev/my-project/repo/mcp-server:latest')
    .fill('ghcr.io/example/brave-mcp:1.0')
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('button', { name: 'Continue' }).click()

  await page.getByRole('radio', { name: 'Use an existing Secret' }).click()
  await expect(page.getByLabel(/^Existing Secret/)).toBeEnabled()
  // Write-only contract at the browser level: no value input ever renders.
  await expect(page.locator('input[type="password"]')).toHaveCount(0)

  await chooseExistingSecret(page, SHARED_SECRET.name)
  await expect(page.getByLabel(/^Environment variable 1/)).toHaveValue('API_KEY')

  await page.getByRole('button', { name: 'Create connector' }).click()
  await expect(page.getByText('Connector created successfully.')).toBeVisible({ timeout: 15_000 })
}

test.describe('Connector Secret reuse — creation', () => {
  test('creates a connector from an existing Secret without value re-entry or Secret writes', async ({
    page,
  }) => {
    await authenticate(page)
    const state = mocks(() => connectorResource('brave-search', undefined))
    await installApiMocks(page, state, 'brave-search')

    await createConnectorUsingSharedSecret(page, 'brave-search')
    await page.screenshot({
      path: evidencePath('pw-01-create-existing-secret.png'),
      fullPage: true,
    })

    const creations = await requestsFor(state, 'POST', 'api/v1/admin/mcp-servers')
    expect(creations).toHaveLength(1)
    // Every stored key is mapped to a suggested destination; no values exist
    // anywhere in the request.
    expect(creations[0]?.body).toMatchObject({
      metadata: { name: 'brave-search' },
      spec: {
        envSecret: {
          name: SHARED_SECRET.name,
          keys: [
            { secretKey: 'api-key', envVar: 'API_KEY' },
            { secretKey: 'workspace-id', envVar: 'WORKSPACE_ID' },
          ],
        },
      },
    })
    // Reference-only: the shared Secret was listed, never written or deleted.
    expect(state.secretWrites).toEqual([])
  })

  test('reuses one Secret across multiple connectors without Secret POST/PUT/DELETE', async ({
    page,
  }) => {
    await authenticate(page)
    const state = mocks(() => connectorResource('brave-search', undefined))
    await installApiMocks(page, state, 'brave-search')

    await createConnectorUsingSharedSecret(page, 'brave-search')
    await createConnectorUsingSharedSecret(page, 'jira-bridge')

    const creations = await requestsFor(state, 'POST', 'api/v1/admin/mcp-servers')
    expect(creations).toHaveLength(2)
    for (const creation of creations) {
      expect(creation.body).toMatchObject({
        spec: { envSecret: { name: SHARED_SECRET.name } },
      })
    }
    const listed = state.requests.filter(
      r => r.method === 'GET' && r.pathname.endsWith('api/v1/admin/mcp-secrets')
    )
    expect(listed.length).toBeGreaterThanOrEqual(2)
    expect(state.secretWrites).toEqual([])
  })

  test('surfaces listing failures with retry and recovers without value prompts', async ({
    page,
  }) => {
    await authenticate(page)
    const state = mocks(() => connectorResource('brave-search', undefined))
    state.listSecretsFailures = 1
    await installApiMocks(page, state, 'brave-search')

    await page.goto('/connectors/new')
    await page.getByPlaceholder('my-mcp-server').fill('brave-search')
    await page
      .getByPlaceholder('us-central1-docker.pkg.dev/my-project/repo/mcp-server:latest')
      .fill('ghcr.io/example/brave-mcp:1.0')
    await page.getByRole('button', { name: 'Continue' }).click()
    await page.getByRole('button', { name: 'Continue' }).click()
    await page.getByRole('radio', { name: 'Use an existing Secret' }).click()

    const alert = appAlert(page)
    await expect(alert).toContainText('Could not load Secrets')
    await expect(page.getByRole('button', { name: 'Create connector' })).toBeDisabled()
    await expect(page.locator('input[type="password"]')).toHaveCount(0)

    await page.getByRole('button', { name: 'Retry loading Secrets' }).click()
    await expect(page.getByLabel(/^Existing Secret/)).toBeEnabled()
    await chooseExistingSecret(page, SHARED_SECRET.name)
    await expect(page.getByLabel(/^Environment variable 1/)).toHaveValue('API_KEY')
  })

  test('an empty Secret catalog disables creation and never asks for values', async ({ page }) => {
    await authenticate(page)
    const state = mocks(() => connectorResource('brave-search', undefined))
    state.secretsItems = []
    await installApiMocks(page, state, 'brave-search')

    await page.goto('/connectors/new')
    await page.getByPlaceholder('my-mcp-server').fill('brave-search')
    await page
      .getByPlaceholder('us-central1-docker.pkg.dev/my-project/repo/mcp-server:latest')
      .fill('ghcr.io/example/brave-mcp:1.0')
    await page.getByRole('button', { name: 'Continue' }).click()
    await page.getByRole('button', { name: 'Continue' }).click()
    await page.getByRole('radio', { name: 'Use an existing Secret' }).click()

    // A genuinely empty listing: the picker enables, but there is nothing to
    // choose, creation stays blocked, and no credential value is ever asked.
    await expect(page.getByText(/No connector Secrets are available/)).toBeVisible()
    await expect(page.getByLabel(/^Existing Secret/)).toBeEnabled()
    await expect(page.getByRole('button', { name: 'Create connector' })).toBeDisabled()
    await expect(page.locator('input[type="password"]')).toHaveCount(0)
    expect(state.secretWrites).toEqual([])
  })
})

test.describe('Connector Secret reuse — change assigned Secret', () => {
  async function prepare(page: Page, serverReads: Array<() => unknown>) {
    await authenticate(page)
    const state = mocks(serverReads[0]!)
    state.serverReads = serverReads
    await installApiMocks(page, state, 'linear')
    return state
  }

  async function openChangeFlow(page: Page) {
    await page.goto('/connectors/linear/edit/credentials')
    await expect(page.getByRole('button', { name: 'Rotate credentials' })).toBeVisible()
    await expect(page.getByText(`Current Secret: ${LEGACY_SECRET.name}`)).toBeVisible()
    await page.getByRole('button', { name: 'Change assigned Secret' }).click()
    await expect(page.getByLabel(/^Existing Secret/)).toBeEnabled()
    await expect(page.locator('input[type="password"]')).toHaveCount(0)
  }

  test('saves only envSecret with CAS identity, preserves destinations, and observes readiness', async ({
    page,
  }) => {
    // Reads: page mount, the change flow's two verification reads, then the
    // post-save poll sees the freshly Ready reassigned connector.
    const current = () => connectorResource('linear', LINEAR_REFERENCE)
    const state = await prepare(page, [
      current,
      current,
      current,
      () => reassignedConnector('linear', new Date().toISOString()),
    ])

    await openChangeFlow(page)
    await chooseExistingSecret(page, SHARED_SECRET.name)
    // Destinations are the connector's contract and survive the reassignment.
    await expect(page.getByLabel(/^Environment variable 1/)).toHaveValue('LINEAR_API_KEY')
    await expect(page.getByLabel(/^Environment variable 2/)).toHaveValue('LINEAR_WORKSPACE')

    await page.getByRole('button', { name: 'Assign and restart' }).click()
    const dialog = page.getByRole('alertdialog')
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText(LEGACY_SECRET.name)
    await expect(dialog).toContainText(SHARED_SECRET.name)
    await page.screenshot({ path: evidencePath('pw-02-change-confirm.png') })
    await dialog.getByRole('button', { name: 'Assign and restart' }).click()

    const saves = await requestsFor(state, 'PUT', 'api/v1/admin/mcp-servers/linear')
    expect(saves).toHaveLength(1)
    expect(saves[0]?.body).toMatchObject({
      metadata: { uid: 'linear-uid', resourceVersion: '10' },
      spec: {
        image: 'ghcr.io/example/linear-mcp:1.4.0',
        envSecret: {
          name: SHARED_SECRET.name,
          keys: [
            { secretKey: 'api-key', envVar: 'LINEAR_API_KEY' },
            { secretKey: 'workspace-id', envVar: 'LINEAR_WORKSPACE' },
          ],
        },
      },
    })
    expect(state.secretWrites).toEqual([])

    // Correlated readiness: a fresh True resolves the wait without any
    // operator action, then the page reloads the new assignment.
    await expect(page.getByText(/Assigned Secret changed/)).toBeVisible({ timeout: 20_000 })
    await expect(page.getByText(`Current Secret: ${SHARED_SECRET.name}`)).toBeVisible({
      timeout: 20_000,
    })
    await expect(page.getByRole('button', { name: 'Change assigned Secret' })).toBeFocused()
    await page.screenshot({
      path: evidencePath('pw-03-change-assigned-ready.png'),
      fullPage: true,
    })
  })

  test('keeps saved distinct from ready, locks navigation, and leaves cleanly', async ({
    page,
  }) => {
    // Reads 1-3 return the pre-change snapshot. From the first post-save poll
    // onward the connector reports the new reference WITHOUT a fresh Ready
    // condition: saved but never observed ready inside this journey.
    const stale = () => connectorResource('linear', LINEAR_REFERENCE)
    const savedNotReady = () => {
      const saved = reassignedConnector('linear', new Date().toISOString())
      return { ...saved, status: { conditions: [] } }
    }
    const state = await prepare(page, [stale, stale, stale, savedNotReady])

    await openChangeFlow(page)
    await chooseExistingSecret(page, SHARED_SECRET.name)
    await page.getByRole('button', { name: 'Assign and restart' }).click()
    await page.getByRole('alertdialog').getByRole('button', { name: 'Assign and restart' }).click()

    await requestsFor(state, 'PUT', 'api/v1/admin/mcp-servers/linear')
    await expect(page.getByText(/Assignment saved/)).toBeVisible()
    // Saved is not ready: tabs stay locked while the rollout is observed.
    for (const tab of await page.getByRole('tab').all()) {
      await expect(tab).toBeDisabled()
    }
    await page.screenshot({ path: evidencePath('pw-04-saved-not-ready.png'), fullPage: true })

    await page.getByRole('button', { name: 'Check credentials later' }).click()
    await expect(page.getByText(`Current Secret: ${SHARED_SECRET.name}`)).toBeVisible()
    await expect(page.getByRole('button', { name: 'Change assigned Secret' })).toBeFocused()
  })

  test('refuses a concurrent connector change before writing and locks until refresh', async ({
    page,
  }) => {
    const current = () => connectorResource('linear', LINEAR_REFERENCE)
    const concurrentlyEdited = () =>
      connectorResource('linear', LINEAR_REFERENCE, { image: 'ghcr.io/example/linear-mcp:1.5.0' })
    const state = await prepare(page, [current, current, concurrentlyEdited])

    await openChangeFlow(page)
    await chooseExistingSecret(page, SHARED_SECRET.name)
    await page.getByRole('button', { name: 'Assign and restart' }).click()
    await page.getByRole('alertdialog').getByRole('button', { name: 'Assign and restart' }).click()

    await expect(appAlert(page)).toContainText('connector changed')
    expect(state.requests.some(r => r.method === 'PUT')).toBe(false)
    expect(state.secretWrites).toEqual([])
    await page.getByRole('button', { name: 'Refresh credentials' }).click()
    await expect(page.getByText(`Current Secret: ${LEGACY_SECRET.name}`)).toBeVisible()
  })

  test('supports no-op refusal, explicit replacement keys, and cancel with focus return', async ({
    page,
  }) => {
    const current = () => connectorResource('linear', LINEAR_REFERENCE)
    const state = await prepare(page, [current])

    await openChangeFlow(page)

    // No-op: re-choosing the currently assigned Secret disables assignment.
    await chooseExistingSecret(page, LEGACY_SECRET.name)
    await expect(page.getByRole('button', { name: 'Assign and restart' })).toBeDisabled()

    // A Secret missing one stored key demands an explicit replacement key and
    // never a credential value.
    await chooseExistingSecret(page, PARTIAL_SECRET.name)
    await expect(page.getByLabel(/^Secret key 2/)).toHaveValue('')
    await expect(page.getByLabel(/^Environment variable 2/)).toHaveValue('LINEAR_WORKSPACE')
    await expect(appAlert(page)).toContainText('Choose a stored key')
    await expect(page.getByRole('button', { name: 'Assign and restart' })).toBeDisabled()
    await expect(page.locator('input[type="password"]')).toHaveCount(0)
    await page.screenshot({ path: evidencePath('pw-05-missing-key-choice.png'), fullPage: true })

    // Cancel returns to the credentials view with focus on the trigger and
    // nothing written.
    await page.getByRole('button', { name: 'Cancel assignment change' }).click()
    await expect(page.getByText(`Current Secret: ${LEGACY_SECRET.name}`)).toBeVisible()
    await expect(page.getByRole('button', { name: 'Change assigned Secret' })).toBeFocused()
    expect(state.requests.some(r => r.method === 'PUT')).toBe(false)
    expect(state.secretWrites).toEqual([])
  })

  test('an empty Secret catalog keeps reassignment disabled without value prompts', async ({
    page,
  }) => {
    const current = () => connectorResource('linear', LINEAR_REFERENCE)
    const state = await prepare(page, [current])
    state.secretsItems = []

    await openChangeFlow(page)
    await expect(page.getByText(/No connector Secrets are available/)).toBeVisible()
    await expect(page.getByRole('button', { name: 'Assign and restart' })).toBeDisabled()
    await expect(page.locator('input[type="password"]')).toHaveCount(0)
    expect(state.secretWrites).toEqual([])
  })

  test('control: the write capture detects named Secret PUT and DELETE', async ({ page }) => {
    const current = () => connectorResource('linear', LINEAR_REFERENCE)
    const state = await prepare(page, [current])

    await page.goto('/connectors/linear/edit/credentials')
    await expect(page.getByRole('button', { name: 'Rotate credentials' })).toBeVisible()

    // In-page fetches traverse page.route, so these deliberately issued
    // named-child writes prove the capture itself — not the fallback 404 —
    // detects mcp-secrets/:name PUT and DELETE, including a value-bearing
    // body. This is the negative/control half of the no-mutation contract;
    // the journeys above prove the flows never trigger it.
    await page.evaluate(async () => {
      await fetch('/control-api/api/v1/admin/mcp-secrets/team-shared-credentials', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 'api-key': 'control-only-fake-value' }),
      })
      await fetch('/control-api/api/v1/admin/mcp-secrets/team-shared-credentials', {
        method: 'DELETE',
      })
    })

    expect(state.secretWrites.map(write => `${write.method} ${write.pathname}`)).toEqual([
      'PUT /control-api/api/v1/admin/mcp-secrets/team-shared-credentials',
      'DELETE /control-api/api/v1/admin/mcp-secrets/team-shared-credentials',
    ])
    expect(state.secretWrites[0]?.body).toEqual({ 'api-key': 'control-only-fake-value' })
  })

  test('recovers from a Secret listing outage inside the change flow', async ({ page }) => {
    const current = () => connectorResource('linear', LINEAR_REFERENCE)
    const state = await prepare(page, [current])
    state.listSecretsFailures = 1

    await page.goto('/connectors/linear/edit/credentials')
    await page.getByRole('button', { name: 'Change assigned Secret' }).click()
    await expect(appAlert(page)).toContainText('Could not load Secrets')
    await expect(page.getByRole('button', { name: 'Assign and restart' })).toBeDisabled()

    await page.getByRole('button', { name: 'Retry loading Secrets' }).click()
    await expect(page.getByLabel(/^Existing Secret/)).toBeEnabled()
    await chooseExistingSecret(page, SHARED_SECRET.name)
    await expect(page.getByRole('button', { name: 'Assign and restart' })).toBeEnabled()
  })
})

test.describe('Connector Secret reuse — narrow viewport', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test('reuse and reassignment stay usable at 390px without horizontal overflow', async ({
    page,
  }) => {
    await authenticate(page)
    const current = () => connectorResource('linear', LINEAR_REFERENCE)
    const state = mocks(current)
    await installApiMocks(page, state, 'linear')

    await page.goto('/connectors/linear/edit/credentials')
    await page.getByRole('button', { name: 'Change assigned Secret' }).click()
    await expect(page.getByLabel(/^Existing Secret/)).toBeEnabled()
    await chooseExistingSecret(page, SHARED_SECRET.name)
    await expect(page.getByLabel(/^Environment variable 1/)).toHaveValue('LINEAR_API_KEY')
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      await page.evaluate(() => window.innerWidth)
    )
    await page.screenshot({ path: evidencePath('pw-06-narrow-change-flow.png'), fullPage: true })
  })
})
