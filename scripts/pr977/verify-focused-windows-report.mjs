import { readFileSync } from 'node:fs'
import path from 'node:path'

const [reportPath, targetPath, caseManifestPath, progressPath] = process.argv.slice(2)
if (!reportPath || !targetPath || !caseManifestPath || !progressPath)
  throw new Error('Expected sanitized report, file manifest, case manifest, and progress paths')
const report = JSON.parse(readFileSync(reportPath, 'utf8'))
const targets = readFileSync(targetPath, 'utf8')
  .split(/\r?\n/)
  .map(value => value.trim().replaceAll('\\', '/'))
  .filter(Boolean)
if (targets.length === 0 || new Set(targets).size !== targets.length)
  throw new Error('Focused target manifest is empty or duplicated')
const caseManifest = JSON.parse(readFileSync(caseManifestPath, 'utf8'))
const selectedCases = caseManifest.selected
const deselectedCases = caseManifest.deselected
if (
  !Array.isArray(selectedCases) ||
  selectedCases.length === 0 ||
  !Array.isArray(deselectedCases) ||
  [...(selectedCases ?? []), ...(deselectedCases ?? [])].some(
    title => typeof title !== 'string' || title.length === 0
  ) ||
  new Set([...selectedCases, ...deselectedCases]).size !==
    selectedCases.length + deselectedCases.length
)
  throw new Error('Focused case manifest is empty, malformed, or duplicated')
if (report.counterConsistency?.valid !== true || report.success !== true)
  throw new Error('Focused Windows report is incomplete, inconsistent, or failed')
if (report.numFailedTests !== 0 || report.numTodoTests !== 0 || !Array.isArray(report.testResults))
  throw new Error('Focused Windows report contains failed, todo, or malformed results')

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
  const assertions = new Map(result.assertionResults.map(item => [item.title, item]))
  const expectedCases = [...selectedCases, ...deselectedCases]
  if (
    assertions.size !== result.assertionResults.length ||
    assertions.size !== expectedCases.length ||
    expectedCases.some(title => !assertions.has(title))
  )
    throw new Error(`Focused case inventory differs for ${path.basename(target)}`)
  for (const title of selectedCases) {
    if (assertions.get(title)?.status !== 'passed')
      throw new Error(`A required focused case did not pass: ${title}`)
  }
  for (const title of deselectedCases) {
    if (!['pending', 'skipped'].includes(assertions.get(title)?.status))
      throw new Error(
        `An intentionally deselected focused case was unexpectedly executed: ${title}`
      )
  }
}
if (files.size !== targets.length)
  throw new Error('Focused Windows report contains an unselected test file')
if (report.numTestFiles !== targets.length)
  throw new Error('Focused Windows test-file counter does not match the selected manifest')
if (
  report.numTotalTests !== selectedCases.length + deselectedCases.length ||
  report.numPassedTests !== selectedCases.length ||
  report.numPendingTests !== deselectedCases.length ||
  report.numFailedTests !== 0
)
  throw new Error('Focused Windows assertion counters do not match the selected case manifest')

const progressLines = readFileSync(progressPath, 'utf8').split(/\r?\n/).filter(Boolean)
const progress = progressLines.map(line => JSON.parse(line))
const cleanup = progress.filter(value => value?.event === 'plugin-acl-cleanup-phase')
const cleanupPhases = new Set([
  'cleanup-start',
  'enumeration-start',
  'enumeration-complete',
  'entry-file-delete-start',
  'entry-directory-delete-start',
  'entry-delete-complete',
  'directory-remove-complete',
  'cleanup-complete',
  'cleanup-failed',
])
const cleanupErrorCodes = new Set(['EBUSY', 'EACCES', 'EPERM', 'ENOTEMPTY', 'ENOENT', 'UNKNOWN'])
const cleanupKeys = new Set([
  'elapsedMs',
  'event',
  'activeFile',
  'activeCase',
  'activeHook',
  'lastCompletedOperation',
  'filesStarted',
  'filesCompleted',
  'casesCompleted',
  'passed',
  'failed',
  'skipped',
  'cleanupPhase',
  'cleanupOrdinal',
  'cleanupElapsedMs',
  'cleanupErrorCode',
])
if (
  cleanup.some(
    value =>
      Object.keys(value).some(key => !cleanupKeys.has(key)) ||
      !cleanupPhases.has(value.cleanupPhase) ||
      !Number.isSafeInteger(value.elapsedMs) ||
      value.elapsedMs < 0 ||
      !Number.isSafeInteger(value.cleanupOrdinal) ||
      value.cleanupOrdinal < 0 ||
      value.cleanupOrdinal > 10_000 ||
      !Number.isSafeInteger(value.cleanupElapsedMs) ||
      value.cleanupElapsedMs < 0 ||
      value.cleanupElapsedMs > 60_000 ||
      (value.cleanupErrorCode !== undefined && !cleanupErrorCodes.has(value.cleanupErrorCode))
  )
)
  throw new Error('Cleanup progress contains an unsafe or malformed record')
const countCleanupPhase = phase => cleanup.filter(value => value.cleanupPhase === phase).length
if (
  cleanup.length === 0 ||
  countCleanupPhase('cleanup-start') < selectedCases.length ||
  countCleanupPhase('enumeration-start') < selectedCases.length ||
  countCleanupPhase('enumeration-complete') < selectedCases.length ||
  countCleanupPhase('entry-file-delete-start') < 2 ||
  countCleanupPhase('entry-delete-complete') < 2 ||
  countCleanupPhase('directory-remove-complete') < selectedCases.length ||
  countCleanupPhase('cleanup-complete') < selectedCases.length ||
  countCleanupPhase('cleanup-failed') !== 0
)
  throw new Error('Focused cleanup phases are incomplete or contain a fatal failure')
process.stdout.write(
  `Focused Windows report verified: files=${files.size} selected=${selectedCases.length} ` +
    `passed=${report.numPassedTests} intentionally-deselected=${report.numPendingTests} failed=0\n`
)
