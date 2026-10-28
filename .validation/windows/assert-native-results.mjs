import fs from 'node:fs'
import path from 'node:path'

const reportPath = process.argv[2]
if (!reportPath) throw new Error('Vitest JSON report path is required')

const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'))
const requiredFiles = [
  'windowsSessionAuthorityAcl.native.test.ts',
  'windowsSessionAuthorityAcl.launch.test.ts',
  'windowsSessionAuthorityDurableFileOps.native.test.ts',
  'windowsSessionAuthorityFileOps.launch.test.ts',
]

if (!Array.isArray(report.testResults) || report.numTotalTests < 1 || report.numPassedTests < 1) {
  throw new Error('Required Windows validation produced no executed test cases')
}
if (report.numFailedTests !== 0 || report.numPendingTests !== 0 || report.numTodoTests !== 0) {
  throw new Error('Required Windows validation contains failed, skipped, or todo test cases')
}

for (const file of requiredFiles) {
  const matching = report.testResults.filter(result => {
    const normalized = String(result.name).replaceAll('\\', '/')
    return normalized.endsWith(`/src/__tests__/${file}`)
  })
  if (matching.length !== 1) {
    throw new Error(`Required native test file did not execute exactly once: ${file}`)
  }

  const [result] = matching
  const assertions = Array.isArray(result.assertionResults) ? result.assertionResults : []
  if (result.status !== 'passed' || assertions.length === 0) {
    throw new Error(`Required native test file did not pass executed assertions: ${file}`)
  }
  if (assertions.some(assertion => assertion.status !== 'passed')) {
    const failures = assertions
      .filter(assertion => assertion.status !== 'passed')
      .map(assertion => {
        const title = [...(assertion.ancestorTitles ?? []), assertion.title].join(' > ')
        return `${path.basename(file)}: ${title} [${assertion.status}]`
      })
    throw new Error(failures.join('\n'))
  }

  console.log(`${file}: ${assertions.length} assertions passed; none skipped`)
}

console.log(
  `Windows native evidence totals: ${report.numPassedTests} passed, ` +
    `${report.numFailedTests} failed, ${report.numPendingTests} skipped`
)
