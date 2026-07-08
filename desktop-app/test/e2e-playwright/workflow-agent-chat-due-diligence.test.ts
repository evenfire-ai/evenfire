import { expect, test } from '@playwright/test'
import { grantUserThroughAdminRoute } from './workflow-approval-quadrants/recipes'
import {
  applyWorkflowRecipeManifest,
  approvalPromptFor,
  captureE2eEvidence,
  cleanupAgentChatRecipe,
  downloadArtifactFromChat,
  downloadArtifactViaUserApi,
  downloadJsonArtifactFromMarketplace,
  enterChatllmChat,
  expandResponseToolDetails,
  expectNoOperationalIds,
  expectNoWorkflowResultToolError,
  openWorkflowRunInMarketplace,
  refreshChatArtifactPanel,
  runWorkflowFromChat,
  sendChatPromptWithModelRescue,
  startFreshThread,
  waitForSucceededRunWithArtifact,
  waitForWorkflowRecipeActive,
} from './workflowAgentChatTools'
import {
  E2E_EMAIL,
  RECIPE_NS,
  launchAndLogin,
  loginAs,
  rendererListWorkflowRuns,
} from './workflowUi'

const STAMP = Date.now()
const RECIPE_NAME = `e2e-agent-due-diligence-${STAMP}`
const ARTIFACT_NAME = 'due-diligence-result.json'
const COMPANY = `Acme due-${STAMP}`

function buildDueDiligenceManifest(name: string): Record<string, unknown> {
  return {
    apiVersion: 'clerum.io/v1alpha1',
    kind: 'WorkflowRecipe',
    metadata: { name, namespace: RECIPE_NS },
    spec: {
      description: `E2E due diligence capability for ${COMPANY}`,
      inputContract: {
        type: 'object',
        required: ['company'],
        properties: {
          company: {
            type: 'string',
            description: 'Target company or organization.',
          },
          depth: {
            type: 'string',
            enum: ['standard', 'full'],
            default: 'full',
            description: 'Due diligence depth.',
          },
        },
      },
      triggers: {
        onDemand: {
          requiresApproval: false,
          allowedActors: ['autonomous'],
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
          id: 'emit-due-diligence-result',
          timeoutSeconds: 120,
          run: {
            type: 'snippet',
            language: 'typescript',
            code: [
              'const payload = {',
              '  scenario: "agent-chat-due-diligence",',
              '  company: sdk.inputs.company,',
              '  depth: sdk.inputs.depth,',
              `  marker: "due-${STAMP}",`,
              '  checks: ["identity", "litigation", "financials"]',
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
  test('lists granted inputContract fields, triggers due diligence from Chat, and downloads the same run in Chat and Workflows', async ({}, testInfo) => {
    test.slow()
    cleanupAgentChatRecipe(RECIPE_NAME)
    applyWorkflowRecipeManifest(buildDueDiligenceManifest(RECIPE_NAME))
    await waitForWorkflowRecipeActive(RECIPE_NAME)
    const { userId, userToken } = await loginAs(E2E_EMAIL)
    await grantUserThroughAdminRoute(RECIPE_NS, RECIPE_NAME, userId)

    const { app, page } = await launchAndLogin(E2E_EMAIL)
    try {
      await enterChatllmChat(page)
      await startFreshThread(page)
      await captureE2eEvidence(page, testInfo, 'due-chat-ready-no-workflows-button')

      const listResponse = await sendChatPromptWithModelRescue(
        page,
        [
          `What workflow recipes can I run?`,
          `For each workflow, tell me the information I need to provide before running it.`,
        ].join(' ')
      )
      await expandResponseToolDetails(listResponse)
      await expect(listResponse).toContainText(RECIPE_NAME, { timeout: 180_000 })
      await expect(listResponse).toContainText(/company/i)
      await expect(listResponse).toContainText(/depth/i)
      await expectNoOperationalIds(listResponse)
      await captureE2eEvidence(page, testInfo, 'due-granted-workflows-input-contract')

      const runsBefore = await rendererListWorkflowRuns(page, RECIPE_NS, RECIPE_NAME, 20)
      const triggerResponse = await runWorkflowFromChat(
        page,
        RECIPE_NAME,
        [
          `${approvalPromptFor(RECIPE_NAME)} with company: ${COMPANY}, depth: full.`,
          `Use the workflow recipe trigger available in this chat.`,
          `Just start it for now; do not check workflow status, health, results, or artifacts yet.`,
          `I will use the workflow results panel to check progress and download the artifact.`,
        ].join(' ')
      )
      await expandResponseToolDetails(triggerResponse)
      await expect(triggerResponse).toContainText(/workflow/i, { timeout: 300_000 })
      await expectNoOperationalIds(triggerResponse)
      await expectNoWorkflowResultToolError(triggerResponse)
      await captureE2eEvidence(page, testInfo, 'due-trigger-summary-in-chat')

      const run = await waitForSucceededRunWithArtifact(
        page,
        RECIPE_NAME,
        runsBefore.items.map(item => item.id),
        ARTIFACT_NAME
      )
      const chatPanel = await refreshChatArtifactPanel(page, run.id, ARTIFACT_NAME)
      const chatArtifact = JSON.parse(
        (await downloadArtifactFromChat(page, chatPanel, run.id, ARTIFACT_NAME)).toString('utf8')
      ) as Record<string, unknown>
      expect(chatArtifact).toMatchObject({
        scenario: 'agent-chat-due-diligence',
        company: COMPANY,
        depth: 'full',
        marker: `due-${STAMP}`,
      })
      await captureE2eEvidence(page, testInfo, 'due-chat-artifact-downloaded')

      const apiArtifact = await downloadArtifactViaUserApi(
        userToken,
        RECIPE_NAME,
        run.id,
        ARTIFACT_NAME
      )
      expect(apiArtifact).toMatchObject({
        scenario: 'agent-chat-due-diligence',
        company: COMPANY,
        depth: 'full',
        marker: `due-${STAMP}`,
      })
      expect(apiArtifact).toMatchObject(chatArtifact)

      const runRow = await openWorkflowRunInMarketplace(page, RECIPE_NAME, run.id, ARTIFACT_NAME)
      await captureE2eEvidence(page, testInfo, 'due-marketplace-same-run-artifact')
      const marketplaceArtifact = await downloadJsonArtifactFromMarketplace(
        runRow,
        run.id,
        ARTIFACT_NAME
      )
      expect(marketplaceArtifact).toMatchObject(apiArtifact)
    } finally {
      await app.close()
      cleanupAgentChatRecipe(RECIPE_NAME)
    }
  })
})
