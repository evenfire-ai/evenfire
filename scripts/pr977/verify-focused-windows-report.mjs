import { readFileSync } from 'node:fs'
import path from 'node:path'

const [reportPath, targetPath] = process.argv.slice(2)
if (!reportPath || !targetPath)
  throw new Error('Expected sanitized report and target manifest paths')
const report = JSON.parse(readFileSync(reportPath, 'utf8'))
const targets = readFileSync(targetPath, 'utf8')
  .split(/\r?\n/)
  .map(value => value.trim().replaceAll('\\', '/'))
  .filter(Boolean)
if (targets.length === 0 || new Set(targets).size !== targets.length)
  throw new Error('Focused target manifest is empty or duplicated')
if (report.counterConsistency?.valid !== true || report.success !== true)
  throw new Error('Focused Windows report is incomplete, inconsistent, or failed')
if (report.numFailedTests !== 0 || report.numTodoTests !== 0 || !Array.isArray(report.testResults))
  throw new Error('Focused Windows report contains failed, todo, or malformed results')

const expectedSkips = new Map([
  [
    'src/__tests__/tokenStore.fallbackRetirement.regression.test.ts',
    new Set(['requires a durable directory sync on retry after a prior unlink succeeded']),
  ],
  ['src/__tests__/pluginAuditLog.test.ts', new Set(['writes the file with POSIX mode 0600'])],
  ['src/__tests__/pluginConsentStore.test.ts', new Set(['writes the file with POSIX mode 0600'])],
])
const files = new Map()
for (const result of report.testResults) {
  const name = String(result.name).replaceAll('\\', '/')
  if (files.has(name))
    throw new Error(`Focused Windows report duplicated a test file: ${path.basename(name)}`)
  files.set(name, result)
}
for (const target of targets) {
  const result = files.get(target)
  if (!result || result.status !== 'passed')
    throw new Error(
      `Focused Windows report omitted or failed a required file: ${path.basename(target)}`
    )
  if (!Array.isArray(result.assertionResults) || result.assertionResults.length === 0)
    throw new Error(`Focused Windows test file executed no cases: ${path.basename(target)}`)
  for (const assertion of result.assertionResults ?? []) {
    if (assertion.status === 'passed') continue
    const allowed = expectedSkips.get(target)
    if (assertion.status !== 'skipped' || !allowed?.has(assertion.title))
      throw new Error(
        `Focused Windows report has an unexpected skip/failure in ${path.basename(target)}`
      )
  }
  const observed = (result.assertionResults ?? [])
    .filter(assertion => assertion.status === 'skipped')
    .map(assertion => assertion.title)
  const expected = [...(expectedSkips.get(target) ?? [])]
  if (observed.length !== expected.length || expected.some(title => !observed.includes(title)))
    throw new Error(`Focused Windows skip inventory differs for ${path.basename(target)}`)
}
if (files.size !== targets.length)
  throw new Error('Focused Windows report contains an unselected test file')
if (report.numTestFiles !== targets.length)
  throw new Error('Focused Windows test-file counter does not match the selected manifest')
process.stdout.write(
  `Focused Windows report verified: files=${files.size} tests=${report.numTotalTests} ` +
    `passed=${report.numPassedTests} skipped=${report.numPendingTests} failed=0\n`
)
