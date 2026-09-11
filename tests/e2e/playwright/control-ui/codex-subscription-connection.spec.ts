/**
 * Codex subscription — Secrets LLM nested tabs + one agent Credential select.
 *
 * Journeys J1–J10 from the redesign plan. Auth: `/` + loginControlUiVisible.
 * Terminal `goto` only in J2. No test.skip. No silent return.
 */
import { type Page, expect, test } from '@playwright/test'
import { controlApi } from '../helpers/api-client'
import { loginControlUiVisible } from '../helpers/visible-login'
import {
  AgentListPage,
  AgentModelPage,
  ControlUiShell,
  SecretsLlmSubscriptionsPage,
} from '../pages/codex-subscription'

type CodexConnection = {
  connectionKey: string
  displayName?: string
  defaultModel?: string | null
  status: string
}

async function loginFromHome(page: Page) {
  await page.goto('/')
  await loginControlUiVisible(page)
  await expect(page.getByLabel('Main navigation')).toBeVisible()
}

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
  test('J1 nested LLM tabs open Subscriptions without a sibling Subscription scope', async ({
    page,
  }) => {
    const shell = new ControlUiShell(page)
    const hub = new SecretsLlmSubscriptionsPage(page)
    await loginFromHome(page)
    await shell.openSecretsLlmSubscriptions()
    await hub.expectTable()
    await expect(page.getByRole('tab', { name: 'LLM' })).toBeVisible()
    await expect(page.getByRole('tab', { name: 'Connector' })).toBeVisible()
    await expect(page.getByRole('tab', { name: 'Recipe' })).toBeVisible()
  })

  test('J2 authenticated deep link and legacy redirect; unauth is AuthGate', async ({ page }) => {
    await page.goto('/secrets/llm/subscriptions')
    await expect(page.getByLabel('Username or email')).toBeVisible({ timeout: 20_000 })
    await expect(page.getByRole('button', { name: 'Add subscription' })).toHaveCount(0)

    await page.goto('/')
    await loginControlUiVisible(page)
    await page.goto('/secrets/subscription')
    await expect(page).toHaveURL(/\/secrets\/llm\/subscriptions$/)
    await expect(page.getByRole('tab', { name: 'Subscriptions', selected: true })).toBeVisible()
  })

  test('J3 Create lands on the sync modal, not the table alone', async ({ page }) => {
    const shell = new ControlUiShell(page)
    const hub = new SecretsLlmSubscriptionsPage(page)
    const displayName = `e2e-add-${Date.now().toString(36)}`
    await loginFromHome(page)
    await shell.openSecretsLlmSubscriptions()
    const key = await hub.createGrant(displayName)
    await expect(page).toHaveURL(/\/secrets\/llm\/subscriptions$/)
    await hub.expectConnectModal()
    const listed = await listConnections()
    expect(listed.find(row => row.connectionKey === key)?.displayName).toBe(displayName)
    await hub.closeConnectModal()
    await expect(page.getByRole('cell', { name: displayName, exact: true })).toBeVisible()
  })

  test('J4 Create starts device connect with a usable ChatGPT link and copy', async ({ page }) => {
    const shell = new ControlUiShell(page)
    const hub = new SecretsLlmSubscriptionsPage(page)
    const agents = new AgentListPage(page)
    const model = new AgentModelPage(page)
    const displayName = `e2e-signin-${Date.now().toString(36)}`

    await loginFromHome(page)
    await shell.openSecretsLlmSubscriptions()
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
    const deviceStart = page.waitForResponse(
      response =>
        /\/api\/v1\/admin\/llm\/providers\/codex-subscription\/(connections\/[^/]+\/)?device\/start$/.test(
          new URL(response.url()).pathname
        ) && response.request().method() === 'POST'
    )
    const grantKey = await hub.createGrant(displayName)
    const deviceRes = await deviceStart
    expect(deviceRes.status(), `device start must return 200, got ${deviceRes.status()}`).toBe(200)
    expect(new URL(deviceRes.url()).pathname).toBe(
      `/api/v1/admin/llm/providers/codex-subscription/connections/${grantKey}/device/start`
    )
    const deviceBody = (await deviceRes.json()) as {
      userCode?: string
      verificationUri?: string
    }
    expect(deviceBody.userCode).toBeTruthy()
    expect(deviceBody.verificationUri).toBe('https://auth.openai.com/codex/device')

    const link = page.getByTestId('codex-device-verification-link')
    await expect(link).toHaveAttribute('href', String(deviceBody.verificationUri))
    await expect(link).toHaveAttribute('target', '_blank')
    await expect(link).toHaveAttribute('rel', /noopener/)
    await expect(link).toHaveAttribute('rel', /noreferrer/)
    await expect(page.getByTestId('codex-device-code')).toHaveText(String(deviceBody.userCode))

    await page.getByRole('button', { name: 'Copy code' }).click()
    await expect(page.getByText('Code copied')).toBeVisible()
    await expect
      .poll(async () => page.evaluate(() => navigator.clipboard.readText()))
      .toBe(String(deviceBody.userCode))

    const grant = (await listConnections()).find(row => row.connectionKey === grantKey)
    expect(grant, 'created grant must be listed').toBeTruthy()
    await expect(
      page.getByRole('dialog').getByRole('button', { name: 'Sync catalog' })
    ).toHaveCount(0)
    await expect(
      page.getByRole('dialog').getByRole('group', { name: 'Enabled models' })
    ).toHaveCount(0)

    await hub.closeConnectModal()
    await shell.openAgents()
    await seedCodexAgents(page, 1)
    await agents.openNth(0)
    await model.openEditor()
    await model.expectOneCredentialSelect()
  })

  test('J5 default-model PATCH, then reopen matches the selected default', async ({ page }) => {
    const shell = new ControlUiShell(page)
    const hub = new SecretsLlmSubscriptionsPage(page)
    await loginFromHome(page)
    await shell.openSecretsLlmSubscriptions()
    const connected = (await listConnections()).find(row => row.status === 'connected')
    expect(connected, 'J5 named precondition: a connected grant with a synced catalog').toBeTruthy()
    const grantKey = connected!.connectionKey
    const displayName = connected!.displayName || grantKey

    const modelsGet = page.waitForResponse(
      response =>
        new RegExp(
          `/api/v1/admin/llm/providers/codex-subscription/connections/${grantKey}/models$`
        ).test(new URL(response.url()).pathname) && response.request().method() === 'GET'
    )
    await hub.openGrant(displayName)
    await modelsGet
    await expect(
      page.getByRole('dialog').getByRole('button', { name: 'Sync catalog' })
    ).toHaveCount(0)
    await expect(page.getByRole('dialog').locator('input[type="checkbox"]')).toHaveCount(0)

    await page.getByLabel('Default model').click()
    const defaultOption = page.getByRole('option').first()
    await expect(defaultOption).toBeVisible()
    const defaultName = ((await defaultOption.textContent()) ?? '').trim()
    const patchDefault = page.waitForResponse(
      response =>
        new RegExp(`/api/v1/admin/llm/providers/codex-subscription/connections/${grantKey}$`).test(
          new URL(response.url()).pathname
        ) && response.request().method() === 'PATCH'
    )
    await defaultOption.click()
    await page.getByRole('button', { name: 'Update subscription' }).click()
    const defaultRes = await patchDefault
    expect(defaultRes.ok(), `defaultModel PATCH must succeed, got ${defaultRes.status()}`).toBe(
      true
    )

    const reopened = page.waitForResponse(
      response =>
        new RegExp(
          `/api/v1/admin/llm/providers/codex-subscription/connections/${grantKey}/models$`
        ).test(new URL(response.url()).pathname) && response.request().method() === 'GET'
    )
    await hub.openGrant(displayName)
    await reopened
    if (defaultName) {
      await expect(page.getByLabel('Default model')).toContainText(defaultName)
    }
  })

  test('J6 one Credential select saves subscription or secret without a ChatGPT radio', async ({
    page,
  }) => {
    const shell = new ControlUiShell(page)
    const hub = new SecretsLlmSubscriptionsPage(page)
    const agents = new AgentListPage(page)
    const model = new AgentModelPage(page)
    const displayName = `e2e-cred-${Date.now().toString(36)}`

    await loginFromHome(page)
    await shell.openSecretsLlmSubscriptions()
    const grantKey = await hub.createGrant(displayName)
    await hub.closeConnectModal()
    await shell.openAgents()
    await seedCodexAgents(page, 1)
    const agentName = await agents.openNth(0)
    await model.openEditor()
    await model.expectOneCredentialSelect()
    await expect(model.credentialSelect().locator('optgroup[label="Subscriptions"]')).toBeVisible()
    const secretName = (
      await page.locator('#host-secret optgroup[label="API keys"] option').allTextContents()
    )
      .map(text => text.replace(' (custom)', '').trim())
      .find(Boolean)
    await model.chooseSubscription(displayName)
    const saved = await model.saveHost(agentName)
    expect(saved.spec?.model?.provider).toBe('codex-subscription')
    expect(saved.spec?.model?.connectionRef).toBe(grantKey)
    expect(saved.spec?.model?.name).toEqual(expect.stringMatching(/\S/))
    expect(saved.spec?.secretRef).toBeUndefined()
    await expect(page.getByLabel('Credential')).toHaveText(displayName)

    expect(secretName, 'J6 named precondition: at least one API key secret').toMatch(/\S/)
    await page.getByRole('button', { name: 'Edit' }).click()
    await model.chooseSecret(secretName!)
    const secretSaved = await model.saveHost(agentName)
    expect(secretSaved.spec?.secretRef).toBe(secretName)
    expect(secretSaved.spec?.model?.connectionRef).toBeUndefined()
    await expect(page.getByLabel('Credential')).toHaveText(secretName!)
  })

  test('J7 the same displayName appears once on a second agent', async ({ page }) => {
    const shell = new ControlUiShell(page)
    const hub = new SecretsLlmSubscriptionsPage(page)
    const agents = new AgentListPage(page)
    const model = new AgentModelPage(page)
    const displayName = `e2e-reuse-${Date.now().toString(36)}`

    await loginFromHome(page)
    await shell.openSecretsLlmSubscriptions()
    await hub.createGrant(displayName)
    await hub.closeConnectModal()
    await shell.openAgents()
    await seedCodexAgents(page, 2)
    await agents.openNth(0)
    await model.openEditor()
    await model.chooseSubscription(displayName)
    await shell.openAgents()
    await agents.openNth(1)
    await model.openEditor()
    await expect(model.credentialSelect().locator(`option:text-is("${displayName}")`)).toHaveCount(
      1
    )
  })

  test('J8 clearing Credential saves unassigned and does not revoke the grant', async ({
    page,
  }) => {
    const shell = new ControlUiShell(page)
    const hub = new SecretsLlmSubscriptionsPage(page)
    const agents = new AgentListPage(page)
    const model = new AgentModelPage(page)
    const displayName = `e2e-clear-${Date.now().toString(36)}`

    await loginFromHome(page)
    await shell.openSecretsLlmSubscriptions()
    const grantKey = await hub.createGrant(displayName)
    await hub.closeConnectModal()
    await shell.openAgents()
    await seedCodexAgents(page, 1)
    const agentName = await agents.openNth(0)
    await model.openEditor()
    await model.chooseSubscription(displayName)
    await model.saveHost(agentName)
    await page.getByRole('button', { name: 'Edit' }).click()
    await model.clearCredential()
    const saved = await model.saveHost(agentName)
    expect(saved.spec?.model?.connectionRef ?? 'unassigned').toBe('unassigned')
    expect(saved.spec?.secretRef).toBeUndefined()
    const after = await listConnections()
    expect(after.find(row => row.connectionKey === grantKey)?.status).not.toBe('revoked')
  })

  test('J9 revoke is only the Secrets IconX and does not rewrite hosts', async ({ page }) => {
    const shell = new ControlUiShell(page)
    const hub = new SecretsLlmSubscriptionsPage(page)
    const agents = new AgentListPage(page)
    const model = new AgentModelPage(page)
    const displayName = `e2e-revoke-${Date.now().toString(36)}`

    await loginFromHome(page)
    await shell.openSecretsLlmSubscriptions()
    const grantKey = await hub.createGrant(displayName)
    await hub.closeConnectModal()
    await shell.openAgents()
    await seedCodexAgents(page, 1)
    const agentName = await agents.openNth(0)
    await model.openEditor()
    await model.chooseSubscription(displayName)
    await model.saveHost(agentName)
    const before = (await controlApi.getHost(agentName)) as {
      spec?: { model?: { connectionRef?: string } }
    }
    await shell.openSecretsLlmSubscriptions()
    await hub.revokeGrant(displayName, grantKey)
    const after = (await controlApi.getHost(agentName)) as {
      spec?: { model?: { connectionRef?: string } }
    }
    expect(after.spec?.model?.connectionRef).toBe(before.spec?.model?.connectionRef)
    await expect(page.getByRole('cell', { name: displayName, exact: true })).toHaveCount(0)
  })

  test('J10 API-KEY does not PATCH grants; Subscriptions does not PUT secrets', async ({
    page,
  }) => {
    const shell = new ControlUiShell(page)
    const hub = new SecretsLlmSubscriptionsPage(page)
    const displayName = `e2e-iso-${Date.now().toString(36)}`
    await loginFromHome(page)
    await shell.openSecretsLlm()
    const grantPatches: string[] = []
    const secretPuts: string[] = []
    page.on('request', request => {
      const url = new URL(request.url())
      if (
        request.method() === 'PATCH' &&
        /\/codex-subscription\/connections\//.test(url.pathname)
      ) {
        grantPatches.push(url.pathname)
      }
      if (request.method() === 'PUT' && /\/api\/v1\/admin\/secrets$/.test(url.pathname)) {
        secretPuts.push(url.pathname)
      }
    })
    await page.getByRole('tab', { name: 'API-KEY' }).click()
    await expect(page).toHaveURL(/\/secrets\/llm$/)
    expect(grantPatches, 'API-KEY must not PATCH grant metadata').toEqual([])
    await shell.openSecretsLlmSubscriptions()
    await hub.createGrant(displayName)
    await hub.closeConnectModal()
    expect(secretPuts, 'Subscriptions must not PUT LLM secrets').toEqual([])
  })
})
