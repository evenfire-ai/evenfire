import { expect, test } from '@playwright/test'
import { grantWorkflowRecipeToUsers } from './third-party-authn-first-party-mcphost/workflowApprovalJourney'
import {
  ARTIFACT_NAME,
  COLLECTION_NAME,
  DATABASE_NAME,
  MONGO_MCP_SERVER_NAME,
  buildMongoMcpManifest,
} from './workflowAgentChatMongoManifest'
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
  expectNoBusinessInputsRequired,
  expectNoOperationalIds,
  expectNoWorkflowResultToolError,
  humanClick,
  kubectl,
  openWorkflowRunInMarketplace,
  refreshChatArtifactPanel,
  runWorkflowFromChat,
  sendChatPromptWithModelRescue,
  startFreshThread,
  waitForMcpServerReady,
  waitForSucceededRunWithArtifact,
  waitForWorkflowRecipeActive,
} from './workflowAgentChatTools'
import { sendChatPromptAndApproveToolCallsUntilText } from './workflowChatMultiToolApproval'
import {
  E2E_EMAIL,
  RECIPE_NS,
  launchAndLogin,
  loginAs,
  rendererListWorkflowRuns,
} from './workflowUi'

const STAMP = Date.now()
const RECIPE_NAME = `e2e-agent-mongo-mcp-${STAMP}`
const MARKER = `agent-chat-mongo-mcp-${STAMP}`
const RECORD_REF = `mongo-business-record-${STAMP}`

type MongoSeedRecord = {
  _id: string
  marker: string
  recordRef: string
  recipeName: string
  source: string
  status: string
}

function mongoEvalLiteral(value: string): string {
  return JSON.stringify(value)
}

function mongoPodName(): string {
  const name = kubectl([
    '-n',
    RECIPE_NS,
    'get',
    'pods',
    '-l',
    'clerum.io/recipe=mongodb-mcp-stack,clerum.io/workload=mongodb',
    '--field-selector=status.phase=Running',
    '-o',
    'jsonpath={.items[0].metadata.name}',
  ]).trim()
  expect(name, 'MongoDB fixture pod must be running').toBeTruthy()
  return name
}

function cleanupMongoSeedDocuments(): void {
  try {
    kubectl(
      [
        '-n',
        RECIPE_NS,
        'exec',
        mongoPodName(),
        '--',
        'mongosh',
        '--quiet',
        DATABASE_NAME,
        '--eval',
        [
          `db.${COLLECTION_NAME}.deleteMany({`,
          `  $or: [`,
          `    { marker: ${mongoEvalLiteral(MARKER)} },`,
          `    { recipeName: ${mongoEvalLiteral(RECIPE_NAME)} },`,
          `    { recordRef: ${mongoEvalLiteral(RECORD_REF)} }`,
          `  ]`,
          `})`,
        ].join('\n'),
      ],
      undefined,
      30_000
    )
  } catch {
    // Test data is uniquely named; preserve the original failure if cleanup races the Mongo pod.
  }
}

function readMongoSeedRecords(): MongoSeedRecord[] {
  const raw = kubectl(
    [
      '-n',
      RECIPE_NS,
      'exec',
      mongoPodName(),
      '--',
      'mongosh',
      '--quiet',
      DATABASE_NAME,
      '--eval',
      [
        `const docs = db.${COLLECTION_NAME}.find(`,
        `  { marker: ${mongoEvalLiteral(MARKER)}, recipeName: ${mongoEvalLiteral(RECIPE_NAME)} },`,
        `  { _id: 1, marker: 1, recordRef: 1, recipeName: 1, source: 1, status: 1 }`,
        `).toArray().map(doc => ({ ...doc, _id: doc._id.toString() }))`,
        `print(JSON.stringify(docs))`,
      ].join('\n'),
    ],
    undefined,
    30_000
  )
  const jsonLine = raw
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .at(-1)
  return JSON.parse(jsonLine ?? '[]') as MongoSeedRecord[]
}

test.describe.serial('Agent Chat workflow recipe with MongoDB MCP', () => {
  test('triggers a no-inputContract workflow from Chat, seeds MongoDB, then reads it through the recipe MCP server', async ({}, testInfo) => {
    test.slow()
    test.info().annotations.push({
      type: 'e2e-contract',
      description:
        'No API trigger shortcut: the workflow run is requested from Agent Chat; MongoDB is populated by the workflow recipe; the workflow artifact download is validated separately; record verification must use a ChatLLM read-only MCP query against the recipe-owned MongoDB MCP server as source of truth.',
    })

    cleanupAgentChatRecipe(RECIPE_NAME)
    applyWorkflowRecipeManifest(
      buildMongoMcpManifest({
        name: RECIPE_NAME,
        namespace: RECIPE_NS,
        marker: MARKER,
        recordRef: RECORD_REF,
      })
    )
    await waitForWorkflowRecipeActive(RECIPE_NAME)
    await waitForMcpServerReady(MONGO_MCP_SERVER_NAME)
    cleanupMongoSeedDocuments()
    const { userId, userToken } = await loginAs(E2E_EMAIL)
    await grantWorkflowRecipeToUsers(RECIPE_NAME, [userId])

    const { app, page } = await launchAndLogin(E2E_EMAIL)
    try {
      await enterChatllmChat(page)
      await startFreshThread(page)
      await expect(page.getByRole('button', { name: /^Workflows$/i })).toHaveCount(0)
      await expect(page.getByTestId('workflow-chat-artifacts')).toHaveCount(0)
      await captureE2eEvidence(page, testInfo, 'mongo-chat-ready-no-workflows-button')

      const listResponse = await sendChatPromptWithModelRescue(
        page,
        [
          `What workflow recipes can I run?`,
          `For each workflow, tell me the information I need to provide before running it.`,
        ].join(' ')
      )
      await expandResponseToolDetails(listResponse)
      await expect(listResponse).toContainText(RECIPE_NAME, { timeout: 180_000 })
      await expectNoBusinessInputsRequired(listResponse)
      await expectNoOperationalIds(listResponse)
      await captureE2eEvidence(page, testInfo, 'mongo-granted-workflow-no-input-contract')

      const runsBefore = await rendererListWorkflowRuns(page, RECIPE_NS, RECIPE_NAME, 20)
      const triggerResponse = await runWorkflowFromChat(
        page,
        RECIPE_NAME,
        [
          `${approvalPromptFor(RECIPE_NAME)} now.`,
          `It does not need any business inputs from me.`,
          `Use the workflow recipe trigger available in this chat.`,
          `Just start it for now; do not check workflow status, health, results, artifacts, or MongoDB yet.`,
          `I will ask for the MongoDB data after the workflow finishes.`,
        ].join(' ')
      )
      await expandResponseToolDetails(triggerResponse)
      await expect(triggerResponse).toContainText(/workflow|mongo/i, { timeout: 300_000 })
      await expectNoOperationalIds(triggerResponse)
      await expectNoWorkflowResultToolError(triggerResponse)
      await captureE2eEvidence(page, testInfo, 'mongo-trigger-summary-in-chat')

      const chatArtifactPanel = page.getByTestId('workflow-chat-artifacts').last()
      await expect(chatArtifactPanel).toBeVisible({ timeout: 60_000 })
      await humanClick(chatArtifactPanel.getByRole('button', { name: /^Refresh$/ }), {
        beforeMs: [700, 1_200],
        afterMs: [900, 1_500],
      })
      await expect(chatArtifactPanel).toContainText(/Workflow results|No downloadable/i)
      await captureE2eEvidence(page, testInfo, 'mongo-results-refresh-before-complete')

      const run = await waitForSucceededRunWithArtifact(
        page,
        RECIPE_NAME,
        runsBefore.items.map(item => item.id),
        ARTIFACT_NAME
      )
      const readyChatArtifactPanel = await refreshChatArtifactPanel(page, run.id, ARTIFACT_NAME)
      await captureE2eEvidence(page, testInfo, 'mongo-results-refresh-after-complete')
      const chatArtifact = JSON.parse(
        (
          await downloadArtifactFromChat(page, readyChatArtifactPanel, run.id, ARTIFACT_NAME)
        ).toString('utf8')
      ) as Record<string, unknown>
      const artifact = await downloadArtifactViaUserApi(
        userToken,
        RECIPE_NAME,
        run.id,
        ARTIFACT_NAME
      )
      expect(artifact).toMatchObject({
        scenario: 'agent-chat-mongo-mcp',
        marker: MARKER,
        recordRef: RECORD_REF,
        database: DATABASE_NAME,
        collection: COLLECTION_NAME,
        mcpServer: MONGO_MCP_SERVER_NAME,
        insertedCount: 1,
      })
      expect(chatArtifact).toMatchObject(artifact)
      await captureE2eEvidence(page, testInfo, 'mongo-chat-artifact-downloaded')
      const seededRecords = readMongoSeedRecords()
      expect(seededRecords.length).toBeGreaterThanOrEqual(1)
      const seededRecord = seededRecords[0]
      expect(seededRecord).toMatchObject({
        marker: MARKER,
        recordRef: RECORD_REF,
        recipeName: RECIPE_NAME,
        source: 'workflow-recipe',
        status: 'ready-for-mcp-read',
      })

      const queryResponse = await sendChatPromptAndApproveToolCallsUntilText(
        page,
        [
          `Show me the MongoDB document with marker ${MARKER}.`,
          `Use only the connected MongoDB data tool in this chat and keep the check read-only.`,
          `The MongoDB database is ${DATABASE_NAME} and the collection is ${COLLECTION_NAME}.`,
          `Do not say the database or collection is missing; use those values to query the marker now.`,
          `Return the database data as a compact table or list with these exact fields: recordRef, marker, recipeName, source, and status.`,
          `Do not use aliases such as recordReference or savedStatus.`,
          `Do not create, update, delete, or write records.`,
        ].join(' '),
        [new RegExp(RECORD_REF), new RegExp(MARKER), new RegExp(RECIPE_NAME)],
        420_000,
        {
          requiredText: [/mongodb|mongo|find/i],
          forbiddenText: [
            /workflow_trigger|workflow_result|workflow_status|workflow_health/i,
            /insert|update|delete|remove|drop|create|write/i,
          ],
        }
      )

      await expandResponseToolDetails(queryResponse)
      await expect(queryResponse).toContainText(/record|row|document|seeded/i, { timeout: 300_000 })
      await expect(queryResponse).toContainText(/record reference|recordRef|reference/i)
      await expect(queryResponse).toContainText(/marker/i)
      await expect(queryResponse).toContainText(/workflow name|recipe name|recipeName/i)
      await expect(queryResponse).toContainText(/source/i)
      await expect(queryResponse).toContainText(/saved status|status/i)
      await expect(queryResponse).toContainText(RECORD_REF)
      await expect(queryResponse).toContainText(MARKER)
      await expect(queryResponse).toContainText(RECIPE_NAME)
      for (const record of seededRecords) {
        await expect(queryResponse).not.toContainText(record._id)
      }
      await expect(queryResponse).toContainText(/workflow-recipe|ready-for-mcp-read/i)
      await expectNoOperationalIds(queryResponse)
      await expectNoWorkflowResultToolError(queryResponse)
      await expect(queryResponse).not.toContainText(
        /latestRun|lastRun|Triggers allowed|Workflow status/i
      )
      await expect(queryResponse).not.toContainText(MONGO_MCP_SERVER_NAME)
      await captureE2eEvidence(page, testInfo, 'mongo-query-result-from-recipe-mcp')
      const queryStepper = queryResponse.getByTestId('progress-stepper').last()
      await expect(queryStepper).not.toContainText(/workflow_result/i)
      await expect(queryStepper).toContainText(/mongodb|find/i, { timeout: 30_000 })
      await expect(queryStepper).not.toContainText(/insert|update|delete|remove|write/i)
      await expect(queryResponse).not.toContainText(/fetch failed|do not have access|was denied/i)

      const runRow = await openWorkflowRunInMarketplace(page, RECIPE_NAME, run.id, ARTIFACT_NAME)
      await captureE2eEvidence(page, testInfo, 'mongo-marketplace-same-run-artifact')
      const marketplaceArtifact = await downloadJsonArtifactFromMarketplace(
        runRow,
        run.id,
        ARTIFACT_NAME
      )
      expect(marketplaceArtifact).toMatchObject(artifact)
    } finally {
      await app.close()
      cleanupMongoSeedDocuments()
      cleanupAgentChatRecipe(RECIPE_NAME)
    }
  })
})
