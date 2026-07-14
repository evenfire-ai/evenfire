import { expect, test } from '@playwright/test'
import { E2E_EMAIL, clearSession, launchAndLogin, loginAs } from '../workflowUi'
import { expectDesktopSdkNotificationInBell } from './desktopSdkClientNotification'
import {
  applySdkWorkloadRecipe,
  cleanupSdkWorkloadRecipe,
  createSdkWorkloadGrants,
  fetchNotificationDeliveryRow,
  makeScopedSdkRecipeName,
  restartSdkCallerWorkload,
  waitForDesktopNotificationAck,
  waitForSdkCallerNotification,
} from './sdkWorkloadFixture'

const SDK_NOTIFICATION_BODY = 'Sent by the plugin workload SDK E2E fixture.'

test.describe('Desktop SDK clientNotifications journey', () => {
  test('delivers plugin workload SDK notifications through the bell and desktop ACK', async () => {
    test.setTimeout(300_000)
    const marker = Date.now().toString(36)
    const recipeName = makeScopedSdkRecipeName(marker)
    let app: Awaited<ReturnType<typeof launchAndLogin>>['app'] | null = null
    let userId = ''
    let notificationId = ''

    try {
      await test.step('Precondition: authorized SDK workload targets the logged-in desktop user', async () => {
        await clearSession()
        cleanupSdkWorkloadRecipe(recipeName)
        const login = await loginAs(E2E_EMAIL)
        userId = login.userId
        applySdkWorkloadRecipe(recipeName, userId)
        await createSdkWorkloadGrants(recipeName, userId)
        restartSdkCallerWorkload(recipeName)
        notificationId = await waitForSdkCallerNotification(recipeName)

        const queued = fetchNotificationDeliveryRow(notificationId)
        expect(queued).toMatchObject({
          eventType: 'plugin_workload_sdk.notification',
          status: 'queued',
          userId,
          deliveredMedium: null,
        })
      })

      await test.step('Open Desktop, read the SDK notification from the bell, and ACK on display', async () => {
        const launched = await launchAndLogin(E2E_EMAIL)
        app = launched.app
        await expectDesktopSdkNotificationInBell(launched.page, recipeName, SDK_NOTIFICATION_BODY)
        await waitForDesktopNotificationAck(notificationId, userId)
      })
    } finally {
      if (app) await app.close().catch(() => undefined)
      cleanupSdkWorkloadRecipe(recipeName)
    }
  })
})
