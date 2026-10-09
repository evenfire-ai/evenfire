import { type Page, expect } from '@playwright/test'
import { type Scenario, required } from './approved-tools-scenarios'
import { expectSignedOutLaunch } from './desktop-session'

// E2E_GUARDIAN_IPC_FLOW: Desktop chat helpers drive the real main-process login
// and chat IPC; completed messages replace renderer response waits.

export async function send(page: Page, prompt: string) {
  await expect(page.getByTestId('chat-input')).toBeVisible()
  await page.getByTestId('chat-input').fill(prompt)
  await expect(page.getByTestId('send-button')).toBeEnabled()
  await page.getByTestId('send-button').click()
  await expect(page.getByTestId('message-list').getByText(prompt, { exact: true })).toBeVisible()
}

export async function newAgentResponses(page: Page) {
  const responses = page.getByTestId('agent-response')
  // Snapshot stable message identities before sending; previous turns must not
  // satisfy the new turn's result, even when their visible text is identical.
  const previousIds = await responses.evaluateAll(elements =>
    elements.map(element => element.getAttribute('data-chat-message-id'))
  )
  expect(previousIds.every(id => typeof id === 'string' && id.length > 0)).toBe(true)
  const exclusions = previousIds
    .map(id => `:not([data-chat-message-id=${JSON.stringify(id)}])`)
    .join('')
  return responses.and(page.locator(`[data-chat-message-id]${exclusions}`))
}

export async function openAgentChat(desktop: Page, scenario: Scenario) {
  await expectSignedOutLaunch(desktop)
  await desktop.getByLabel('Email', { exact: true }).fill(required('TEST_USER_EMAIL'))
  await desktop.getByLabel('Password', { exact: true }).fill(required('TEST_USER_PASSWORD'))
  await desktop.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(desktop.getByTestId('nav-chat')).toBeVisible()
  await desktop.getByTestId('nav-chat').click()
  await desktop.getByTestId('nav-new-chat').click()
  await expect(
    desktop.getByRole('heading', { name: 'Start a new conversation with:', exact: true })
  ).toBeVisible()
  await desktop.getByRole('button', { name: 'Switch chat agent', exact: true }).click()
  await desktop.getByRole('menuitem', { name: scenario.agentDisplayName, exact: true }).click()
  await expect(
    desktop.getByRole('button', { name: 'Switch chat agent', exact: true })
  ).toContainText(scenario.agentDisplayName)
  await desktop.getByRole('button', { name: 'Model — Select model', exact: true }).click()
  // The menu labels an option with the allowlist entry's displayName and
  // falls back to the model id when there is none (ModelSelector.tsx:276).
  // Which of the two renders depends on catalog metadata this test does not
  // own: the deterministic upstream serves a display_name of its own. Keying
  // on the testid (ModelSelector.tsx:269) anchors this to the same id the
  // Control UI step bound, instead of to a label sourced outside this spec.
  const modelOption = desktop.getByTestId(`model-option-${scenario.modelName}`)
  await expect(modelOption).toHaveCount(1)
  await modelOption.click()
  await expect(
    desktop.getByRole('button', { name: `Model — ${scenario.modelName}`, exact: true })
  ).toBeVisible()
  await expect(desktop.getByTestId('agent-response')).toHaveCount(0)
}
