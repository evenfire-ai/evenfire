import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  focusedCaseCount,
  validateFocusedManifest as validateFocusedPlan,
} from './focused-windows-plan.mjs'

const EXPECTED_TARGET = 'src/__tests__/pluginStorageWindowsAcl.native.test.ts'
const CLEANUP_PHASES = new Set([
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
const CLEANUP_ERROR_CODES = new Set(['EBUSY', 'EACCES', 'EPERM', 'ENOTEMPTY', 'ENOENT', 'UNKNOWN'])
const CLEANUP_KEYS = new Set([
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
const REPORTER_EVENTS = new Set([
  'file-queued',
  'file-started',
  'file-completed',
  'case-started',
  'case-completed',
  'hook-started',
  'hook-completed',
  'run-completed',
])
const REPORTER_KEYS = new Set([
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
  'caseStatus',
  'runReason',
])
const HOOK_NAMES = new Set(['beforeAll', 'beforeEach', 'afterEach', 'afterAll', 'unknown-hook'])

function fail(message) {
  throw new Error(message)
}

export function validateFocusedManifest(manifest) {
  try {
    return validateFocusedPlan(manifest)
  } catch (error) {
    fail(error.message)
  }
}

export function validateCleanupProgress(cleanup, selectedCount, maximumRuntimeMs) {
  let session = null
  let completedSessions = 0
  let fileDeleteStarts = 0
  for (const value of cleanup) {
    if (
      Object.keys(value).some(key => !CLEANUP_KEYS.has(key)) ||
      !CLEANUP_PHASES.has(value.cleanupPhase) ||
      !Number.isSafeInteger(value.elapsedMs) ||
      value.elapsedMs < 0 ||
      value.elapsedMs > maximumRuntimeMs ||
      !Number.isSafeInteger(value.cleanupOrdinal) ||
      value.cleanupOrdinal < 0 ||
      value.cleanupOrdinal > 10_000 ||
      !Number.isSafeInteger(value.cleanupElapsedMs) ||
      value.cleanupElapsedMs < 0 ||
      value.cleanupElapsedMs > 60_000 ||
      (value.cleanupErrorCode !== undefined &&
        (!CLEANUP_ERROR_CODES.has(value.cleanupErrorCode) ||
          value.cleanupPhase !== 'cleanup-failed')) ||
      value.activeFile !== EXPECTED_TARGET.split('/').at(-1) ||
      value.activeCase !== null ||
      value.activeHook !== 'afterEach' ||
      value.lastCompletedOperation !== value.cleanupPhase ||
      ['filesStarted', 'filesCompleted', 'casesCompleted', 'passed', 'failed', 'skipped'].some(
        key => !Number.isSafeInteger(value[key]) || value[key] < 0 || value[key] > 10_000
      )
    ) {
      fail('Cleanup progress contains an unsafe or malformed record')
    }
    if (value.cleanupPhase === 'cleanup-failed') fail('Focused cleanup reported a fatal failure')
    if (value.cleanupPhase === 'cleanup-start') {
      if (session || value.cleanupOrdinal !== 0)
        fail('Focused cleanup sessions overlap or have an invalid start ordinal')
      session = {
        enumerations: new Set(),
        completedEnumerations: new Set(),
        deletes: new Set(),
        removed: false,
      }
      continue
    }
    if (!session) fail('Focused cleanup phase appeared outside a cleanup session')
    if (value.cleanupPhase === 'enumeration-start') {
      if (session.enumerations.has(value.cleanupOrdinal))
        fail('Focused cleanup duplicated an enumeration ordinal')
      session.enumerations.add(value.cleanupOrdinal)
    } else if (value.cleanupPhase === 'enumeration-complete') {
      if (
        !session.enumerations.has(value.cleanupOrdinal) ||
        session.completedEnumerations.has(value.cleanupOrdinal)
      )
        fail('Focused cleanup completed an unstarted or duplicated enumeration')
      session.completedEnumerations.add(value.cleanupOrdinal)
    } else if (
      value.cleanupPhase === 'entry-file-delete-start' ||
      value.cleanupPhase === 'entry-directory-delete-start'
    ) {
      if (session.deletes.has(value.cleanupOrdinal))
        fail('Focused cleanup duplicated a delete ordinal')
      session.deletes.add(value.cleanupOrdinal)
      if (value.cleanupPhase === 'entry-file-delete-start') fileDeleteStarts += 1
    } else if (value.cleanupPhase === 'entry-delete-complete') {
      if (!session.deletes.has(value.cleanupOrdinal))
        fail('Focused cleanup completed an unstarted deletion')
      session.deletes.delete(value.cleanupOrdinal)
    } else if (value.cleanupPhase === 'directory-remove-complete') {
      if (session.removed) fail('Focused cleanup removed its fixture directory more than once')
      session.removed = true
    } else if (value.cleanupPhase === 'cleanup-complete') {
      if (
        session.enumerations.size === 0 ||
        session.enumerations.size !== session.completedEnumerations.size ||
        session.deletes.size !== 0 ||
        !session.removed
      ) {
        fail('Focused cleanup session is incomplete')
      }
      completedSessions += 1
      session = null
    }
  }
  if (session || completedSessions !== selectedCount || fileDeleteStarts < 2)
    fail('Focused cleanup phases are incomplete or contain a fatal failure')
  return { completedSessions, fileDeleteStarts, phases: cleanup.length }
}

function validateReporterProgress(progress, manifest, maximumRuntimeMs, selectedCount) {
  const totalCases = focusedCaseCount(manifest)
  const caseTitles = new Set([...manifest.selected, ...manifest.deselected])
  const reporterProgress = progress.filter(value => value?.event !== 'plugin-acl-cleanup-phase')
  for (const value of reporterProgress) {
    if (
      Object.keys(value).some(key => !REPORTER_KEYS.has(key)) ||
      !REPORTER_EVENTS.has(value.event) ||
      !Number.isSafeInteger(value.elapsedMs) ||
      value.elapsedMs < 0 ||
      value.elapsedMs > maximumRuntimeMs ||
      (value.activeFile !== null && value.activeFile !== EXPECTED_TARGET.split('/').at(-1)) ||
      (value.activeCase !== null && !caseTitles.has(value.activeCase)) ||
      (value.activeHook !== null && !HOOK_NAMES.has(value.activeHook)) ||
      !Number.isSafeInteger(value.filesStarted) ||
      !Number.isSafeInteger(value.filesCompleted) ||
      !Number.isSafeInteger(value.casesCompleted) ||
      !Number.isSafeInteger(value.passed) ||
      !Number.isSafeInteger(value.failed) ||
      !Number.isSafeInteger(value.skipped) ||
      [
        value.filesStarted,
        value.filesCompleted,
        value.casesCompleted,
        value.passed,
        value.failed,
        value.skipped,
      ].some(counter => counter < 0 || counter > 10_000) ||
      (value.caseStatus !== undefined &&
        (value.event !== 'case-completed' ||
          !['passed', 'failed', 'skipped', 'pending', 'unknown'].includes(value.caseStatus))) ||
      (value.runReason !== undefined &&
        (value.event !== 'run-completed' ||
          !['passed', 'failed', 'interrupted', 'unknown'].includes(value.runReason))) ||
      (value.event === 'run-completed' && value.lastCompletedOperation !== 'run-completed') ||
      ![
        'run-created',
        'case-completed',
        'file-completed',
        'run-completed',
        'beforeAll-completed',
        'beforeEach-completed',
        'afterEach-completed',
        'afterAll-completed',
        'unknown-hook-completed',
      ].includes(value.lastCompletedOperation)
    ) {
      fail('Reporter progress contains an unsafe or malformed record')
    }
  }
  const terminal = reporterProgress.at(-1)
  if (
    terminal?.event !== 'run-completed' ||
    terminal.runReason !== 'passed' ||
    terminal.filesStarted !== 1 ||
    terminal.filesCompleted !== 1 ||
    terminal.casesCompleted !== totalCases ||
    terminal.passed !== selectedCount ||
    terminal.failed !== 0 ||
    terminal.skipped !== totalCases - selectedCount
  ) {
    fail('Reporter progress has no complete final run record')
  }
  return terminal
}

function parseJson(filePath, description) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'))
  } catch {
    fail(`${description} is missing or malformed`)
  }
}

export function verifyFocusedProcess({
  reportPath,
  targetPath,
  caseManifestPath,
  progressPath,
  statusPath,
  identityPath,
  processId,
  outputPath,
  expectedSourceSha = process.env.PR977_SOURCE_SHA,
  expectedHarnessSha = process.env.GITHUB_SHA,
}) {
  if (
    !reportPath ||
    !targetPath ||
    !caseManifestPath ||
    !progressPath ||
    !statusPath ||
    !identityPath
  )
    fail('Expected report, target, case, progress, watchdog, and identity artifacts')
  const manifest = validateFocusedManifest(parseJson(caseManifestPath, 'Focused case manifest'))
  const process = manifest.processes.find(value => value.id === processId)
  if (!process) fail('Focused process identifier is missing or unexpected')
  const identity = parseJson(identityPath, 'Focused source identity')
  if (
    !/^[a-f0-9]{40}$/.test(expectedSourceSha ?? '') ||
    !/^[a-f0-9]{40}$/.test(expectedHarnessSha ?? '') ||
    identity.sourceSha !== expectedSourceSha ||
    identity.harnessSha !== expectedHarnessSha ||
    identity.expectedSourceSha !== expectedSourceSha ||
    identity.expectedHarnessSha !== expectedHarnessSha
  ) {
    fail('Focused report source or harness SHA does not match the exact pinned revisions')
  }
  const targets = readFileSync(targetPath, 'utf8')
    .split(/\r?\n/)
    .map(value => value.trim().replaceAll('\\', '/'))
    .filter(Boolean)
  if (targets.length !== 1 || targets[0] !== EXPECTED_TARGET)
    fail('Focused file manifest must select exactly the native plugin DACL test')

  const report = parseJson(reportPath, 'Sanitized Vitest report')
  if (report.counterConsistency?.valid !== true || report.success !== true)
    fail('Focused Windows report is incomplete, inconsistent, or failed')
  if (
    report.numFailedTests !== 0 ||
    report.numTodoTests !== 0 ||
    !Array.isArray(report.testResults)
  ) {
    fail('Focused Windows report contains failed, todo, or malformed results')
  }

  const files = new Map()
  for (const result of report.testResults) {
    const name = String(result.name).replaceAll('\\', '/')
    if (files.has(name)) fail(`Focused report duplicated a test file: ${path.basename(name)}`)
    files.set(name, result)
  }
  if (files.size !== 1 || !files.has(EXPECTED_TARGET))
    fail('Focused report contains an omitted or unexpected test file')
  const file = files.get(EXPECTED_TARGET)
  if (file.status !== 'passed' || !Array.isArray(file.assertionResults))
    fail('Focused native test file failed or did not execute')
  const assertions = new Map(file.assertionResults.map(item => [item.title, item]))
  const expectedCases = [...manifest.selected, ...manifest.deselected]
  if (
    assertions.size !== file.assertionResults.length ||
    assertions.size !== expectedCases.length ||
    expectedCases.some(title => !assertions.has(title))
  ) {
    fail('Focused case inventory is missing, duplicated, or contains unexpected cases')
  }
  const processCases = new Set(process.selected)
  for (const title of manifest.selected) {
    const status = assertions.get(title)?.status
    const valid = processCases.has(title)
      ? status === 'passed'
      : ['pending', 'skipped'].includes(status)
    if (!valid) {
      fail(`A required focused case has an invalid process status: ${title}`)
    }
  }
  for (const title of manifest.deselected) {
    if (!['pending', 'skipped'].includes(assertions.get(title)?.status)) {
      fail(`An intentionally deselected case was unexpectedly executed: ${title}`)
    }
  }
  const selectedCount = process.selected.length
  const totalCases = focusedCaseCount(manifest)
  if (
    report.numTestFiles !== 1 ||
    report.numTotalTests !== totalCases ||
    report.numPassedTests !== selectedCount ||
    report.numPendingTests !== totalCases - selectedCount ||
    report.numFailedTests !== 0
  ) {
    fail('Focused report counters do not match this process selection')
  }

  const progress = readFileSync(progressPath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => JSON.parse(line))
  const terminalProgress = validateReporterProgress(
    progress,
    manifest,
    process.maximumRuntimeMs,
    selectedCount
  )
  if (
    !terminalProgress ||
    terminalProgress.filesStarted !== 1 ||
    terminalProgress.filesCompleted !== 1 ||
    terminalProgress.casesCompleted !== totalCases ||
    terminalProgress.passed !== selectedCount ||
    terminalProgress.failed !== 0 ||
    terminalProgress.skipped !== totalCases - selectedCount
  ) {
    fail('Focused progress counters or completion marker are incomplete')
  }

  const status = parseJson(statusPath, 'Watchdog status')
  if (
    status.outcome !== 'completed' ||
    status.exitCode !== 0 ||
    status.signal !== null ||
    !Number.isSafeInteger(status.elapsedMs) ||
    status.elapsedMs < 1 ||
    status.elapsedMs > process.maximumRuntimeMs ||
    status.lastProgress?.event !== 'run-completed' ||
    status.lastProgress?.casesCompleted !== totalCases ||
    status.lastProgress?.passed !== selectedCount ||
    status.lastProgress?.failed !== 0 ||
    status.lastProgress?.skipped !== totalCases - selectedCount
  ) {
    fail('Focused process failed, timed out, or lacks complete watchdog evidence')
  }

  const cleanup = progress.filter(value => value?.event === 'plugin-acl-cleanup-phase')
  const cleanupSummary = validateCleanupProgress(cleanup, selectedCount, process.maximumRuntimeMs)

  const result = {
    processId,
    sourceSha: identity.sourceSha,
    harnessSha: identity.harnessSha,
    elapsedMs: status.elapsedMs,
    selected: process.selected,
    passed: selectedCount,
    skippedInProcess: totalCases - selectedCount,
    intentionallyDeselectedSkipped: manifest.deselected.length,
    deferredRequiredCasesSkipped: manifest.selected.length - selectedCount,
    cleanupPhases: cleanupSummary.phases,
  }
  if (outputPath) writeFileSync(outputPath, `${JSON.stringify(result)}\n`)
  return result
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [
    reportPath,
    targetPath,
    caseManifestPath,
    progressPath,
    statusPath,
    identityPath,
    processId,
    outputPath,
  ] = process.argv.slice(2)
  const verified = verifyFocusedProcess({
    reportPath,
    targetPath,
    caseManifestPath,
    progressPath,
    statusPath,
    identityPath,
    processId,
    outputPath,
  })
  process.stdout.write(
    `Focused process verified: id=${verified.processId} selected=${verified.passed} ` +
      `elapsed-ms=${verified.elapsedMs} cleanup-phases=${verified.cleanupPhases}\n`
  )
}
