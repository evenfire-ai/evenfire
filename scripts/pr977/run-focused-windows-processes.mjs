import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  executeFocusedSequence,
  focusedTestNamePattern,
  validateFocusedManifest,
} from './focused-windows-plan.mjs'
import { verifyFocusedProcess } from './verify-focused-windows-report.mjs'
import diagnostics from './windows-native-spawn-observer.cjs'

const { validateEnvironmentFingerprint, validateNativeHelperAttempt } = diagnostics

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options })
  if (result.error)
    throw new Error(`Could not start ${path.basename(command)}: ${result.error.code}`)
  return result
}

function readRevision(repositoryPath) {
  return execFileSync('git', ['-C', repositoryPath, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim()
}

async function main() {
  const desktopRoot = process.cwd()
  const sourceRoot = path.resolve(desktopRoot, '..')
  const validationRoot = path.resolve(desktopRoot, '../../validation')
  const scriptRoot = path.dirname(fileURLToPath(import.meta.url))
  const manifestPath = path.join(validationRoot, '.validation/windows/focused-test-cases.json')
  const targetPath = path.join(validationRoot, '.validation/windows/focused-test-target.txt')
  const manifest = validateFocusedManifest(JSON.parse(readFileSync(manifestPath, 'utf8')))
  const expectedSourceSha = process.env.PR977_SOURCE_SHA
  const expectedHarnessSha = process.env.GITHUB_SHA
  const sourceSha = readRevision(sourceRoot)
  const harnessSha = readRevision(validationRoot)
  if (
    !/^[a-f0-9]{40}$/.test(expectedSourceSha ?? '') ||
    !/^[a-f0-9]{40}$/.test(expectedHarnessSha ?? '') ||
    sourceSha !== expectedSourceSha ||
    harnessSha !== expectedHarnessSha
  ) {
    throw new Error('Focused orchestration refused mismatched application or harness revisions')
  }

  const artifactRoot = process.env.RUNNER_TEMP
    ? path.join(process.env.RUNNER_TEMP, 'pr977-focused')
    : process.env.PR977_ARTIFACT_ROOT
  if (!artifactRoot || !path.isAbsolute(artifactRoot))
    throw new Error('Focused artifact root is missing or not absolute')
  mkdirSync(artifactRoot, { recursive: true })
  const identityPath = path.join(artifactRoot, 'source-identity.json')
  const fingerprintPath = path.join(artifactRoot, 'environment-fingerprint.json')
  const helperAttemptsPath = path.join(artifactRoot, 'native-helper-load-attempts.jsonl')
  let fingerprint
  try {
    fingerprint = validateEnvironmentFingerprint(
      JSON.parse(readFileSync(fingerprintPath, 'utf8')),
      sourceSha,
      harnessSha
    )
  } catch {
    throw new Error(
      'Focused orchestration refused a missing or invalid Windows environment fingerprint'
    )
  }
  if (
    !fingerprint.runtimeProbeSucceeded ||
    !fingerprint.nativeHelper.preparationSucceeded ||
    !existsSync(helperAttemptsPath)
  ) {
    throw new Error('Focused orchestration refused incomplete native environment diagnostics')
  }
  writeFileSync(
    identityPath,
    `${JSON.stringify({
      sourceSha,
      harnessSha,
      expectedSourceSha,
      expectedHarnessSha,
    })}\n`
  )

  const vitest = path.join(desktopRoot, 'node_modules/vitest/vitest.mjs')
  const watchdog = path.join(scriptRoot, 'run-vitest-with-watchdog.mjs')
  const sanitizer = path.join(scriptRoot, 'sanitize-windows-vitest-report.mjs')
  const reporter = path.join(scriptRoot, 'windows-diagnostic-reporter.mjs')
  const spawnObserver = path.join(scriptRoot, 'windows-native-spawn-observer.cjs')
  const selectedTarget = readFileSync(targetPath, 'utf8').trim()
  const summary = await executeFocusedSequence(manifest, async processSpec => {
    const previousAttemptCount = readFileSync(helperAttemptsPath, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean).length
    const processDirectory = path.join(artifactRoot, `process-${processSpec.id}`)
    mkdirSync(processDirectory, { recursive: true })
    const progressPath = path.join(processDirectory, 'progress.jsonl')
    const statusPath = path.join(processDirectory, 'watchdog-status.json')
    const rawReportPath = path.join(processDirectory, 'vitest-raw.json')
    const reportPath = path.join(processDirectory, 'focused-report.json')
    const verifiedPath = path.join(processDirectory, 'verified-result.json')
    const testArgs = [
      vitest,
      'run',
      '--testTimeout=120000',
      '--hookTimeout=30000',
      '--maxWorkers=1',
      '--no-file-parallelism',
      '--retry=0',
      `--reporter=${reporter}`,
      `--outputFile.json=${rawReportPath}`,
      '--testNamePattern',
      focusedTestNamePattern(processSpec),
      selectedTarget,
    ]
    const runner = runCommand(
      process.execPath,
      [
        watchdog,
        `--maximum-runtime-ms=${processSpec.maximumRuntimeMs}`,
        `--no-progress-ms=${processSpec.noProgressMs}`,
        `--progress=${progressPath}`,
        `--status=${statusPath}`,
        '--',
        process.execPath,
        ...testArgs,
      ],
      {
        cwd: desktopRoot,
        env: {
          ...process.env,
          PR977_DESKTOP_ROOT: desktopRoot,
          PR977_FOCUSED_PROCESS_ID: processSpec.id,
          PR977_NATIVE_LOAD_ATTEMPTS_PATH: helperAttemptsPath,
          NODE_OPTIONS: [process.env.NODE_OPTIONS?.trim(), `--require="${spawnObserver}"`]
            .filter(Boolean)
            .join(' '),
        },
        stdio: 'inherit',
      }
    )

    let sanitizeStatus = null
    if (existsSync(rawReportPath)) {
      const sanitized = runCommand(process.execPath, [sanitizer, rawReportPath, reportPath], {
        cwd: desktopRoot,
        stdio: 'inherit',
      })
      sanitizeStatus = sanitized.status
    }
    if (runner.status !== 0) {
      let watchdogReason = 'status-missing'
      if (existsSync(statusPath)) {
        try {
          const status = JSON.parse(readFileSync(statusPath, 'utf8'))
          watchdogReason = `${status.outcome}:${status.reason ?? status.signal ?? 'none'}`
        } catch {
          watchdogReason = 'status-malformed'
        }
      }
      throw new Error(
        `Focused ${processSpec.id} process failed (exit=${runner.status ?? 'null'}; ` +
          `signal=${runner.signal ?? 'none'}; watchdog=${watchdogReason}); artifacts retained`
      )
    }
    if (sanitizeStatus !== 0 || !existsSync(reportPath))
      throw new Error(`Focused ${processSpec.id} report is missing or could not be sanitized`)

    const verified = verifyFocusedProcess({
      reportPath,
      targetPath,
      caseManifestPath: manifestPath,
      progressPath,
      statusPath,
      identityPath,
      processId: processSpec.id,
      outputPath: verifiedPath,
      expectedSourceSha,
      expectedHarnessSha,
    })
    const attempts = readFileSync(helperAttemptsPath, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map(line => {
        try {
          return JSON.parse(line)
        } catch {
          throw new Error('Native helper diagnostics contain a malformed attempt record')
        }
      })
    if (
      attempts.length > 256 ||
      attempts.some(value => {
        const processId = value?.processId
        return (
          !['consent', 'audit-rotation'].includes(processId) ||
          !validateNativeHelperAttempt(value, processId)
        )
      }) ||
      !attempts.slice(previousAttemptCount).some(value => value.processId === processSpec.id)
    ) {
      throw new Error(`Focused ${processSpec.id} process lacks valid native helper timing evidence`)
    }
    process.stdout.write(
      `Completed focused process ${processSpec.id}: ${verified.passed} required case(s), ` +
        `${verified.elapsedMs} ms; native-inspector-attempts=${attempts.length - previousAttemptCount}\n`
    )
    return verified
  })

  const summaryPath = path.join(artifactRoot, 'focused-summary.json')
  writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`)
  process.stdout.write(
    `Focused Windows result: ${summary.passedRequiredCases}/${summary.requiredCases} ` +
      `distinct selected cases passed; total-process-ms=${summary.totalProcessElapsedMs}\n`
  )
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  })
}
