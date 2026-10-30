import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildObservedVitestNodeArgs } from './run-focused-windows-processes.mjs'
import diagnostics from './windows-native-spawn-observer.cjs'

const { validateNativeHelperAttempt } = diagnostics
const scratchRoot = process.env.CODEX_SCRATCH_ROOT
if (!scratchRoot || !path.isAbsolute(scratchRoot))
  throw new Error('Focused launcher contract requires CODEX_SCRATCH_ROOT')
const scratchParent = path.join(scratchRoot, 'evenfire')
mkdirSync(scratchParent, { recursive: true })
const directory = mkdtempSync(path.join(scratchParent, 'pr977-focused-launcher-proof-'))
const scriptRoot = path.dirname(fileURLToPath(import.meta.url))
const watchdogPath = path.join(scriptRoot, 'run-vitest-with-watchdog.mjs')
const desktopRoot = process.cwd()
const vitestPath = path.join(desktopRoot, 'node_modules', 'vitest', 'vitest.mjs')
const spaceRoot = path.join(directory, 'fixture paths with spaces')
const processTreePidPath = path.join(directory, 'process-tree-child.pid')
let processTreeChildPid = null

function runWatchdog(
  name,
  nodeArguments,
  { maximumRuntimeMs = 30_000, noProgressMs = 20_000, extraEnv = {} } = {}
) {
  const progressPath = path.join(directory, `${name}-progress.jsonl`)
  const statusPath = path.join(directory, `${name}-watchdog-status.json`)
  const attemptsPath = path.join(directory, `${name}-attempts.jsonl`)
  writeFileSync(progressPath, '', { encoding: 'utf8' })
  writeFileSync(attemptsPath, '', { encoding: 'utf8' })
  const result = spawnSync(
    process.execPath,
    [
      watchdogPath,
      `--maximum-runtime-ms=${maximumRuntimeMs}`,
      `--no-progress-ms=${noProgressMs}`,
      `--progress=${progressPath}`,
      `--status=${statusPath}`,
      '--',
      process.execPath,
      ...nodeArguments,
    ],
    {
      cwd: desktopRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_OPTIONS: '--trace-warnings',
        PR977_FOCUSED_PROCESS_ID: 'consent',
        PR977_NATIVE_LOAD_ATTEMPTS_PATH: attemptsPath,
        ...extraEnv,
      },
      shell: false,
      timeout: Math.max(10_000, maximumRuntimeMs + 10_000),
      windowsHide: true,
    }
  )
  return { result, statusPath, attemptsPath }
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error?.code === 'ESRCH') return false
    return true
  }
}

try {
  assert.equal(existsSync(vitestPath), true, 'The installed Desktop Vitest entrypoint is required')
  mkdirSync(spaceRoot, { recursive: true })
  const observerPath = path.join(spaceRoot, 'native observer preload.cjs')
  const fakePowerShellPath = path.join(spaceRoot, 'powershell.exe')
  copyFileSync(path.join(scriptRoot, 'windows-native-spawn-observer.cjs'), observerPath)
  try {
    linkSync(realpathSync(process.execPath), fakePowerShellPath)
  } catch {
    copyFileSync(realpathSync(process.execPath), fakePowerShellPath)
  }
  if (process.platform !== 'win32') chmodSync(fakePowerShellPath, 0o755)

  const windowsObserverPath = String.raw`C:\runner workspace\validation\scripts\native observer.cjs`
  const windowsVitestPath = String.raw`C:\runner workspace\desktop app\node_modules\vitest\vitest.mjs`
  const windowsArgs = buildObservedVitestNodeArgs(windowsObserverPath, windowsVitestPath, [
    'run',
    '--retry=0',
    'src/__tests__/pluginStorageWindowsAcl.native.test.ts',
  ])
  assert.deepEqual(windowsArgs, [
    '--require',
    windowsObserverPath,
    windowsVitestPath,
    'run',
    '--retry=0',
    'src/__tests__/pluginStorageWindowsAcl.native.test.ts',
  ])
  assert.throws(() => buildObservedVitestNodeArgs('relative-observer.cjs', windowsVitestPath, []))

  const testRoot = path.join(directory, 'Vitest worker fixture root with spaces')
  mkdirSync(testRoot, { recursive: true })
  const testPath = path.join(testRoot, 'observer-preload.test.mjs')
  const configPath = path.join(testRoot, 'vitest.config.mjs')
  const optionsPath = path.join(directory, 'inherited-node-options.txt')
  const markerScript = "Write-Phase 'helper-load-start'\nAdd-Type -Path $assemblyPath"
  const secret = 'synthetic-token-not-for-report'
  const syntheticPowerShellOutput =
    'EVENFIRE_PLUGIN_ACL_PHASE=helper-load-start;ordinal=2;elapsedMs=11\n' +
    `private fixture path ${directory}; token ${secret}\n`
  const fakePowerShellProgram = `process.stderr.write(${JSON.stringify(syntheticPowerShellOutput)}); process.exit(7);`
  writeFileSync(
    testPath,
    `import assert from 'node:assert/strict'\n` +
      `import { spawnSync } from 'node:child_process'\n` +
      `import { writeFileSync } from 'node:fs'\n` +
      `test('synthetic observer preload records a sanitized child attempt', () => {\n` +
      `  const observerIsPreloaded = process.execArgv.some((value, index) => value === '--require' && process.execArgv[index + 1] === ${JSON.stringify(observerPath)})\n` +
      `  writeFileSync(process.env.PR977_TEST_NODE_OPTIONS_PATH, JSON.stringify({ nodeOptions: process.env.NODE_OPTIONS ?? '', observerIsPreloaded }))\n` +
      `  const result = spawnSync(${JSON.stringify(fakePowerShellPath)}, ['-e', ${JSON.stringify(fakePowerShellProgram)}], {\n` +
      `    encoding: 'utf8',\n` +
      `    input: ${JSON.stringify(`${markerScript}\n${directory}\n${secret}`)},\n` +
      `    timeout: 15000,\n` +
      `    windowsHide: true,\n` +
      `  })\n` +
      `  assert.equal(result.status, 7)\n` +
      `  assert.equal(result.error, undefined)\n` +
      `})\n`,
    { encoding: 'utf8' }
  )
  writeFileSync(
    configPath,
    `export default { test: { globals: true, include: ['observer-preload.test.mjs'], ` +
      `pool: 'forks', maxWorkers: 1, minWorkers: 1, fileParallelism: false, testTimeout: 10000 } }\n`,
    { encoding: 'utf8' }
  )

  const childArguments = buildObservedVitestNodeArgs(observerPath, vitestPath, [
    'run',
    '--config',
    configPath,
    '--root',
    testRoot,
    '--execArgv=--require',
    `--execArgv=${observerPath}`,
    '--reporter=dot',
    '--retry=0',
    testPath,
  ])
  const watchdogInvocation = [
    watchdogPath,
    '--maximum-runtime-ms=30000',
    '--no-progress-ms=20000',
    `--progress=${path.join(directory, 'vitest-progress.jsonl')}`,
    `--status=${path.join(directory, 'vitest-watchdog-status.json')}`,
    '--',
    process.execPath,
    ...childArguments,
  ]
  assert.equal(watchdogInvocation.indexOf(observerPath) > watchdogInvocation.indexOf('--'), true)
  assert.equal(
    watchdogInvocation.indexOf(observerPath) < watchdogInvocation.indexOf(vitestPath),
    true
  )
  assert.equal(watchdogInvocation.includes(`--require="${observerPath}"`), false)

  const vitestRun = runWatchdog('vitest', childArguments, {
    extraEnv: { PR977_TEST_NODE_OPTIONS_PATH: optionsPath },
  })
  const vitestStatus = JSON.parse(readFileSync(vitestRun.statusPath, 'utf8'))
  assert.equal(vitestRun.result.status, 0, 'The real Vitest child must pass the preload contract')
  assert.equal(vitestStatus.outcome, 'completed')
  assert.equal(vitestStatus.exitCode, 0)
  assert.equal(vitestStatus.signal, null)
  const inheritedNodeState = JSON.parse(readFileSync(optionsPath, 'utf8'))
  assert.equal(inheritedNodeState.nodeOptions, '--trace-warnings')
  assert.equal(inheritedNodeState.observerIsPreloaded, true)

  const records = readFileSync(vitestRun.attemptsPath, 'utf8')
    .trim()
    .split(/\r?\n/)
    .map(value => JSON.parse(value))
  assert.equal(records.length, 1, 'The Vitest worker must emit exactly one synthetic attempt')
  assert.equal(records[0].outcome, 'process-exit-failed')
  assert.equal(records[0].processErrorCode, null)
  assert.equal(records[0].exitStatus, 7)
  assert.equal(records[0].lastPhase, 'helper-load-start')
  assert.equal(records[0].nativeOrdinal, 2)
  assert.equal(validateNativeHelperAttempt(records[0], 'consent'), true)
  assert.doesNotMatch(
    JSON.stringify(records),
    /private fixture path|synthetic-token-not-for-report/
  )

  const failedChildPath = path.join(directory, 'failed-child.mjs')
  writeFileSync(failedChildPath, 'process.exit(17)\n', { encoding: 'utf8' })
  const failedLaunch = runWatchdog(
    'failed-child',
    buildObservedVitestNodeArgs(observerPath, failedChildPath, [])
  )
  const failedStatus = JSON.parse(readFileSync(failedLaunch.statusPath, 'utf8'))
  assert.equal(failedLaunch.result.status, 17)
  assert.equal(failedStatus.outcome, 'failed')
  assert.equal(failedStatus.exitCode, 17)

  const missingObserver = path.join(spaceRoot, 'missing observer.cjs')
  const preloadFailure = runWatchdog(
    'preload-failure',
    buildObservedVitestNodeArgs(missingObserver, failedChildPath, [])
  )
  const preloadStatus = JSON.parse(readFileSync(preloadFailure.statusPath, 'utf8'))
  assert.notEqual(preloadFailure.result.status, 0)
  assert.equal(preloadStatus.outcome, 'failed')
  assert.notEqual(preloadStatus.exitCode, 0)

  const hangingParentPath = path.join(directory, 'hanging-parent.cjs')
  writeFileSync(
    hangingParentPath,
    `const { spawn } = require('node:child_process'); ` +
      `const { writeFileSync } = require('node:fs'); ` +
      `const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { ` +
      `stdio: 'ignore', windowsHide: true }); ` +
      `writeFileSync(${JSON.stringify(processTreePidPath)}, String(child.pid)); ` +
      `setInterval(() => {}, 1000);\n`,
    { encoding: 'utf8' }
  )
  const timedLaunch = runWatchdog(
    'process-tree-timeout',
    buildObservedVitestNodeArgs(observerPath, hangingParentPath, []),
    { maximumRuntimeMs: 2_000, noProgressMs: 8_000 }
  )
  if (existsSync(processTreePidPath))
    processTreeChildPid = Number(readFileSync(processTreePidPath, 'utf8'))
  const timeoutStatus = JSON.parse(readFileSync(timedLaunch.statusPath, 'utf8'))
  assert.equal(timedLaunch.result.status, 124)
  assert.equal(timeoutStatus.outcome, 'watchdog-expired')
  assert.equal(timeoutStatus.reason, 'maximum-runtime')
  assert.ok(Number.isSafeInteger(timeoutStatus.elapsedMs) && timeoutStatus.elapsedMs <= 10_000)

  if (process.platform === 'win32') {
    const deadline = Date.now() + 3_000
    while (processIsAlive(processTreeChildPid) && Date.now() < deadline)
      await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal(
      processIsAlive(processTreeChildPid),
      false,
      'Windows watchdog must terminate the owned tree'
    )
    assert.equal(timeoutStatus.termination?.method, 'taskkill-tree')
  } else if (existsSync(processTreePidPath)) {
    if (processIsAlive(processTreeChildPid)) process.kill(processTreeChildPid, 'SIGTERM')
    const deadline = Date.now() + 3_000
    while (processIsAlive(processTreeChildPid) && Date.now() < deadline)
      await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal(processIsAlive(processTreeChildPid), false)
  }

  process.stdout.write(
    'Focused launcher argv, Vitest preload, synthetic observer, watchdog, failure, and timeout contracts passed\n'
  )
} finally {
  if (!Number.isSafeInteger(processTreeChildPid) && existsSync(processTreePidPath))
    processTreeChildPid = Number(readFileSync(processTreePidPath, 'utf8'))
  if (Number.isSafeInteger(processTreeChildPid) && processIsAlive(processTreeChildPid)) {
    if (process.platform === 'win32')
      spawnSync('taskkill.exe', ['/PID', String(processTreeChildPid), '/T', '/F'], {
        stdio: 'ignore',
        timeout: 5_000,
        windowsHide: true,
      })
    else process.kill(processTreeChildPid, 'SIGKILL')
  }
  rmSync(directory, { recursive: true, force: true })
}
