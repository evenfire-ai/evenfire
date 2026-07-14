import { type Page, expect, test } from '@playwright/test'
import { requireProfileUiBaseUrl } from './telegramApprovalMediumVerification'
import {
  TELEGRAM_ALT_CHAT_ID,
  TELEGRAM_CHAT_ID,
  applyTelegramCommunicationChannel,
  configureChannelReaderTelegramApiRoot,
  expectChannelReaderCanReachMcpHost,
  expectChannelReaderHasNoProviderHttpIngress,
  fakeTelegramPollingCount,
  installFakeTelegramProvider,
  removeFakeTelegramProvider,
  removeTelegramCommunicationChannel,
  restoreChannelReaderTelegramApiRoot,
  waitForChannelReader,
} from './third-party-authn-first-party-mcphost/fakeTelegramProvider'
import { E2E_EMAIL, HOST_REF } from './third-party-authn-first-party-mcphost/telegramE2eClient'
import {
  type TelegramMediumBinding,
  cleanupTelegramMediumBinding,
  enrollTelegramMedium,
  profilesSql,
  sqlLiteral,
} from './third-party-authn-first-party-mcphost/workflowApprovalJourney'
import { clearSession, loginAs } from './workflowUi'

// Two distinct PRIVATE Telegram accounts. For private chats the provider user id
// equals the provider channel id, which `enrollTelegramMedium` requires.
const ACCOUNT_A: TelegramMediumBinding = {
  providerUserId: TELEGRAM_CHAT_ID,
  providerChannelId: TELEGRAM_CHAT_ID,
}
const ACCOUNT_B: TelegramMediumBinding = {
  providerUserId: TELEGRAM_ALT_CHAT_ID,
  providerChannelId: TELEGRAM_ALT_CHAT_ID,
}

const PREFERRED_ACCOUNT_SELECT = '#preferred-notification-account'
const NO_EXTERNAL_CHANNELS_NOTE =
  'No external channels connected; deliveries will only reach the desktop app.'

async function loginProfileUi(page: Page, baseUrl: string): Promise<void> {
  // profile-ui uses a real email+password sign-in (LoginPanel), not a dev login.
  // The seeded password for the E2E user is provided via the desktop env.
  const password = process.env.E2E_DESKTOP_PASSWORD || process.env.E2E_TEST_PASSWORD || 'test123!'
  await page.goto(baseUrl)
  await page.getByLabel('Email').fill(E2E_EMAIL)
  await page.getByLabel('Password').fill(password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  // The authenticated app renders its nav after sign-in; "Signed in as …" lives
  // on /settings and /approval-channels, not the home, so confirm via the nav.
  await expect(page.getByRole('link', { name: 'Approval Channels' })).toBeVisible({
    timeout: 30_000,
  })
}

async function openApprovalChannels(page: Page, baseUrl: string): Promise<void> {
  await page.getByRole('link', { name: 'Approval Channels' }).click()
  await expect(page).toHaveURL(`${baseUrl}/approval-channels`)
  // The page has both an h1 page-title and an h2 section-title named "Approval
  // Channels"; pin the h1 to avoid a strict-mode match of two elements.
  await expect(page.getByRole('heading', { name: 'Approval Channels', level: 1 })).toBeVisible()
}

function preferredAccountSelect(page: Page) {
  return page.locator(PREFERRED_ACCOUNT_SELECT)
}

async function preferredOptionLabels(page: Page): Promise<string[]> {
  return preferredAccountSelect(page).locator('option').allTextContents()
}

function preferredAccountOptionLabel(binding: TelegramMediumBinding): string {
  return `Telegram · chat ${binding.providerChannelId}`
}

/**
 * Resolve the active workflow_approval_medium_accounts.id for the logged-in user
 * by Telegram binding. This is the value the preferred-account picker writes into
 * user_notification_preferences.preferred_account_id.
 */
function mediumAccountId(userId: string, binding: TelegramMediumBinding): string {
  const id = profilesSql(`
    SELECT id::text
      FROM workflow_approval_medium_accounts
     WHERE user_id = ${sqlLiteral(userId)}
       AND medium = 'telegram'
       AND provider_user_id = ${sqlLiteral(binding.providerUserId)}
       AND provider_channel_id = ${sqlLiteral(binding.providerChannelId)}
       AND disabled_at IS NULL
     ORDER BY created_at DESC
     LIMIT 1;
  `)
  expect(id, 'verified Telegram medium account should exist for the binding').toMatch(
    /^[0-9a-f-]{36}$/i
  )
  return id
}

function storedPreferredAccountId(userId: string): string {
  return profilesSql(`
    SELECT COALESCE(preferred_account_id::text, '')
      FROM user_notification_preferences
     WHERE user_id = ${sqlLiteral(userId)};
  `)
}

function resetNotificationPreferences(userId: string): void {
  profilesSql(
    `DELETE FROM user_notification_preferences WHERE user_id = ${sqlLiteral(userId)};`,
    20_000
  )
}

async function prepareFakeTelegram(): Promise<void> {
  installFakeTelegramProvider()
  configureChannelReaderTelegramApiRoot()
  applyTelegramCommunicationChannel(HOST_REF, [
    { providerChannelId: ACCOUNT_A.providerChannelId, providerUserId: ACCOUNT_A.providerUserId },
    { providerChannelId: ACCOUNT_B.providerChannelId, providerUserId: ACCOUNT_B.providerUserId },
  ])
  waitForChannelReader(HOST_REF)
  expectChannelReaderHasNoProviderHttpIngress(HOST_REF)
  expectChannelReaderCanReachMcpHost(HOST_REF)
  await expect
    .poll(() => fakeTelegramPollingCount(), {
      timeout: 30_000,
      intervals: [500, 1_000, 2_000],
      message: 'channel-reader should poll fake Telegram before enrollment',
    })
    .toBeGreaterThan(0)
}

function teardownFakeTelegram(): void {
  removeTelegramCommunicationChannel()
  restoreChannelReaderTelegramApiRoot()
  removeFakeTelegramProvider()
}

test.describe.serial('Profile UI preferred delivery account picker (Telegram)', () => {
  test('one account: default Automatico and one option, then pick persists', async ({
    browser,
  }) => {
    // Fail-fast: each scenario's fixture (fake provider + enrollment) has its own
    // bounded waits (≤90s each). 240s caps a stuck scenario; serial mode then
    // skips the rest instead of running each one to the old 15-minute ceiling.
    test.setTimeout(240_000)
    const profileUiBaseUrl = requireProfileUiBaseUrl()
    let profilePage: Page | null = null
    let userId = ''

    try {
      await clearSession()
      removeTelegramCommunicationChannel()
      cleanupTelegramMediumBinding(ACCOUNT_A)

      await prepareFakeTelegram()
      const session = await loginAs(E2E_EMAIL)
      userId = session.userId
      resetNotificationPreferences(userId)
      await enrollTelegramMedium(session.userToken, userId, ACCOUNT_A)

      profilePage = await browser.newPage()
      await loginProfileUi(profilePage, profileUiBaseUrl)
      await openApprovalChannels(profilePage, profileUiBaseUrl)

      // Picker is rendered with exactly one account option + the leading Automatico.
      await expect(preferredAccountSelect(profilePage)).toBeVisible({ timeout: 30_000 })
      await expect
        .poll(() => preferredOptionLabels(profilePage!), {
          timeout: 30_000,
          intervals: [500, 1_000, 2_000],
          message: 'one verified account should produce Automatico + one option',
        })
        .toEqual(['Automatic (most recent channel)', preferredAccountOptionLabel(ACCOUNT_A)])

      // Default is Automatico: the select value is empty (no preferred_account_id).
      await expect(preferredAccountSelect(profilePage)).toHaveValue('')
      expect(storedPreferredAccountId(userId)).toBe('')

      // Pick the account; the PUT must persist preferred_account_id to that id.
      const accountAId = mediumAccountId(userId, ACCOUNT_A)
      await preferredAccountSelect(profilePage).selectOption(accountAId)
      await expect(profilePage.getByText('Preferred channel updated.')).toBeVisible({
        timeout: 30_000,
      })
      await expect
        .poll(() => storedPreferredAccountId(userId), {
          timeout: 30_000,
          intervals: [500, 1_000, 2_000],
          message: 'selecting the only account should persist preferred_account_id',
        })
        .toBe(accountAId)
    } finally {
      if (profilePage) await profilePage.close().catch(() => undefined)
      if (userId) resetNotificationPreferences(userId)
      cleanupTelegramMediumBinding(ACCOUNT_A)
      teardownFakeTelegram()
    }
  })

  test('two accounts: both options + Automatico default, pick second persists', async ({
    browser,
  }) => {
    // Fail-fast: each scenario's fixture (fake provider + enrollment) has its own
    // bounded waits (≤90s each). 240s caps a stuck scenario; serial mode then
    // skips the rest instead of running each one to the old 15-minute ceiling.
    test.setTimeout(240_000)
    const profileUiBaseUrl = requireProfileUiBaseUrl()
    let profilePage: Page | null = null
    let userId = ''

    try {
      await clearSession()
      removeTelegramCommunicationChannel()
      cleanupTelegramMediumBinding(ACCOUNT_A)
      cleanupTelegramMediumBinding(ACCOUNT_B)

      await prepareFakeTelegram()
      const session = await loginAs(E2E_EMAIL)
      userId = session.userId
      resetNotificationPreferences(userId)
      await enrollTelegramMedium(session.userToken, userId, ACCOUNT_A)
      await enrollTelegramMedium(session.userToken, userId, ACCOUNT_B)

      profilePage = await browser.newPage()
      await loginProfileUi(profilePage, profileUiBaseUrl)
      await openApprovalChannels(profilePage, profileUiBaseUrl)

      await expect(preferredAccountSelect(profilePage)).toBeVisible({ timeout: 30_000 })
      await expect
        .poll(() => preferredOptionLabels(profilePage!), {
          timeout: 30_000,
          intervals: [500, 1_000, 2_000],
          message: 'two verified accounts should produce Automatico + both options',
        })
        .toEqual(
          expect.arrayContaining([
            'Automatic (most recent channel)',
            preferredAccountOptionLabel(ACCOUNT_A),
            preferredAccountOptionLabel(ACCOUNT_B),
          ])
        )
      expect((await preferredOptionLabels(profilePage)).length).toBe(3)

      // Default is Automatico (most-recent by backend COALESCE) until the user picks.
      await expect(preferredAccountSelect(profilePage)).toHaveValue('')
      expect(storedPreferredAccountId(userId)).toBe('')

      const accountBId = mediumAccountId(userId, ACCOUNT_B)
      await preferredAccountSelect(profilePage).selectOption(accountBId)
      await expect(profilePage.getByText('Preferred channel updated.')).toBeVisible({
        timeout: 30_000,
      })
      await expect
        .poll(() => storedPreferredAccountId(userId), {
          timeout: 30_000,
          intervals: [500, 1_000, 2_000],
          message: 'selecting the second account should persist its id',
        })
        .toBe(accountBId)
    } finally {
      if (profilePage) await profilePage.close().catch(() => undefined)
      if (userId) resetNotificationPreferences(userId)
      cleanupTelegramMediumBinding(ACCOUNT_A)
      cleanupTelegramMediumBinding(ACCOUNT_B)
      teardownFakeTelegram()
    }
  })

  test('remove preferred account: backend clears preference, picker drops it', async ({
    browser,
  }) => {
    // Fail-fast: each scenario's fixture (fake provider + enrollment) has its own
    // bounded waits (≤90s each). 240s caps a stuck scenario; serial mode then
    // skips the rest instead of running each one to the old 15-minute ceiling.
    test.setTimeout(240_000)
    const profileUiBaseUrl = requireProfileUiBaseUrl()
    let profilePage: Page | null = null
    let userId = ''

    try {
      await clearSession()
      removeTelegramCommunicationChannel()
      cleanupTelegramMediumBinding(ACCOUNT_A)
      cleanupTelegramMediumBinding(ACCOUNT_B)

      await prepareFakeTelegram()
      const session = await loginAs(E2E_EMAIL)
      userId = session.userId
      resetNotificationPreferences(userId)
      await enrollTelegramMedium(session.userToken, userId, ACCOUNT_A)
      await enrollTelegramMedium(session.userToken, userId, ACCOUNT_B)

      profilePage = await browser.newPage()
      await loginProfileUi(profilePage, profileUiBaseUrl)
      await openApprovalChannels(profilePage, profileUiBaseUrl)

      await expect(preferredAccountSelect(profilePage)).toBeVisible({ timeout: 30_000 })

      // Set preferred = account A, confirm persistence.
      const accountAId = mediumAccountId(userId, ACCOUNT_A)
      await preferredAccountSelect(profilePage).selectOption(accountAId)
      await expect(profilePage.getByText('Preferred channel updated.')).toBeVisible({
        timeout: 30_000,
      })
      await expect
        .poll(() => storedPreferredAccountId(userId), {
          timeout: 30_000,
          intervals: [500, 1_000, 2_000],
          message: 'preferred account A should persist before disconnect',
        })
        .toBe(accountAId)

      // Disconnect account A from the Approval Channels list.
      await profilePage
        .locator('.member-row', { hasText: `Private chat ID ${ACCOUNT_A.providerChannelId}` })
        .getByRole('button', { name: 'Disconnect' })
        .click()
      await expect(profilePage.getByText('Telegram identity disconnected.')).toBeVisible({
        timeout: 30_000,
      })

      // Backend lifecycle: disabling the preferred account clears preferred_account_id.
      await expect
        .poll(() => storedPreferredAccountId(userId), {
          timeout: 30_000,
          intervals: [500, 1_000, 2_000],
          message: 'disabling the saved preferred account should clear preferred_account_id',
        })
        .toBe('')

      // Picker no longer lists A; only the still-active B remains, and value is Automatico.
      await expect
        .poll(() => preferredOptionLabels(profilePage!), {
          timeout: 30_000,
          intervals: [500, 1_000, 2_000],
          message: 'the disabled account A must drop out of the picker',
        })
        .toEqual(['Automatic (most recent channel)', preferredAccountOptionLabel(ACCOUNT_B)])
      await expect(preferredAccountSelect(profilePage)).toHaveValue('')

      // With only B left, B is the de-facto default delivery channel (backend COALESCE),
      // while the UI still shows Automatico until an explicit pick.
      const remainingLabels = await preferredOptionLabels(profilePage)
      expect(remainingLabels).not.toContain(preferredAccountOptionLabel(ACCOUNT_A))
      expect(remainingLabels).toContain(preferredAccountOptionLabel(ACCOUNT_B))
    } finally {
      if (profilePage) await profilePage.close().catch(() => undefined)
      if (userId) resetNotificationPreferences(userId)
      cleanupTelegramMediumBinding(ACCOUNT_A)
      cleanupTelegramMediumBinding(ACCOUNT_B)
      teardownFakeTelegram()
    }
  })

  test('remove both accounts: picker hidden, desktop-only note shown', async ({ browser }) => {
    // Fail-fast: each scenario's fixture (fake provider + enrollment) has its own
    // bounded waits (≤90s each). 240s caps a stuck scenario; serial mode then
    // skips the rest instead of running each one to the old 15-minute ceiling.
    test.setTimeout(240_000)
    const profileUiBaseUrl = requireProfileUiBaseUrl()
    let profilePage: Page | null = null
    let userId = ''

    try {
      await clearSession()
      removeTelegramCommunicationChannel()
      cleanupTelegramMediumBinding(ACCOUNT_A)
      cleanupTelegramMediumBinding(ACCOUNT_B)

      await prepareFakeTelegram()
      const session = await loginAs(E2E_EMAIL)
      userId = session.userId
      resetNotificationPreferences(userId)
      await enrollTelegramMedium(session.userToken, userId, ACCOUNT_A)
      await enrollTelegramMedium(session.userToken, userId, ACCOUNT_B)

      profilePage = await browser.newPage()
      await loginProfileUi(profilePage, profileUiBaseUrl)
      await openApprovalChannels(profilePage, profileUiBaseUrl)

      await expect(preferredAccountSelect(profilePage)).toBeVisible({ timeout: 30_000 })

      // Disconnect both Telegram accounts.
      for (const binding of [ACCOUNT_A, ACCOUNT_B]) {
        await profilePage
          .locator('.member-row', { hasText: `Private chat ID ${binding.providerChannelId}` })
          .getByRole('button', { name: 'Disconnect' })
          .click()
        await expect(profilePage.getByText('Telegram identity disconnected.')).toBeVisible({
          timeout: 30_000,
        })
      }

      // Zero active accounts → the picker is not rendered; the desktop-only note shows.
      await expect(profilePage.getByText(NO_EXTERNAL_CHANNELS_NOTE)).toBeVisible({
        timeout: 30_000,
      })
      await expect(preferredAccountSelect(profilePage)).toHaveCount(0)

      // preferred_account_id is null in DB (empty COALESCE result).
      await expect
        .poll(() => storedPreferredAccountId(userId), {
          timeout: 30_000,
          intervals: [500, 1_000, 2_000],
          message: 'with no active accounts preferred_account_id must be null',
        })
        .toBe('')
    } finally {
      if (profilePage) await profilePage.close().catch(() => undefined)
      if (userId) resetNotificationPreferences(userId)
      cleanupTelegramMediumBinding(ACCOUNT_A)
      cleanupTelegramMediumBinding(ACCOUNT_B)
      teardownFakeTelegram()
    }
  })
})
