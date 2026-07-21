import { type ElectronApplication, type Page, test } from '@playwright/test'
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
  openSettings,
  requireRecorderConfirm,
  screenshotAndLog,
  sendChatMessage,
  visitSettingsTab,
} from './qa-recorder-helpers'

test('optional QA recorder: Desktop settings and chat journey', async ({}, testInfo) => {
  requireRecorderConfirm(
    'QA_RECORDER_CONFIRM_CHAT',
    'This journey sends a real chat message and may incur model cost.'
  )
  assertAllowedTarget('EXTERNAL_REST_API_BASE_URL', EXTERNAL_REST_API_BASE_URL)
  assertAllowedTarget('RPC_PROXY_BASE_URL', RPC_PROXY_BASE_URL)

  const credentials = desktopCredentials()
  const hostRef = configuredHostRef()
  let app: ElectronApplication | undefined
  let page: Page | undefined

  try {
    const launched = await launchDesktopApp(testInfo)
    app = launched.app
    page = launched.page

    await login(page, credentials)
    await openSettings(page)
    await visitSettingsTab(page, 'Appearance', 'Theme')
    await visitSettingsTab(page, 'Notifications', 'In App Notifications')
    await visitSettingsTab(page, 'Information', 'External REST API URL')
    await openExactAgentChat(page, hostRef)
    await sendChatMessage(page)

    await screenshotAndLog(page, testInfo, 'desktop-settings-chat')
  } finally {
    await finalizeRecording(app, page)
  }
})
