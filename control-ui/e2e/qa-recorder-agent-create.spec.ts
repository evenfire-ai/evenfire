import { type Page, expect, test } from '@playwright/test'
import {
  CONTROL_API_URL,
  CONTROL_UI_URL,
  type NamedResource,
  adminCredentials,
  api,
  assertAllowedTarget,
  loginThroughUi,
  requireRecorderConfirm,
  requiredValue,
  resourceName,
  screenshotAndLog,
  uniqueE2EName,
} from './qa-recorder-helpers'

function wizardActions(page: Page) {
  return page.locator('.cu-create-actions')
}

async function clickWizardNext(page: Page): Promise<void> {
  const next = wizardActions(page).getByRole('button', { name: 'Next', exact: true })
  await expect(next).toBeEnabled()
  await next.click()
}

async function requireLlmSecret(
  request: import('@playwright/test').APIRequestContext
): Promise<string> {
  const configured = requiredValue('E2E_AGENT_SECRET_NAME', [process.env.E2E_AGENT_SECRET_NAME])
  const { status, data } = await api<{ items?: NamedResource[] }>(
    request,
    'GET',
    '/api/v1/admin/secrets'
  )
  if (status !== 200) {
    throw new Error(`Unable to list LLM secrets before agent creation: HTTP ${status}.`)
  }
  const secretNames = (data.items ?? []).map(resourceName).filter(Boolean)
  if (!secretNames.includes(configured)) {
    throw new Error(
      `E2E_AGENT_SECRET_NAME="${configured}" was not found. Choose an explicit disposable-environment secret.`
    )
  }
  return configured
}

async function cleanupAgentFlowResources(
  request: import('@playwright/test').APIRequestContext,
  names: { agentName: string; contextName: string }
): Promise<void> {
  await api(request, 'DELETE', `/api/v1/admin/hosts/${encodeURIComponent(names.agentName)}`)
  await api(request, 'DELETE', `/api/v1/admin/contexts/${encodeURIComponent(names.contextName)}`)
}

async function waitForAgent(
  request: import('@playwright/test').APIRequestContext,
  agentName: string
): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const { status, data } = await api<Record<string, unknown>>(
      request,
      'GET',
      `/api/v1/admin/hosts/${encodeURIComponent(agentName)}`
    )
    if (status === 200) return data
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  throw new Error(`Created agent "${agentName}" did not become visible through Control API.`)
}

test.describe('optional QA recorder: Control UI agent creation', () => {
  test('records login and the complete create-agent journey', async ({ page }, testInfo) => {
    requireRecorderConfirm(
      'QA_RECORDER_CONFIRM_MUTATIONS',
      'This journey creates and deletes local agent resources.'
    )
    assertAllowedTarget('CONTROL_UI_URL', CONTROL_UI_URL)
    assertAllowedTarget('CONTROL_API_URL', CONTROL_API_URL)

    const credentials = adminCredentials()
    const agentName = uniqueE2EName('qa-recorder-agent')
    const contextName = `${agentName}-ctx`.slice(0, 63).replace(/-$/, '')
    const memberLabel = process.env.E2E_AGENT_ACCESS_LABEL?.trim()

    try {
      await loginThroughUi(page, credentials)
      const sessionRequest = page.request
      const secretName = await requireLlmSecret(sessionRequest)
      await cleanupAgentFlowResources(sessionRequest, { agentName, contextName })

      await page.getByRole('link', { name: 'Agents', exact: true }).click()
      await expect(page).toHaveURL(/\/(?:hosts|agents)$/)

      const createAgent = page.getByRole('button', { name: 'Create agent', exact: true })
      await expect(createAgent).toBeEnabled()
      await createAgent.click()
      await expect(page).toHaveURL(/\/(?:hosts|agents)\/new$/)
      await expect(page.getByRole('heading', { name: 'Create agent', exact: true })).toBeVisible()

      await page.getByPlaceholder('agent-name').fill(agentName)
      await clickWizardNext(page)

      await page.getByLabel(/create new context/i).check()
      await page.getByPlaceholder('context-name').fill(contextName)
      await clickWizardNext(page)

      await expect(page.getByText('Model & credentials', { exact: true })).toBeVisible()
      await page.getByLabel(/Use an existing Secret/i).check()
      await page.getByRole('button', { name: /select secret/i }).click()
      const secretOption = page.locator('.cu-agent-select__option').filter({ hasText: secretName })
      await expect(secretOption.first()).toBeVisible()
      await secretOption.first().click()
      await clickWizardNext(page)

      await expect(page.getByTestId('wizard-users-list')).toBeVisible()
      if (memberLabel) {
        await page.getByPlaceholder('Search members...').fill(memberLabel)
        const memberOption = page.getByRole('option', { name: memberLabel, exact: true })
        await expect(memberOption).toBeVisible()
        await memberOption.click()
      }
      await clickWizardNext(page)

      const skipChannels = page.getByRole('button', { name: /skip channel setup/i })
      await expect(skipChannels).toBeEnabled()
      await skipChannels.click()

      await expect(page).toHaveURL(/\/(?:hosts|agents)$/)
      const created = await waitForAgent(sessionRequest, agentName)
      expect((created.metadata as { name?: string } | undefined)?.name).toBe(agentName)
      expect((created.spec as { contextRef?: string } | undefined)?.contextRef).toBe(contextName)
      expect((created.spec as { secretRef?: string } | undefined)?.secretRef).toBe(secretName)

      await screenshotAndLog(page, testInfo, 'control-create-agent-complete')
    } finally {
      await cleanupAgentFlowResources(page.request, { agentName, contextName })
    }
  })
})
