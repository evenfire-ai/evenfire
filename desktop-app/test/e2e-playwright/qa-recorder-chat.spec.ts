import { type ElectronApplication, type Page, expect, test } from '@playwright/test'
import {
  EXTERNAL_REST_API_BASE_URL,
  RPC_PROXY_BASE_URL,
  assertAllowedTarget,
  configuredHostRef,
  desktopCredentials,
  finalizeRecording,
  launchDesktopApp,
  login,
  openExactAgentChat,
  requireRecorderConfirm,
  screenshotAndLog,
  sendChatMessage,
} from './qa-recorder-helpers'

// Deep chat journey: composer landing, send-button enablement, real send, and
// thread/agent-response rendering. This is the focused companion to the combined
// settings-chat smoke (qa-recorder-settings-chat.spec.ts) — it drills into the
// composer + thread interactions only. Sending a real message costs model
// tokens, so the whole journey is gated behind QA_RECORDER_CONFIRM_CHAT=1.
test('optional QA recorder: Desktop chat composer, thread, and task progress journey', async ({}, testInfo) => {
  requireRecorderConfirm(
    'QA_RECORDER_CONFIRM_CHAT',
    'This journey sends a real chat message and may incur model cost.'
  )
  await assertAllowedTarget('EXTERNAL_REST_API_BASE_URL', EXTERNAL_REST_API_BASE_URL)
  await assertAllowedTarget('RPC_PROXY_BASE_URL', RPC_PROXY_BASE_URL)

  const credentials = desktopCredentials()
  const hostRef = configuredHostRef()
  let app: ElectronApplication | undefined
  let page: Page | undefined

  try {
    const launched = await launchDesktopApp(testInfo)
    app = launched.app
    page = launched.page

    await login(page, credentials)
    await openExactAgentChat(page, hostRef)

    const composer = page.getByRole('textbox', { name: 'Agent message composer' })
    const sendButton = page.getByTestId('send-button')

    // (1) The exact agent's composer landed and is interactive.
    await expect(composer).toBeVisible({ timeout: 20_000 })
    await expect(composer).toBeEnabled({ timeout: 20_000 })

    // Establish a known-empty draft so the disabled-while-empty assertion is
    // deterministic regardless of any persisted draft state for this chat.
    await composer.click()
    await composer.fill('')

    // (2) The send button is disabled while the composer is empty, then becomes
    // enabled once the user types a draft (ComposerPanel gates the button on a
    // non-empty trimmed draft and/or attachments).
    await expect(sendButton).toBeVisible({ timeout: 20_000 })
    await expect(sendButton).toBeDisabled({ timeout: 20_000 })
    await composer.fill('Probe draft to enable the send button.')
    await expect(sendButton).toBeEnabled({ timeout: 20_000 })

    // (3) Send the real QA prompt via the shared helper — it fills the composer,
    // clicks send, and waits for a non-empty [data-testid='agent-response'].
    await sendChatMessage(page)

    // (4) The thread surface rendered the exchange: the message-list is present
    // and at least one assistant response bubble is visible with content.
    await expect(page.getByTestId('message-list')).toBeVisible({ timeout: 20_000 })
    const agentResponse = page.getByTestId('agent-response').first()
    await expect(agentResponse).toBeVisible({ timeout: 20_000 })
    await expect(agentResponse).not.toHaveText('')

    await screenshotAndLog(page, testInfo, 'desktop-chat-composer-thread')
  } finally {
    await finalizeRecording(app, page)
  }
})
