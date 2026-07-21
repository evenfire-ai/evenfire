import { type Page, expect, test } from '@playwright/test'
import {
  assertGfsFixtureCleaned,
  cleanupGfsFixture,
  getGfsChildResourceSummary,
  getGfsGrantSummary,
  seedGfsFileFixture,
  seedGfsGrant,
  uniqueGfsFixtureName,
} from '../../../tests/e2e/gfsUiFixtures'
import { cleanupGfsWorkflowRunsAfter } from './workflowAgentChatGfsCleanup'
import {
  expectDurableGfsGrantUsage,
  waitForWorkflowRunSucceeded,
  workflowRunInfraState,
} from './workflowAgentChatGfsRunState'
import {
  GFS_PLUGIN_NAMESPACE,
  GFS_PLUGIN_RECIPE,
  GFS_PLUGIN_SUBJECT_ID,
  expectWorkflowGfsProbeResult,
  gfsWorkflowRunsAfter,
  listGfsWorkflowRuns,
  waitForGfsRunScopedRuntime,
} from './workflowAgentChatGfsRuntime'
import {
  approvalPromptFor,
  approveWorkflowNotification,
  captureE2eEvidence,
  enterChatllmChat,
  expandResponseToolDetails,
  expectNoOperationalIds,
  runWorkflowFromChat,
  sendChatPromptWithModelRescue,
  startFreshThread,
  waitForWorkflowRecipeActive,
} from './workflowAgentChatTools'
import { sendChatPromptAndApproveToolCallsUntilText } from './workflowChatMultiToolApproval'
import { E2E_EMAIL, launchAndLogin, loginAs, rendererListWorkflowRuns } from './workflowUi'

async function waitForChatRunExecution(
  page: Page,
  baselineIds: ReadonlySet<string>,
  userId: string
): Promise<{ childName: string; runId: string }> {
  let match: Awaited<ReturnType<typeof rendererListWorkflowRuns>>['items'][number] | undefined
  await expect
    .poll(
      async () => {
        const newRuns = gfsWorkflowRunsAfter(baselineIds)
        if (newRuns.length !== 1 || !newRuns[0]?.childName) return null
        const runs = await rendererListWorkflowRuns(
          page,
          GFS_PLUGIN_NAMESPACE,
          GFS_PLUGIN_RECIPE,
          20
        )
        match = runs.items.find(run => run.id === newRuns[0]!.runId && run.executionRef?.name)
        return match?.executionRef?.name ?? null
      },
      {
        timeout: 90_000,
        intervals: [500, 1_000, 2_000],
        message: `Agent Chat should create exactly one new child-backed run for ${GFS_PLUGIN_RECIPE}`,
      }
    )
    .not.toBeNull()

  expect(match).toBeTruthy()
  expect(gfsWorkflowRunsAfter(baselineIds)).toHaveLength(1)
  expect(match!.actor).toMatchObject({ type: 'user-session', userId })
  expect(['Pending', 'Running']).toContain(match!.phase)
  expect(match!.executionRef).toMatchObject({ namespace: GFS_PLUGIN_NAMESPACE })
  return { childName: match!.executionRef!.name, runId: match!.id }
}

test.describe.serial('Agent Chat WorkflowRecipe GFS runtime grants', () => {
  test('triggers the exact third-party recipe from Desktop Chat and inherits its folder read/write grant in the run-scoped mcp-host', async ({}, testInfo) => {
    test.setTimeout(1_200_000)
    test.info().annotations.push({
      type: 'e2e-contract',
      description:
        'The workflow must be discovered and triggered through visible Desktop Agent Chat. Its host receives one inheritable grant on the parent folder and no direct grant on the child file. The chat response is not proof by itself: the test independently binds the one new user-session run to its exact child and proves that its ordered agentic steps performed real GFS read/stat/write/read-back operations from the run-scoped mcp-host, with durable audit and final-resource validation. Direct API triggering, kubectl-exec tool shortcuts, and fleet-wide parent runtimes are forbidden.',
    })

    const fixtureName = uniqueGfsFixtureName('e2e-gfs-desktop-chat-grant')
    let fixture: ReturnType<typeof seedGfsFileFixture> | undefined
    let childName: string | undefined
    let runId: string | undefined
    let app: Awaited<ReturnType<typeof launchAndLogin>>['app'] | undefined
    const baselineRunIds = new Set(listGfsWorkflowRuns().map(run => run.runId))

    try {
      await waitForWorkflowRecipeActive(GFS_PLUGIN_RECIPE)
      const { userId } = await loginAs(E2E_EMAIL)
      fixture = seedGfsFileFixture(fixtureName)
      seedGfsGrant({
        resourceId: fixture.resourceId,
        subjectType: 'host',
        subjectId: GFS_PLUGIN_SUBJECT_ID,
        permissions: ['read', 'write'],
        inherit: true,
        grantedBy: 'e2e:desktop-chat-precondition',
      })
      expect(
        getGfsGrantSummary({
          resourceId: fixture.resourceId,
          subjectType: 'host',
          subjectId: GFS_PLUGIN_SUBJECT_ID,
        })
      ).toMatchObject({
        permissions: ['read', 'write'],
        inherit: true,
        grantedBy: 'e2e:desktop-chat-precondition',
      })
      expect(
        getGfsGrantSummary({
          resourceId: fixture.fileResourceId,
          subjectType: 'host',
          subjectId: GFS_PLUGIN_SUBJECT_ID,
        })
      ).toBeNull()
      const initialResource = getGfsChildResourceSummary({
        parentResourceId: fixture.resourceId,
        name: fixture.fileName,
      })
      expect(initialResource).not.toBeNull()
      const updatedContent = `Desktop Chat third-party workflow updated ${fixture.fileName}`

      const launched = await launchAndLogin(E2E_EMAIL)
      app = launched.app
      const { page } = launched
      await enterChatllmChat(page)
      await startFreshThread(page)
      await expect(page.getByRole('button', { name: /^Workflows$/i })).toHaveCount(0)
      await captureE2eEvidence(page, testInfo, 'gfs-chat-ready-no-workflow-shortcut')

      const listResponse = await sendChatPromptWithModelRescue(
        page,
        'What workflow recipes can I run? List the exact recipe names and required business inputs.'
      )
      await expandResponseToolDetails(listResponse)
      await expect(listResponse).toContainText(GFS_PLUGIN_RECIPE, { timeout: 180_000 })
      await expectNoOperationalIds(listResponse)
      await captureE2eEvidence(page, testInfo, 'gfs-workflow-discovered-in-chat')

      const triggerResponse = await runWorkflowFromChat(
        page,
        GFS_PLUGIN_RECIPE,
        [
          `${approvalPromptFor(GFS_PLUGIN_RECIPE)} now.`,
          'Use the workflow recipe trigger available in this chat.',
          'When the approval request appears, wait for me to approve it in this app and then continue.',
          `Pass these exact business inputs: resourceId=${fixture.fileResourceId} and updatedContent=${JSON.stringify(updatedContent)}.`,
          'After it starts, do not request results or approve the workflow step; leave the run active.',
        ].join(' ')
      )
      await expandResponseToolDetails(triggerResponse)
      await expect(triggerResponse).toContainText(/workflow/i, { timeout: 300_000 })
      await expect(triggerResponse).toContainText(/approved|started|triggered|run/i, {
        timeout: 300_000,
      })
      await expect(triggerResponse).not.toContainText(/workflow tool failed|broker request failed/i)
      await expectNoOperationalIds(triggerResponse)
      await captureE2eEvidence(page, testInfo, 'gfs-workflow-triggered-from-chat')

      const execution = await waitForChatRunExecution(page, baselineRunIds, userId)
      runId = execution.runId
      childName = execution.childName
      await waitForGfsRunScopedRuntime(runId, childName, {
        resourceId: fixture.fileResourceId,
        updatedContent,
      })

      await test.step('the user approves the held workflow step and infra waits for completion', async () => {
        await approveWorkflowNotification(page, GFS_PLUGIN_RECIPE)
        await waitForWorkflowRunSucceeded(runId!, childName!)
      })

      const resultResponse = await sendChatPromptAndApproveToolCallsUntilText(
        page,
        [
          `Check the final status of ${GFS_PLUGIN_RECIPE}.`,
          'Use workflow_status for the workflow I just started from this chat.',
          'Tell me whether it completed successfully; do not trigger another run.',
        ].join(' '),
        [/Succeeded/i],
        420_000,
        { requiredText: [/workflow_status/i], forbiddenText: [/workflow_trigger/i] }
      )
      await expandResponseToolDetails(resultResponse)
      await expect(resultResponse).toContainText(/Succeeded|completed successfully/i)
      await captureE2eEvidence(page, testInfo, 'gfs-workflow-completed-visible-in-chat')

      expect(gfsWorkflowRunsAfter(baselineRunIds)).toEqual([
        { childName: childName!, runId: runId! },
      ])
      expect(workflowRunInfraState(runId!)).toEqual({ childName: childName!, phase: 'Succeeded' })
      await expectWorkflowGfsProbeResult({
        childName: childName!,
        fileResourceId: fixture.fileResourceId,
        fileUri: fixture.fileUri,
        initialContent: `E2E GFS file fixture: ${fixture.name}\n`,
        runId: runId!,
        updatedContent,
      })
      expectDurableGfsGrantUsage(fixture.fileUri)
      expect(
        getGfsChildResourceSummary({
          parentResourceId: fixture.resourceId,
          name: fixture.fileName,
        })
      ).toMatchObject({
        bytes: Buffer.byteLength(updatedContent),
        version: initialResource!.version + 1,
      })
      await captureE2eEvidence(page, testInfo, 'gfs-run-scoped-runtime-read-write-proven')
      expect(
        getGfsGrantSummary({
          resourceId: fixture.resourceId,
          subjectType: 'host',
          subjectId: GFS_PLUGIN_SUBJECT_ID,
        })
      ).toMatchObject({ permissions: ['read', 'write'], inherit: true })
      expect(
        getGfsGrantSummary({
          resourceId: fixture.fileResourceId,
          subjectType: 'host',
          subjectId: GFS_PLUGIN_SUBJECT_ID,
        })
      ).toBeNull()
    } finally {
      if (app) await app.close()
      try {
        await cleanupGfsWorkflowRunsAfter(baselineRunIds)
      } finally {
        cleanupGfsFixture(fixtureName)
        assertGfsFixtureCleaned(fixtureName)
        if (fixture) {
          expect(
            getGfsGrantSummary({
              resourceId: fixture.resourceId,
              subjectType: 'host',
              subjectId: GFS_PLUGIN_SUBJECT_ID,
            })
          ).toBeNull()
          expect(
            getGfsGrantSummary({
              resourceId: fixture.fileResourceId,
              subjectType: 'host',
              subjectId: GFS_PLUGIN_SUBJECT_ID,
            })
          ).toBeNull()
        }
      }
    }
  })
})
