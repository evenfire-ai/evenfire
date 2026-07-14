import { expect, test } from '@playwright/test'
import {
  expectApprovalRequestedNotification,
  latestWorkflowRunSignal,
  providerDecisionCount,
  providerEventResult,
  workflowApprovalTriggerCallerKey,
} from './third-party-authn-third-party-mcphost/figureDApprovalSignals'
import { resetProviderRequests } from './third-party-authn-third-party-mcphost/figureDProviderApi'
import {
  FIGURE_D_COMMUNICATION_CHANNEL_REF,
  FIGURE_D_SLACK_WORKSPACE,
  expectedFigureDReaderEventId,
  installFigureDProviderHarness,
} from './third-party-authn-third-party-mcphost/figureDProviderHarness'
import {
  callerRecipeManifest,
  stepApprovalRecipeManifest,
  targetRecipeManifest,
} from './third-party-authn-third-party-mcphost/figureDRecipeManifests'
import {
  approveLatestTelegramDm,
  expectFigureDHealth,
  logFigureD,
  mediumAccountIds,
  waitForProviderAction,
} from './third-party-authn-third-party-mcphost/figureDTestHelpers'
import {
  applyWorkflowManifest,
  latestWorkflowRunPhase,
  preferVerifiedApprovalMediumBinding,
  seedVerifiedApprovalMediumBinding,
  triggerApprovalId,
  triggerRuntimeMcpHostRef,
  triggerWorkflowAsUser,
  waitForApprovalStatus,
  waitForWorkflowRunPhase,
  workflowRunCountForRecipe,
} from './third-party-authn-third-party-mcphost/figureDWorkflowJourney'
import {
  submitSlackInteraction,
  submitTelegramDecisionRaw,
} from './third-party-authn-third-party-mcphost/providerWebhookActions'
import {
  approvalStatus,
  workflowRunCountForApproval,
} from './workflow-approval-quadrants/approvalApi'
import {
  CONTROL_API,
  READER_API,
  WORKFLOW_RECIPE_NS,
} from './workflow-approval-quadrants/constants'
import {
  cleanupApprovalMediumResidues,
  cleanupRecipe,
  grantUserThroughAdminRoute,
  setUserWorkflowGrantsThroughAdminRoute,
} from './workflow-approval-quadrants/recipes'
import { E2E_EMAIL, loginAs as devLogin } from './workflowUi'

const RUN_FIGURE_D = process.env.E2E_FIGURE_D_TELEGRAM_SLACK === '1'
const MODEL_PROVIDER =
  process.env.E2E_WORKFLOW_MODEL_PROVIDER || process.env.CLERUM_MODEL_PROVIDER || 'zai'
const MODEL_NAME = process.env.E2E_WORKFLOW_MODEL_NAME || process.env.CLERUM_MODEL_NAME || 'glm-4.7'
const REQUESTER_EMAIL = process.env.E2E_FIGURE_D_REQUESTER_EMAIL || 'test2@clerum.io'

function expectedRuntimeHostRef(recipeName: string): RegExp {
  return new RegExp(`^${WORKFLOW_RECIPE_NS}/(?:${recipeName}-[a-z0-9]{8}|~[a-f0-9]{16})$`)
}

test.describe
  .serial('Figure D: 3rd-party AuthN, 3rd-party MCP-Host Telegram/Slack approvals', () => {
  test.skip(!RUN_FIGURE_D, 'Set E2E_FIGURE_D_TELEGRAM_SLACK=1 against a seeded minikube stack')
  test.slow()

  let providerHarness: Awaited<ReturnType<typeof installFigureDProviderHarness>> | null = null

  test.beforeAll(async () => {
    logFigureD('installing provider harness')
    providerHarness = await installFigureDProviderHarness()
    logFigureD('provider harness installed')
    await expectFigureDHealth(`${CONTROL_API}/health`)
    await expectFigureDHealth(`${READER_API}/health`)
  })

  test.afterAll(async () => {
    await providerHarness?.stop()
  })

  test('delivers Slack DM to a verified user binding and gates workflow trigger', async () => {
    if (!providerHarness) throw new Error('provider harness is not installed')
    const stamp = Date.now()
    const targetRecipe = `e2e-quadrant-figd-slack-target-${stamp}`
    const callerRecipe = `e2e-quadrant-figd-slack-caller-${stamp}`
    const approvalMessage = `3rd-party AuthN, 3rd-party MCP-Host Slack approval ${stamp}`
    const { userId: approverUserId } = await devLogin(E2E_EMAIL)
    const { userId: requesterUserId, userToken: requesterToken } = await devLogin(REQUESTER_EMAIL)
    const slackUserId = `UFIGD${stamp}`
    const slackChannelId = 'D-figure-d'
    const telegramUserId = `70${stamp}`
    const telegramChatId = telegramUserId
    const existingAccounts = mediumAccountIds([slackUserId, telegramUserId])

    try {
      await test.step('seed verified approver Slack and Telegram private bindings', async () => {
        cleanupApprovalMediumResidues({
          providerUserIds: [slackUserId, telegramUserId],
          preserveAccountIds: existingAccounts,
        })
        seedVerifiedApprovalMediumBinding({
          userId: approverUserId,
          medium: 'telegram',
          providerUserId: telegramUserId,
          providerChannelId: telegramChatId,
          communicationChannelRef: FIGURE_D_COMMUNICATION_CHANNEL_REF,
        })
        seedVerifiedApprovalMediumBinding({
          userId: approverUserId,
          medium: 'slack',
          providerUserId: slackUserId,
          providerWorkspaceId: FIGURE_D_SLACK_WORKSPACE,
          providerChannelId: slackChannelId,
          communicationChannelRef: FIGURE_D_COMMUNICATION_CHANNEL_REF,
        })
        preferVerifiedApprovalMediumBinding(slackUserId)
      })

      await test.step('install caller and target recipes with requester and approver boundaries', async () => {
        await cleanupRecipe(callerRecipe)
        await cleanupRecipe(targetRecipe)
        applyWorkflowManifest(targetRecipeManifest(targetRecipe, targetRecipe))
        applyWorkflowManifest(
          callerRecipeManifest({
            name: callerRecipe,
            targetName: targetRecipe,
            approverUserId,
            approvalMessage,
            model: { provider: MODEL_PROVIDER, model: MODEL_NAME },
          })
        )
        await grantUserThroughAdminRoute(WORKFLOW_RECIPE_NS, targetRecipe, approverUserId)
        await grantUserThroughAdminRoute(WORKFLOW_RECIPE_NS, callerRecipe, requesterUserId)
      })

      await test.step('requester starts caller recipe and Slack approver receives private DM', async () => {
        await resetProviderRequests(providerHarness.providerUrl)
        await triggerWorkflowAsUser(requesterToken, callerRecipe)
        const actionValue = await waitForProviderAction(
          providerHarness.providerUrl,
          'slack',
          targetRecipe,
          'Approve',
          slackChannelId
        )
        const callerKey = `${WORKFLOW_RECIPE_NS}/${callerRecipe}`
        expect(triggerRuntimeMcpHostRef(actionValue)).toMatch(expectedRuntimeHostRef(callerRecipe))
        const approvalId = triggerApprovalId(actionValue)
        expect(workflowApprovalTriggerCallerKey(approvalId)).toBe(callerKey)
        expectApprovalRequestedNotification({
          approvalId,
          targetUserId: approverUserId,
          expectedCallerKey: callerKey,
        })
        expect(approvalStatus(approvalId)).toBe('pending')
        expect(workflowRunCountForApproval(approvalId)).toBe(0)

        const providerEventId = `figd-slack-${stamp}`
        await submitSlackInteraction({
          trigger_id: providerEventId,
          user: { id: slackUserId },
          team: { id: FIGURE_D_SLACK_WORKSPACE },
          channel: { id: slackChannelId },
          actions: [{ value: actionValue, action_ts: providerEventId }],
        })
        const eventId = expectedFigureDReaderEventId('slack', slackChannelId, providerEventId)
        await expect
          .poll(() => providerEventResult('slack', eventId), { timeout: 60_000 })
          .toBe('decided:1')
        expect(providerDecisionCount(approvalId)).toBe(1)
        await waitForApprovalStatus(approvalId, 'consumed')
        await expect
          .poll(() => workflowRunCountForApproval(approvalId), { timeout: 120_000 })
          .toBe(1)
        expect(workflowRunCountForRecipe(targetRecipe)).toBe(1)
        await expect
          .poll(() => latestWorkflowRunSignal(targetRecipe), { timeout: 120_000 })
          .toBe(`Succeeded:${targetRecipe}`)
      })
    } finally {
      await cleanupRecipe(callerRecipe)
      await cleanupRecipe(targetRecipe)
      cleanupApprovalMediumResidues({
        providerUserIds: [slackUserId, telegramUserId],
        preserveAccountIds: existingAccounts,
      })
    }
  })

  test('rejects chatllm as a Figure D provider callback target', async () => {
    const response = await submitTelegramDecisionRaw({
      actionValue: 'approve:99999999-8888-7777-6666-555555555555:chatllm',
      providerEventId: `figd-chatllm-negative-${Date.now()}`,
      providerUserId: '700000001',
      chatId: '700000001',
    })
    expect(response.status, response.body).toBeGreaterThanOrEqual(400)
    expect(response.status).not.toBe(200)
  })

  test('Telegram DM lets a second user approve a recipe before another user can start it', async () => {
    if (!providerHarness) throw new Error('provider harness is not installed')
    const stamp = Date.now()
    const targetRecipe = `e2e-quadrant-figd-start-target-${stamp}`
    const callerRecipe = `e2e-quadrant-figd-start-caller-${stamp}`
    const approvalMessage = `3rd-party AuthN, 3rd-party MCP-Host start approval ${stamp}`
    const { userId: approverUserId } = await devLogin(E2E_EMAIL)
    const { userId: requesterUserId, userToken: requesterToken } = await devLogin(REQUESTER_EMAIL)
    const telegramUserId = `71${stamp}`
    const telegramChatId = telegramUserId
    const existingAccounts = mediumAccountIds([telegramUserId])

    try {
      await test.step('seed verified approver private Telegram binding', async () => {
        cleanupApprovalMediumResidues({
          providerUserIds: [telegramUserId],
          preserveAccountIds: existingAccounts,
        })
        seedVerifiedApprovalMediumBinding({
          userId: approverUserId,
          medium: 'telegram',
          providerUserId: telegramUserId,
          providerChannelId: telegramChatId,
          communicationChannelRef: FIGURE_D_COMMUNICATION_CHANNEL_REF,
        })
      })

      await test.step('install caller and target recipes with requester and approver boundaries', async () => {
        await cleanupRecipe(callerRecipe)
        await cleanupRecipe(targetRecipe)
        applyWorkflowManifest(targetRecipeManifest(targetRecipe, targetRecipe))
        applyWorkflowManifest(
          callerRecipeManifest({
            name: callerRecipe,
            targetName: targetRecipe,
            approverUserId,
            approvalMessage,
            model: { provider: MODEL_PROVIDER, model: MODEL_NAME },
          })
        )
        await grantUserThroughAdminRoute(WORKFLOW_RECIPE_NS, targetRecipe, approverUserId)
        await grantUserThroughAdminRoute(WORKFLOW_RECIPE_NS, callerRecipe, requesterUserId)
      })

      await test.step('requester starts the caller recipe and target approval is sent as Telegram DM', async () => {
        await resetProviderRequests(providerHarness.providerUrl)
        await triggerWorkflowAsUser(requesterToken, callerRecipe)
        const actionValue = await waitForProviderAction(
          providerHarness.providerUrl,
          'telegram',
          targetRecipe,
          'Approve',
          telegramChatId
        )
        const callerKey = `${WORKFLOW_RECIPE_NS}/${callerRecipe}`
        expect(triggerRuntimeMcpHostRef(actionValue)).toMatch(expectedRuntimeHostRef(callerRecipe))
        const approvalId = triggerApprovalId(actionValue)
        expect(workflowApprovalTriggerCallerKey(approvalId)).toBe(callerKey)
        expectApprovalRequestedNotification({
          approvalId,
          targetUserId: approverUserId,
          expectedCallerKey: callerKey,
        })
        expect(approvalStatus(approvalId)).toBe('pending')
        expect(workflowRunCountForApproval(approvalId)).toBe(0)

        const decidedApprovalId = await approveLatestTelegramDm({
          providerUrl: providerHarness.providerUrl,
          recipeName: targetRecipe,
          telegramUserId,
          telegramChatId,
          providerEventId: `figd-start-${stamp}`,
        })
        expect(decidedApprovalId).toBe(approvalId)
        await waitForApprovalStatus(approvalId, 'consumed')
        await expect
          .poll(() => workflowRunCountForApproval(approvalId), { timeout: 120_000 })
          .toBe(1)
        expect(workflowRunCountForRecipe(targetRecipe)).toBe(1)
        await expect
          .poll(() => latestWorkflowRunSignal(targetRecipe), { timeout: 120_000 })
          .toBe(`Succeeded:${targetRecipe}`)
      })
    } finally {
      await cleanupRecipe(callerRecipe)
      await cleanupRecipe(targetRecipe)
      cleanupApprovalMediumResidues({
        providerUserIds: [telegramUserId],
        preserveAccountIds: existingAccounts,
      })
    }
  })

  test('Telegram DM unblocks a second-user approval inside a multi-step recipe', async () => {
    if (!providerHarness) throw new Error('provider harness is not installed')
    const stamp = Date.now()
    const recipeName = `e2e-quadrant-figd-step-${stamp}`
    const approvalMessage = `3rd-party AuthN, 3rd-party MCP-Host step approval ${stamp}`
    const { userId: approverUserId } = await devLogin(E2E_EMAIL)
    const { userId: requesterUserId, userToken: requesterToken } = await devLogin(REQUESTER_EMAIL)
    const telegramUserId = `72${stamp}`
    const telegramChatId = telegramUserId
    const existingAccounts = mediumAccountIds([telegramUserId])

    try {
      await test.step('seed verified approver private Telegram binding', async () => {
        cleanupApprovalMediumResidues({
          providerUserIds: [telegramUserId],
          preserveAccountIds: existingAccounts,
        })
        seedVerifiedApprovalMediumBinding({
          userId: approverUserId,
          medium: 'telegram',
          providerUserId: telegramUserId,
          providerChannelId: telegramChatId,
          communicationChannelRef: FIGURE_D_COMMUNICATION_CHANNEL_REF,
        })
      })

      await test.step('install multi-step recipe with requester trigger grant and approver allowlist', async () => {
        await cleanupRecipe(recipeName)
        applyWorkflowManifest(
          stepApprovalRecipeManifest({
            name: recipeName,
            approverUserId,
            approvalMessage,
            marker: recipeName,
            model: { provider: MODEL_PROVIDER, model: MODEL_NAME },
          })
        )
        await setUserWorkflowGrantsThroughAdminRoute(WORKFLOW_RECIPE_NS, recipeName, [
          requesterUserId,
          approverUserId,
        ])
      })

      await test.step('requester starts recipe and it waits at the approval-gated step', async () => {
        await resetProviderRequests(providerHarness.providerUrl)
        await triggerWorkflowAsUser(requesterToken, recipeName)
        const actionValue = await waitForProviderAction(
          providerHarness.providerUrl,
          'telegram',
          recipeName,
          'Approve',
          telegramChatId
        )
        const callerKey = `${WORKFLOW_RECIPE_NS}/${recipeName}`
        expect(triggerRuntimeMcpHostRef(actionValue)).toMatch(expectedRuntimeHostRef(recipeName))
        const approvalId = triggerApprovalId(actionValue)
        expect(workflowApprovalTriggerCallerKey(approvalId)).toBe(callerKey)
        expectApprovalRequestedNotification({
          approvalId,
          targetUserId: approverUserId,
          expectedCallerKey: callerKey,
        })
        expect(approvalStatus(approvalId)).toBe('pending')
        expect(latestWorkflowRunPhase(recipeName)).not.toBe('Succeeded')

        const decidedApprovalId = await approveLatestTelegramDm({
          providerUrl: providerHarness.providerUrl,
          recipeName,
          telegramUserId,
          telegramChatId,
          providerEventId: `figd-step-${stamp}`,
        })
        expect(decidedApprovalId).toBe(approvalId)
        await waitForApprovalStatus(approvalId, 'approved')
        await waitForWorkflowRunPhase(recipeName, 'Succeeded')
        await expect
          .poll(() => latestWorkflowRunSignal(recipeName), { timeout: 120_000 })
          .toBe(`Succeeded:${recipeName}`)
      })
    } finally {
      await cleanupRecipe(recipeName)
      cleanupApprovalMediumResidues({
        providerUserIds: [telegramUserId],
        preserveAccountIds: existingAccounts,
      })
    }
  })
})
