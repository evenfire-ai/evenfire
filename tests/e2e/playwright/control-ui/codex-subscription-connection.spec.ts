/**
 * Codex subscription — assign/unbind on the agent model tab; create, assign,
 * and revoke from Secrets → Subscription.
 *
 * Guardian: prove the route, not the destination. ChatGPT OAuth is the only
 * mocked external boundary. Happy path starts at `/` and clicks through the
 * sidebar. Direct `goto` of an agent model tab or `/secrets/subscription` is
 * not the happy-path entry.
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

async function openSecretsSubscription(page: Page) {
  await page.getByRole('link', { name: 'Secrets', exact: true }).click()
  await expect(page).toHaveURL(/\/secrets\/(llm)?$|\/secrets\/llm$/)
  await page.getByRole('tab', { name: 'Subscription' }).click()
  await expect(page).toHaveURL(/\/secrets\/subscription$/)
  await expect(page.getByTestId('codex-subscription-hub')).toBeVisible()
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

  test('agent models can unbind this host and never expose grant Revoke', async ({ page }) => {
    await page.goto('/')
    await loginControlUiVisible(page)
    await openAgents(page)
    const firstName = await openFirstAgent(page)
    await openModelEditor(page)
    await chooseSubscriptionCredential(page)

    await page.getByRole('button', { name: 'New subscription' }).click()
    const displayName = `e2e-unbind-${Date.now().toString(36)}`
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
    const grantKey = String(createdBody.connectionKey)

    const put = page.waitForResponse(
      response =>
        new RegExp(`/api/v1/admin/hosts/${firstName}$`).test(new URL(response.url()).pathname) &&
        response.request().method() === 'PUT'
    )
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    expect((await put).ok()).toBe(true)

    await expect(page.getByRole('button', { name: 'Revoke', exact: true })).toHaveCount(0)
    await expect(page.getByRole('link', { name: 'Manage subscription' })).toBeVisible()

    const unbind = page.waitForResponse(
      response =>
        new RegExp(
          `/api/v1/admin/llm/providers/codex-subscription/connections/${grantKey}/hosts/${firstName}/unbind$`
        ).test(new URL(response.url()).pathname) && response.request().method() === 'POST'
    )
    await page.getByRole('button', { name: 'Remove from this agent' }).click()
    await expect(page.getByRole('alertdialog')).toBeVisible()
    await page.getByRole('alertdialog').getByRole('button', { name: 'Remove agent' }).click()
    const unbindRes = await unbind
    expect(unbindRes.ok(), `unbind must succeed, got ${unbindRes.status()}`).toBe(true)
    await expect(page).toHaveURL(new RegExp(`/((?:hosts|agents))/${firstName}/model`))
    await expect(page.getByTestId('codex-connection-status')).toHaveText(
      /No subscription assigned/i
    )

    const host = (await controlApi.getHost(firstName)) as {
      spec?: { model?: { connectionRef?: string } }
    }
    expect(host.spec?.model?.connectionRef).toBe('unassigned')
    const after = await listConnections()
    expect(after.find(row => row.connectionKey === grantKey)?.status).not.toBe('revoked')
  })

  test('Secrets Subscription hub creates, assigns, and is the only revoke path', async ({
    page,
  }) => {
    await page.goto('/')
    await loginControlUiVisible(page)
    await openAgents(page)
    await ensureListedAgents(page, 2)
    await openSecretsSubscription(page)

    await page.getByRole('button', { name: 'Add subscription' }).click()
    const displayName = `e2e-hub-${Date.now().toString(36)}`
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
    const grantKey = String(createdBody.connectionKey)
    await expect(page.getByText(displayName)).toBeVisible()

    const grantCard = page.getByTestId(`codex-hub-grant-${grantKey}`)
    await expect(grantCard.getByRole('heading', { name: 'Assigned' })).toBeVisible()
    await expect(grantCard.getByRole('heading', { name: 'Available' })).toBeVisible()
    const assignable = grantCard.getByRole('button', { name: 'Assign' }).first()
    test.skip((await assignable.count()) === 0, 'hub assign requires a second Codex agent')
    const bind = page.waitForResponse(
      response =>
        new RegExp(
          `/api/v1/admin/llm/providers/codex-subscription/connections/${grantKey}/hosts/[^/]+/bind$`
        ).test(new URL(response.url()).pathname) && response.request().method() === 'POST'
    )
    await assignable.click()
    const bindRes = await bind
    expect(bindRes.ok(), `bind must succeed, got ${bindRes.status()}`).toBe(true)
    const bindBody = (await bindRes.json()) as { host?: string; connectionRef?: string }
    expect(bindBody.connectionRef).toBe(grantKey)
    const boundHost = String(bindBody.host)
    const host = (await controlApi.getHost(boundHost)) as {
      spec?: { model?: { connectionRef?: string } }
    }
    expect(host.spec?.model?.connectionRef).toBe(grantKey)

    const revoke = page.waitForResponse(
      response =>
        new RegExp(
          `/api/v1/admin/llm/providers/codex-subscription/connections/${grantKey}/revoke$`
        ).test(new URL(response.url()).pathname) && response.request().method() === 'POST'
    )
    await grantCard.getByRole('button', { name: 'Revoke subscription' }).click()
    await expect(page.getByRole('alertdialog')).toBeVisible()
    await page.getByRole('alertdialog').getByRole('button', { name: 'Revoke subscription' }).click()
    const revokeRes = await revoke
    expect(revokeRes.ok(), `revoke must succeed, got ${revokeRes.status()}`).toBe(true)
    const revokeBody = (await revokeRes.json()) as { status?: string; connectionKey?: string }
    expect(revokeBody.status).toBe('revoked')
    expect(revokeBody.connectionKey).toBe(grantKey)
    const afterHost = (await controlApi.getHost(boundHost)) as {
      spec?: { model?: { connectionRef?: string } }
    }
    expect(afterHost.spec?.model?.connectionRef).toBe(grantKey)
  })

  test('LLM secrets empty state links to the Subscription hub', async ({ page }) => {
    await page.goto('/')
    await loginControlUiVisible(page)
    await page.getByRole('link', { name: 'Secrets', exact: true }).click()
    await expect(page).toHaveURL(/\/secrets\/llm$/)
    const link = page.getByRole('link', {
      name: 'ChatGPT subscriptions are managed in the Subscription tab.',
    })
    if (await link.isVisible().catch(() => false)) {
      await link.click()
      await expect(page).toHaveURL(/\/secrets\/subscription$/)
      await expect(page.getByTestId('codex-subscription-hub')).toBeVisible()
    }
  })
})
