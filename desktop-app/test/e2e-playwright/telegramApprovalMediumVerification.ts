import { type Page, expect } from '@playwright/test'
import { watchdogStep } from './e2eTestUtils'
import {
  CHANNELS_NS,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHANNEL_NAME,
  applyTelegramCommunicationChannel,
} from './third-party-authn-first-party-mcphost/fakeTelegramProvider'
import {
  type TelegramMediumBinding,
  cleanupTelegramMediumBinding,
  kubectl,
  profilesSql,
  sqlLiteral,
} from './third-party-authn-first-party-mcphost/workflowApprovalJourney'
import { K8S_CONTEXT } from './workflowUi'

const PENDING_PROVIDER_EVENT_USER_ID = '__telegram_provider_event_pending__'
const CONTROL_UI = (process.env.CONTROL_UI_BASE_URL || process.env.CONTROL_UI_URL || '').replace(
  /\/$/,
  ''
)
const ADMIN_USERNAME = process.env.E2E_ADMIN_USERNAME || process.env.ADMIN_USER || 'admin'
const ADMIN_PASSWORD =
  process.env.E2E_ADMIN_PASSWORD ||
  process.env.ADMIN_PASSWORD ||
  process.env.ADMIN_PASS ||
  process.env.TEST_ADMIN_PASSWORD ||
  (/^clerum-(?:test|codex-|detached-)/.test(K8S_CONTEXT) ? 'changeme123!' : '')

function externalChannelsNav(page: Page) {
  return page
    .getByRole('link', { name: 'External Channels' })
    .or(page.getByRole('button', { name: 'External Channels' }))
}

function loginUsernameInput(page: Page) {
  return page.getByLabel(/Username(?: or email)?/i)
}

type TelegramRoute = {
  channelId: string
  chatType: 'private' | 'group' | 'supergroup'
}

async function controlUiWatchdogStep<T>(
  name: string,
  timeoutMs: number,
  body: () => Promise<T> | T
): Promise<T> {
  return watchdogStep(name, timeoutMs, body, {
    timeoutLabel: `Control UI step: ${name}`,
  })
}

function requireControlUiBaseUrl(): string {
  if (!CONTROL_UI) {
    throw new Error('CONTROL_UI_BASE_URL or CONTROL_UI_URL is required for Control UI E2E')
  }
  if (
    /^clerum-(codex|detached)-/.test(K8S_CONTEXT) &&
    /^https?:\/\/(localhost|127\.0\.0\.1):3000(?:\/|$)/.test(CONTROL_UI)
  ) {
    throw new Error('branch-scoped Control UI E2E must not use fixed localhost port 3000')
  }
  return CONTROL_UI
}

function requireAdminPassword(): string {
  if (!ADMIN_PASSWORD) {
    throw new Error(
      'E2E_ADMIN_PASSWORD, ADMIN_PASSWORD, or ADMIN_PASS is required for Control UI E2E'
    )
  }
  return ADMIN_PASSWORD
}

export function requireProfileUiBaseUrl(): string {
  const url = process.env.PROFILE_UI_BASE_URL || process.env.PROFILE_UI_URL
  if (!url) {
    throw new Error('PROFILE_UI_BASE_URL or PROFILE_UI_URL is required for profile-ui E2E')
  }
  if (
    /^clerum-(codex|detached)-/.test(K8S_CONTEXT) &&
    /^https?:\/\/(localhost|127\.0\.0\.1):3001(?:\/|$)/.test(url)
  ) {
    throw new Error('branch-scoped profile-ui E2E must not use fixed localhost port 3001')
  }
  return url.replace(/\/$/, '')
}

async function loginControlUi(page: Page, baseUrl: string): Promise<void> {
  await page.goto(baseUrl)
  const usernameInput = loginUsernameInput(page)
  await expect(usernameInput.or(externalChannelsNav(page))).toBeVisible({
    timeout: 30_000,
  })
  if (await usernameInput.isVisible().catch(() => false)) {
    await usernameInput.fill(ADMIN_USERNAME)
    await page.getByLabel('Password').fill(requireAdminPassword())
    const signInButton = page.getByRole('button', { name: /^Sign in$/ })
    await expect(signInButton).toBeEnabled({ timeout: 10_000 })
    await signInButton.click()
  }
  await expect(externalChannelsNav(page)).toBeVisible({ timeout: 30_000 })
  await expect(page.getByRole('button', { name: 'Log out' })).toBeVisible({ timeout: 30_000 })
}

export function telegramCommunicationChannelRoutes(): TelegramRoute[] {
  const raw = kubectl(
    ['-n', CHANNELS_NS, 'get', 'communicationchannel', TELEGRAM_CHANNEL_NAME, '-o', 'json'],
    undefined,
    10_000
  )
  const parsed = JSON.parse(raw) as {
    spec?: { telegram?: Array<{ channelId?: string; chatType?: string }> }
  }
  return (parsed.spec?.telegram ?? [])
    .map(item => ({
      channelId: String(item.channelId || ''),
      chatType:
        item.chatType === 'group' || item.chatType === 'private' || item.chatType === 'supergroup'
          ? item.chatType
          : null,
    }))
    .filter((item): item is TelegramRoute => !!item.channelId && !!item.chatType)
}

export async function createTelegramCommunicationChannelFromControlUi(
  page: Page,
  hostName: string,
  routes: TelegramRoute[]
): Promise<void> {
  const baseUrl = requireControlUiBaseUrl()
  await controlUiWatchdogStep('login Control UI', 35_000, () => loginControlUi(page, baseUrl))

  await controlUiWatchdogStep('open communication channels tab', 35_000, async () => {
    await externalChannelsNav(page).click()
    await expect(page).toHaveURL(/tab=communication-channels/, { timeout: 30_000 })
    await expect(page.getByText(/Communication channels/i).first()).toBeVisible({
      timeout: 30_000,
    })
  })

  await controlUiWatchdogStep('open create channel form', 35_000, async () => {
    await page.getByRole('button', { name: 'Add channel' }).click()
    await expect(page).toHaveURL(/\/communication-channels\/new$/, { timeout: 30_000 })
    await expect(page.getByRole('heading', { name: 'Create communication channel' })).toBeVisible()
  })

  await controlUiWatchdogStep('fill channel name', 10_000, async () => {
    await page.getByLabel('Channel name').fill(TELEGRAM_CHANNEL_NAME)
  })

  await controlUiWatchdogStep('select channel agent reference', 15_000, async () => {
    await page.getByLabel('Agent reference').selectOption(hostName)
  })

  await controlUiWatchdogStep('continue to channel routing', 15_000, async () => {
    await page.getByRole('button', { name: 'Continue' }).click()
  })

  await controlUiWatchdogStep('complete Telegram routing', 35_000, async () => {
    await expect(page.getByRole('heading', { name: 'Channel routing' })).toBeVisible({
      timeout: 15_000,
    })
    await page.getByLabel('Telegram Bot Token').fill(TELEGRAM_BOT_TOKEN)

    for (const [index, route] of routes.entries()) {
      await page.getByRole('button', { name: 'Add Telegram channel' }).click()
      const channelIdInput = page.getByLabel('Telegram channel ID').nth(index)
      await expect(channelIdInput).toBeVisible()
      await channelIdInput.fill(route.channelId)
      await page.getByLabel('Telegram chat type').nth(index).selectOption(route.chatType)
    }
  })

  await controlUiWatchdogStep('submit Telegram communication channel', 45_000, async () => {
    await page.getByRole('button', { name: 'Create channel' }).click()
    await expect(page).toHaveURL(/tab=communication-channels/, { timeout: 45_000 })
    await expect(
      page.getByRole('button', { name: TELEGRAM_CHANNEL_NAME, exact: true })
    ).toBeVisible({
      timeout: 45_000,
    })
  })

  await controlUiWatchdogStep('verify persisted Telegram channel routes', 35_000, async () => {
    await expect
      .poll(() => telegramCommunicationChannelRoutes(), {
        timeout: 30_000,
        intervals: [500, 1_000, 2_000],
        message: 'Control UI should persist Telegram private and group channel routes',
      })
      .toEqual(expect.arrayContaining(routes))
  })
}

export function applyTelegramVerificationCommunicationChannel(hostName: string): void {
  // Reuse the existing fake Telegram helper without duplicating its Secret YAML, then
  // immediately patch the target to the unverified state this spec exercises.
  applyTelegramCommunicationChannel(hostName, [
    { providerChannelId: 'verification-bootstrap', providerUserId: '__verification_bootstrap__' },
  ])
  kubectl(
    [
      '-n',
      CHANNELS_NS,
      'patch',
      'communicationchannel',
      TELEGRAM_CHANNEL_NAME,
      '--type=merge',
      '-p',
      JSON.stringify({
        metadata: {
          annotations: {
            'clerum.io/telegram-bot-username': 'clerum_e2e_bot',
            'clerum.io/telegram-bot-label': '@clerum_e2e_bot',
          },
        },
        spec: {
          telegram: [{ channelId: 'verification-bootstrap', chatType: 'private', userIds: [] }],
        },
      }),
    ],
    undefined,
    30_000
  )
}

export function cleanupTelegramVerificationState(binding: TelegramMediumBinding): void {
  cleanupTelegramMediumBinding(binding)
  profilesSql(
    `
    DELETE FROM workflow_approval_medium_challenges
     WHERE medium = 'telegram'
       AND provider_user_id = ${sqlLiteral(PENDING_PROVIDER_EVENT_USER_ID)};
    `,
    20_000
  )
}

export function ensureUserCanAccessAgent(userId: string, agentName: string): void {
  profilesSql(
    `
    INSERT INTO user_agents (user_id, agent_name)
    VALUES (${sqlLiteral(userId)}, ${sqlLiteral(agentName)})
    ON CONFLICT DO NOTHING;
    `,
    20_000
  )
}

export function telegramAssociationUserIds(providerChannelId: string): string[] {
  const raw = kubectl(
    ['-n', CHANNELS_NS, 'get', 'communicationchannel', TELEGRAM_CHANNEL_NAME, '-o', 'json'],
    undefined,
    10_000
  )
  const parsed = JSON.parse(raw) as {
    spec?: { telegram?: Array<{ channelId?: string; chatType?: string; userIds?: string[] }> }
  }
  const group = (parsed.spec?.telegram ?? []).find(item => item.channelId === providerChannelId)
  return group?.userIds ?? []
}

export function workflowApprovalMediumAccountCount(binding: TelegramMediumBinding): number {
  return Number(
    profilesSql(`
      SELECT COUNT(*)
        FROM workflow_approval_medium_accounts
       WHERE medium = 'telegram'
         AND provider_user_id = ${sqlLiteral(binding.providerUserId)}
         AND provider_channel_id = ${sqlLiteral(binding.providerChannelId)}
         AND disabled_at IS NULL;
    `)
  )
}

export function expectNoVerifiedTelegramBinding(binding: TelegramMediumBinding): void {
  expect(workflowApprovalMediumAccountCount(binding)).toBe(0)
  expect(telegramAssociationUserIds(binding.providerChannelId)).not.toContain(
    binding.providerUserId
  )
}
