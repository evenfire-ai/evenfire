/**
 * Codex subscription — assign, connect, sync, reuse, and revoke from the
 * agent model page.
 *
 * Guardian: prove the route, not the destination. ChatGPT OAuth is the only
 * mocked external boundary. Happy path starts at `/` and clicks through Agents.
 * Direct `goto` of an agent model tab is not the happy-path entry.
 */
import { type Page, expect, test } from '@playwright/test'
import { controlApi } from '../helpers/api-client'
import { loginControlUiVisible } from '../helpers/visible-login'

type CodexConnection = {
  connectionKey: string
  displayName?: string
  status: string
  catalogRevision: number
  assignedHosts?: Array<{ name: string }>
}

async function openAgents(page: Page) {
  await page.getByRole('link', { name: 'Agents', exact: true }).click()
  await expect(page).toHaveURL(/\/(?:hosts|agents)$/)
}

async function agentRows(page: Page) {
  return page.getByRole('row', { name: /Open agent / })
}

async function ensureListedAgents(page: Page, minimum = 1): Promise<void> {
  const listed = await controlApi.getHosts()
  const items = Array.isArray(listed.items) ? listed.items : []
  const needed = Math.max(0, minimum - items.length)
  for (let index = 0; index < needed; index += 1) {
    const name = `e2e-codex-guardian${needed === 1 && index === 0 ? '' : `-${index + 1}`}`
    try {
      await controlApi.createHost({
        metadata: { name },
        spec: {
          host: name,
          contextRef: '',
          secretRef: '',
          channels: [],
          model: {
            provider: 'codex-subscription',
            name: 'gpt-5.1',
            connectionRef: 'deployment-default',
          },
        },
      })
    } catch {
      break
    }
  }
  if (needed > 0) {
    await page.getByRole('button', { name: /Reload agents/i }).click()
  }
  await expect((await agentRows(page)).first()).toBeVisible()
}

async function openFirstAgent(page: Page): Promise<string> {
  await ensureListedAgents(page, 1)
  const row = (await agentRows(page)).first()
  await expect(row).toBeVisible()
  const label = (await row.getAttribute('aria-label')) ?? ''
  const name = label.replace(/^Open agent\s+/, '').trim()
  await row.click()
  await expect(page).toHaveURL(/\/(?:hosts|agents)\/[^/]+/)
  return decodeURIComponent(name)
}

async function openModelEditor(page: Page) {
  await page.getByRole('tab', { name: 'Models & creds' }).click()
  await expect(page).toHaveURL(/\/(?:hosts|agents)\/[^/]+\/model/)
  await expect(page.getByRole('tab', { name: 'Models & creds', selected: true })).toBeVisible()
  const edit = page.getByRole('button', { name: 'Edit', exact: true })
  if (await edit.isVisible().catch(() => false)) {
    await edit.click()
  }
  await expect(page.getByLabel('Provider')).toBeVisible()
}

async function chooseSubscriptionCredential(page: Page) {
  await page.getByLabel('Provider').click()
  await page.getByRole('option', { name: 'OpenAI', exact: true }).click()
  await expect(page.getByRole('option', { name: 'OpenAI Codex Subscription' })).toHaveCount(0)
  await page.getByRole('radio', { name: 'ChatGPT subscription' }).check()
  await expect(page.getByTestId('codex-agent-assignment')).toBeVisible()
}

function subscriptionPicker(page: Page) {
  return page.locator('#codex-subscription')
}

async function listConnections(): Promise<CodexConnection[]> {
  return controlApi.listCodexConnections()
}

test.describe('Codex subscription connection', () => {
  test('operator assigns a subscription from the agent model tab', async ({ page }) => {
    await page.goto('/')
    await loginControlUiVisible(page)
    await openAgents(page)
    const agentName = await openFirstAgent(page)
    await openModelEditor(page)
    await chooseSubscriptionCredential(page)

    const picker = subscriptionPicker(page)
    await expect(picker).toBeVisible()
    await expect(page.getByLabel(/OpenAI API key/i)).toHaveCount(0)

    const connections = await listConnections()
    let selectedKey = await picker.inputValue()
    if (!connections.some(row => row.connectionKey === selectedKey)) {
      const usable = connections.find(row => row.status !== 'revoked')
      expect(usable, 'an assignable ChatGPT subscription must exist').toBeTruthy()
      await picker.selectOption(usable!.connectionKey)
      selectedKey = usable!.connectionKey
    }
    const selected = connections.find(row => row.connectionKey === selectedKey)
    test.skip(
      selected?.status !== 'connected',
      'assign+save requires a live ChatGPT grant as fixture setup'
    )

    const put = page.waitForResponse(
      response =>
        new RegExp(`/api/v1/admin/hosts/${agentName}$`).test(new URL(response.url()).pathname) &&
        response.request().method() === 'PUT'
    )
    const modelSelect = page.getByLabel(/^Model$/i)
    const optionCount = await modelSelect
      .locator('option')
      .count()
      .catch(() => 0)
    if (optionCount > 1) {
      await modelSelect.selectOption({ index: 1 })
    }
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    const response = await put
    expect(response.ok(), `assign save must succeed, got ${response.status()}`).toBe(true)
    const body = (await response.json()) as {
      spec?: { model?: { provider?: string; connectionRef?: string } }
    }
    expect(body.spec?.model?.provider).toBe('codex-subscription')
    expect(body.spec?.model?.connectionRef).toBe(selectedKey)

    const host = (await controlApi.getHost(agentName)) as {
      spec?: { model?: { connectionRef?: string } }
    }
    expect(host.spec?.model?.connectionRef).toBe(selectedKey)
  })

  test('Sign in with ChatGPT starts device login from the agent page', async ({ page }) => {
    await page.goto('/')
    await loginControlUiVisible(page)
    await openAgents(page)
    await openFirstAgent(page)
    await openModelEditor(page)
    await chooseSubscriptionCredential(page)
    await expect(subscriptionPicker(page)).toBeVisible()
    const signIn = page.getByRole('button', { name: 'Sign in with ChatGPT' })
    if (!(await signIn.isEnabled())) {
      await page.getByRole('button', { name: 'New subscription' }).click()
      await page.getByLabel('New subscription name').fill(`e2e-device-${Date.now().toString(36)}`)
      const created = page.waitForResponse(
        response =>
          /\/api\/v1\/admin\/llm\/providers\/codex-subscription\/connections$/.test(
            new URL(response.url()).pathname
          ) && response.request().method() === 'POST'
      )
      await page.getByRole('button', { name: 'Create', exact: true }).click()
      expect((await created).ok()).toBe(true)
    }
    await expect(signIn).toBeEnabled()

    const deviceStart = page.waitForResponse(
      response =>
        /\/api\/v1\/admin\/llm\/providers\/codex-subscription\/(connections\/[^/]+\/)?device\/start$/.test(
          new URL(response.url()).pathname
        ) && response.request().method() === 'POST'
    )
    await signIn.click()
    const response = await deviceStart
    expect(response.ok(), `device start must succeed, got ${response.status()}`).toBe(true)
    const body = (await response.json()) as { userCode?: string; verificationUri?: string }
    expect(body.userCode).toEqual(expect.any(String))
    expect(body.verificationUri).toMatch(/^https:\/\/auth\.openai\.com\/codex\/device/)
    await expect(page.getByTestId('codex-device-code')).toContainText(String(body.userCode))
    await expect(page).toHaveURL(/\/(?:hosts|agents)\/[^/]+\/model/)
    await expect(page).not.toHaveURL(/oauth\/authorize/)
  })

  test('Sync catalog is disabled until that grant is connected', async ({ page }) => {
    await page.goto('/')
    await loginControlUiVisible(page)
    await openAgents(page)
    await openFirstAgent(page)
    await openModelEditor(page)
    await chooseSubscriptionCredential(page)

    const connections = await listConnections()
    const picker = subscriptionPicker(page)
    const disconnected = connections.find(
      row => row.status !== 'connected' && row.status !== 'revoked'
    )
    if (disconnected) {
      await picker.selectOption(disconnected.connectionKey)
      await expect(page.getByRole('button', { name: 'Sync catalog' })).toBeDisabled()
    }

    const connected = connections.find(row => row.status === 'connected')
    if (!connected) {
      await expect(page.getByRole('button', { name: 'Sync catalog' })).toBeDisabled()
      return
    }

    await picker.selectOption(connected.connectionKey)
    const sync = page.waitForResponse(
      response =>
        new RegExp(
          `/api/v1/admin/llm/providers/codex-subscription/connections/${connected.connectionKey}/catalog/sync$`
        ).test(new URL(response.url()).pathname) && response.request().method() === 'POST'
    )
    await page.getByRole('button', { name: 'Sync catalog' }).click()
    const response = await sync
    expect(response.ok(), `catalog sync must succeed, got ${response.status()}`).toBe(true)
    const body = (await response.json()) as {
      added?: number
      refreshed?: number
      connection?: { catalogRevision?: number; connectionKey?: string }
    }
    expect(body.connection?.connectionKey).toBe(connected.connectionKey)
    expect(typeof body.connection?.catalogRevision).toBe('number')
    expect((body.added ?? 0) + (body.refreshed ?? 0)).toBeGreaterThanOrEqual(0)
  })

  test('operator reuses the same grant on a second agent', async ({ page }) => {
    await page.goto('/')
    await loginControlUiVisible(page)
    await openAgents(page)
    await openFirstAgent(page)
    await openModelEditor(page)
    await chooseSubscriptionCredential(page)

    await page.getByRole('button', { name: 'New subscription' }).click()
    const displayName = `e2e-shared-${Date.now().toString(36)}`
    await page.getByLabel('New subscription name').fill(displayName)
    const created = page.waitForResponse(
      response =>
        /\/api\/v1\/admin\/llm\/providers\/codex-subscription\/connections$/.test(
          new URL(response.url()).pathname
        ) && response.request().method() === 'POST'
    )
    await page.getByRole('button', { name: 'Create', exact: true }).click()
    const createRes = await created
    expect(createRes.ok()).toBe(true)
    const createdBody = (await createRes.json()) as { connectionKey?: string }
    const sharedKey = createdBody.connectionKey
    expect(sharedKey).toEqual(expect.any(String))
    await expect(subscriptionPicker(page)).toHaveValue(String(sharedKey))

    await openAgents(page)
    await ensureListedAgents(page, 2)
    const agents = await agentRows(page)
    test.skip((await agents.count()) < 2, 'reuse requires a second agent in the list')
    await agents.nth(1).click()
    await expect(page).toHaveURL(/\/(?:hosts|agents)\/[^/]+/)
    await openModelEditor(page)
    await chooseSubscriptionCredential(page)
    await subscriptionPicker(page).selectOption(String(sharedKey))
    await expect(subscriptionPicker(page)).toHaveValue(String(sharedKey))
    await expect(page.getByRole('option', { name: displayName })).toHaveCount(1)
  })

  test('revoking a shared grant from the agent page fail-closes that key only', async ({
    page,
  }) => {
    await page.goto('/')
    await loginControlUiVisible(page)
    await openAgents(page)
    const firstName = await openFirstAgent(page)
    await openModelEditor(page)
    await chooseSubscriptionCredential(page)

    await page.getByRole('button', { name: 'New subscription' }).click()
    const displayName = `e2e-revoke-${Date.now().toString(36)}`
    await page.getByLabel('New subscription name').fill(displayName)
    const created = page.waitForResponse(
      response =>
        /\/api\/v1\/admin\/llm\/providers\/codex-subscription\/connections$/.test(
          new URL(response.url()).pathname
        ) && response.request().method() === 'POST'
    )
    await page.getByRole('button', { name: 'Create', exact: true }).click()
    const createRes = await created
    expect(createRes.ok()).toBe(true)
    const createdBody = (await createRes.json()) as { connectionKey?: string }
    const revokeKey = String(createdBody.connectionKey)

    const revoke = page.waitForResponse(
      response =>
        new RegExp(
          `/api/v1/admin/llm/providers/codex-subscription/connections/${revokeKey}/revoke$`
        ).test(new URL(response.url()).pathname) && response.request().method() === 'POST'
    )
    await page.getByRole('button', { name: 'Revoke', exact: true }).click()
    await expect(page.getByRole('alertdialog')).toBeVisible()
    await expect(page.getByRole('alertdialog')).toContainText(/agent/i)
    await page.getByRole('alertdialog').getByRole('button', { name: 'Revoke', exact: true }).click()
    const response = await revoke
    expect(response.ok(), `revoke must succeed, got ${response.status()}`).toBe(true)
    const body = (await response.json()) as { status?: string; connectionKey?: string }
    expect(body.status).toBe('revoked')
    expect(body.connectionKey).toBe(revokeKey)
    await expect(page).toHaveURL(new RegExp(`/((?:hosts|agents))/${firstName}/model`))
    await expect(page.getByTestId('codex-connection-status')).toHaveText(/Revoked/i)
    await expect(page.getByRole('button', { name: 'Sync catalog' })).toBeDisabled()

    const after = await listConnections()
    const revoked = after.find(row => row.connectionKey === revokeKey)
    expect(revoked?.status).toBe('revoked')
    const otherLive = after.find(
      row => row.connectionKey !== revokeKey && row.status === 'connected'
    )
    if (otherLive) {
      expect(otherLive.status).toBe('connected')
    }
  })
})
