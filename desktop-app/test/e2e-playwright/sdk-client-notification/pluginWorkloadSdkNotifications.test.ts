import { expect, test } from '@playwright/test'
import {
  ensureUserCanAccessAgent,
  workflowApprovalMediumAccountCount,
} from '../telegramApprovalMediumVerification'
import {
  TELEGRAM_PROVIDER_USER_ID,
  applyTelegramCommunicationChannel,
  configureChannelReaderTelegramApiRoot,
  expectChannelReaderLoadedTelegram,
  fakeTelegramPollingCount,
  fakeTelegramSentMessages,
  installFakeTelegramProvider,
  removeFakeTelegramProvider,
  removeTelegramCommunicationChannel,
  restoreChannelReaderTelegramApiRoot,
  waitForChannelReader,
} from '../third-party-authn-first-party-mcphost/fakeTelegramProvider'
import { HOST_REF } from '../third-party-authn-first-party-mcphost/telegramE2eClient'
import {
  type TelegramMediumBinding,
  cleanupTelegramMediumBinding,
  enrollTelegramMedium,
} from '../third-party-authn-first-party-mcphost/workflowApprovalJourney'
import { E2E_EMAIL, clearSession, launchAndLogin, loginAs } from '../workflowUi'
import { expectDesktopSdkNotificationInBell } from './desktopSdkClientNotification'
import {
  applySdkWorkloadRecipe,
  cleanupSdkWorkloadRecipe,
  createSdkWorkloadGrants,
  expireNotificationGraceWindow,
  fetchNotificationDeliveryRow,
  makeScopedSdkRecipeName,
  notificationGraceSecondsRemaining,
  purgeStaleSdkNotifications,
  resetUserNotificationPreferences,
  restartSdkCallerWorkload,
  waitForChannelReaderTerminalDelivery,
  waitForDesktopNotificationAck,
  waitForSdkCallerNotification,
  waitForSdkPromptBridgeInvocation,
} from './sdkWorkloadFixture'

// Body emitted by tests/e2e/fixtures/workflow-plugin-sdk-e2e/src/index.js. The
// fake Telegram channel and the desktop bell both surface this exact text, so
// it doubles as the business signal that proves the SDK notification — not some
// other delivery — reached the medium under test.
const SDK_NOTIFICATION_BODY = 'Sent by the plugin workload SDK E2E fixture.'

// Private Telegram /verify enrollment requires chatId === senderId. Keep one
// stable id so the CommunicationChannel allowlist, verified medium account,
// and fakeTelegramSentMessages fallback signal all align.
const TELEGRAM_BINDING: TelegramMediumBinding = {
  providerUserId: TELEGRAM_PROVIDER_USER_ID,
  providerChannelId: TELEGRAM_PROVIDER_USER_ID,
}

test.describe('Plugin Workload SDK notifications', () => {
  test('positive: SDK workload calls the LLM and the user reads the notification in the Desktop bell', async () => {
    test.setTimeout(360_000)
    const marker = `desktop-${Date.now().toString(36)}`
    const recipeName = makeScopedSdkRecipeName(marker)
    let userId = ''
    let notificationId = ''

    try {
      await test.step('Precondition: authorized SDK workload targets the logged-in desktop user', async () => {
        await clearSession()
        cleanupSdkWorkloadRecipe(recipeName)
        const login = await loginAs(E2E_EMAIL)
        userId = login.userId
        expect(userId).toMatch(/^[0-9a-f-]{36}$/)
        // The desktop app only renders the authenticated shell (and the
        // notification bell) when the user is associated with an agent, so seed
        // the user→agent access the same way the offline-fallback test does.
        ensureUserCanAccessAgent(userId, HOST_REF)
        // Isolation: drop any non-terminal SDK deliveries a prior run left
        // queued so per-notification assertions only see this test's delivery.
        purgeStaleSdkNotifications(userId)
        applySdkWorkloadRecipe(recipeName, userId)
        await createSdkWorkloadGrants(recipeName, userId)
      })

      await test.step('SDK workload performs an LLM (promptBridge) round-trip', async () => {
        restartSdkCallerWorkload(recipeName)
        // Business signal: the workload only logs an invocationId after the SDK
        // proxied the prompt to the LLM and returned a response.
        const invocationId = await waitForSdkPromptBridgeInvocation(recipeName)
        expect(invocationId.length).toBeGreaterThan(0)
      })

      await test.step('SDK workload enqueues a clientNotification for the granted user', async () => {
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
        const { app, page } = await launchAndLogin(E2E_EMAIL)
        try {
          // Visible UI signal: the SDK notification renders in the bell panel.
          await expectDesktopSdkNotificationInBell(page, recipeName, SDK_NOTIFICATION_BODY)
          // Business signal: desktop display drives the terminal ACK to the
          // desktop medium (never Telegram while the user is connected).
          await waitForDesktopNotificationAck(notificationId, userId)
          const delivered = fetchNotificationDeliveryRow(notificationId)
          expect(delivered).toMatchObject({
            status: 'sent',
            deliveredMedium: 'desktop',
            userId,
          })
        } finally {
          await app.close().catch(() => undefined)
        }
      })
    } finally {
      cleanupSdkWorkloadRecipe(recipeName)
    }
  })

  test('negative: offline user falls back to Telegram after the desktop grace window', async () => {
    test.setTimeout(420_000)
    const marker = `telegram-${Date.now().toString(36)}`
    const recipeName = makeScopedSdkRecipeName(marker)
    let userId = ''
    let notificationId = ''

    try {
      await test.step('Precondition: fake Telegram channel reachable and SDK workload authorized', async () => {
        await clearSession()
        cleanupSdkWorkloadRecipe(recipeName)
        cleanupTelegramMediumBinding(TELEGRAM_BINDING)
        removeTelegramCommunicationChannel()

        installFakeTelegramProvider()
        configureChannelReaderTelegramApiRoot()
        applyTelegramCommunicationChannel(HOST_REF, [
          {
            providerChannelId: TELEGRAM_BINDING.providerChannelId,
            providerUserId: TELEGRAM_BINDING.providerUserId,
          },
        ])
        waitForChannelReader(HOST_REF)
        expectChannelReaderLoadedTelegram(HOST_REF)
        await expect
          .poll(() => fakeTelegramPollingCount(), {
            timeout: 30_000,
            intervals: [500, 1_000, 2_000],
            message: 'channel-reader should be polling fake Telegram before fallback',
          })
          .toBeGreaterThan(0)

        const login = await loginAs(E2E_EMAIL)
        userId = login.userId
        expect(userId).toMatch(/^[0-9a-f-]{36}$/)
        ensureUserCanAccessAgent(userId, HOST_REF)
        // Precondition: channel fallback must be enabled for this user. Clear any
        // stale preferences row so COALESCE defaults fallback on and preferred
        // medium resolves to the verified Telegram account.
        resetUserNotificationPreferences(userId)
        // Isolation: drop any non-terminal SDK deliveries a prior run left
        // queued; once fallback is enabled the channel-reader would otherwise
        // claim and send them to the fresh fake Telegram inbox.
        purgeStaleSdkNotifications(userId)

        // Realistic precondition: the user connected Telegram through the
        // challenge/confirm flow (not a direct DB insert), so the verified
        // medium account exists.
        await enrollTelegramMedium(login.userToken, userId, TELEGRAM_BINDING)
        expect(workflowApprovalMediumAccountCount(TELEGRAM_BINDING)).toBe(1)

        applySdkWorkloadRecipe(recipeName, userId)
        await createSdkWorkloadGrants(recipeName, userId)
      })

      await test.step('SDK workload enqueues a clientNotification while the user is offline', async () => {
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

      await test.step('Route guard: no Telegram delivery while the desktop grace window is active', async () => {
        const graceSeconds = notificationGraceSecondsRemaining(notificationId)
        if (graceSeconds > 0) {
          // The desktop-first window is still open: the channel-reader must NOT
          // have fallen back to Telegram yet. We never open the Desktop app, so
          // the only way out is the grace-gated fallback we exercise next.
          // Filter to the SDK notification body: the enrollment challenge/confirm
          // flow (precondition) also messages this fake chat, and that unrelated
          // chatter must not be conflated with an SDK delivery.
          const duringGrace = fetchNotificationDeliveryRow(notificationId)
          expect(duringGrace?.deliveredMedium).not.toBe('telegram')
          expect(
            fakeTelegramSentMessages(TELEGRAM_PROVIDER_USER_ID).filter(message =>
              message.text.includes(SDK_NOTIFICATION_BODY)
            )
          ).toHaveLength(0)
        }
      })

      await test.step('Grace window elapses and the notification is delivered through Telegram', async () => {
        // Fast-forward only the grace clock; the real channel-reader still has
        // to claim the delivery and send it through the fake Telegram provider.
        expireNotificationGraceWindow(notificationId)

        // Authoritative business signal at the external boundary: the bot
        // actually emitted the SDK notification body to the verified chat. The
        // desktop app was never opened, so this can only be the messaging
        // fallback, not a desktop delivery.
        await expect
          .poll(
            () =>
              fakeTelegramSentMessages(TELEGRAM_PROVIDER_USER_ID).some(message =>
                message.text.includes(SDK_NOTIFICATION_BODY)
              ),
            {
              timeout: 90_000,
              intervals: [1_000, 2_000, 5_000],
              message: 'fake Telegram should receive the SDK notification body on fallback',
            }
          )
          .toBe(true)

        // The delivery row settles as terminal for this user and is not a
        // desktop ACK (delivered_medium never becomes 'desktop' here).
        await waitForChannelReaderTerminalDelivery(notificationId, userId)
        const delivered = fetchNotificationDeliveryRow(notificationId)
        expect(delivered?.status).toBe('sent')
        expect(delivered?.userId).toBe(userId)
        // S4: the channel terminal ACK now records the delivering medium, so
        // this is the verified-Telegram fallback (never a desktop delivery).
        expect(delivered?.deliveredMedium).toBe('telegram')
      })
    } finally {
      cleanupSdkWorkloadRecipe(recipeName)
      cleanupTelegramMediumBinding(TELEGRAM_BINDING)
      removeTelegramCommunicationChannel()
      restoreChannelReaderTelegramApiRoot()
      removeFakeTelegramProvider()
    }
  })
})
