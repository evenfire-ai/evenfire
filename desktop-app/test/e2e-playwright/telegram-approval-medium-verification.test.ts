import { type Page, expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { requireExecutable, watchdogStep } from './e2eTestUtils'
import {
  cleanupTelegramVerificationState,
  createTelegramCommunicationChannelFromControlUi,
  ensureUserCanAccessAgent,
  expectNoVerifiedTelegramBinding,
  requireProfileUiBaseUrl,
  telegramAssociationUserIds,
  workflowApprovalMediumAccountCount,
} from './telegramApprovalMediumVerification'
import {
  TELEGRAM_CHANNEL_NAME,
  configureChannelReaderTelegramApiRoot,
  expectChannelReaderCanReachMcpHost,
  expectChannelReaderHasNoProviderHttpIngress,
  expectChannelReaderLoadedTelegram,
  fakeTelegramPollingCount,
  installFakeTelegramProvider,
  removeFakeTelegramProvider,
  removeTelegramCommunicationChannel,
  restoreChannelReaderTelegramApiRoot,
  waitForChannelReader,
} from './third-party-authn-first-party-mcphost/fakeTelegramProvider'
import { approveAndExpectConsumed } from './third-party-authn-first-party-mcphost/telegramApprovalAssertions'
import {
  E2E_EMAIL,
  HOST_REF,
  type TelegramClientIdentity,
  expectTelegramWorkflowList,
  openTelegramClient,
  sendTelegramClientMessage,
  setTelegramClientIdentity,
  telegramReplyItems,
  waitForPendingApprovalId,
  waitForTelegramReplyTextAfter,
  waitForWorkflowApprovalInTelegramClient,
} from './third-party-authn-first-party-mcphost/telegramE2eClient'
import {
  type TelegramMediumBinding,
  cleanupWorkflowRecipe,
  installWorkflowRecipeForUser,
  makeScopedE2ERecipeName,
  pendingApprovalCountForRecipe,
} from './third-party-authn-first-party-mcphost/workflowApprovalJourney'
import { E2E_DESKTOP_PASSWORD, K8S_CONTEXT, clearSession, loginAs } from './workflowUi'

const TELEGRAM_PRIVATE_ID = '424242'
const TELEGRAM_GROUP_ID = '-424242'
const FAIL_FAST_TIMEOUT_MS = Number(process.env.E2E_TELEGRAM_PROFILE_VERIFY_TIMEOUT_MS || 90_000)
const EXPECTED_CONTEXT_RE = /^clerum-(codex|detached)-/
const REQUIRED_PORT_FORWARDS = [
  { env: 'CONTROL_UI_BASE_URL', service: 'svc/control-ui' },
  { env: 'PROFILE_UI_BASE_URL', service: 'svc/profile-ui' },
  { env: 'CONTROL_API_BASE_URL', service: 'svc/control-api' },
  { env: 'EXTERNAL_REST_API_BASE_URL', service: 'svc/external-rest-api' },
  { env: 'RPC_PROXY_BASE_URL', service: 'svc/rpc-proxy' },
  {
    env: 'WORKFLOW_APPROVAL_READER_BASE_URL',
    service: 'svc/workflow-approval-request-reader',
  },
  { env: 'MCP_HOST_RUNTIME_BASE_URL', fallbackEnv: 'MCP_HOST_BASE_URL', service: 'svc/chatllm' },
] as const

const VERIFIED_TELEGRAM_IDENTITY: TelegramClientIdentity = {
  providerUserId: TELEGRAM_PRIVATE_ID,
  providerChannelId: TELEGRAM_PRIVATE_ID,
  providerChannelType: 'private',
  conversationLabel: 'Test User - verified Telegram private chat',
}

const VERIFIED_TELEGRAM_GROUP_IDENTITY: TelegramClientIdentity = {
  providerUserId: TELEGRAM_PRIVATE_ID,
  providerChannelId: TELEGRAM_GROUP_ID,
  providerChannelType: 'group',
  conversationLabel: 'Test User - verified Telegram group',
}

const WRONG_CHANNEL_IDENTITY: TelegramClientIdentity = {
  providerUserId: TELEGRAM_PRIVATE_ID,
  providerChannelId: '424243',
  providerChannelType: 'private',
  conversationLabel: 'Test User - mismatched Telegram private chat',
}

function telegramBinding(identity: TelegramClientIdentity): TelegramMediumBinding {
  return {
    providerUserId: identity.providerUserId,
    providerChannelId: identity.providerChannelId,
  }
}

function assertExpectedContextAndPortForwards(): void {
  requireExecutable('kubectl', 'branch-scoped Kubernetes context validation')
  requireExecutable(
    'lsof',
    'branch-scoped port-forward ownership validation in telegram-approval-medium-verification.test.ts'
  )
  requireExecutable('ps', 'branch-scoped port-forward command validation')

  const currentContext = execFileSync('kubectl', ['config', 'current-context'], {
    encoding: 'utf-8',
    timeout: 5_000,
  }).trim()
  expect(currentContext, 'kubectl current-context must match E2E_K8S_CONTEXT').toBe(K8S_CONTEXT)
  expect(K8S_CONTEXT, 'this spec must run against a branch-scoped minikube context').toMatch(
    EXPECTED_CONTEXT_RE
  )

  for (const expected of REQUIRED_PORT_FORWARDS) {
    const fallbackEnv = 'fallbackEnv' in expected ? expected.fallbackEnv : undefined
    const envName = process.env[expected.env] ? expected.env : (fallbackEnv ?? expected.env)
    const url = process.env[envName] || ''
    expect(url, `${expected.env} is required`).toBeTruthy()
    const parsedUrl = new URL(url)
    expect(
      ['127.0.0.1', 'localhost'].includes(parsedUrl.hostname),
      `${envName} must point at a local branch-owned port-forward`
    ).toBe(true)
    expect(parsedUrl.port, `${envName} must include an explicit localhost port`).toBeTruthy()
    const lsof = execFileSync('lsof', ['-nP', `-iTCP:${parsedUrl.port}`, '-sTCP:LISTEN'], {
      encoding: 'utf-8',
      timeout: 5_000,
    })
    const pid = lsof.match(/^kubectl\s+(\d+)\s+/m)?.[1]
    expect(
      pid,
      `kubectl port-forward must listen on ${envName} port ${parsedUrl.port}`
    ).toBeTruthy()
    const command = execFileSync('ps', ['-p', pid!, '-o', 'command='], {
      encoding: 'utf-8',
      timeout: 5_000,
    })
    expect(command, `${expected.env} port-forward must use ${K8S_CONTEXT}`).toContain(
      `--context=${K8S_CONTEXT}`
    )
    expect(command, `${expected.env} port-forward must target ${expected.service}`).toContain(
      expected.service
    )
  }
}

async function loginProfileUi(page: Page, baseUrl: string): Promise<void> {
  await page.goto(baseUrl)
  const emailInput = page.getByLabel('Email')
  await expect(emailInput).toBeVisible({ timeout: 30_000 })
  await emailInput.fill(E2E_EMAIL)
  await page.getByLabel('Password').fill(E2E_DESKTOP_PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('link', { name: 'Approval Channels' })).toBeVisible({
    timeout: 30_000,
  })
}

async function openApprovalChannels(page: Page, baseUrl: string): Promise<void> {
  await page.getByRole('link', { name: 'Approval Channels' }).click()
  await expect(page).toHaveURL(`${baseUrl}/approval-channels`)
  await expect(
    page.locator('header').getByRole('heading', { name: 'Approval Channels' })
  ).toBeVisible()
  const manageButton = page.getByRole('button', { name: 'Manage' })
  await expect(manageButton).toBeVisible({ timeout: 30_000 })
  await manageButton.click()
  await expect(page).toHaveURL(`${baseUrl}/settings/social/telegram`)
  await expect(page.getByRole('tab', { name: 'Social channels' })).toHaveAttribute(
    'aria-selected',
    'true'
  )
  await expect(page.getByRole('tab', { name: 'Telegram' })).toHaveAttribute('aria-selected', 'true')
}

async function startTelegramConnection(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Connect Telegram' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('heading', { name: 'Connect Telegram' })).toBeVisible()
  const continueButton = dialog.getByRole('button', { name: 'Continue' })
  await expect(continueButton).toBeEnabled()
  await continueButton.click()
  await expect(dialog.getByRole('heading', { name: 'Verify Telegram' })).toBeVisible()
}

async function visibleVerificationCode(page: Page): Promise<string> {
  const command = await page.getByTestId('telegram-verification-command').innerText({
    timeout: 30_000,
  })
  const match = command.match(/\/verify\s+(\d{6})/)
  expect(match?.[1]).toMatch(/^\d{6}$/)
  return match![1]
}

test.describe('Profile UI Telegram approval medium verification', () => {
  test('connects by Telegram /verify and enables workflow approval for the selected agent', async ({
    browser,
  }) => {
    test.setTimeout(420_000)

    const profileUiBaseUrl = requireProfileUiBaseUrl()
    const verifiedBinding = telegramBinding(VERIFIED_TELEGRAM_IDENTITY)
    const groupBinding = telegramBinding(VERIFIED_TELEGRAM_GROUP_IDENTITY)
    const wrongBinding = telegramBinding(WRONG_CHANNEL_IDENTITY)
    const recipeName = makeScopedE2ERecipeName('profile-verify-telegram')
    const marker = `profile-verify-telegram-${Date.now()}`
    const telegramMessageBase = Math.floor(Date.now() / 1000) * 1000
    let profilePage: Page | null = null
    let controlPage: Page | null = null
    let telegramPage: Page | null = null
    let telegramPortForward: { stop: () => void } | null = null
    let verifiedUserId = ''

    try {
      await watchdogStep(
        'fail fast when context or port-forwards are branch-scoped',
        10_000,
        () => {
          assertExpectedContextAndPortForwards()
        }
      )

      await watchdogStep('clean prior Telegram verification state', 45_000, async () => {
        await clearSession()
        removeTelegramCommunicationChannel()
        cleanupWorkflowRecipe(recipeName)
        cleanupTelegramVerificationState(verifiedBinding)
        cleanupTelegramVerificationState(groupBinding)
        cleanupTelegramVerificationState(wrongBinding)
      })

      await watchdogStep('install fake Telegram provider', 20_000, async () => {
        installFakeTelegramProvider()
        configureChannelReaderTelegramApiRoot()
      })

      await watchdogStep('grant test user access to the selected agent', 30_000, async () => {
        const login = await loginAs(E2E_EMAIL)
        verifiedUserId = login.userId
        ensureUserCanAccessAgent(login.userId, HOST_REF)
      })

      await watchdogStep(
        'create Telegram communication channel through Control UI',
        75_000,
        async () => {
          controlPage = await browser.newPage()
          await createTelegramCommunicationChannelFromControlUi(controlPage, HOST_REF, E2E_EMAIL)
          await controlPage.close()
          controlPage = null
        }
      )

      await watchdogStep('wait for channel-reader to load Telegram channel', 45_000, async () => {
        waitForChannelReader(HOST_REF)
        expectChannelReaderLoadedTelegram(HOST_REF)
      })

      await watchdogStep('validate channel-reader runtime boundaries', 30_000, async () => {
        expectChannelReaderHasNoProviderHttpIngress(HOST_REF)
        expectChannelReaderCanReachMcpHost(HOST_REF)
      })

      await watchdogStep('wait for fake Telegram polling', 35_000, async () => {
        await expect
          .poll(() => fakeTelegramPollingCount(), {
            timeout: 30_000,
            intervals: [500, 1_000, 2_000],
            message: 'channel-reader should poll fake Telegram before verification messages',
          })
          .toBeGreaterThan(0)
      })

      await watchdogStep('seed workflow recipe', 45_000, async () => {
        await installWorkflowRecipeForUser({
          recipeName,
          marker,
          userId: verifiedUserId,
        })
      })

      await watchdogStep(
        'open fake Telegram client and Profile UI approval page',
        60_000,
        async () => {
          const telegram = await openTelegramClient(browser)
          telegramPage = telegram.page
          telegramPortForward = telegram.portForward
          await setTelegramClientIdentity(telegramPage, VERIFIED_TELEGRAM_IDENTITY)

          profilePage = await browser.newPage()
          await loginProfileUi(profilePage, profileUiBaseUrl)
          await openApprovalChannels(profilePage, profileUiBaseUrl)
        }
      )
      if (!telegramPage || !profilePage) {
        throw new Error('watchdog setup did not open Telegram client and Profile UI pages')
      }

      await expect(profilePage.getByRole('button', { name: 'Connect Telegram' })).toBeVisible()
      expectNoVerifiedTelegramBinding(verifiedBinding)

      await watchdogStep(
        'unverified Telegram trigger must not create approval',
        45_000,
        async () => {
          const unverifiedPollCount = fakeTelegramPollingCount()
          await sendTelegramClientMessage(
            telegramPage,
            `Run ${recipeName} with marker: ${marker}. Give me the workflow result in this Telegram chat after it starts.`,
            telegramMessageBase + 1,
            VERIFIED_TELEGRAM_IDENTITY
          )
          await expect
            .poll(() => fakeTelegramPollingCount(), {
              timeout: 30_000,
              intervals: [500, 1_000, 2_000],
              message: 'channel-reader should drain the unverified Telegram update',
            })
            .toBeGreaterThan(unverifiedPollCount)
          expect(pendingApprovalCountForRecipe(recipeName)).toBe(0)
          await expect
            .poll(() => pendingApprovalCountForRecipe(recipeName), {
              timeout: 10_000,
              intervals: [1_000, 2_000],
              message: 'unverified Telegram identity must not create workflow approvals',
            })
            .toBe(0)
        }
      )

      await watchdogStep(
        'verify Telegram identity through channel-scoped target',
        75_000,
        async () => {
          await startTelegramConnection(profilePage)
          const code = await visibleVerificationCode(profilePage)

          const wrongReplyCount = await telegramReplyItems(telegramPage).count()
          await sendTelegramClientMessage(
            telegramPage,
            `/verify ${code}`,
            telegramMessageBase + 2,
            WRONG_CHANNEL_IDENTITY
          )
          await waitForTelegramReplyTextAfter(
            telegramPage,
            wrongReplyCount,
            /Verification failed/,
            FAIL_FAST_TIMEOUT_MS
          )
          expectNoVerifiedTelegramBinding(verifiedBinding)
          expectNoVerifiedTelegramBinding(wrongBinding)

          await setTelegramClientIdentity(telegramPage, VERIFIED_TELEGRAM_IDENTITY)
          await expect(telegramReplyItems(telegramPage)).toHaveCount(0, { timeout: 10_000 })
          const verifyReplyCount = await telegramReplyItems(telegramPage).count()
          await sendTelegramClientMessage(
            telegramPage,
            `/verify ${code}`,
            telegramMessageBase + 3,
            VERIFIED_TELEGRAM_IDENTITY
          )
          await waitForTelegramReplyTextAfter(
            telegramPage,
            verifyReplyCount,
            /Telegram identity confirmed/,
            FAIL_FAST_TIMEOUT_MS
          )
          await profilePage.getByRole('dialog').getByRole('button', { name: 'Confirm' }).click()
          const privateAccountRow = profilePage
            .locator('.settings-target-row')
            .filter({ hasText: TELEGRAM_CHANNEL_NAME })
            .filter({ hasText: 'Private chat' })
          await expect(privateAccountRow).toBeVisible({ timeout: 30_000 })
          await expect(privateAccountRow).toContainText('Verified')
          await expect
            .poll(() => workflowApprovalMediumAccountCount(verifiedBinding), {
              timeout: 30_000,
              intervals: [500, 1_000, 2_000],
              message: 'provider-event confirmation should create the verified medium account',
            })
            .toBe(1)
          await expect
            .poll(() => telegramAssociationUserIds(verifiedBinding.providerChannelId), {
              timeout: 30_000,
              intervals: [500, 1_000, 2_000],
              message: 'selected CommunicationChannel should receive only the verified identity',
            })
            .toContain(verifiedUserId)
        }
      )

      await watchdogStep(
        'verified Telegram identity lists the granted workflow through mcp-host',
        60_000,
        async () => {
          await sendTelegramClientMessage(
            telegramPage,
            'List the workflow recipes I can run. Include the exact workflow recipe names.',
            telegramMessageBase + 4,
            VERIFIED_TELEGRAM_IDENTITY
          )
          await expectTelegramWorkflowList(telegramPage, [recipeName], [], 45_000)
        }
      )

      await watchdogStep(
        'verified private Telegram trigger creates and consumes approval',
        150_000,
        async () => {
          await sendTelegramClientMessage(
            telegramPage,
            `Run ${recipeName} with marker: ${marker}. Give me the workflow result in this Telegram chat after it starts.`,
            telegramMessageBase + 5,
            VERIFIED_TELEGRAM_IDENTITY
          )
          const approvalId = await waitForPendingApprovalId(recipeName, FAIL_FAST_TIMEOUT_MS)
          await waitForWorkflowApprovalInTelegramClient(
            telegramPage,
            recipeName,
            FAIL_FAST_TIMEOUT_MS
          )
          await approveAndExpectConsumed(
            telegramPage,
            recipeName,
            approvalId,
            'provider-event verified identity should approve only its pending request',
            'verified Telegram identity should create exactly one workflow run',
            {
              approvalCardTimeout: FAIL_FAST_TIMEOUT_MS,
              consumedTimeout: FAIL_FAST_TIMEOUT_MS,
              runTimeout: FAIL_FAST_TIMEOUT_MS,
            }
          )
        }
      )

      await watchdogStep(
        'verify Telegram group through the provider event flow',
        75_000,
        async () => {
          await startTelegramConnection(profilePage)
          const code = await visibleVerificationCode(profilePage)
          await setTelegramClientIdentity(telegramPage, VERIFIED_TELEGRAM_GROUP_IDENTITY)
          const replyCount = await telegramReplyItems(telegramPage).count()
          await sendTelegramClientMessage(
            telegramPage,
            `/verify ${code}`,
            telegramMessageBase + 6,
            VERIFIED_TELEGRAM_GROUP_IDENTITY
          )
          await waitForTelegramReplyTextAfter(
            telegramPage,
            replyCount,
            /Telegram identity confirmed/,
            FAIL_FAST_TIMEOUT_MS
          )
          await profilePage.getByRole('dialog').getByRole('button', { name: 'Confirm' }).click()
          await expect
            .poll(() => workflowApprovalMediumAccountCount(groupBinding), {
              timeout: 30_000,
              intervals: [500, 1_000, 2_000],
              message: 'provider-event confirmation should create the verified group account',
            })
            .toBe(1)
          await expect
            .poll(() => telegramAssociationUserIds(groupBinding.providerChannelId), {
              timeout: 30_000,
              intervals: [500, 1_000, 2_000],
              message: 'the selected CommunicationChannel should record the verified group',
            })
            .toContain(verifiedUserId)
        }
      )

      await watchdogStep(
        'verified group Telegram trigger creates and consumes approval',
        150_000,
        async () => {
          await setTelegramClientIdentity(telegramPage, VERIFIED_TELEGRAM_GROUP_IDENTITY)
          await sendTelegramClientMessage(
            telegramPage,
            `@clerum_e2e_bot Run ${recipeName} with marker: ${marker}-group. Give me the workflow result in this Telegram group after it starts.`,
            telegramMessageBase + 7,
            VERIFIED_TELEGRAM_GROUP_IDENTITY
          )
          const groupApprovalId = await waitForPendingApprovalId(recipeName, FAIL_FAST_TIMEOUT_MS)
          await waitForWorkflowApprovalInTelegramClient(
            telegramPage,
            recipeName,
            FAIL_FAST_TIMEOUT_MS
          )
          await approveAndExpectConsumed(
            telegramPage,
            recipeName,
            groupApprovalId,
            'same verified Telegram actor should approve from the configured group',
            'verified Telegram actor in the configured group should create exactly one workflow run',
            {
              approvalCardTimeout: FAIL_FAST_TIMEOUT_MS,
              consumedTimeout: FAIL_FAST_TIMEOUT_MS,
              runTimeout: FAIL_FAST_TIMEOUT_MS,
            }
          )
        }
      )

      await watchdogStep('disconnect verified Telegram identity', 45_000, async () => {
        const verifiedAccountRow = profilePage
          .locator('.settings-target-row')
          .filter({ hasText: TELEGRAM_CHANNEL_NAME })
          .filter({ hasText: 'Private chat' })
        await expect(verifiedAccountRow).toBeVisible({ timeout: 30_000 })
        await verifiedAccountRow.getByRole('button', { name: 'Delete' }).click()
        await profilePage.getByRole('button', { name: 'Delete connection' }).click()
        await expect(profilePage.getByText('Telegram identity disconnected.')).toBeVisible({
          timeout: 30_000,
        })
        await expect
          .poll(() => workflowApprovalMediumAccountCount(verifiedBinding), {
            timeout: 30_000,
            intervals: [500, 1_000, 2_000],
            message: 'disconnect should disable the verified medium account',
          })
          .toBe(0)
        await expect
          .poll(() => telegramAssociationUserIds(verifiedBinding.providerChannelId), {
            timeout: 30_000,
            intervals: [500, 1_000, 2_000],
            message: 'disconnect should remove the selected target association',
          })
          .not.toContain(verifiedUserId)
      })
    } finally {
      if (profilePage) await profilePage.close().catch(() => undefined)
      if (controlPage) await controlPage.close().catch(() => undefined)
      if (telegramPage) await telegramPage.close().catch(() => undefined)
      telegramPortForward?.stop()
      cleanupWorkflowRecipe(recipeName)
      cleanupTelegramVerificationState(verifiedBinding)
      cleanupTelegramVerificationState(groupBinding)
      cleanupTelegramVerificationState(wrongBinding)
      removeTelegramCommunicationChannel()
      restoreChannelReaderTelegramApiRoot()
      removeFakeTelegramProvider()
    }
  })
})
