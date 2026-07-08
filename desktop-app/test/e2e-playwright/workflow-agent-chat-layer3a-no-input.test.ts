import { type Locator, expect, test } from '@playwright/test'
import { profilesSql, sqlLiteral } from './workflow-approval-quadrants/cluster'
import {
  applyWorkflowRecipeManifest,
  approvalPromptFor,
  captureE2eEvidence,
  cleanupAgentChatRecipe,
  downloadArtifactViaUserApi,
  downloadJsonArtifactFromMarketplace,
  enterChatllmChat,
  expandResponseToolDetails,
  expectNoOperationalIds,
  openWorkflowRunInMarketplace,
  runWorkflowFromChat,
  sendChatPromptWithModelRescue,
  startFreshThread,
  waitForSucceededRunWithArtifact,
  waitForWorkflowRecipeActive,
} from './workflowAgentChatTools'
import { sendChatPromptAndApproveToolCallsUntilText } from './workflowChatMultiToolApproval'
import { downloadWorkflowResultResponseFileFromAssistant } from './workflowResultResponseAttachment'
import {
  E2E_EMAIL,
  RECIPE_NS,
  launchAndLogin,
  loginAs,
  rendererListWorkflowRuns,
} from './workflowUi'

const STAMP = Date.now()
const RECIPE_NAME = `e2e-agent-layer3a-no-input-${STAMP}`
const ARTIFACT_NAME = 'layer3a-no-input-result.json'

function grantUserWorkflowPrecondition(recipeName: string, userId: string): void {
  const result = profilesSql(
    `
    INSERT INTO user_workflow_triggers (user_id, recipe_namespace, recipe_name)
    VALUES (${sqlLiteral(userId)}, ${sqlLiteral(RECIPE_NS)}, ${sqlLiteral(recipeName)})
    ON CONFLICT DO NOTHING;
    SELECT user_id
      FROM user_workflow_triggers
     WHERE user_id = ${sqlLiteral(userId)}
       AND recipe_namespace = ${sqlLiteral(RECIPE_NS)}
       AND recipe_name = ${sqlLiteral(recipeName)};
    `,
    20_000
  )
  expect(result).toContain(userId)
}

async function expectNoBusinessInputsRequiredInList(response: Locator): Promise<void> {
  await expect(response).toContainText(
    /(((business )?inputs?|information).{0,40}none|none.{0,40}((business )?inputs?|information)|no required inputs|no inputs? needed|requires no information)/i
  )
}

function buildLayer3aNoInputManifest(name: string): Record<string, unknown> {
  return {
    apiVersion: 'clerum.io/v1alpha1',
    kind: 'WorkflowRecipe',
    metadata: { name, namespace: RECIPE_NS },
    spec: {
      description: `E2E Layer 3A no-input workflow capability ${STAMP}`,
      triggers: {
        onDemand: {
          requiresApproval: true,
          allowedActors: ['autonomous', 'user'],
        },
      },
      output: {
        destination: 'pvc',
        name,
        format: 'json',
        storageSize: '64Mi',
      },
      steps: [
        {
          id: 'emit-layer3a-no-input-result',
          timeoutSeconds: 120,
          run: {
            type: 'snippet',
            language: 'typescript',
            code: [
              'const inputKeys = Object.keys(sdk.inputs ?? {})',
              'const payload = {',
              '  scenario: "agent-chat-layer3a-no-input",',
              `  marker: "layer3a-${STAMP}",`,
              '  noBusinessInputsRequired: true,',
              '  inputKeys',
              '}',
              `const artifact = await sdk.artifacts.writeJson("${ARTIFACT_NAME}", payload)`,
              'return { ...payload, artifact }',
            ].join('\n'),
            capabilities: {
              artifacts: { maxCount: 1 },
            },
          },
        },
      ],
    },
  }
}

test.describe.serial('Workflow recipes as chat-native tools', () => {
  test('approves a granted Layer 3A no-input recipe and downloads workflow_result response attachments from Agent Chat', async ({}, testInfo) => {
    test.slow()
    cleanupAgentChatRecipe(RECIPE_NAME)
    const manifest = buildLayer3aNoInputManifest(RECIPE_NAME)
    expect((manifest.spec as { inputContract?: unknown }).inputContract).toBeUndefined()
    expect((manifest.spec as { steps?: unknown[] }).steps).toHaveLength(1)
    expect(manifest.spec).toMatchObject({
      output: {
        destination: 'pvc',
        name: RECIPE_NAME,
        format: 'json',
      },
    })
    applyWorkflowRecipeManifest(manifest)
    await waitForWorkflowRecipeActive(RECIPE_NAME)
    const { userId, userToken } = await loginAs(E2E_EMAIL)
    grantUserWorkflowPrecondition(RECIPE_NAME, userId)

    const { app, page } = await launchAndLogin(E2E_EMAIL)
    let appClosed = false
    try {
      await enterChatllmChat(page)
      await startFreshThread(page)
      await captureE2eEvidence(page, testInfo, 'layer3a-chat-ready-no-workflows-button')

      const listResponse = await sendChatPromptWithModelRescue(
        page,
        [
          `What workflow recipes can I run?`,
          `For each workflow, tell me the information I need to provide before running it.`,
        ].join(' ')
      )
      await expandResponseToolDetails(listResponse)
      await expect(listResponse).toContainText(RECIPE_NAME, { timeout: 180_000 })
      await expectNoBusinessInputsRequiredInList(listResponse)
      await expectNoOperationalIds(listResponse)
      await captureE2eEvidence(page, testInfo, 'layer3a-granted-workflow-no-input-contract')

      const runsBefore = await rendererListWorkflowRuns(page, RECIPE_NS, RECIPE_NAME, 20)
      let triggerResponse
      try {
        triggerResponse = await runWorkflowFromChat(
          page,
          RECIPE_NAME,
          [
            `${approvalPromptFor(RECIPE_NAME)} now.`,
            `It does not need any business inputs from me.`,
            `Use the workflow recipe trigger available in this chat.`,
            `When the approval request appears, wait for me to approve it in this app and then continue.`,
            `After the workflow is started, do not call workflow_result yet.`,
          ].join(' ')
        )
      } catch (error) {
        await captureE2eEvidence(page, testInfo, 'layer3a-trigger-approval-missing')
        throw error
      }
      await expandResponseToolDetails(triggerResponse)
      await expect(triggerResponse).toContainText(/workflow/i, { timeout: 300_000 })
      await expect(triggerResponse).toContainText(/approved|started|triggered|run/i, {
        timeout: 300_000,
      })
      await expectNoOperationalIds(triggerResponse)
      await expect(triggerResponse).not.toContainText(/Workflow broker request failed \(403\)/i)
      await expect(triggerResponse).not.toContainText(/workflow tool failed/i)
      await expect(triggerResponse).not.toContainText(
        /could not retrieve the workflow result artifact/i
      )
      await captureE2eEvidence(page, testInfo, 'layer3a-approved-trigger-summary-in-chat')

      const run = await waitForSucceededRunWithArtifact(
        page,
        RECIPE_NAME,
        runsBefore.items.map(item => item.id),
        ARTIFACT_NAME
      )

      const apiArtifact = await downloadArtifactViaUserApi(
        userToken,
        RECIPE_NAME,
        run.id,
        ARTIFACT_NAME
      )
      expect(apiArtifact).toMatchObject({
        scenario: 'agent-chat-layer3a-no-input',
        marker: `layer3a-${STAMP}`,
        noBusinessInputsRequired: true,
        inputKeys: [],
      })

      const resultResponse = await sendChatPromptAndApproveToolCallsUntilText(
        page,
        [
          `Download the workflow result artifact for ${RECIPE_NAME}.`,
          `Use the workflow_result tool for this completed workflow run.`,
          `Return the generated file as a downloadable attachment in this chat.`,
        ].join(' '),
        [/./],
        420_000,
        {
          approvalRequired: false,
          requiredText: [/workflow_result/i],
          forbiddenText: [/workflow_trigger/i],
        }
      )
      await expandResponseToolDetails(resultResponse)
      const resultStepper = resultResponse.getByTestId('progress-stepper').last()
      if (await resultStepper.isVisible().catch(() => false)) {
        await expect(resultStepper).toContainText(/workflow_result/i)
        await expect(resultStepper).not.toContainText(/workflow_trigger/i)
      }
      await expect(resultResponse).not.toContainText(
        /could not retrieve the workflow result artifact/i
      )
      await downloadWorkflowResultResponseFileFromAssistant(
        resultResponse,
        ARTIFACT_NAME,
        apiArtifact
      )
      await captureE2eEvidence(page, testInfo, 'layer3a-workflow-result-response-file-downloaded')

      const repeatedResultResponse = await sendChatPromptAndApproveToolCallsUntilText(
        page,
        [
          `I already asked for the workflow result for ${RECIPE_NAME}.`,
          `Ask for that same completed workflow result again now.`,
          `Use workflow_result again and attach the same generated file as a downloadable response attachment.`,
        ].join(' '),
        [/./],
        420_000,
        {
          approvalRequired: false,
          requiredText: [/workflow_result/i],
          forbiddenText: [/workflow_trigger/i],
        }
      )
      await expandResponseToolDetails(repeatedResultResponse)
      const repeatedResultStepper = repeatedResultResponse.getByTestId('progress-stepper').last()
      if (await repeatedResultStepper.isVisible().catch(() => false)) {
        await expect(repeatedResultStepper).toContainText(/workflow_result/i)
        await expect(repeatedResultStepper).not.toContainText(/workflow_trigger/i)
      }
      await expect(repeatedResultResponse).not.toContainText(
        /could not retrieve the workflow result artifact/i
      )
      await downloadWorkflowResultResponseFileFromAssistant(
        repeatedResultResponse,
        ARTIFACT_NAME,
        apiArtifact
      )
      await captureE2eEvidence(
        page,
        testInfo,
        'layer3a-workflow-result-response-file-downloaded-again'
      )

      await app.close()
      appClosed = true

      const relaunched = await launchAndLogin(E2E_EMAIL)
      try {
        await enterChatllmChat(relaunched.page)
        const hydratedResponse = relaunched.page
          .getByTestId('agent-response')
          .filter({ hasText: ARTIFACT_NAME })
          .last()
        await downloadWorkflowResultResponseFileFromAssistant(
          hydratedResponse,
          ARTIFACT_NAME,
          apiArtifact
        )
        await captureE2eEvidence(
          relaunched.page,
          testInfo,
          'layer3a-workflow-result-response-file-downloaded-after-relaunch'
        )

        const runRow = await openWorkflowRunInMarketplace(
          relaunched.page,
          RECIPE_NAME,
          run.id,
          ARTIFACT_NAME
        )
        await captureE2eEvidence(relaunched.page, testInfo, 'layer3a-marketplace-same-run-artifact')
        const marketplaceArtifact = await downloadJsonArtifactFromMarketplace(
          runRow,
          run.id,
          ARTIFACT_NAME
        )
        expect(marketplaceArtifact).toMatchObject(apiArtifact)
      } finally {
        await relaunched.app.close()
      }
    } finally {
      if (!appClosed) await app.close()
      cleanupAgentChatRecipe(RECIPE_NAME)
    }
  })
})
