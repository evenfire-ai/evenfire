import { type Browser, chromium, expect, test } from '@playwright/test'
import fs from 'node:fs'
import {
  ensureUserCanAccessAgent,
  workflowApprovalMediumAccountCount,
} from '../telegramApprovalMediumVerification'
import {
  TELEGRAM_PROVIDER_USER_ID,
  applyTelegramCommunicationChannel,
  configureChannelReaderTelegramApiRoot,
  fakeTelegramPollingCount,
  fakeTelegramSentMessages,
  installFakeTelegramProvider,
  openFakeTelegramClientPortForward,
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
  profilesSql,
  sqlLiteral,
} from '../third-party-authn-first-party-mcphost/workflowApprovalJourney'
import { E2E_EMAIL, EXT_API, RECIPE_NS, clearSession, launchAndLogin, loginAs } from '../workflowUi'
import { expectDesktopSdkNotificationInBell } from './desktopSdkClientNotification'
import {
  expireNotificationGraceWindow,
  fetchNotificationDeliveryRow,
  notificationGraceSecondsRemaining,
  purgeStaleSdkNotifications,
  resetUserNotificationPreferences,
  waitForChannelReaderTerminalDelivery,
  waitForDesktopNotificationAck,
} from './sdkWorkloadFixture'

// The evenfire recipe (no-fallback, grant-driven recipients). Its sandbox-ui is
// the REAL sender here: a user opens it and clicks "Send notification", instead
// of a synthetic SDK fixture. The clientNotifications grant must already allow
// both test + test2 as userRefs and the `backend` caller (the recipe-deploy
// script seeds exactly that).
const RECIPE = process.env.E2E_SANDBOX_UI_RECIPE || 'evenfire-prompt-notify-app'
const RPC_PROXY = process.env.RPC_PROXY_BASE_URL || 'http://127.0.0.1:8094'
const SECOND_EMAIL = process.env.E2E_SECOND_USER_EMAIL || 'test2@clerum.io'
const SANDBOX_UI_RPC_HOST_REF = 'sandbox-ui'

// Distinct from the synthetic-fixture binding so the two suites never collide on
// the same fake chat. Private /verify enrollment requires chatId === senderId.
const TELEGRAM_BINDING: TelegramMediumBinding = {
  providerUserId: TELEGRAM_PROVIDER_USER_ID,
  providerChannelId: TELEGRAM_PROVIDER_USER_ID,
}

function resolveUserId(email: string): string {
  const id = profilesSql(
    `SELECT id::text FROM users WHERE lower(email) = ${sqlLiteral(email.toLowerCase())} LIMIT 1;`
  ).trim()
  if (!/^[0-9a-f-]{36}$/.test(id))
    throw new Error(`could not resolve user id for ${email}: "${id}"`)
  return id
}

/**
 * This suite exercises the team-grant sandbox-ui path. Teamless sessions can
 * use direct UI grants, but these E2E users stay in the same local team so the
 * sender session carries a teamId.
 */
function ensureUsersInSandboxUiTeam(userIds: string[]): void {
  const ids = userIds.filter(id => /^[0-9a-f-]{36}$/i.test(id))
  if (ids.length !== userIds.length || ids.length === 0) {
    throw new Error(`invalid E2E user ids for sandbox-ui team: ${userIds.join(', ')}`)
  }
  const idArray = ids.map(sqlLiteral).join(', ')
  profilesSql(`
    WITH existing AS (
      SELECT id FROM teams
       WHERE name = 'e2e-evenfire-prompt-notify'
       ORDER BY created_at ASC, id ASC
       LIMIT 1
    ),
    inserted AS (
      INSERT INTO teams(name)
      SELECT 'e2e-evenfire-prompt-notify'
       WHERE NOT EXISTS (SELECT 1 FROM existing)
      RETURNING id
    ),
    target_team AS (
      SELECT id FROM existing
      UNION ALL
      SELECT id FROM inserted
      LIMIT 1
    )
    INSERT INTO team_members (team_id, user_id, role, status)
    SELECT target_team.id, user_id, 'member', 'active'
      FROM target_team, unnest(ARRAY[${idArray}]::uuid[]) AS user_id
    ON CONFLICT (team_id, user_id)
    DO UPDATE SET role = 'member', status = 'active', updated_at = now();
  `)
}

function grantSandboxUiRecipeToUser(userId: string): void {
  profilesSql(`
    INSERT INTO user_workflow_triggers (user_id, recipe_namespace, recipe_name)
    VALUES (${sqlLiteral(userId)}, ${sqlLiteral(RECIPE_NS)}, ${sqlLiteral(RECIPE)})
    ON CONFLICT DO NOTHING;
  `)
}

/** Mint the sandbox-ui session a Desktop App WebContentsView would mint, for `userToken`. */
async function mintSandboxUiSession(userToken: string): Promise<string> {
  const tokenResp = await fetch(`${EXT_API}/api/v1/rpc/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${userToken}` },
    body: JSON.stringify({ scopes: ['sandbox:ui:view'], hostRefs: [SANDBOX_UI_RPC_HOST_REF] }),
  })
  const rpcToken = (JSON.parse(await tokenResp.text()) as { token?: string }).token
  expect(rpcToken, 'rpc token issuance must return a token').toBeTruthy()
  const sessionResp = await fetch(
    `${RPC_PROXY}/api/v1/sandbox-ui/${encodeURIComponent(RECIPE_NS)}/${encodeURIComponent(
      RECIPE
    )}/session`,
    { method: 'POST', headers: { Authorization: `Bearer ${rpcToken}` } }
  )
  expect(sessionResp.status, await sessionResp.text()).toBe(204)
  const setCookie = sessionResp.headers.get('set-cookie') ?? ''
  expect(setCookie).toContain('clerum_sandbox_ui_session=')
  return setCookie.split(';', 1)[0]
}

/**
 * Drive the recipe's sandbox-ui as a real user: select the recipient BY EMAIL,
 * fill the notify form, send, and return the SDK notificationId. This is the
 * real send path (no API shortcut) — the same UI a Desktop App embeds.
 */
async function sendNotificationFromSandboxUi(
  browser: Browser,
  userToken: string,
  recipientEmail: string,
  body: string
): Promise<string> {
  const cookie = await mintSandboxUiSession(userToken)
  const rpcUrl = new URL(RPC_PROXY)
  const context = await browser.newContext()
  await context.addCookies([
    {
      name: 'clerum_sandbox_ui_session',
      value: cookie.split('=').slice(1).join('='),
      domain: rpcUrl.hostname,
      path: '/',
    },
  ])
  const page = await context.newPage()
  try {
    await page.goto(
      `${RPC_PROXY}/api/v1/sandbox-ui/${encodeURIComponent(RECIPE_NS)}/${encodeURIComponent(
        RECIPE
      )}/view/`,
      { waitUntil: 'domcontentloaded' }
    )
    const userSelect = page.locator('#userRef')
    const realOptions = userSelect.locator('option[value]:not([value=""])')
    await expect
      .poll(() => realOptions.count(), {
        timeout: 25_000,
        message: 'recipient dropdown never populated from the SDK grant',
      })
      .toBeGreaterThan(0)
    // The dropdown shows EMAIL handles — pick the recipient by their email.
    await userSelect.selectOption({ label: recipientEmail })
    await page.locator('#title').fill('Cross-user SDK notification')
    await page.locator('#message').fill(body)
    const notifyOut = page.locator('#notify-out')
    await page.locator('#notify').click()
    // Wait for the TERMINAL result (notificationId or an error) — never the
    // transient 'Sending…' phase, which a fast SDK accept races right past.
    await expect(notifyOut).toContainText(/notificationId|error/i, { timeout: 30_000 })
    const text = ((await notifyOut.textContent()) ?? '').trim()
    expect(text.toLowerCase()).not.toContain('unauthorized')
    const match = text.match(/"notificationId"\s*:\s*"([0-9a-f-]{36})"/i)
    if (!match) throw new Error(`sandbox-ui notify did not return a notificationId: "${text}"`)
    return match[1]
  } finally {
    await context.close()
  }
}

test.describe('Evenfire sandbox-ui — cross-user SDK notification delivery', () => {
  test('test2 sends from the sandbox-ui and test reads it in the Desktop bell', async () => {
    test.setTimeout(300_000)
    const marker = `xuser-desktop-${Date.now().toString(36)}`
    const body = `Cross-user desktop delivery ${marker}.`
    let browser: Browser | null = null
    let notificationId = ''

    try {
      await test.step('Precondition: both users provisioned; recipient inbox clean', async () => {
        await clearSession()
        const recipient = await loginAs(E2E_EMAIL) // test = the recipient (will go online)
        const sender = await loginAs(SECOND_EMAIL) // test2 = the sender (sandbox-ui)
        expect(recipient.userId).toMatch(/^[0-9a-f-]{36}$/)
        expect(sender.userId).toMatch(/^[0-9a-f-]{36}$/)
        ensureUserCanAccessAgent(recipient.userId, HOST_REF)
        // test2 is the SENDER: sandbox-ui access is team-scoped, so both users
        // need active team membership before control-api can mint a team-scoped
        // sandbox:ui:view RPC token.
        ensureUsersInSandboxUiTeam([recipient.userId, sender.userId])
        ensureUserCanAccessAgent(sender.userId, HOST_REF)
        grantSandboxUiRecipeToUser(sender.userId)
        // Isolation: only this test's delivery should reach the recipient.
        purgeStaleSdkNotifications(recipient.userId)
      })

      const sender = await loginAs(SECOND_EMAIL) // re-login: token now carries the team
      browser = await chromium.launch()

      await test.step('test goes ONLINE in the Desktop App, then test2 sends from the sandbox-ui', async () => {
        const { app, page } = await launchAndLogin(E2E_EMAIL)
        try {
          // test2 sends to test from the recipe sandbox-ui (recipient picked by email).
          notificationId = await sendNotificationFromSandboxUi(
            browser!,
            sender.userToken,
            E2E_EMAIL,
            body
          )
          expect(notificationId).toMatch(/^[0-9a-f-]{36}$/)

          // Desktop reception: test reads the SDK notification in the bell.
          await expectDesktopSdkNotificationInBell(page, RECIPE, body)
          // Business signal: desktop display drives the terminal ACK to 'desktop'.
          const recipientId = resolveUserId(E2E_EMAIL)
          await waitForDesktopNotificationAck(notificationId, recipientId)
          const delivered = fetchNotificationDeliveryRow(notificationId)
          expect(delivered).toMatchObject({
            status: 'sent',
            deliveredMedium: 'desktop',
            userId: recipientId,
          })
          if (process.env.E2E_EVIDENCE_DIR)
            await page.screenshot({
              path: `${process.env.E2E_EVIDENCE_DIR}/delivery-1-desktop-bell.png`,
            })
        } finally {
          await app.close().catch(() => undefined)
        }
      })
    } finally {
      if (browser) await browser.close().catch(() => undefined)
    }
  })

  test('test sends from the sandbox-ui to OFFLINE test2, which falls back to Telegram', async () => {
    test.setTimeout(420_000)
    const marker = `xuser-telegram-${Date.now().toString(36)}`
    const body = `Cross-user telegram fallback ${marker}.`
    let browser: Browser | null = null
    let notificationId = ''
    let recipientId = ''

    try {
      await test.step('Precondition: fake Telegram reachable; test2 has a verified Telegram medium and is offline', async () => {
        await clearSession()
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
        await expect
          .poll(() => fakeTelegramPollingCount(), {
            timeout: 30_000,
            intervals: [500, 1_000, 2_000],
            message: 'channel-reader should be polling fake Telegram before fallback',
          })
          .toBeGreaterThan(0)

        const recipient = await loginAs(SECOND_EMAIL) // test2 = OFFLINE recipient
        recipientId = recipient.userId
        expect(recipientId).toMatch(/^[0-9a-f-]{36}$/)
        ensureUserCanAccessAgent(recipientId, HOST_REF)
        resetUserNotificationPreferences(recipientId)
        purgeStaleSdkNotifications(recipientId)
        // Real challenge/confirm enrollment so the verified medium account exists.
        await enrollTelegramMedium(recipient.userToken, recipientId, TELEGRAM_BINDING)
        expect(workflowApprovalMediumAccountCount(TELEGRAM_BINDING)).toBe(1)
      })

      const senderId = resolveUserId(E2E_EMAIL)
      ensureUsersInSandboxUiTeam([senderId, recipientId])
      const sender = await loginAs(E2E_EMAIL) // test = the sender (sandbox-ui)
      grantSandboxUiRecipeToUser(sender.userId)
      browser = await chromium.launch()

      await test.step('test sends to test2 from the sandbox-ui while test2 has no Desktop session', async () => {
        notificationId = await sendNotificationFromSandboxUi(
          browser!,
          sender.userToken,
          SECOND_EMAIL,
          body
        )
        expect(notificationId).toMatch(/^[0-9a-f-]{36}$/)
        const queued = fetchNotificationDeliveryRow(notificationId)
        expect(queued).toMatchObject({
          eventType: 'plugin_workload_sdk.notification',
          status: 'queued',
          userId: recipientId,
          deliveredMedium: null,
        })
      })

      await test.step('Route guard: no Telegram delivery while the desktop grace window is active', async () => {
        if (notificationGraceSecondsRemaining(notificationId) > 0) {
          const duringGrace = fetchNotificationDeliveryRow(notificationId)
          expect(duringGrace?.deliveredMedium).not.toBe('telegram')
          expect(
            fakeTelegramSentMessages(TELEGRAM_PROVIDER_USER_ID).filter(m => m.text.includes(body))
          ).toHaveLength(0)
        }
      })

      await test.step('Grace window elapses and the notification is delivered through Telegram', async () => {
        expireNotificationGraceWindow(notificationId)
        await expect
          .poll(
            () =>
              fakeTelegramSentMessages(TELEGRAM_PROVIDER_USER_ID).some(m => m.text.includes(body)),
            {
              timeout: 90_000,
              intervals: [1_000, 2_000, 5_000],
              message: 'fake Telegram should receive the sandbox-ui notification body on fallback',
            }
          )
          .toBe(true)
        await waitForChannelReaderTerminalDelivery(notificationId, recipientId)
        const delivered = fetchNotificationDeliveryRow(notificationId)
        expect(delivered?.status).toBe('sent')
        expect(delivered?.userId).toBe(recipientId)
        expect(delivered?.deliveredMedium).toBe('telegram')
        if (process.env.E2E_EVIDENCE_DIR) {
          fs.mkdirSync(process.env.E2E_EVIDENCE_DIR, { recursive: true })
          const sentMessages = fakeTelegramSentMessages(TELEGRAM_PROVIDER_USER_ID).filter(m =>
            m.text.includes(body)
          )
          fs.writeFileSync(
            `${process.env.E2E_EVIDENCE_DIR}/telegram-fallback-to-test2-clerum-io.json`,
            `${JSON.stringify(
              {
                recipientEmail: SECOND_EMAIL,
                recipientId,
                notificationId,
                expectedBody: body,
                delivery: delivered,
                sentMessages,
              },
              null,
              2
            )}\n`
          )

          const telegramClient = await openFakeTelegramClientPortForward()
          const telegramPage = await browser!.newPage()
          try {
            await telegramPage.goto(telegramClient.url, { waitUntil: 'domcontentloaded' })
            await telegramPage.evaluate(providerUserId => {
              const clientWindow = window as Window & {
                __registerTelegramConversation?: (identity: {
                  conversationLabel: string
                  providerUserId: string
                  providerChannelId: string
                  providerChannelType: 'private'
                }) => void
              }
              clientWindow.__registerTelegramConversation?.({
                conversationLabel: 'E2E fake Telegram fallback for test2',
                providerUserId,
                providerChannelId: providerUserId,
                providerChannelType: 'private',
              })
            }, TELEGRAM_PROVIDER_USER_ID)
            await telegramPage
              .getByTestId('telegram-conversation-select')
              .selectOption('E2E fake Telegram fallback for test2')
            await expect(
              telegramPage.getByTestId('telegram-bot-reply').filter({ hasText: body }).first()
            ).toBeVisible({ timeout: 15_000 })
            await telegramPage.screenshot({
              path: `${process.env.E2E_EVIDENCE_DIR}/telegram-fallback-to-test2-clerum-io.png`,
              fullPage: true,
            })
          } finally {
            await telegramPage.close().catch(() => undefined)
            telegramClient.stop()
          }
        }
      })
    } finally {
      if (browser) await browser.close().catch(() => undefined)
      cleanupTelegramMediumBinding(TELEGRAM_BINDING)
      removeTelegramCommunicationChannel()
      restoreChannelReaderTelegramApiRoot()
      removeFakeTelegramProvider()
    }
  })
})
