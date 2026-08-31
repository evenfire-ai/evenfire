/**
 * Page objects for Secrets LLM subscriptions and the agent Credential select.
 *
 * Guardian: helpers only click/assert user-visible controls. API seeding lives
 * in the spec and is named as a precondition, never as the behavior under test.
 */
import { type Locator, type Page, expect } from '@playwright/test'

export class ControlUiShell {
  constructor(readonly page: Page) {}

  async openAgents() {
    await this.page.getByRole('link', { name: 'Agents', exact: true }).click()
    await expect(this.page).toHaveURL(/\/(?:hosts|agents)$/)
    await expect(this.page.getByRole('button', { name: /Reload agents/i })).toBeVisible()
  }

  async openSecretsLlm() {
    await this.page.getByRole('link', { name: 'Secrets', exact: true }).click()
    await expect(this.page).toHaveURL(/\/secrets\/(llm)?$/)
  }

  async openSecretsLlmSubscriptions() {
    await this.openSecretsLlm()
    await this.page.getByRole('tab', { name: 'Subscriptions' }).click()
    await expect(this.page).toHaveURL(/\/secrets\/llm\/subscriptions$/)
    await expect(
      this.page.getByRole('tab', { name: 'Subscriptions', selected: true })
    ).toBeVisible()
  }
}

export class AgentListPage {
  constructor(readonly page: Page) {}

  rows(): Locator {
    return this.page.getByRole('row', { name: /Open agent / })
  }

  async openNamed(name: string): Promise<void> {
    const row = this.page.getByRole('row', { name: `Open agent ${name}` })
    await expect(row).toBeVisible()
    await row.click()
    await expect(this.page).toHaveURL(new RegExp(`/((?:hosts|agents))/${name}(?:/|$)`))
  }

  async openNth(index: number): Promise<string> {
    const row = this.rows().nth(index)
    await expect(row).toBeVisible()
    const label = (await row.getAttribute('aria-label')) ?? ''
    const name = label.replace(/^Open agent\s+/, '').trim()
    expect(name, 'agent row must expose a name').toMatch(/\S/)
    await row.click()
    await expect(this.page).toHaveURL(/\/(?:hosts|agents)\/[^/]+/)
    return decodeURIComponent(name)
  }
}

export class AgentModelPage {
  constructor(readonly page: Page) {}

  credentialSelect(): Locator {
    return this.page.getByLabel('Credential', { exact: true })
  }

  saveButton(): Locator {
    return this.page.getByRole('button', { name: 'Save', exact: true })
  }

  async openEditor() {
    await this.page.getByRole('tab', { name: 'Models & creds' }).click()
    await expect(this.page).toHaveURL(/\/(?:hosts|agents)\/[^/]+\/model/)
    await expect(
      this.page.getByRole('tab', { name: 'Models & creds', selected: true })
    ).toBeVisible()
    const edit = this.page.getByRole('button', { name: 'Edit', exact: true })
    if ((await edit.count()) > 0) {
      await edit.click()
    }
    await expect(this.credentialSelect()).toBeVisible()
  }

  async expectOneCredentialSelect() {
    await expect(this.credentialSelect()).toHaveCount(1)
    await expect(this.page.getByRole('radio', { name: /ChatGPT subscription/i })).toHaveCount(0)
    await expect(this.page.getByRole('button', { name: 'Sign in with ChatGPT' })).toHaveCount(0)
    await expect(this.page.getByRole('button', { name: 'Sync catalog' })).toHaveCount(0)
    await expect(this.page.getByRole('button', { name: 'New subscription' })).toHaveCount(0)
  }

  async chooseSubscription(displayName: string) {
    await this.credentialSelect().selectOption({ label: displayName })
  }

  async chooseSecret(secretName: string) {
    await this.credentialSelect().selectOption(secretName)
  }

  async clearCredential() {
    await this.credentialSelect().selectOption('')
  }

  async saveHost(agentName: string) {
    await expect(this.saveButton()).toBeEnabled()
    const put = this.page.waitForResponse(
      response =>
        new RegExp(`/api/v1/admin/hosts/${agentName}$`).test(new URL(response.url()).pathname) &&
        response.request().method() === 'PUT'
    )
    await this.saveButton().click()
    const response = await put
    expect(
      response.status(),
      'assign save must not 422 empty model.name or model_not_offered'
    ).not.toBe(422)
    expect(response.ok(), `assign save must succeed, got ${response.status()}`).toBe(true)
    return (await response.json()) as {
      spec?: {
        secretRef?: string
        model?: { provider?: string; name?: string; connectionRef?: string }
      }
    }
  }
}

export class SecretsLlmSubscriptionsPage {
  constructor(readonly page: Page) {}

  async expectTable() {
    await expect(this.page.getByRole('tab', { name: 'API-KEY' })).toBeVisible()
    await expect(this.page.getByRole('tab', { name: 'Subscriptions' })).toBeVisible()
    await expect(this.page.getByRole('tab', { name: /^Subscription$/ })).toHaveCount(0)
    await expect(this.page.getByRole('columnheader', { name: 'Agents' })).toHaveCount(0)
    const hasHeaders = (await this.page.getByRole('columnheader', { name: 'Name' }).count()) > 0
    if (hasHeaders) {
      await expect(this.page.getByRole('columnheader', { name: 'Status' })).toBeVisible()
    } else {
      await expect(
        this.page.getByText(/No ChatGPT subscriptions|Add subscription/i).first()
      ).toBeVisible()
    }
  }

  grantRow(displayName: string): Locator {
    return this.page.getByRole('row', { name: new RegExp(displayName) })
  }

  async expectConnectModal() {
    const dialog = this.page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Sign in with ChatGPT' })).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Sync catalog' })).toBeVisible()
  }

  async closeConnectModal() {
    await this.page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click()
    await expect(this.page.getByRole('dialog')).toHaveCount(0)
  }

  /**
   * Create a named grant. After the 201 the sync dialog stays open
   * (Sign in visible). Callers that leave Secrets must closeConnectModal first.
   */
  async createGrant(displayName: string): Promise<string> {
    await this.page.getByRole('button', { name: 'Add subscription' }).click()
    await this.page.getByLabel('Name', { exact: true }).fill(displayName)
    const created = this.page.waitForResponse(
      response =>
        /\/api\/v1\/admin\/llm\/providers\/codex-subscription\/connections$/.test(
          new URL(response.url()).pathname
        ) && response.request().method() === 'POST'
    )
    await this.page.getByRole('button', { name: 'Create', exact: true }).click()
    const response = await created
    expect(response.status(), `create grant must return 201, got ${response.status()}`).toBe(201)
    const body = (await response.json()) as { connectionKey?: string }
    expect(body.connectionKey).toBeTruthy()
    await this.expectConnectModal()
    return String(body.connectionKey)
  }

  async openGrant(displayName: string) {
    await this.page
      .getByRole('button', { name: `Update ChatGPT subscription ${displayName}` })
      .click()
    await expect(this.page.getByRole('dialog')).toBeVisible()
  }

  async revokeGrant(displayName: string, connectionKey: string) {
    const revoke = this.page.waitForResponse(
      response =>
        new RegExp(
          `/api/v1/admin/llm/providers/codex-subscription/connections/${connectionKey}/revoke$`
        ).test(new URL(response.url()).pathname) && response.request().method() === 'POST'
    )
    await this.page
      .getByRole('button', { name: `Delete ChatGPT subscription ${displayName}` })
      .click()
    await expect(this.page.getByRole('alertdialog')).toBeVisible()
    await this.page.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click()
    const response = await revoke
    expect(response.ok(), `revoke must succeed, got ${response.status()}`).toBe(true)
  }
}

/** @deprecated Use SecretsLlmSubscriptionsPage. Kept for any leftover imports. */
export class CodexSubscriptionHubPage extends SecretsLlmSubscriptionsPage {}
