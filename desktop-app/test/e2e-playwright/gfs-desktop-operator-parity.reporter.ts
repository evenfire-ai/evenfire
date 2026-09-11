import type {
  FullConfig,
  FullResult,
  Reporter,
  TestCase,
  TestResult,
} from '@playwright/test/reporter'
import fs from 'node:fs'
import {
  type GfsOperatorScenarioResult,
  evaluateGfsOperatorScenarioResults,
  gfsOperatorResultSummaryPath,
  gfsOperatorRuntimeEvidencePath,
  requireGfsOperatorRunId,
  scenarioIdFromTitle,
  writeJsonAtomically,
} from './gfsDesktopOperatorParityContract'

export default class GfsDesktopOperatorParityReporter implements Reporter {
  private readonly results: GfsOperatorScenarioResult[] = []
  private configurationErrors: string[] = []

  onBegin(config: FullConfig): void {
    if (config.workers !== 1) {
      this.configurationErrors.push(`workers must be 1; received ${config.workers}`)
    }
    if (config.projects.some(project => project.retries !== 0)) {
      this.configurationErrors.push('retries must be 0 for every project')
    }
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    const id = scenarioIdFromTitle(test.title)
    if (!id) return
    this.results.push({
      id,
      status: result.status,
      title: test.titlePath().join(' > '),
    })
  }

  async onEnd(result: FullResult): Promise<{ status: 'failed' } | void> {
    let runId: string
    try {
      runId = requireGfsOperatorRunId()
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(error)
      return { status: 'failed' }
    }

    const runtimeEvidencePath = gfsOperatorRuntimeEvidencePath(runId)
    const verdict = evaluateGfsOperatorScenarioResults(
      this.results,
      fs.existsSync(runtimeEvidencePath)
    )
    const errors = [...this.configurationErrors, ...verdict.errors]
    if (result.status !== 'passed') {
      errors.push(`Playwright ended with status=${result.status}`)
    }
    const ok = errors.length === 0
    writeJsonAtomically(gfsOperatorResultSummaryPath(runId), {
      schemaVersion: 1,
      suite: 'gfs-desktop-operator-parity',
      runId,
      completedAt: new Date().toISOString(),
      playwrightStatus: result.status,
      ok,
      errors,
      totals: {
        required: verdict.required,
        observed: verdict.observed,
        passed: verdict.passed,
        failed: verdict.failed,
        skipped: verdict.skipped,
      },
      scenarios: this.results,
      runtimeEvidencePath,
    })

    if (!ok) {
      // eslint-disable-next-line no-console
      console.error(`[GFS-OPERATOR-E2E] FAIL-LOUD: ${errors.join('; ')}`)
      return { status: 'failed' }
    }
    // eslint-disable-next-line no-console
    console.log(
      `[GFS-OPERATOR-E2E] PASS ${verdict.passed}/${verdict.required} required scenarios · run=${runId}`
    )
  }

  printsToStdio(): boolean {
    return true
  }
}
