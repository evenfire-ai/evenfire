import { expect, test } from '@playwright/test'
import {
  assertGfsFixtureCleaned,
  cleanupGfsFixture,
  cleanupGfsWorkflowRecipeFixture,
  getGfsGrantSummary,
  seedGfsFileFixture,
  seedGfsWorkflowRecipeCloneFixture,
  uniqueGfsFixtureName,
} from '../../tests/e2e/gfsUiFixtures'
import { openGfsFilePanel } from './support/gfs-control-ui-session'
import {
  type FirstPartyHostKey,
  exerciseGfsFirstPartyEffectiveGrantJourney,
} from './support/gfs-first-party-effective-grants.test'
import { cleanupNormalGfsPluginRun } from './support/gfs-normal-workflow-cleanup.test'
import {
  GFS_PLUGIN_NAMESPACE,
  GFS_PLUGIN_RECIPE,
  startNormalGfsPluginRun,
} from './support/gfs-normal-workflow-run.test'
import { expectNormalGfsPluginRunHeld } from './support/gfs-normal-workflow-state.test'
import { exerciseGfsPluginEffectiveGrantJourney } from './support/gfs-plugin-effective-grants.test'

test.describe('GFS runtime grant enforcement', () => {
  test('normal WorkflowRecipe run-scoped mcp-host preserves read, write, and combined grants', async ({
    browserName,
    page,
  }) => {
    test.skip(
      browserName === 'firefox',
      'The normal WorkflowRecipe run-scoped mcp-host journey runs once in Chromium.'
    )
    test.setTimeout(600_000)

    const fixtureName = uniqueGfsFixtureName('e2e-gfs-plugin-grant')
    const unrelatedRecipeName = uniqueGfsFixtureName('e2e-gfs-plugin-isolation')
    const subjectId = `3rd:${GFS_PLUGIN_NAMESPACE}/${GFS_PLUGIN_RECIPE}`
    const unrelatedSubjectId = `3rd:${GFS_PLUGIN_NAMESPACE}/${unrelatedRecipeName}`
    let fixture: ReturnType<typeof seedGfsFileFixture> | undefined
    let childName: string | undefined
    let runId: string | undefined
    let unrelatedChildName: string | undefined
    let unrelatedRunId: string | undefined

    try {
      fixture = seedGfsFileFixture(fixtureName)
      seedGfsWorkflowRecipeCloneFixture(unrelatedRecipeName, GFS_PLUGIN_RECIPE)
      const { pod, unrelatedPod } =
        await test.step('operator visibly starts two plugins with independent run-scoped mcp-hosts', async () => {
          expect(
            getGfsGrantSummary({
              resourceId: fixture.fileResourceId,
              subjectType: 'host',
              subjectId,
            })
          ).toBeNull()
          expect(
            getGfsGrantSummary({
              resourceId: fixture.fileResourceId,
              subjectType: 'host',
              subjectId: unrelatedSubjectId,
            })
          ).toBeNull()
          const grantedRun = await startNormalGfsPluginRun(page, progress => {
            runId = progress.runId
            childName = progress.childName
          })
          const unrelatedRun = await startNormalGfsPluginRun(
            page,
            progress => {
              unrelatedRunId = progress.runId
              unrelatedChildName = progress.childName
            },
            unrelatedRecipeName
          )
          return { pod: grantedRun.pod, unrelatedPod: unrelatedRun.pod }
        })
      const panel =
        await test.step('operator reaches the isolated file through visible Control UI navigation', () =>
          openGfsFilePanel(page, fixture))

      await exerciseGfsPluginEffectiveGrantJourney({
        fileResourceId: fixture.fileResourceId,
        fileUri: fixture.fileUri,
        initialContent: `E2E GFS file fixture: ${fixture.name}\n`,
        page,
        panel,
        pod,
        unrelatedPod,
        updatedContent: `normal third-party workflow updated ${fixture.fileName}`,
      })

      await test.step('workflow remains approval-held with zero delayed LLM or tool execution', () => {
        expect(runId).toBeTruthy()
        expect(childName).toBeTruthy()
        expectNormalGfsPluginRunHeld(runId!, childName!)
        expect(unrelatedRunId).toBeTruthy()
        expect(unrelatedChildName).toBeTruthy()
        expectNormalGfsPluginRunHeld(unrelatedRunId!, unrelatedChildName!, unrelatedRecipeName)
      })
    } finally {
      try {
        try {
          await cleanupNormalGfsPluginRun(runId, childName)
        } finally {
          await cleanupNormalGfsPluginRun(unrelatedRunId, unrelatedChildName, unrelatedRecipeName)
        }
      } finally {
        cleanupGfsWorkflowRecipeFixture(unrelatedRecipeName)
        cleanupGfsFixture(fixtureName)
        assertGfsFixtureCleaned(fixtureName)
        if (fixture) {
          expect(
            getGfsGrantSummary({
              resourceId: fixture.fileResourceId,
              subjectType: 'host',
              subjectId,
            })
          ).toBeNull()
          expect(
            getGfsGrantSummary({
              resourceId: fixture.fileResourceId,
              subjectType: 'host',
              subjectId: unrelatedSubjectId,
            })
          ).toBeNull()
        }
      }
    }
  })

  for (const targetHost of [
    'stateful',
    'stateless',
  ] as const satisfies readonly FirstPartyHostKey[]) {
    test(`first-party ${targetHost} Host consumes grants through its independent runtime identity`, async ({
      browserName,
      page,
    }) => {
      test.skip(
        browserName === 'firefox',
        'The effective in-cluster first-party Host isolation journey runs once in Chromium.'
      )
      test.setTimeout(600_000)

      const fixtureName = uniqueGfsFixtureName(`e2e-gfs-first-party-${targetHost}-grant`)
      let fixture: ReturnType<typeof seedGfsFileFixture> | undefined
      try {
        fixture = seedGfsFileFixture(fixtureName)
        const panel =
          await test.step('operator reaches the isolated file through visible Control UI navigation', () =>
            openGfsFilePanel(page, fixture))
        await exerciseGfsFirstPartyEffectiveGrantJourney({ fixture, page, panel, targetHost })
      } finally {
        cleanupGfsFixture(fixtureName)
        assertGfsFixtureCleaned(fixtureName)
        if (fixture) {
          for (const subjectId of ['1st:mcp-host/chatllm', '1st:mcp-host/chatllm-stateless']) {
            expect(
              getGfsGrantSummary({
                resourceId: fixture.fileResourceId,
                subjectType: 'host',
                subjectId,
              })
            ).toBeNull()
          }
        }
      }
    })
  }
})
