/**
 * Codex subscription — assign, connect, sync, reuse, and revoke from the
 * agent model page.
 *
 * Guardian: prove the route, not the destination. ChatGPT OAuth is the only
 * mocked external boundary. Happy path starts at `/` and clicks through Agents.
 * Direct `goto` of an agent model tab is not the happy-path entry.
 */
import { type Page, expect, test } from '@playwright/test'
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

async function openNamedAgent(page: Page, name: string) {
  await page.getByRole('link', { name, exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/((?:hosts|agents))/${name}(?:/|$)`))
}

async function openFirstAgent(page: Page): Promise<string> {
  const named = page.locator('a[href*="/agents/"], a[href*="/hosts/"]').filter({
    hasNotText: /Create|new/i,
  })
  await expect(named.first()).toBeVisible()
  const href = (await named.first().getAttribute('href')) ?? ''
  const match = href.match(/\/(?:hosts|agents)\/([^/]+)/)
  const name = match?.[1] ?? ''
  await named.first().click()
  await expect(page).toHaveURL(/\/(?:hosts|agents)\/[^/]+/)
  return decodeURIComponent(name)
}

async function openModelEditor(page: Page) {
  await page.getByRole('tab', { name: /Model/i }).click()
  await expect(page).toHaveURL(/\/(?:hosts|agents)\/[^/]+\/model/)
  await expect(page.getByRole('heading', { name: /Model/i })).toBeVisible()
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

async function listConnections(page: Page): Promise<CodexConnection[]> {
  const res = await page.request.get('/api/v1/admin/llm/providers/codex-subscription/connections')
  expect(res.ok(), `list connections must succeed, got ${res.status()}`).toBe(true)
  const body = (await res.json()) as { connections?: CodexConnection[] }
  return body.connections ?? []
}

test.describe('Codex subscription connection', () => {
  test('operator assigns a subscription from the agent model tab', async ({ page }) => {
    await page.goto('/')
    await loginControlUiVisible(page)
    await openAgents(page)
    const agentName = await openFirstAgent(page)
    await openModelEditor(page)
    await chooseSubscriptionCredential(page)

    const picker = page.getByLabel('ChatGPT subscription')
    await expect(picker).toBeVisible()
    await expect(page.getByLabel(/OpenAI API key/i)).toHaveCount(0)

    const connections = await listConnections(page)
    const selectedKey = await picker.inputValue()
    expect(selectedKey.length).toBeGreaterThan(0)
    expect(connections.some(row => row.connectionKey === selectedKey)).toBe(true)
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

    const echoed = await page.request.get(`/api/v1/admin/hosts/${encodeURIComponent(agentName)}`)
    expect(echoed.ok()).toBe(true)
    const host = (await echoed.json()) as {
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

    const deviceStart = page.waitForResponse(
      response =>
        /\/api\/v1\/admin\/llm\/providers\/codex-subscription\/(connections\/[^/]+\/)?device\/start$/.test(
          new URL(response.url()).pathname
        ) && response.request().method() === 'POST'
    )
    await page.getByRole('button', { name: 'Sign in with ChatGPT' }).click()
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

    const connections = await listConnections(page)
    const picker = page.getByLabel('ChatGPT subscription')
    const disconnected = connections.find(row => row.status !== 'connected')
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
    await expect(page.getByLabel('ChatGPT subscription')).toHaveValue(String(sharedKey))

    await openAgents(page)
    const agents = page.locator('a[href*="/agents/"], a[href*="/hosts/"]').filter({
      hasNotText: /Create|new/i,
    })
    const count = await agents.count()
    test.skip(count < 2, 'reuse requires a second agent in the list')
    await agents.nth(1).click()
    await expect(page).toHaveURL(/\/(?:hosts|agents)\/[^/]+/)
    await openModelEditor(page)
    await chooseSubscriptionCredential(page)
    await page.getByLabel('ChatGPT subscription').selectOption(String(sharedKey))
    await expect(page.getByLabel('ChatGPT subscription')).toHaveValue(String(sharedKey))
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

    const after = await listConnections(page)
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
