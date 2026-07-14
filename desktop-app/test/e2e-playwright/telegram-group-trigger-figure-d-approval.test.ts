import { expect, test } from '@playwright/test'
import {
  type FakeTelegramClientPortForward,
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
import { approveAndExpectConsumed } from './third-party-authn-first-party-mcphost/telegramApprovalAssertions'
import {
  E2E_ALT_EMAIL,
  E2E_EMAIL,
  HOST_REF,
  type TelegramClientIdentity,
  openTelegramClient,
  sendTelegramClientMessage,
  waitForPendingApprovalId,
} from './third-party-authn-first-party-mcphost/telegramE2eClient'
import {
  cleanupTelegramMediumBinding,
  cleanupWorkflowRecipe,
  grantWorkflowRecipeToUsers,
  makeScopedE2ERecipeName,
  profilesSql,
  sqlLiteral,
} from './third-party-authn-first-party-mcphost/workflowApprovalJourney'
import { installFigureDProviderHarness } from './third-party-authn-third-party-mcphost/figureDProviderHarness'
import { stepApprovalRecipeManifest } from './third-party-authn-third-party-mcphost/figureDRecipeManifests'
import {
  approveLatestTelegramDm,
  denyLatestTelegramDm,
  expectFigureDHealth,
  waitForProviderAction,
} from './third-party-authn-third-party-mcphost/figureDTestHelpers'
import {
  applyWorkflowManifest,
  latestWorkflowRunPhase,
  seedVerifiedApprovalMediumBinding,
  triggerApprovalId,
  triggerRuntimeMcpHostRef,
  waitForApprovalStatus,
  waitForWorkflowRunPhase,
  workflowRunCountForRecipe,
} from './third-party-authn-third-party-mcphost/figureDWorkflowJourney'
import { WORKFLOW_RECIPE_NS } from './workflow-approval-quadrants/constants'
import { clearSession, loginAs } from './workflowUi'

const RUN_GROUP_FIGURE_D = process.env.E2E_FIGURE_C_D_TELEGRAM_GROUP === '1'
const MODEL = {
  provider: process.env.E2E_WORKFLOW_MODEL_PROVIDER || 'zai',
  model: process.env.E2E_WORKFLOW_MODEL || 'glm-4.7',
}

function latestWorkflowRunStepSignal(recipeName: string): string {
  return profilesSql(`
    SELECT wr.phase || ':' ||
           COALESCE(
             string_agg(wrs.step_id || '=' || wrs.phase || COALESCE('[' || wrs.error || ']', ''), ',' ORDER BY wrs.step_id),
             ''
           )
      FROM workflow_runs wr
      LEFT JOIN workflow_run_steps wrs
        ON wrs.run_id = wr.run_id
     WHERE wr.recipe_namespace = ${sqlLiteral(WORKFLOW_RECIPE_NS)}
       AND wr.recipe_name = ${sqlLiteral(recipeName)}
     GROUP BY wr.run_id, wr.phase, wr.created_at
     ORDER BY wr.created_at DESC
     LIMIT 1;
  `)
}

async function waitForLatestWorkflowRunStepSignal(recipeName: string, pattern: RegExp) {
  await expect
    .poll(() => latestWorkflowRunStepSignal(recipeName), {
      timeout: 300_000,
      intervals: [1_000, 2_000, 5_000],
      message: `waiting for workflow run step signal ${pattern} on ${recipeName}`,
    })
    .toMatch(pattern)
}

function ensureUserWorkflowGrant(recipeName: string, userId: string): void {
  profilesSql(`
    INSERT INTO user_workflow_triggers (user_id, recipe_namespace, recipe_name)
    VALUES (${sqlLiteral(userId)}, ${sqlLiteral(WORKFLOW_RECIPE_NS)}, ${sqlLiteral(recipeName)})
    ON CONFLICT DO NOTHING;
  `)
  expect(
    Number(
      profilesSql(`
        SELECT COUNT(*)
          FROM user_workflow_triggers
         WHERE user_id = ${sqlLiteral(userId)}
           AND recipe_namespace = ${sqlLiteral(WORKFLOW_RECIPE_NS)}
           AND recipe_name = ${sqlLiteral(recipeName)};
      `)
    )
  ).toBe(1)
}

function verifiedTelegramBindingUserId(identity: TelegramClientIdentity): string {
  return profilesSql(`
    SELECT user_id::text
      FROM workflow_approval_medium_accounts
     WHERE medium = 'telegram'
       AND provider_user_id = ${sqlLiteral(identity.providerUserId)}
       AND provider_channel_id = ${sqlLiteral(identity.providerChannelId)}
       AND disabled_at IS NULL
     ORDER BY updated_at DESC
     LIMIT 1;
  `)
}

function telegramTriggeredStepApprovalManifest(
  params: Parameters<typeof stepApprovalRecipeManifest>[0]
) {
  const manifest = stepApprovalRecipeManifest(params)
  ;(
    manifest.spec as {
      triggers?: { onDemand?: { requiresApproval?: boolean; allowedActors?: string[] } }
    }
  ).triggers = { onDemand: { requiresApproval: true, allowedActors: ['autonomous'] } }
  return manifest
}

test.describe('Telegram group trigger -> Figure D step approval DM', () => {
  test.skip(
    !RUN_GROUP_FIGURE_D,
    'Set E2E_FIGURE_C_D_TELEGRAM_GROUP=1 against a branch-owned minikube profile'
  )

  test('approve and deny travel through channel-reader, private DM, reader callback, and runtime mcp-host', async ({
    browser,
  }) => {
    test.setTimeout(1_200_000)

    const approveRecipe = makeScopedE2ERecipeName('group-figure-d-approve')
    const denyRecipe = makeScopedE2ERecipeName('group-figure-d-deny')
    const markerBase = `telegram-group-figure-d-${Date.now()}`
    const telegramIdentitySeed = Date.now() % 1_000_000
    const approveRequesterGroup: TelegramClientIdentity = {
      providerUserId: String(910_000_000 + telegramIdentitySeed * 10 + 1),
      providerChannelId: String(-910_000_000 - telegramIdentitySeed * 10 - 1),
      providerChannelType: 'group',
      conversationLabel: 'EventFire approve workflow triage group',
    }
    const denyRequesterGroup: TelegramClientIdentity = {
      providerUserId: String(910_000_000 + telegramIdentitySeed * 10 + 3),
      providerChannelId: String(-910_000_000 - telegramIdentitySeed * 10 - 3),
      providerChannelType: 'group',
      conversationLabel: 'EventFire deny workflow triage group',
    }
    const approverPrivateChat: TelegramClientIdentity = {
      providerUserId: String(920_000_000 + telegramIdentitySeed * 10 + 2),
      providerChannelId: String(920_000_000 + telegramIdentitySeed * 10 + 2),
      providerChannelType: 'private',
      conversationLabel: 'Figure D approver private Telegram DM',
    }
    const messageBase = Math.floor(Date.now() / 1000) * 1000

    let telegramPage: Awaited<ReturnType<typeof openTelegramClient>>['page'] | null = null
    let telegramPortForward: FakeTelegramClientPortForward | null = null
    let figureDProvider: Awaited<ReturnType<typeof installFigureDProviderHarness>> | null = null

    async function triggerFromTelegramGroup(
      recipeName: string,
      marker: string,
      messageId: number,
      requesterGroup: TelegramClientIdentity
    ) {
      if (!telegramPage) throw new Error('Telegram client was not initialized')
      await sendTelegramClientMessage(
        telegramPage,
        `Trigger the workflow recipe named ${recipeName} with marker: ${marker}. Start a new workflow run; do not check the status of an existing run.`,
        messageId,
        requesterGroup
      )
      const triggerApprovalId = await waitForPendingApprovalId(recipeName)
      await approveAndExpectConsumed(
        telegramPage,
        recipeName,
        triggerApprovalId,
        `Telegram group provider decision should consume the trigger approval for ${recipeName}`,
        `Telegram group trigger approval should create one workflow run for ${recipeName}`
      )
      await expect
        .poll(() => workflowRunCountForRecipe(recipeName), {
          timeout: 240_000,
          intervals: [1_000, 2_000, 5_000],
          message: `Telegram group command should create one workflow run for ${recipeName}`,
        })
        .toBe(1)
    }

    async function expectPrivateApprovalDm(recipeName: string, label: 'Approve' | 'Deny') {
      if (!figureDProvider) throw new Error('Figure D provider was not initialized')
      const actionValue = await waitForProviderAction(
        figureDProvider.providerUrl,
        'telegram',
        recipeName,
        label,
        approverPrivateChat.providerChannelId
      )
      expect(triggerRuntimeMcpHostRef(actionValue)).toMatch(/^sandbox-recipes\/~[a-f0-9]{16}$/)
      return triggerApprovalId(actionValue)
    }

    try {
      await test.step('Prepare Telegram group channel-reader and private Figure D approval DM target', async () => {
        await clearSession()
        for (const recipeName of [approveRecipe, denyRecipe]) cleanupWorkflowRecipe(recipeName)
        cleanupTelegramMediumBinding(approveRequesterGroup)
        cleanupTelegramMediumBinding(denyRequesterGroup)
        cleanupTelegramMediumBinding(approverPrivateChat)

        installFakeTelegramProvider()
        configureChannelReaderTelegramApiRoot(HOST_REF)
        applyTelegramCommunicationChannel(HOST_REF, [approveRequesterGroup, denyRequesterGroup])
        waitForChannelReader(HOST_REF)
        expectChannelReaderHasNoProviderHttpIngress(HOST_REF)
        expectChannelReaderCanReachMcpHost(HOST_REF)
        await expect.poll(() => fakeTelegramPollingCount(), { timeout: 30_000 }).toBeGreaterThan(0)

        const telegram = await openTelegramClient(browser)
        telegramPage = telegram.page
        telegramPortForward = telegram.portForward

        const { userId: requesterUserId } = await loginAs(E2E_EMAIL)
        const { userId: approverUserId } = await loginAs(E2E_ALT_EMAIL)
        seedVerifiedApprovalMediumBinding({
          userId: requesterUserId,
          medium: 'telegram',
          providerUserId: approveRequesterGroup.providerUserId,
          providerChannelId: approveRequesterGroup.providerChannelId,
        })
        seedVerifiedApprovalMediumBinding({
          userId: requesterUserId,
          medium: 'telegram',
          providerUserId: denyRequesterGroup.providerUserId,
          providerChannelId: denyRequesterGroup.providerChannelId,
        })
        seedVerifiedApprovalMediumBinding({
          userId: approverUserId,
          medium: 'telegram',
          providerUserId: approverPrivateChat.providerUserId,
          providerChannelId: approverPrivateChat.providerChannelId,
        })
        expect(verifiedTelegramBindingUserId(approveRequesterGroup)).toBe(requesterUserId)
        expect(verifiedTelegramBindingUserId(denyRequesterGroup)).toBe(requesterUserId)

        for (const [recipeName, suffix] of [
          [approveRecipe, 'approve'],
          [denyRecipe, 'deny'],
        ] as const) {
          applyWorkflowManifest(
            telegramTriggeredStepApprovalManifest({
              name: recipeName,
              approverUserId,
              approvalMessage: `Figure D ${suffix} gate for ${recipeName}`,
              marker: `${markerBase}-${suffix}`,
              model: MODEL,
            })
          )
          await grantWorkflowRecipeToUsers(recipeName, [requesterUserId, approverUserId])
          ensureUserWorkflowGrant(recipeName, requesterUserId)
          ensureUserWorkflowGrant(recipeName, approverUserId)
        }

        figureDProvider = await installFigureDProviderHarness()
        await expectFigureDHealth(`${figureDProvider.providerUrl}/health`)
      })

      await test.step('Approve path: group trigger waits on private approver DM and then succeeds', async () => {
        await triggerFromTelegramGroup(
          approveRecipe,
          `${markerBase}-approve`,
          messageBase + 11,
          approveRequesterGroup
        )
        const previewApprovalId = await expectPrivateApprovalDm(approveRecipe, 'Approve')
        expect(latestWorkflowRunPhase(approveRecipe)).not.toBe('Succeeded')

        const decidedApprovalId = await approveLatestTelegramDm({
          providerUrl: figureDProvider!.providerUrl,
          recipeName: approveRecipe,
          telegramUserId: approverPrivateChat.providerUserId,
          telegramChatId: approverPrivateChat.providerChannelId,
          providerEventId: `figure-d-group-approve-${Date.now()}`,
        })
        expect(decidedApprovalId).toBe(previewApprovalId)
        await waitForApprovalStatus(decidedApprovalId, 'approved')
        await waitForWorkflowRunPhase(approveRecipe, 'Succeeded')
        await waitForLatestWorkflowRunStepSignal(
          approveRecipe,
          /Succeeded:.*approval-gated-step=Succeeded.*finalize-after-approval=Succeeded/
        )
      })

      await test.step('Deny path: private approver denial blocks the protected workflow segment', async () => {
        await triggerFromTelegramGroup(
          denyRecipe,
          `${markerBase}-deny`,
          messageBase + 22,
          denyRequesterGroup
        )
        const previewApprovalId = await expectPrivateApprovalDm(denyRecipe, 'Deny')
        expect(latestWorkflowRunPhase(denyRecipe)).not.toBe('Succeeded')

        const decidedApprovalId = await denyLatestTelegramDm({
          providerUrl: figureDProvider!.providerUrl,
          recipeName: denyRecipe,
          telegramUserId: approverPrivateChat.providerUserId,
          telegramChatId: approverPrivateChat.providerChannelId,
          providerEventId: `figure-d-group-deny-${Date.now()}`,
        })
        expect(decidedApprovalId).toBe(previewApprovalId)
        await waitForApprovalStatus(decidedApprovalId, 'denied')
        await waitForWorkflowRunPhase(denyRecipe, 'Failed')
        await waitForLatestWorkflowRunStepSignal(
          denyRecipe,
          /Failed:.*approval-gated-step=Failed\[approval-denied:/
        )
        expect(latestWorkflowRunStepSignal(denyRecipe)).not.toContain(
          'finalize-after-approval=Succeeded'
        )
      })
    } finally {
      if (telegramPage) await telegramPage.close().catch(() => undefined)
      telegramPortForward?.stop()
      await figureDProvider?.stop().catch(() => undefined)
      removeTelegramCommunicationChannel()
      restoreChannelReaderTelegramApiRoot(HOST_REF)
      removeFakeTelegramProvider()
      cleanupTelegramMediumBinding(approveRequesterGroup)
      cleanupTelegramMediumBinding(denyRequesterGroup)
      cleanupTelegramMediumBinding(approverPrivateChat)
      for (const recipeName of [approveRecipe, denyRecipe]) cleanupWorkflowRecipe(recipeName)
    }
  })
})
