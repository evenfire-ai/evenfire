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
  'No external channels are connected. Connect one under Social channels.'

async function loginProfileUi(page: Page): Promise<void> {
  // profile-ui uses a real email+password sign-in (LoginPanel), not a dev login.
  // The seeded password for the E2E user is provided via the desktop env.
  const password = process.env.E2E_DESKTOP_PASSWORD || process.env.E2E_TEST_PASSWORD || 'test123!'
  // E2E_GUARDIAN_NAVIGATION: root-entry — ordinary password login owns this session.
  await page.goto('/')
  await page.getByLabel('Email').fill(E2E_EMAIL)
  await page.getByLabel('Password').fill(password)
  const loginResponse = page.waitForResponse(
    response =>
      response.url().endsWith('/api/v1/auth/password-login') &&
      response.request().method() === 'POST'
  )
  await page.getByRole('button', { name: 'Sign in' }).click()
  expect((await loginResponse).status()).toBe(200)
  await expect(page.getByRole('heading', { name: 'Social channels', exact: true })).toBeVisible({
    timeout: 30_000,
  })
}

async function openApprovalChannels(page: Page, baseUrl: string): Promise<void> {
  await page.getByRole('link', { name: 'Settings', exact: true }).click()
  await page.getByRole('tab', { name: 'Approval channels', exact: true }).click()
  await expect(page).toHaveURL(`${baseUrl}/settings/approval-channels`)
  await expect(page.getByRole('heading', { name: 'Preferred approval channel' })).toBeVisible()
}

async function editPreferredAccount(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Edit preferred channel' }).click()
  await expect(preferredAccountSelect(page)).toBeVisible()
}

async function disconnectAccount(
  page: Page,
  baseUrl: string,
  binding: TelegramMediumBinding
): Promise<void> {
  await page.getByRole('link', { name: 'Social channels' }).click()
  await expect(page).toHaveURL(`${baseUrl}/channels/telegram`)
  const row = page.getByRole('row').filter({ hasText: accountDisplayName(binding) })
  await row.getByRole('button', { name: /Actions for/ }).click()
  await page.getByRole('menuitem', { name: 'Delete connection' }).click()
  await page.getByRole('button', { name: 'Delete connection', exact: true }).click()
  await expect(page.getByText('Telegram identity disconnected.')).toBeVisible({ timeout: 30_000 })
  await openApprovalChannels(page, baseUrl)
}

function preferredAccountSelect(page: Page) {
  return page.locator(PREFERRED_ACCOUNT_SELECT)
}

async function preferredOptionLabels(page: Page): Promise<string[]> {
  return preferredAccountSelect(page).locator('option').allTextContents()
}

function accountDisplayName(binding: TelegramMediumBinding): string {
  return `E2E Telegram ${binding.providerChannelId}`
}

function preferredAccountOptionLabel(binding: TelegramMediumBinding) {
  return expect.stringContaining(accountDisplayName(binding))
}

function nameEnrolledAccounts(userId: string): void {
  // Name real enrolled records so two private accounts on one target remain
  // distinguishable through the same display-name contract used by the UI.
  for (const binding of [ACCOUNT_A, ACCOUNT_B]) {
    profilesSql(`UPDATE workflow_approval_medium_accounts
      SET display_name = ${sqlLiteral(accountDisplayName(binding))}
      WHERE user_id = ${sqlLiteral(userId)} AND medium = 'telegram'
        AND provider_user_id = ${sqlLiteral(binding.providerUserId)}
        AND provider_channel_id = ${sqlLiteral(binding.providerChannelId)};`)
  }
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

      nameEnrolledAccounts(userId)
      profilePage = await browser.newPage({ baseURL: profileUiBaseUrl })
      await loginProfileUi(profilePage)
      await openApprovalChannels(profilePage, profileUiBaseUrl)

      // Picker is rendered with exactly one account option + the leading Automatico.
      await editPreferredAccount(profilePage)
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
      await profilePage
        .getByRole('dialog')
        .getByRole('button', { name: 'Save', exact: true })
        .click()
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

      nameEnrolledAccounts(userId)
      profilePage = await browser.newPage({ baseURL: profileUiBaseUrl })
      await loginProfileUi(profilePage)
      await openApprovalChannels(profilePage, profileUiBaseUrl)

      await editPreferredAccount(profilePage)
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
      await profilePage
        .getByRole('dialog')
        .getByRole('button', { name: 'Save', exact: true })
        .click()
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

      nameEnrolledAccounts(userId)
      profilePage = await browser.newPage({ baseURL: profileUiBaseUrl })
      await loginProfileUi(profilePage)
      await openApprovalChannels(profilePage, profileUiBaseUrl)

      await editPreferredAccount(profilePage)

      // Set preferred = account A, confirm persistence.
      const accountAId = mediumAccountId(userId, ACCOUNT_A)
      await preferredAccountSelect(profilePage).selectOption(accountAId)
      await profilePage
        .getByRole('dialog')
        .getByRole('button', { name: 'Save', exact: true })
        .click()
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

      await disconnectAccount(profilePage, profileUiBaseUrl, ACCOUNT_A)
      await editPreferredAccount(profilePage)

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
      expect(remainingLabels).not.toContainEqual(preferredAccountOptionLabel(ACCOUNT_A))
      expect(remainingLabels).toContainEqual(preferredAccountOptionLabel(ACCOUNT_B))
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

      nameEnrolledAccounts(userId)
      profilePage = await browser.newPage({ baseURL: profileUiBaseUrl })
      await loginProfileUi(profilePage)
      await openApprovalChannels(profilePage, profileUiBaseUrl)

      await editPreferredAccount(profilePage)

      await profilePage
        .getByRole('dialog')
        .getByRole('button', { name: 'Cancel', exact: true })
        .click()
      for (const binding of [ACCOUNT_A, ACCOUNT_B]) {
        await disconnectAccount(profilePage, profileUiBaseUrl, binding)
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
