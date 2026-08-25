/**
 * Page objects for Codex subscription Control UI journeys.
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

  async openSecretsSubscription() {
    await this.openSecretsLlm()
    await this.page.getByRole('tab', { name: 'Subscription' }).click()
    await expect(this.page).toHaveURL(/\/secrets\/subscription$/)
    await expect(this.page.getByTestId('codex-subscription-hub')).toBeVisible()
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

  subscriptionPicker(): Locator {
    return this.page.locator('#codex-subscription')
  }

  modelSelect(): Locator {
    return this.page.getByLabel(/^Model$/i)
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
    await expect(this.page.getByLabel('Provider')).toBeVisible()
  }

  async chooseChatGPTSubscription() {
    await this.page.getByLabel('Provider').click()
    await this.page.getByRole('option', { name: 'OpenAI', exact: true }).click()
    await expect(this.page.getByRole('option', { name: 'OpenAI Codex Subscription' })).toHaveCount(
      0
    )
    await this.page.getByRole('radio', { name: 'ChatGPT subscription' }).check()
    await expect(this.page.getByTestId('codex-agent-assignment')).toBeVisible()
    await expect(this.page.getByLabel(/OpenAI API key/i)).toHaveCount(0)
  }

  async expectNamedModel(): Promise<string> {
    const select = this.modelSelect()
    await expect(select).toBeVisible()
    const value = ((await select.textContent()) ?? '').trim()
    expect(
      value,
      'ChatGPT switch must keep or seed spec.model.name — empty name is the 422 bug'
    ).toMatch(/\S/)
    expect(value, 'placeholder is not a saved model name').not.toMatch(
      /select model|no enabled models/i
    )
    return value
  }

  async createGrant(displayName: string): Promise<string> {
    await this.page.getByRole('button', { name: 'New subscription' }).click()
    await this.page.getByLabel('New subscription name').fill(displayName)
    const created = this.page.waitForResponse(
      response =>
        /\/api\/v1\/admin\/llm\/providers\/codex-subscription\/connections$/.test(
          new URL(response.url()).pathname
        ) && response.request().method() === 'POST'
    )
    await this.page.getByRole('button', { name: 'Create', exact: true }).click()
    const response = await created
    expect(response.ok(), `create grant must succeed, got ${response.status()}`).toBe(true)
    const body = (await response.json()) as { connectionKey?: string }
    expect(body.connectionKey).toEqual(expect.any(String))
    await expect(this.subscriptionPicker()).toHaveValue(String(body.connectionKey))
    return String(body.connectionKey)
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
      spec?: { model?: { provider?: string; name?: string; connectionRef?: string } }
    }
  }
}

export class CodexSubscriptionHubPage {
  constructor(readonly page: Page) {}

  table(): Locator {
    return this.page.getByTestId('codex-hub-table')
  }

  grantRow(connectionKey: string): Locator {
    return this.page.getByTestId(`codex-hub-grant-${connectionKey}`)
  }

  async expectTable() {
    await expect(this.table()).toBeVisible()
    await expect(this.page.getByRole('columnheader', { name: 'Name' })).toBeVisible()
    await expect(this.page.getByRole('columnheader', { name: 'Status' })).toBeVisible()
    await expect(this.page.getByRole('columnheader', { name: 'Agents' })).toBeVisible()
    await expect(this.page.getByRole('heading', { name: 'Available' })).toHaveCount(0)
    await expect(this.page.getByRole('heading', { name: 'Assigned' })).toHaveCount(0)
  }

  async createGrant(displayName: string): Promise<string> {
    await this.page.getByRole('button', { name: 'Add subscription' }).click()
    await this.page.getByLabel('New subscription name').fill(displayName)
    const created = this.page.waitForResponse(
      response =>
        /\/api\/v1\/admin\/llm\/providers\/codex-subscription\/connections$/.test(
          new URL(response.url()).pathname
        ) && response.request().method() === 'POST'
    )
    await this.page.getByRole('button', { name: 'Create', exact: true }).click()
    const response = await created
    expect(response.ok(), `hub create must succeed, got ${response.status()}`).toBe(true)
    const body = (await response.json()) as { connectionKey?: string }
    expect(body.connectionKey).toEqual(expect.any(String))
    await expect(this.page.getByText(displayName)).toBeVisible()
    return String(body.connectionKey)
  }

  async assignFirstAgents(connectionKey: string, count: number): Promise<string[]> {
    const row = this.grantRow(connectionKey)
    await expect(row.getByLabel('Add agents to this subscription')).toBeVisible()
    await row.getByLabel('Add agents to this subscription').click()
    const options = row.getByRole('option')
    await expect(
      options.first(),
      'hub assign requires seeded Codex agents — API seed is a named precondition'
    ).toBeVisible()
    const available = await options.count()
    expect(
      available,
      `hub multi-assign needs ${count} agents, found ${available}`
    ).toBeGreaterThanOrEqual(count)

    const names: string[] = []
    for (let index = 0; index < count; index += 1) {
      const option = options.nth(index)
      const label = ((await option.getAttribute('aria-label')) ?? '').trim()
      expect(label, `assignable agent #${index + 1} must have a name`).toMatch(/\S/)
      names.push(label)
      await option.click()
    }

    const bindPath = new RegExp(
      `/api/v1/admin/llm/providers/codex-subscription/connections/${connectionKey}/hosts/[^/]+/bind$`
    )
    const bindBodies: Promise<{ host?: string; connectionRef?: string; ok: boolean }>[] = []
    const onResponse = (response: import('@playwright/test').Response) => {
      if (
        bindPath.test(new URL(response.url()).pathname) &&
        response.request().method() === 'POST'
      ) {
        bindBodies.push(
          response.json().then(body => ({
            ...(body as { host?: string; connectionRef?: string }),
            ok: response.ok(),
          }))
        )
      }
    }
    this.page.on('response', onResponse)

    await row
      .getByRole('button', { name: count > 1 ? `Add ${count} agents` : 'Add agents' })
      .click()
    await expect
      .poll(() => bindBodies.length, { message: `expected ${count} bind responses` })
      .toBe(count)
    this.page.off('response', onResponse)
    const binds = await Promise.all(bindBodies)
    for (const bind of binds) {
      expect(bind.ok, 'each hub bind must succeed').toBe(true)
      expect(bind.connectionRef).toBe(connectionKey)
    }
    return names
  }

  async removeAgentFromGrant(connectionKey: string, hostName: string) {
    const row = this.grantRow(connectionKey)
    const unbind = this.page.waitForResponse(
      response =>
        new RegExp(
          `/api/v1/admin/llm/providers/codex-subscription/connections/${connectionKey}/hosts/${hostName}/unbind$`
        ).test(new URL(response.url()).pathname) && response.request().method() === 'POST'
    )
    await row.getByRole('button', { name: `Remove agent ${hostName}` }).click()
    await expect(this.page.getByRole('alertdialog')).toBeVisible()
    await this.page.getByRole('alertdialog').getByRole('button', { name: 'Remove agent' }).click()
    const response = await unbind
    expect(response.ok(), `hub unbind must succeed, got ${response.status()}`).toBe(true)
    const body = (await response.json()) as { host?: string; connectionRef?: string }
    expect(body.host).toBe(hostName)
    expect(body.connectionRef).toBe('unassigned')
  }
}
