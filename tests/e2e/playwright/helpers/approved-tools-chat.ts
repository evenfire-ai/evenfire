import { type Page, expect } from '@playwright/test'
import { type Scenario, required } from './approved-tools-scenarios'
import {
  SIGN_IN_RESULT_TIMEOUT_MS,
  assertUntamperedInputs,
  loginRefusedMessage,
} from './desktop-diagnostics.mjs'
import { expectSignedOutLaunch } from './desktop-session'
import { desktopMainLogLines } from './launch-desktop'
import { loginLedgerRootFromEnv, recordPasswordLogin, waitForLoginPace } from './login-ledger.mjs'

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

/**
 * Waits for the sign-in's outcome: the signed-in nav, or the auth status toast.
 * A refusal names its own message instead of timing out on a locator, so a login
 * held back by control-api's password admission policy reads as that and not as
 * a product defect (MS-B1 item 3, issue #1273).
 */
async function expectSignedInOrRefused(desktop: Page): Promise<void> {
  const signedIn = desktop.getByTestId('nav-chat')
  // Error toasts are `role="alert"` (`components/Common/ToastStack`); nothing
  // else on the login form carries that role. `count`/`allTextContents` are used
  // instead of a combined locator so a second toast cannot turn this into a
  // strict-mode failure.
  const refusal = desktop.getByRole('alert')
  const outcome = async (): Promise<'signed-in' | 'refused' | 'pending'> => {
    if (await signedIn.isVisible()) return 'signed-in'
    return (await refusal.count()) > 0 ? 'refused' : 'pending'
  }
  await expect
    .poll(outcome, {
      timeout: SIGN_IN_RESULT_TIMEOUT_MS,
      message: 'the Desktop sign-in must show the signed-in navigation or an auth status toast',
    })
    .not.toBe('pending')
  if ((await outcome()) === 'signed-in') {
    await expect(signedIn).toBeVisible()
    return
  }
  const [toastText = null] = await refusal.allTextContents()
  throw new Error(loginRefusedMessage(toastText, desktopMainLogLines()))
}

/**
 * Signs the isolated Desktop app in; the session stays open for the caller.
 *
 * Two lane hazards run around the click (MS-B1, MS-B2):
 * control-api verifies one password per 7.5 s across every identity, so a lane of
 * short tests waits on its own ledger before logging in; and a headed window
 * accepts keystrokes from the operator's desktop, so both filled values are
 * compared with the expected ones immediately before the click.
 */
export async function signInDesktop(desktop: Page) {
  await expectSignedOutLaunch(desktop)
  const email = required('TEST_USER_EMAIL')
  const password = required('TEST_USER_PASSWORD')
  const emailField = desktop.getByLabel('Email', { exact: true })
  const passwordField = desktop.getByLabel('Password', { exact: true })
  await emailField.fill(email)
  await passwordField.fill(password)
  const ledgerRoot = loginLedgerRootFromEnv()
  await waitForLoginPace(ledgerRoot)
  const inputChecks = assertUntamperedInputs({
    email: { expected: email, actual: await emailField.inputValue() },
    password: { expected: password, actual: await passwordField.inputValue() },
  })
  // Recorded before the click, so a login that dies mid-flight still paces the
  // next one.
  recordPasswordLogin(ledgerRoot, { surface: 'desktop', inputChecks })
  await desktop.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expectSignedInOrRefused(desktop)
}

/**
 * Opens a new chat with the scenario's agent from an already signed-in app. The
 * sign-in is separate so a caller can observe the agent before the chat opens.
 */
export async function openNewAgentChat(desktop: Page, scenario: Scenario) {
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
  // The interactive chip is the only state that carries no model id and the
  // `Model — Select model` name: while the list loads it is absent, a failed read
  // shows "Models unavailable — retry loading the model list", a degraded
  // allowlist renders a static `Model Select model (selection unavailable)` chip,
  // and a bound agent shows `Model — <name>` (ModelSelector.tsx). Asserting the
  // state before the click names which one the run found instead of timing out on
  // the locator alone.
  const modelChip = desktop.getByTestId('selected-chat-model')
  await expect(modelChip).toBeVisible()
  await expect(modelChip).toHaveAttribute('data-model-id', '')
  await expect(modelChip).toHaveAccessibleName('Model — Select model')
  await modelChip.click()
  // The menu labels an option with the allowlist entry's displayName and
  // falls back to the model id when there is none (ModelSelector.tsx:276).
  // Which of the two renders depends on catalog metadata this test does not
  // own: the deterministic upstream serves a display_name of its own. Keying
  // on the testid (ModelSelector.tsx:269) anchors this to the same id the
  // Control UI step bound, instead of to a label sourced outside this spec.
  const modelOption = desktop.getByTestId(`model-option-${scenario.modelName}`)
  await expect(modelOption).toHaveCount(1)
  await modelOption.click()
  // The chip label follows the same displayName fallback, so assert the
  // selected model id instead of that label (ModelSelector.tsx:212-213).
  await expect(desktop.getByTestId('selected-chat-model')).toHaveAttribute(
    'data-model-id',
    scenario.modelName
  )
  await expect(desktop.getByTestId('agent-response')).toHaveCount(0)
}

/** Signs in and opens a new chat with the scenario's agent. */
export async function openAgentChat(desktop: Page, scenario: Scenario) {
  await signInDesktop(desktop)
  await openNewAgentChat(desktop, scenario)
}
