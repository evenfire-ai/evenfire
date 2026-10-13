import {
  type Locator,
  type Page,
  type Request,
  type Response,
  expect,
  test,
} from '@playwright/test'
import { CONTROL_ROUTES } from '../app/constants/routes'
import {
  CONTROL_API_URL,
  CONTROL_UI_URL,
  adminCredentials,
  assertAllowedTarget,
  directApi,
  loginThroughUi,
  requireRecorderConfirm,
  requiredValue,
  screenshotAndLog,
  uniqueE2EName,
} from './qa-recorder-helpers'

// Task 11 source contract: run each scenario separately in the same owned,
// disposable local lane. The operator configures the real API before running:
//   --grep 'normal navigation': CONTROL_API_ADMIN_SUBSCRIPTION_READ_PER_MIN >= 150
//   --grep 'real 429':          CONTROL_API_ADMIN_SUBSCRIPTION_READ_PER_MIN = 2
// The existing API window is a fixed calendar minute, not a configurable knob.
// Both CONTROL_API_CODEX_SUBSCRIPTION_ENABLED and
// CONTROL_API_GROK_SUBSCRIPTION_ENABLED must be true.
// Require QA_RECORDER_CONFIRM_MUTATIONS=1, QA_RECORDER_CONFIRM_OWNED_RUNTIME=1,
// explicit loopback CONTROL_UI_URL/CONTROL_API_URL, normal recorder admin login,
// E2E_AGENT_SECRET_NAME (an existing local Secret containing an OpenAI key), and
// two distinct enabled OpenAI allowlist rows: E2E_AGENT_MODEL_NAME and
// E2E_AGENT_DRAFT_MODEL_NAME. No provider execution or catalog write is needed.
// Set QA_RECORDER_ROOT to the primary checkout's ignored .local-notes/infra/runs
// directory. These declarations do not establish deployment or runtime proof.
// Each test signs in, creates its own agent through the wizard, signs out and
// signs in again through the visible UI, then selects that agent from the list.
// Only observed successful creates enter the cleanup ledger. Direct API calls
// are confined to teardown of those exact resources, never setup or assertions.

const CAPABILITIES = '/api/v1/admin/llm/providers/capabilities'
// Required fields append " *" to their accessible name, and the catalog tab
// appends its model count.
const PROVIDER_FIELD = /^Provider(?: \*)?$/
const MODEL_FIELD = /^Model(?: \*)?$/
const NAME_FIELD = /^Name(?: \*)?$/
const UNIT_FIELD = /^Unit(?: \*)?$/
const CATALOG_TAB = /^Catalog(?: \(\d+\))?$/
const INVENTORIES = [
  '/api/v1/admin/llm/providers/codex-subscription/connections',
  '/api/v1/admin/llm/providers/grok-subscription/connections',
] as const
const METADATA_REUSE_MS = 30_000

type AgentFixture = { secretName: string; modelName: string; draftModelName: string; quota: number }
type OwnedAgent = { name: string; contextNames: Set<string>; hostCreated: boolean }
// Times are taken when Playwright reports the browser's request and response,
// so recovery timing is measured from the 429's arrival to each reread's start.
type MetadataRead = { path: string; status?: number; startedAtMs: number; respondedAtMs?: number }

function apiPath(url: string): string {
  return new URL(url).pathname.replace(/^\/control-api(?=\/)/, '')
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function isRead(response: Response, path: string): boolean {
  return response.request().method() === 'GET' && apiPath(response.url()) === path
}

function isWrite(response: Response, method: string, path: string): boolean {
  return response.request().method() === method && apiPath(response.url()) === path
}

function assertOwnedResponse(response: Response): void {
  expect(
    [new URL(CONTROL_UI_URL).origin, new URL(CONTROL_API_URL).origin],
    'The observed API response must come from the declared owned local runtime'
  ).toContain(new URL(response.url()).origin)
}

function fixtureFor(scenario: 'normal' | 'overload'): AgentFixture {
  requireRecorderConfirm(
    'QA_RECORDER_CONFIRM_MUTATIONS',
    'This journey creates and deletes its own agent and context.'
  )
  requireRecorderConfirm(
    'QA_RECORDER_CONFIRM_OWNED_RUNTIME',
    'This journey requires a disposable local runtime owned by this lane.'
  )
  for (const [label, url] of [
    ['CONTROL_UI_URL', CONTROL_UI_URL],
    ['CONTROL_API_URL', CONTROL_API_URL],
  ]) {
    requiredValue(label, [process.env[label]])
    // The existing helper documents localhost as necessary for Playwright's
    // API cookie jar to share the secure browser cookie during owned cleanup.
    expect(new URL(url).hostname, `${label} must use the owned localhost mapping`).toBe('localhost')
    assertAllowedTarget(label, url)
  }
  const recorderRoot = requiredValue('QA_RECORDER_ROOT', [process.env.QA_RECORDER_ROOT])
  expect(recorderRoot, 'Use an absolute recording directory under the primary checkout').toMatch(
    /^\//
  )
  expect(
    recorderRoot,
    'Keep recording evidence under the ignored primary .local-notes/infra/runs path'
  ).toMatch(/\/\.local-notes\/infra\/runs(?:\/|$)/)
  const rawQuota = requiredValue('CONTROL_API_ADMIN_SUBSCRIPTION_READ_PER_MIN', [
    process.env.CONTROL_API_ADMIN_SUBSCRIPTION_READ_PER_MIN,
  ])
  expect(
    rawQuota,
    'Declare the real API quota as a positive integer; the test never reconfigures it'
  ).toMatch(/^[1-9]\d*$/)
  const quota = Number(rawQuota)
  expect(Number.isSafeInteger(quota)).toBe(true)
  if (scenario === 'normal')
    expect(
      quota,
      'The normal runtime must meet the subscription read target'
    ).toBeGreaterThanOrEqual(150)
  else expect(quota, 'Configure quota 2 externally before the controlled real-429 run').toBe(2)

  const modelName = requiredValue('E2E_AGENT_MODEL_NAME', [process.env.E2E_AGENT_MODEL_NAME])
  const draftModelName = requiredValue('E2E_AGENT_DRAFT_MODEL_NAME', [
    process.env.E2E_AGENT_DRAFT_MODEL_NAME,
  ])
  expect(draftModelName, 'Draft retention needs a second enabled OpenAI model').not.toBe(modelName)
  return {
    secretName: requiredValue('E2E_AGENT_SECRET_NAME', [process.env.E2E_AGENT_SECRET_NAME]),
    modelName,
    draftModelName,
    quota,
  }
}

function observeReads(page: Page) {
  const reads = new Map<Request, MetadataRead>()
  const throttles: string[] = []
  const recordRequest = (request: Request) => {
    const path = apiPath(request.url())
    if (
      request.method() === 'GET' &&
      (path === CAPABILITIES ||
        /^\/api\/v1\/admin\/llm\/providers\/(?:codex|grok)-subscription(?:\/|$)/.test(path))
    ) {
      reads.set(request, { path, startedAtMs: Date.now() })
    }
  }
  const recordResponse = (response: Response) => {
    const read = reads.get(response.request())
    if (read) {
      read.status = response.status()
      read.respondedAtMs = Date.now()
    }
    const path = apiPath(response.url())
    if (path.startsWith('/api/v1/admin/') && response.status() === 429) throttles.push(path)
  }
  page.on('request', recordRequest)
  page.on('response', recordResponse)
  return {
    snapshot: () => Array.from(reads.values()).map(read => ({ ...read })),
    throttles,
    stop: () => {
      page.off('request', recordRequest)
      page.off('response', recordResponse)
    },
  }
}

async function signIn(page: Page): Promise<void> {
  const authenticated = page.waitForResponse(response =>
    isWrite(response, 'POST', '/api/v1/admin/auth/login')
  )
  await loginThroughUi(page, adminCredentials())
  expect((await authenticated).status(), 'Real UI login must succeed').toBe(200)
  await expect(page).not.toHaveURL(/\/login(?:\?|$)/)
  await expect(page.getByRole('button', { name: 'Log out', exact: true })).toBeVisible()
}

async function signOut(page: Page): Promise<void> {
  const signedOut = page.waitForResponse(response =>
    isWrite(response, 'POST', '/api/v1/admin/auth/logout')
  )
  await page.getByRole('button', { name: 'Log out', exact: true }).click()
  expect([200, 204]).toContain((await signedOut).status())
  // Logout keeps the current route as `?next=` so the next sign-in returns to it.
  await expect(page).toHaveURL(
    new RegExp(`${escapeRegex(CONTROL_ROUTES.login)}(?:\\?next=[^&#]+)?$`)
  )
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible()
}

async function openAgents(page: Page): Promise<void> {
  await page
    .getByRole('navigation', { name: 'Main sections' })
    .getByRole('link', { name: 'Agents', exact: true })
    .click()
  await expect(page).toHaveURL(new RegExp(`${escapeRegex(CONTROL_ROUTES.agents.root)}$`))
  await expect(
    page.getByText('Manage available agents and their host mappings.', { exact: true })
  ).toBeVisible()
  // Login may already land on Agents. The visible reload provides a real
  // inventory signal even when clicking its current navigation destination.
  const reload = page.getByRole('button', { name: 'Reload agents', exact: true })
  await expect(reload).toBeEnabled()
  const inventory = page.waitForResponse(response => isRead(response, '/api/v1/admin/hosts'))
  await reload.click()
  const response = await inventory
  assertOwnedResponse(response)
  expect(response.status()).toBe(200)
}

async function selectModel(page: Page, picker: Locator, model: string): Promise<void> {
  await expect(picker).toBeEnabled()
  await picker.click()
  const option = page.getByRole('option', { name: model, exact: true })
  await expect(option, `The explicit local model fixture ${model} must be enabled`).toBeVisible()
  await option.click()
  await expect(picker).toContainText(model)
  await expect(picker).toHaveAttribute('aria-expanded', 'false')
}

async function createAgent(page: Page, owned: OwnedAgent, fixture: AgentFixture): Promise<void> {
  await openAgents(page)
  await page.getByRole('button', { name: 'Create agent', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`${escapeRegex(CONTROL_ROUTES.agents.new)}$`))
  await expect(page.getByRole('heading', { name: 'Create agent', exact: true })).toBeVisible()
  // The field is required, so its accessible name carries the "*" marker.
  const agentName = page.getByLabel(/^Agent name/)
  await agentName.fill(owned.name)
  await expect(agentName).toHaveValue(owned.name)
  await page.getByRole('button', { name: 'Next', exact: true }).click()

  await expect(page.getByRole('region', { name: 'LLM configuration', exact: true })).toBeVisible()
  await page.getByRole('radio', { name: /^Use an existing LLM Secret/ }).check()
  await page.getByRole('button', { name: 'Select LLM Secret...', exact: true }).click()
  const secret = page.getByRole('option', {
    name: new RegExp(`^${escapeRegex(fixture.secretName)}(?:\\s|$)`),
  })
  await expect(
    secret,
    'The explicit local existing Secret fixture must be available in the visible picker'
  ).toBeVisible()
  await secret.click()
  const provider = page.getByLabel('Provider', { exact: true })
  await provider.click()
  await page.getByRole('option', { name: 'OpenAI', exact: true }).click()
  await expect(provider).toContainText('OpenAI')
  // Prove both model fixtures through the picker before choosing the saved one.
  const model = page.getByLabel('Default model', { exact: true })
  await selectModel(page, model, fixture.draftModelName)
  await selectModel(page, model, fixture.modelName)
  await page.getByRole('button', { name: 'Next', exact: true }).click()
  await expect(page.getByTestId('wizard-users-list')).toBeVisible()
  await expect(page.getByTestId('wizard-empty-access-warning')).toBeVisible()
  await page.getByRole('button', { name: 'Next', exact: true }).click()
  await expect(page.getByRole('group', { name: 'Available connectors' })).toBeVisible()
  await expect(
    page.getByText('None selected. You can add connectors later from the agent detail page.', {
      exact: true,
    })
  ).toBeVisible()

  const created = page.waitForResponse(response => isWrite(response, 'POST', '/api/v1/admin/hosts'))
  await page.getByRole('button', { name: 'Create Agent', exact: true }).click()
  const response = await created
  expect([200, 201]).toContain(response.status())
  const submitted = response.request().postDataJSON()
  expect(submitted.metadata.name).toBe(owned.name)
  expect(submitted.spec.model).toEqual({ provider: 'openai', name: fixture.modelName })
  expect(submitted.spec.secretRef).toBe(fixture.secretName)
  expect(
    owned.contextNames.has(submitted.spec.contextRef),
    'The linked context must have been created successfully by this UI run'
  ).toBe(true)
  await expect(page).toHaveURL(
    new RegExp(`${escapeRegex(CONTROL_ROUTES.agents.detail(owned.name))}(?:/overview)?$`)
  )
  await expect(
    page.getByRole('heading', { name: `Agent: ${owned.name}`, exact: true })
  ).toBeVisible()
  await expect(page.getByRole('region', { name: 'Agent identity' })).toContainText(owned.name)
  await expect(page.getByRole('region', { name: 'Configuration', exact: true })).toContainText(
    fixture.modelName
  )
}

async function withOwnedAgent(
  page: Page,
  fixture: AgentFixture,
  journey: (owned: OwnedAgent) => Promise<void>
): Promise<void> {
  const owned: OwnedAgent = {
    name: uniqueE2EName('qa-rate-limit'),
    contextNames: new Set(),
    hostCreated: false,
  }
  const trackCreate = (response: Response) => {
    if (response.request().method() !== 'POST' || ![200, 201].includes(response.status())) return
    const path = apiPath(response.url())
    if (path !== '/api/v1/admin/hosts' && path !== '/api/v1/admin/contexts') return
    const body = response.request().postDataJSON()
    const name = body?.metadata?.name
    if (path === '/api/v1/admin/hosts' && name === owned.name) owned.hostCreated = true
    if (
      path === '/api/v1/admin/contexts' &&
      typeof name === 'string' &&
      new RegExp(`^${escapeRegex(owned.name)}-\\d{5}$`).test(name)
    )
      owned.contextNames.add(name)
  }
  page.on('response', trackCreate)
  let journeyFailure: unknown
  try {
    await test.step('sign in and create a test-owned static agent through the wizard', async () => {
      await signIn(page)
      await createAgent(page, owned, fixture)
    })
    await journey(owned)
  } catch (error) {
    journeyFailure = error
    throw error
  } finally {
    page.off('response', trackCreate)
    // The ledger contains only successful creates observed in this execution.
    // A wizard compensation may have removed a context already; 404 is allowed.
    const failures: Error[] = []
    const resources = [
      ...(owned.hostCreated ? [`/api/v1/admin/hosts/${encodeURIComponent(owned.name)}`] : []),
      ...Array.from(
        owned.contextNames,
        name => `/api/v1/admin/contexts/${encodeURIComponent(name)}`
      ),
    ]
    // The journey signs out and back in, so a failure between the two leaves the
    // browser session logged out. Cleanup authenticates on its own.
    if (resources.length > 0) {
      const { status } = await directApi(page.request, 'POST', '/api/v1/admin/auth/login', {
        ...adminCredentials(),
      })
      if (status !== 200) failures.push(new Error(`Cleanup login failed: HTTP ${status}`))
    }
    for (const path of failures.length > 0 ? [] : resources) {
      try {
        const { status } = await directApi(page.request, 'DELETE', path)
        if (![200, 204, 404].includes(status))
          throw new Error(`Owned-resource cleanup failed: ${path}, HTTP ${status}`)
      } catch (error) {
        failures.push(error instanceof Error ? error : new Error('Owned-resource cleanup failed'))
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(
        [...(journeyFailure === undefined ? [] : [journeyFailure]), ...failures],
        // Playwright prints only the message, so name every cause in it.
        `This run left owned resources requiring cleanup: ${failures
          .map(failure => failure.message)
          .join(
            '; '
          )}${journeyFailure instanceof Error ? `; journey: ${journeyFailure.message}` : ''}`
      )
    }
  }
}

function waitForBundle(page: Page, name: string): Promise<Response> {
  // The bundle is an observed UI read. Validate its domain payload below;
  // no request is issued from the test and no internal state is fabricated.
  return page.waitForResponse(response =>
    isRead(response, `/api/v1/admin/hosts/${encodeURIComponent(name)}/detail`)
  )
}

async function assertSavedBundle(
  response: Response,
  owned: OwnedAgent,
  fixture: AgentFixture
): Promise<void> {
  assertOwnedResponse(response)
  expect(response.status()).toBe(200)
  const bundle = await response.json()
  expect(bundle.host.metadata.name).toBe(owned.name)
  expect(bundle.host.spec.model).toEqual({ provider: 'openai', name: fixture.modelName })
  expect(bundle.host.spec.secretRef).toBe(fixture.secretName)
  expect(owned.contextNames.has(bundle.host.spec.contextRef)).toBe(true)
  expect(bundle.agentUsers).toEqual([])
  expect(bundle.agentTeams).toEqual([])
}

async function selectOwnedAgent(
  page: Page,
  owned: OwnedAgent,
  fixture: AgentFixture
): Promise<void> {
  await openAgents(page)
  const row = page.getByRole('row', { name: `Open agent ${owned.name}`, exact: true })
  await expect(row).toBeVisible()
  await expect(row).toContainText(owned.name)
  const bundle = waitForBundle(page, owned.name)
  await row.click()
  await assertSavedBundle(await bundle, owned, fixture)
  await expect(page).toHaveURL(
    new RegExp(`${escapeRegex(CONTROL_ROUTES.agents.detail(owned.name))}(?:/overview)?$`)
  )
  await expect(
    page.getByRole('heading', { name: `Agent: ${owned.name}`, exact: true })
  ).toBeVisible()
}

async function agentSections(page: Page, owned: OwnedAgent, fixture: AgentFixture): Promise<void> {
  const tabs = page.getByRole('tablist', { name: 'Agent sections' })
  for (const [label, slug] of [
    ['Overview', 'overview'],
    ['Identity', 'identity'],
    ['Access', 'access'],
    ['Connectors', 'connectors'],
    ['Models & creds', 'model'],
  ]) {
    await test.step(`open agent ${label} through the visible section tab`, async () => {
      const access =
        label === 'Access'
          ? page.waitForResponse(response =>
              isRead(response, `/api/v1/admin/agents/${encodeURIComponent(owned.name)}/users`)
            )
          : undefined
      const personalization =
        label === 'Identity'
          ? page.waitForResponse(response =>
              isRead(
                response,
                `/api/v1/admin/hosts/${encodeURIComponent(owned.name)}/personalization`
              )
            )
          : undefined
      const tab = tabs.getByRole('tab', { name: label, exact: true })
      await tab.click()
      await expect(page).toHaveURL(
        new RegExp(`${escapeRegex(CONTROL_ROUTES.agents.tab(owned.name, slug))}$`)
      )
      await expect(tab).toHaveAttribute('aria-selected', 'true')
      await expect(
        page.getByRole('heading', { name: `Agent: ${owned.name}`, exact: true })
      ).toBeVisible()
      if (label === 'Overview') {
        await expect(page.getByRole('region', { name: 'Agent identity' })).toContainText(owned.name)
        await expect(
          page.getByRole('region', { name: 'Configuration', exact: true })
        ).toContainText(fixture.modelName)
        await expect(page.getByRole('region', { name: 'Connectors', exact: true })).toContainText(
          'No connectors attached.'
        )
      } else if (label === 'Identity') {
        const response = await personalization!
        assertOwnedResponse(response)
        expect(response.status()).toBe(200)
        const identity = page.getByRole('region', { name: 'Admin-managed identity files' })
        await expect(identity).toBeVisible()
        await expect(
          identity.getByRole('heading', { name: 'IDENTITY.md', exact: true })
        ).toBeVisible()
        await expect(identity.getByRole('alert')).toHaveCount(0)
      } else if (label === 'Access') {
        const response = await access!
        expect(response.status()).toBe(200)
        expect((await response.json()).items).toEqual([])
        await expect(
          page
            .getByRole('region', { name: 'Access', exact: true })
            .getByText('No members have access yet.', { exact: true })
        ).toBeVisible()
      } else if (label === 'Connectors') {
        await expect(
          page.getByText('Connectors available to this agent.', { exact: true })
        ).toBeVisible()
        await expect(
          page.getByRole('cell', { name: 'No connectors attached yet.', exact: true })
        ).toBeVisible()
      } else {
        await expect(
          page
            .getByRole('region', { name: 'LLM configuration summary' })
            .getByText(fixture.modelName, { exact: true })
        ).toBeVisible()
        await expect(page.getByRole('button', { name: 'Edit', exact: true })).toBeEnabled()
      }
    })
  }
}

async function assertCapabilities(response: Response, fixture: AgentFixture): Promise<void> {
  assertOwnedResponse(response)
  expect(response.status()).toBe(200)
  const headers = response.headers()
  expect(
    headers['x-ratelimit-limit'],
    'The observed runtime limit must match the declared external configuration'
  ).toBe(String(fixture.quota))
  expect(headers['ratelimit-policy']).toBe(`${fixture.quota};w=60`)
  const body = await response.json()
  for (const provider of ['codex-subscription', 'grok-subscription']) {
    expect(
      body.providers?.[provider]?.enabled,
      `Enable both provider capabilities in the owned fixture; ${provider} is unavailable`
    ).toBe(true)
  }
}

async function firstEditor(page: Page, fixture: AgentFixture): Promise<Response[]> {
  const capabilities = page.waitForResponse(response => isRead(response, CAPABILITIES))
  const reads = [
    capabilities,
    ...INVENTORIES.map(path => page.waitForResponse(response => isRead(response, path))),
  ]
  // Attach rejection handlers to every pending wait before fixture validation.
  // A disabled capability fails clearly before waiting for absent inventories.
  const completed = Promise.allSettled(reads)
  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Edit model & credentials', exact: true })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByLabel('Current model', { exact: true })).toContainText(fixture.modelName)
  await assertCapabilities(await capabilities, fixture)
  const responses = (await completed).map(result => {
    if (result.status === 'rejected') throw result.reason
    return result.value
  })
  await expect(
    dialog.getByRole('status').filter({ hasText: 'Loading subscription options…' })
  ).toHaveCount(0)
  return responses
}

async function cancelEditor(page: Page, owned: OwnedAgent, fixture: AgentFixture): Promise<void> {
  const bundle = waitForBundle(page, owned.name)
  await page
    .getByRole('dialog', { name: 'Edit model & credentials', exact: true })
    .getByRole('button', { name: 'Cancel', exact: true })
    .click()
  await assertSavedBundle(await bundle, owned, fixture)
  await expect(
    page.getByRole('dialog', { name: 'Edit model & credentials', exact: true })
  ).toHaveCount(0)
  await expect(
    page
      .getByRole('region', { name: 'LLM configuration summary' })
      .getByText(fixture.modelName, { exact: true })
  ).toBeVisible()
}

async function catalogForms(page: Page, owned: OwnedAgent): Promise<void> {
  const nav = page.getByRole('navigation', { name: 'Main sections' })
  const models = page.waitForResponse(response => isRead(response, '/api/v1/admin/llm-models'))
  await nav.getByRole('link', { name: 'LLM Models', exact: true }).click()
  expect((await models).status()).toBe(200)
  await expect(page).toHaveURL(new RegExp(`${escapeRegex(CONTROL_ROUTES.llmModels.root)}$`))
  await expect(page.getByRole('tab', { name: CATALOG_TAB })).toHaveAttribute(
    'aria-selected',
    'true'
  )
  await page.getByRole('button', { name: 'Add model', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`${escapeRegex(CONTROL_ROUTES.llmModels.new)}$`))
  await expect(page.getByRole('heading', { name: 'Add allowed model', exact: true })).toBeVisible()
  const provider = page.getByRole('combobox', { name: PROVIDER_FIELD })
  await expect(
    provider.getByRole('option', { name: 'xAI Grok Subscription', exact: true })
  ).toHaveCount(1)
  await provider.selectOption('grok-subscription')
  await expect(provider).toHaveValue('grok-subscription')
  await page.getByLabel(MODEL_FIELD).fill(`${owned.name}-model-draft`)
  await expect(page.getByLabel(MODEL_FIELD)).toHaveValue(`${owned.name}-model-draft`)
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`${escapeRegex(CONTROL_ROUTES.llmModels.root)}$`))

  const cost = nav.getByRole('button', { name: 'Cost & Usage', exact: true })
  if ((await cost.getAttribute('aria-expanded')) !== 'true') await cost.click()
  await expect(cost).toHaveAttribute('aria-expanded', 'true')
  const prices = page.waitForResponse(response => isRead(response, '/api/v1/admin/llm-prices'))
  await nav.getByRole('link', { name: 'LLM Prices', exact: true }).click()
  expect((await prices).status()).toBe(200)
  await expect(page).toHaveURL(new RegExp(`${escapeRegex(CONTROL_ROUTES.costAndUsage.llmPrices)}$`))
  await page.getByRole('button', { name: 'Add price', exact: true }).click()
  await expect(page).toHaveURL(
    new RegExp(`${escapeRegex(CONTROL_ROUTES.costAndUsage.newLlmPrice())}$`)
  )
  await expect(page.getByRole('heading', { name: 'Add LLM price', exact: true })).toBeVisible()
  await expect(
    page
      .getByRole('combobox', { name: PROVIDER_FIELD })
      .getByRole('option', { name: 'xAI Grok Subscription', exact: true })
  ).toHaveCount(1)
  await page.getByLabel(MODEL_FIELD).fill(`${owned.name}-price-draft`)
  await expect(page.getByLabel(MODEL_FIELD)).toHaveValue(`${owned.name}-price-draft`)
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`${escapeRegex(CONTROL_ROUTES.costAndUsage.llmPrices)}$`))

  const budgets = page.waitForResponse(response => isRead(response, '/api/v1/admin/budgets'))
  await nav.getByRole('link', { name: 'Token Budgets', exact: true }).click()
  expect((await budgets).status()).toBe(200)
  await expect(page).toHaveURL(
    new RegExp(`${escapeRegex(CONTROL_ROUTES.costAndUsage.tokenBudgets)}$`)
  )
  await page.getByRole('button', { name: 'New budget', exact: true }).click()
  await expect(page).toHaveURL(
    new RegExp(`${escapeRegex(CONTROL_ROUTES.costAndUsage.newTokenBudget)}$`)
  )
  await expect(page.getByRole('heading', { name: 'New token budget', exact: true })).toBeVisible()
  await page.getByLabel(NAME_FIELD).fill(`${owned.name}-budget-draft`)
  await page.getByLabel(UNIT_FIELD).selectOption('tokens')
  await page
    .getByRole('combobox', { name: 'Add Provider to scope', exact: true })
    .selectOption('grok-subscription')
  await expect(
    page.getByRole('button', {
      name: 'Remove xAI Grok Subscription from Provider scope',
      exact: true,
    })
  ).toBeVisible()
  await expect(page.getByLabel(NAME_FIELD)).toHaveValue(`${owned.name}-budget-draft`)
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(page).toHaveURL(
    new RegExp(`${escapeRegex(CONTROL_ROUTES.costAndUsage.tokenBudgets)}$`)
  )
}

test.describe('optional QA recorder: administrative rate-limit journeys', () => {
  test('normal navigation reuses subscription reads and preserves the agent', async ({
    page,
  }, testInfo) => {
    const fixture = fixtureFor('normal')
    const entireJourney = observeReads(page)
    try {
      await withOwnedAgent(page, fixture, async owned => {
        await test.step('start a fresh visible session and navigate the owned agent without optional subscription reads', async () => {
          await signOut(page)
          const coldSession = observeReads(page)
          try {
            await signIn(page)
            await selectOwnedAgent(page, owned, fixture)
            await agentSections(page, owned, fixture)
            expect(
              coldSession.snapshot(),
              'Ordinary agent sections must issue zero optional subscription GETs'
            ).toEqual([])
            const editorOpenedAt = Date.now()
            const responses = await firstEditor(page, fixture)
            expect(responses.map(response => response.status())).toEqual([200, 200, 200])
            expect(
              coldSession
                .snapshot()
                .map(read => read.path)
                .sort()
            ).toEqual([CAPABILITIES, ...INVENTORIES].sort())
            await cancelEditor(page, owned, fixture)
            expect(
              Date.now() - editorOpenedAt,
              'Reopen must occur within the actual 30-second reuse window'
            ).toBeLessThan(METADATA_REUSE_MS)
            await page.getByRole('button', { name: 'Edit', exact: true }).click()
            const dialog = page.getByRole('dialog', {
              name: 'Edit model & credentials',
              exact: true,
            })
            await expect(dialog).toBeVisible()
            await expect(dialog.getByLabel('Current model', { exact: true })).toContainText(
              fixture.modelName
            )
            await expect(
              dialog.getByRole('status').filter({ hasText: 'Loading subscription options…' })
            ).toHaveCount(0)
            await expect(dialog.getByRole('alert')).toHaveCount(0)
            await cancelEditor(page, owned, fixture)
            expect(
              coldSession.snapshot(),
              'Reopening within TTL must reuse all three reads'
            ).toHaveLength(3)
            await agentSections(page, owned, fixture)
            expect(
              coldSession.snapshot(),
              'Repeating representative sections must not reload subscription inventories'
            ).toHaveLength(3)
            await catalogForms(page, owned)
            expect(
              coldSession.snapshot().filter(read => read.path !== CAPABILITIES),
              'Catalog forms discover capabilities without listing either provider inventory'
            ).toHaveLength(2)
            expect(coldSession.snapshot().every(read => read.status === 200)).toBe(true)
            await screenshotAndLog(page, testInfo, 'admin-rate-limit-normal')
          } finally {
            coldSession.stop()
          }
        })
      })
      expect(
        entireJourney.throttles,
        'The configured normal workload must not receive an administrative 429'
      ).toEqual([])
    } finally {
      entireJourney.stop()
    }
  })

  test('real 429 preserves the model draft and recovers after Retry-After', async ({
    page,
  }, testInfo) => {
    const fixture = fixtureFor('overload')
    await withOwnedAgent(page, fixture, async owned => {
      await signOut(page)
      const coldSession = observeReads(page)
      try {
        await signIn(page)
        await selectOwnedAgent(page, owned, fixture)
        await agentSections(page, owned, fixture)
        expect(
          coldSession.snapshot(),
          'Ordinary agent sections must not spend the low subscription quota'
        ).toEqual([])
        const responses = await firstEditor(page, fixture)
        expect(responses.map(response => response.status()).sort()).toEqual([200, 200, 429])
        expect(
          coldSession
            .snapshot()
            .map(read => read.path)
            .sort()
        ).toEqual([CAPABILITIES, ...INVENTORIES].sort())
        const limited = responses.find(response => response.status() === 429)!
        const retryAfter = Number(limited.headers()['retry-after'])
        expect(
          Number.isSafeInteger(retryAfter),
          'A real throttle must provide numeric Retry-After'
        ).toBe(true)
        expect(retryAfter).toBeGreaterThan(0)
        expect(retryAfter).toBeLessThanOrEqual(60)
        const body = await limited.json()
        expect(body.code).toBe('rate_limited')
        expect(body.retryAfterSeconds).toBe(retryAfter)
        expect(body.message).toMatch(/try again in \d+ seconds/i)
        // Anchor the deadline on the 429's arrival, not on the moment every
        // initial response has settled: a slower sibling response would
        // otherwise push the expected deadline past a correct recovery.
        const limitedRead = coldSession.snapshot().find(read => read.status === 429)
        expect(limitedRead?.respondedAtMs, 'The 429 arrival time was recorded').toBeDefined()
        const retryAt = limitedRead!.respondedAtMs! + retryAfter * 1_000
        const dialog = page.getByRole('dialog', { name: 'Edit model & credentials', exact: true })
        const alert = dialog.getByRole('alert')
        await expect(alert).toContainText(/(?:try again|retry) in \d+ seconds/i)
        await expect(alert.getByRole('button', { name: 'Retry', exact: true })).toBeVisible()
        await selectModel(
          page,
          dialog.getByLabel('Current model', { exact: true }),
          fixture.draftModelName
        )
        await expect(
          page.getByRole('heading', {
            name: `Agent: ${owned.name}`,
            exact: true,
            includeHidden: true,
          })
        ).toBeVisible()
        await screenshotAndLog(page, testInfo, 'admin-rate-limit-real-429-draft')

        // The editor recovers on its own at the deadline supplied by the real
        // guard: the shared background recovery rereads the denied inventory and
        // the alert, with its Retry button, goes away without a click. Clicking
        // Retry here would race that recovery. Each reread must start at or
        // after the deadline; the tolerance covers the delay between the
        // browser's events and Playwright reporting them.
        const readsBeforeDeadline = 3
        await expect(dialog.getByRole('alert')).toHaveCount(0, {
          timeout: retryAfter * 1_000 + 15_000,
        })
        await expect(
          dialog.getByRole('status').filter({ hasText: 'Loading subscription options…' })
        ).toHaveCount(0)
        const recoveryStarts = coldSession
          .snapshot()
          .slice(readsBeforeDeadline)
          .map(read => read.startedAtMs - retryAt)
        expect(recoveryStarts.length, 'Recovery rereads the denied inventory').toBeGreaterThan(0)
        expect(
          Math.min(...recoveryStarts),
          'No automatic recovery read starts before the Retry-After deadline'
        ).toBeGreaterThanOrEqual(-1_000)
        await expect(dialog.getByLabel('Current model', { exact: true })).toContainText(
          fixture.draftModelName
        )
        const afterDeadline = coldSession.snapshot().slice(readsBeforeDeadline)
        expect(
          afterDeadline.map(read => read.status),
          'No read after the Retry-After deadline is throttled again'
        ).not.toContain(429)
        expect(
          afterDeadline.length,
          'The automatic recovery stays within one quota window'
        ).toBeLessThanOrEqual(fixture.quota)
        expect(
          afterDeadline.every(read => read.path !== CAPABILITIES),
          'Recovery reloads only inventories'
        ).toBe(true)
        expect(coldSession.snapshot().filter(read => read.path === CAPABILITIES)).toHaveLength(1)
        await screenshotAndLog(page, testInfo, 'admin-rate-limit-recovered-draft')
        const readsAfterRecovery = coldSession.snapshot().length
        await cancelEditor(page, owned, fixture)
        await agentSections(page, owned, fixture)
        expect(
          coldSession.snapshot(),
          'Agent identity/access/connectors stay usable after the real throttle'
        ).toHaveLength(readsAfterRecovery)
      } finally {
        coldSession.stop()
      }
    })
  })
})
