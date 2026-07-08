import { type Page, expect, test } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { WorkflowRunArtifact, WorkflowRunListItem } from '../../src/types'
import {
  E2E_EMAIL,
  RECIPE_NS,
  cleanupRecipeRuntimeState,
  clearSession,
  launchAndLogin,
  loginAs,
  openWorkflowsPage,
  rendererListWorkflowRuns,
  rendererListWorkflows,
  rendererReadWorkflow,
  seedAllowlist,
  selectWorkflow,
  shortRunId,
  waitForNewRun,
} from './workflowUi'

const RECIPE_CRON = 'e2e-scheduled-recipe'
const EXPECTED_ARTIFACT = 'weekly-summary-report.pdf'

async function rendererListWorkflowRunArtifacts(
  page: Page,
  runId: string
): Promise<WorkflowRunArtifact[]> {
  const result = await page.evaluate(
    ([recipeNs, recipeName, recipeRunId]) => {
      return (window as any).clerum.workflows.listRunArtifacts(recipeNs, recipeName, recipeRunId)
    },
    [RECIPE_NS, RECIPE_CRON, runId]
  )
  return Array.isArray(result?.artifacts) ? result.artifacts : []
}

async function waitForSucceededRunWithArtifact(
  page: Page,
  runId: string
): Promise<WorkflowRunListItem> {
  let latestRun: WorkflowRunListItem | undefined

  await expect
    .poll(
      async () => {
        const runs = await rendererListWorkflowRuns(page, RECIPE_NS, RECIPE_CRON, 20)
        latestRun = runs.items.find(item => item.id === runId)
        if (!latestRun) return 'missing'
        if (latestRun.phase !== 'Succeeded') return latestRun.phase
        const artifacts = await rendererListWorkflowRunArtifacts(page, runId)
        latestRun = { ...latestRun, artifacts }
        return artifacts.some(artifact => artifact.name === EXPECTED_ARTIFACT)
          ? 'ready'
          : 'missing-artifact'
      },
      {
        timeout: 420_000,
        intervals: [1_000, 2_000, 5_000],
        message: `${RECIPE_CRON} run should succeed and expose ${EXPECTED_ARTIFACT}`,
      }
    )
    .toBe('ready')

  if (!latestRun) throw new Error(`run ${runId} was not visible`)
  return latestRun
}

async function downloadArtifactFromDesktopRun(page: Page, runId: string): Promise<void> {
  await page.getByRole('button', { name: /^refresh$/i }).click()
  const runRow = page.locator('.workflow-run-row').filter({ hasText: shortRunId(runId) })
  await expect(runRow).toBeVisible({ timeout: 30_000 })
  const artifactButton = runRow.getByRole('button', { name: EXPECTED_ARTIFACT })
  await expect(artifactButton).toBeVisible({ timeout: 30_000 })

  const expectedFilename = `${shortRunId(runId)}-${EXPECTED_ARTIFACT}`
  const downloadPath = path.join(os.homedir(), 'Downloads', expectedFilename)
  fs.rmSync(downloadPath, { force: true })

  await artifactButton.click()
  await expect
    .poll(
      () => {
        if (!fs.existsSync(downloadPath)) return 0
        return fs.statSync(downloadPath).size
      },
      {
        timeout: 30_000,
        intervals: [250, 500, 1_000],
        message: `Desktop App should save ${expectedFilename} to Downloads`,
      }
    )
    .toBeGreaterThan(0)

  const header = fs.readFileSync(downloadPath).subarray(0, 4).toString('utf8')
  fs.rmSync(downloadPath, { force: true })
  expect(header).toBe('%PDF')
}

test('agentic workflow fixture can be triggered and its run artifact downloaded from desktop', async () => {
  await clearSession()

  const auth = await loginAs(E2E_EMAIL)
  seedAllowlist(auth.userId, RECIPE_CRON)
  cleanupRecipeRuntimeState(RECIPE_CRON)

  const { app, page } = await launchAndLogin()

  try {
    await openWorkflowsPage(page)

    const workflows = await rendererListWorkflows(page)
    expect(workflows.items.some(item => item.metadata?.name === RECIPE_CRON)).toBe(true)

    const recipe = await rendererReadWorkflow(page, RECIPE_NS, RECIPE_CRON)
    const spec = (recipe.spec || {}) as Record<string, unknown>
    const triggers = (spec.triggers || {}) as Record<string, unknown>
    expect(triggers.onDemand).toBeTruthy()

    const detailCard = await selectWorkflow(page, RECIPE_CRON, RECIPE_NS)
    await expect(detailCard.getByRole('button', { name: 'Trigger' })).toBeVisible()
    await expect(detailCard.getByRole('button', { name: 'Refresh' })).toBeVisible()
    await expect(detailCard.getByRole('heading', { name: 'Recent Runs' })).toBeVisible()

    const runsBefore = await rendererListWorkflowRuns(page, RECIPE_NS, RECIPE_CRON, 20)
    await detailCard.getByRole('button', { name: /^trigger$/i }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Workflow triggered.' })).toBeVisible({
      timeout: 10_000,
    })

    const run = await waitForNewRun(
      page,
      RECIPE_NS,
      RECIPE_CRON,
      runsBefore.items.map(item => item.id),
      60_000
    )
    const completedRun = await waitForSucceededRunWithArtifact(page, run.id)
    expect(completedRun.artifacts?.map(artifact => artifact.name)).toContain(EXPECTED_ARTIFACT)
    await downloadArtifactFromDesktopRun(page, run.id)
  } finally {
    await app.close()
  }
})
