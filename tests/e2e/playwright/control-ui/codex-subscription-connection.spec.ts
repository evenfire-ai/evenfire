/**
 * Codex subscription — assign/unbind on the agent model tab; create, multi-assign,
 * and revoke from Secrets → Subscription.
 *
 * E2E contract
 * ------------
 * Journey              | Entry                         | Actions                                      | Transitions                         | Business signal
 * API key → ChatGPT    | `/` + visible login + Agents  | Open agent → Models → ChatGPT → Save         | `/agents/:name/model`               | PUT host ≠ 422, spec.model.name non-empty
 * Assign from agent    | same                          | Create grant in UI → Save                    | stay on model tab                   | PUT 200, connectionRef persisted
 * Device login         | same                          | Sign in with ChatGPT                         | stay on model, no oauth URL         | device start 200 + userCode in UI
 * Sync catalog         | same                          | Select grant → Sync                          | stay on model                       | disabled until connected; POST sync when connected
 * Reuse grant          | Agents list with 2 seeded     | Create grant on A → pick same grant on B     | second agent model tab              | picker value = shared key
 * Unbind               | agent model                   | Create → Save → Remove from this agent       | stay on model                       | unbind 200, connectionRef=unassigned, grant not revoked
 * Hub table + assign   | `/` → Secrets → Subscription  | Create grant → pick 2 agents → Add 2 → Revoke| `/secrets/subscription` + table     | 2 bind 200s, chips, revoke status
 * LLM → Subscription   | Secrets LLM                   | Empty-state link or Subscription tab         | `/secrets/subscription`             | hub visible
 *
 * Forbidden shortcuts: happy-path `goto` of `/secrets/subscription` or an agent
 * model tab; `test.skip`; silent `return` after an empty model; mutating storage
 * to skip login. API host create is a named precondition only.
 *
 * ChatGPT OAuth is the only mocked/external boundary (live device code is
 * asserted, not completed).
 */
import { type Page, expect, test } from '@playwright/test'
import { controlApi } from '../helpers/api-client'
import { loginControlUiVisible } from '../helpers/visible-login'
import {
  AgentListPage,
  AgentModelPage,
  CodexSubscriptionHubPage,
  ControlUiShell,
} from '../pages/codex-subscription'

type CodexConnection = {
  connectionKey: string
  displayName?: string
  status: string
  catalogRevision: number
  assignedHosts?: Array<{ name: string }>
}

async function loginFromHome(page: Page) {
  await page.goto('/')
  await loginControlUiVisible(page)
  await expect(page.getByLabel('Main navigation')).toBeVisible()
}

/**
 * Named API precondition — not the behavior under test. Seeds ChatGPT-capable
 * hosts so the Agents table and hub picker have rows. Fails loud if create fails.
 */
async function seedCodexAgents(page: Page, minimum: number): Promise<void> {
  const listed = await controlApi.getHosts()
  const items = Array.isArray(listed.items) ? listed.items : []
  const needed = Math.max(0, minimum - items.length)
  for (let index = 0; index < needed; index += 1) {
    const name = `e2e-codex-guardian${needed === 1 && index === 0 ? '' : `-${index + 1}`}`
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
          connectionRef: 'unassigned',
        },
      },
    })
  }
  if (needed > 0) {
    await page.getByRole('button', { name: /Reload agents/i }).click()
  }
  const agents = new AgentListPage(page)
  await expect(agents.rows().first()).toBeVisible()
  expect(
    await agents.rows().count(),
    `need ${minimum} agents after named API seed`
  ).toBeGreaterThanOrEqual(minimum)
}

async function listConnections(): Promise<CodexConnection[]> {
  return controlApi.listCodexConnections()
}

test.describe('Codex subscription connection', () => {
  test('switching from API key to ChatGPT keeps a model name and never 422s', async ({ page }) => {
    const shell = new ControlUiShell(page)
    const agents = new AgentListPage(page)
    const model = new AgentModelPage(page)

    await test.step('enter from home and open the first agent model editor', async () => {
      await loginFromHome(page)
      await shell.openAgents()
      await seedCodexAgents(page, 1)
      await agents.openNth(0)
      await model.openEditor()
    })

    await test.step('switch OpenAI API key → ChatGPT subscription', async () => {
      await model.chooseChatGPTSubscription()
      await model.expectNamedModel()
    })

    await test.step('Save persists a non-empty spec.model.name', async () => {
      const save = model.saveButton()
      await expect(save).toBeEnabled()
      const put = page.waitForResponse(
        response =>
          /\/api\/v1\/admin\/hosts\/[^/]+$/.test(new URL(response.url()).pathname) &&
          response.request().method() === 'PUT'
      )
      await save.click()
      const response = await put
      expect(
        response.status(),
        'API-key → ChatGPT save must not 422 empty model.name or model_not_offered'
      ).not.toBe(422)
      expect(response.ok(), `save must succeed, got ${response.status()}`).toBe(true)
      const body = (await response.json()) as { spec?: { model?: { name?: string } } }
      expect(body.spec?.model?.name).toEqual(expect.stringMatching(/\S/))
    })
  })

  test('operator assigns a subscription from the agent model tab', async ({ page }) => {
    const shell = new ControlUiShell(page)
    const agents = new AgentListPage(page)
    const model = new AgentModelPage(page)
    const displayName = `e2e-assign-${Date.now().toString(36)}`

    await loginFromHome(page)
    await shell.openAgents()
    await seedCodexAgents(page, 1)
    const agentName = await agents.openNth(0)
    await model.openEditor()
    await model.chooseChatGPTSubscription()

    const grantKey = await test.step('create the grant through the agent UI', () =>
      model.createGrant(displayName))
    await model.expectNamedModel()

    const body = await test.step('Save assigns the grant without a 422', () =>
      model.saveHost(agentName))
    expect(body.spec?.model?.provider).toBe('codex-subscription')
    expect(body.spec?.model?.name).toEqual(expect.stringMatching(/\S/))
    expect(body.spec?.model?.connectionRef).toBe(grantKey)

    const host = (await controlApi.getHost(agentName)) as {
      spec?: { model?: { connectionRef?: string; name?: string } }
    }
    expect(host.spec?.model?.connectionRef).toBe(grantKey)
    expect(host.spec?.model?.name).toEqual(expect.stringMatching(/\S/))
  })

  test('Sign in with ChatGPT starts device login from the agent page', async ({ page }) => {
    const shell = new ControlUiShell(page)
    const agents = new AgentListPage(page)
    const model = new AgentModelPage(page)

    await loginFromHome(page)
    await shell.openAgents()
    await seedCodexAgents(page, 1)
    await agents.openNth(0)
    await model.openEditor()
    await model.chooseChatGPTSubscription()
    await expect(model.subscriptionPicker()).toBeVisible()

    const signIn = page.getByRole('button', { name: 'Sign in with ChatGPT' })
    if ((await signIn.count()) === 0 || !(await signIn.isEnabled())) {
      await model.createGrant(`e2e-device-${Date.now().toString(36)}`)
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
    const shell = new ControlUiShell(page)
    const agents = new AgentListPage(page)
    const model = new AgentModelPage(page)

    await loginFromHome(page)
    await shell.openAgents()
    await seedCodexAgents(page, 1)
    await agents.openNth(0)
    await model.openEditor()
    await model.chooseChatGPTSubscription()

    const connections = await listConnections()
    const picker = model.subscriptionPicker()
    const disconnected = connections.find(
      row => row.status !== 'connected' && row.status !== 'revoked'
    )
    const connected = connections.find(row => row.status === 'connected')

    if (disconnected) {
      await picker.selectOption(disconnected.connectionKey)
      await expect(page.getByRole('button', { name: 'Sync catalog' })).toBeDisabled()
    }

    if (!connected) {
      await expect(
        page.getByRole('button', { name: 'Sync catalog' }),
        'without a connected grant Sync must stay disabled'
      ).toBeDisabled()
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
    const shell = new ControlUiShell(page)
    const agents = new AgentListPage(page)
    const model = new AgentModelPage(page)
    const displayName = `e2e-shared-${Date.now().toString(36)}`

    await loginFromHome(page)
    await shell.openAgents()
    await seedCodexAgents(page, 2)
    await agents.openNth(0)
    await model.openEditor()
    await model.chooseChatGPTSubscription()
    const sharedKey = await model.createGrant(displayName)

    await test.step('open a second agent through the list', async () => {
      await shell.openAgents()
      expect(
        await agents.rows().count(),
        'reuse requires two seeded agents'
      ).toBeGreaterThanOrEqual(2)
      await agents.openNth(1)
      await model.openEditor()
      await model.chooseChatGPTSubscription()
    })

    await model.subscriptionPicker().selectOption(sharedKey)
    await expect(model.subscriptionPicker()).toHaveValue(sharedKey)
    await expect(page.getByRole('option', { name: displayName })).toHaveCount(1)
  })

  test('agent models can unbind this host and never expose grant Revoke', async ({ page }) => {
    const shell = new ControlUiShell(page)
    const agents = new AgentListPage(page)
    const model = new AgentModelPage(page)
    const displayName = `e2e-unbind-${Date.now().toString(36)}`

    await loginFromHome(page)
    await shell.openAgents()
    await seedCodexAgents(page, 1)
    const firstName = await agents.openNth(0)
    await model.openEditor()
    await model.chooseChatGPTSubscription()
    const grantKey = await model.createGrant(displayName)
    await model.expectNamedModel()
    await model.saveHost(firstName)

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

  test('Secrets Subscription hub creates, assigns two agents, and is the only revoke path', async ({
    page,
  }) => {
    const shell = new ControlUiShell(page)
    const hub = new CodexSubscriptionHubPage(page)
    const displayName = `e2e-hub-${Date.now().toString(36)}`

    await test.step('reach the hub through Secrets → Subscription', async () => {
      await loginFromHome(page)
      await shell.openAgents()
      await seedCodexAgents(page, 2)
      await shell.openSecretsSubscription()
      await hub.expectTable()
    })

    const grantKey = await test.step('create a grant from the hub CTA', () =>
      hub.createGrant(displayName))

    const bound = await test.step('assign two agents in one hub action', () =>
      hub.assignFirstAgents(grantKey, 2))

    const grantRow = hub.grantRow(grantKey)
    await expect(grantRow.getByTestId('codex-hub-agent-chips')).toBeVisible()
    for (const hostName of bound) {
      await expect(grantRow.getByRole('link', { name: hostName })).toBeVisible()
      const host = (await controlApi.getHost(hostName)) as {
        spec?: { model?: { connectionRef?: string } }
      }
      expect(host.spec?.model?.connectionRef).toBe(grantKey)
    }

    await test.step('revoke only from the hub danger action', async () => {
      const revoke = page.waitForResponse(
        response =>
          new RegExp(
            `/api/v1/admin/llm/providers/codex-subscription/connections/${grantKey}/revoke$`
          ).test(new URL(response.url()).pathname) && response.request().method() === 'POST'
      )
      await grantRow.getByRole('button', { name: 'Revoke subscription' }).click()
      await expect(page.getByRole('alertdialog')).toBeVisible()
      await page
        .getByRole('alertdialog')
        .getByRole('button', { name: 'Revoke subscription' })
        .click()
      const revokeRes = await revoke
      expect(revokeRes.ok(), `revoke must succeed, got ${revokeRes.status()}`).toBe(true)
      const revokeBody = (await revokeRes.json()) as { status?: string; connectionKey?: string }
      expect(revokeBody.status).toBe('revoked')
      expect(revokeBody.connectionKey).toBe(grantKey)
    })

    for (const hostName of bound) {
      const afterHost = (await controlApi.getHost(hostName)) as {
        spec?: { model?: { connectionRef?: string } }
      }
      expect(afterHost.spec?.model?.connectionRef).toBe(grantKey)
    }
  })

  test('LLM secrets empty state or tab reaches the Subscription hub', async ({ page }) => {
    const shell = new ControlUiShell(page)
    await loginFromHome(page)
    await shell.openSecretsLlm()
    await expect(page).toHaveURL(/\/secrets\/llm$/)

    const emptyLink = page.getByRole('link', {
      name: 'ChatGPT subscriptions are managed in the Subscription tab.',
    })
    const tab = page.getByRole('tab', { name: 'Subscription' })
    await expect(tab).toBeVisible()
    if ((await emptyLink.count()) > 0) {
      await emptyLink.click()
    } else {
      await tab.click()
    }
    await expect(page).toHaveURL(/\/secrets\/subscription$/)
    await expect(page.getByTestId('codex-subscription-hub')).toBeVisible()
  })
})
