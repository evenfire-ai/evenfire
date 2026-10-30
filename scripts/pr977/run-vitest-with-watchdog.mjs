import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, readFileSync, statSync, writeFileSync } from 'node:fs'

function parseArguments(argv) {
  const separator = argv.indexOf('--')
  if (separator < 0 || separator === argv.length - 1)
    throw new Error('Expected watchdog options followed by -- and the Vitest command')
  const options = Object.fromEntries(
    argv.slice(0, separator).map(value => {
      const match = value.match(/^--([a-z-]+)=(.+)$/)
      if (!match) throw new Error('Invalid watchdog option')
      return [match[1], match[2]]
    })
  )
  const command = argv.slice(separator + 1)
  const maximumRuntimeMs = Number(options['maximum-runtime-ms'])
  const noProgressMs = Number(options['no-progress-ms'])
  if (
    !Number.isSafeInteger(maximumRuntimeMs) ||
    maximumRuntimeMs < 1 ||
    !Number.isSafeInteger(noProgressMs) ||
    noProgressMs < 1 ||
    !options.progress ||
    !options.status
  ) {
    throw new Error('Invalid watchdog limits or diagnostic paths')
  }
  return {
    command,
    maximumRuntimeMs,
    noProgressMs,
    progress: options.progress,
    status: options.status,
  }
}

function lastValidProgress(progressPath) {
  try {
    const lines = readFileSync(progressPath, 'utf8').split(/\r?\n/).reverse()
    for (const line of lines) {
      if (!line) continue
      try {
        const value = JSON.parse(line)
        if (
          value &&
          Number.isSafeInteger(value.elapsedMs) &&
          typeof value.event === 'string' &&
          ['activeFile', 'activeCase', 'activeHook', 'lastCompletedOperation'].every(
            key => value[key] === null || typeof value[key] === 'string'
          )
        ) {
          return value
        }
      } catch {
        // Ignore a partial final line and retain the last complete progress record.
      }
    }
  } catch {
    return null
  }
  return null
}

function writeStatus(statusPath, value) {
  writeFileSync(statusPath, `${JSON.stringify(value)}\n`, { encoding: 'utf8' })
}

function terminateOwnedTree(pid) {
  if (process.platform === 'win32') {
    const result = spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
      encoding: 'utf8',
      timeout: 10_000,
      windowsHide: true,
      stdio: 'ignore',
    })
    return { method: 'taskkill-tree', status: result.status, errorCode: result.error?.code }
  }
  try {
    process.kill(pid, 'SIGTERM')
    return { method: 'signal', signal: 'SIGTERM' }
  } catch (error) {
    return { method: 'signal', errorCode: error?.code ?? 'OTHER' }
  }
}

const startedAt = Date.now()
const { command, maximumRuntimeMs, noProgressMs, progress, status } = parseArguments(
  process.argv.slice(2)
)
appendFileSync(progress, '')
const child = spawn(command[0], command.slice(1), {
  cwd: process.cwd(),
  env: { ...process.env, PR977_PROGRESS_PATH: progress },
  stdio: 'ignore',
  windowsHide: true,
})
if (!child.pid) throw new Error('Vitest process did not start')

let latestProgress = null
let latestProgressAt = startedAt
let termination = null
const close = new Promise(resolve =>
  child.once('close', (code, signal) => resolve({ code, signal }))
)
const timer = setInterval(() => {
  const nextProgress = lastValidProgress(progress)
  if (nextProgress && nextProgress.elapsedMs !== latestProgress?.elapsedMs) {
    latestProgress = nextProgress
    try {
      latestProgressAt = statSync(progress).mtimeMs
    } catch {
      latestProgressAt = Date.now()
    }
  }
  const now = Date.now()
  const reason =
    now - startedAt >= maximumRuntimeMs
      ? 'maximum-runtime'
      : now - latestProgressAt >= noProgressMs
        ? 'no-progress'
        : null
  if (!reason || termination || child.exitCode !== null) return
  termination = { reason, atElapsedMs: now - startedAt, action: terminateOwnedTree(child.pid) }
}, 250)
timer.unref()

let watchdogPoll
const watchdogExpired = new Promise(resolve => {
  watchdogPoll = setInterval(() => {
    if (termination) resolve({ code: null, signal: 'WATCHDOG' })
  }, 50)
})
const result = await Promise.race([close, watchdogExpired])
clearInterval(watchdogPoll)
clearInterval(timer)

if (termination) {
  const finalProgress = lastValidProgress(progress) ?? latestProgress
  writeStatus(status, {
    outcome: 'watchdog-expired',
    reason: termination.reason,
    elapsedMs: Date.now() - startedAt,
    termination: termination.action,
    lastProgress: finalProgress,
  })
  process.exitCode = 124
} else {
  const exitCode = Number.isInteger(result.code) ? result.code : 1
  const finalProgress = lastValidProgress(progress) ?? latestProgress
  writeStatus(status, {
    outcome: exitCode === 0 ? 'completed' : 'failed',
    exitCode,
    signal: result.signal ?? null,
    elapsedMs: Date.now() - startedAt,
    lastProgress: finalProgress,
  })
  process.exitCode = exitCode
}
