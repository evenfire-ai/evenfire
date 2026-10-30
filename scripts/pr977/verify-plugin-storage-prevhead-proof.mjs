import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export function verifyPreviousHeadReport(report) {
  if (
    report?.success !== false ||
    report?.counterConsistency?.valid !== true ||
    report?.numTestFiles !== 1 ||
    report?.numTotalTests !== 2 ||
    report?.numPassedTests !== 0 ||
    report?.numFailedTests !== 2 ||
    report?.numPendingTests !== 0 ||
    !Array.isArray(report.testResults) ||
    report.testResults.length !== 1
  ) {
    throw new Error('Previous-head proof report is incomplete or does not contain one failure')
  }
  const file = report.testResults[0]
  const expectedTitles = new Set([
    'rejects a new audit append after an unsafe DACL is added',
    'refuses to trust an existing consent grant after an unsafe DACL is added',
  ])
  if (file?.status !== 'failed' || file?.failure?.phase !== 'test') {
    throw new Error('Previous-head proof did not fail at the intended privacy assertion')
  }
  const assertions = file?.assertionResults ?? []
  if (
    assertions.length !== expectedTitles.size ||
    assertions.some(
      assertion =>
        assertion.status !== 'failed' ||
        !expectedTitles.delete(assertion.title) ||
        assertion.failure?.phase !== 'test' ||
        assertion.failure?.category !== 'assertion' ||
        assertion.failure?.errorType !== 'AssertionError' ||
        assertion.failure?.failedHooks?.length !== 0
    ) ||
    expectedTitles.size !== 0
  ) {
    throw new Error('Previous-head proof did not fail at both intended privacy assertions')
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  const reportPath = process.argv[2]
  if (!reportPath) throw new Error('Expected a sanitized previous-head report path')
  verifyPreviousHeadReport(JSON.parse(readFileSync(reportPath, 'utf8')))
  process.stdout.write('Previous-head assertion-red verified for consent and audit privacy.\n')
}
