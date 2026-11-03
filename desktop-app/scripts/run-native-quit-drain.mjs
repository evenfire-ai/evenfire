import electronPath from 'electron'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'darwin') {
  console.log('native quit drain fixture: SKIP (macOS only)')
  process.exit(0)
}

const desktopRoot = fileURLToPath(new URL('..', import.meta.url))
const passSentinel = 'QUIT_DRAIN_NATIVE_FIXTURE_PASS'

async function runFixture(rejectedPreparationPhase) {
  const profileRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'evenfire-quit-drain-profile-'))
  const appDataRoot = path.join(profileRoot, 'app-data')
  const userDataRoot = path.join(profileRoot, 'user-data')
  const sessionDataRoot = path.join(profileRoot, 'session-data')
  const configPath = path.join(profileRoot, 'runtime-config.json')
  const childEnvironment = { ...process.env }
  delete childEnvironment.ELECTRON_RUN_AS_NODE
  delete childEnvironment.EVENFIRE_TEST_QUIT_DRAIN_REJECT_PREPARATION
  childEnvironment.CLERUM_DESKTOP_CONFIG_PATH = configPath
  if (rejectedPreparationPhase) {
    childEnvironment.EVENFIRE_TEST_QUIT_DRAIN_REJECT_PREPARATION = rejectedPreparationPhase
  }

  try {
    await Promise.all(
      [appDataRoot, userDataRoot, sessionDataRoot].map(directory =>
        fs.mkdir(directory, { recursive: true })
      )
    )

    const child = spawn(
      electronPath,
      [`--user-data-dir=${userDataRoot}`, './test/native/quit-drain.bootstrap.cjs', profileRoot],
      {
        cwd: desktopRoot,
        env: childEnvironment,
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    )
    let output = ''
    child.stdout.on('data', chunk => {
      output += chunk.toString()
    })
    child.stderr.on('data', chunk => {
      output += chunk.toString()
    })

    const exitCode = await new Promise((resolve, reject) => {
      let timedOut = false
      const deadline = setTimeout(() => {
        timedOut = true
        child.kill('SIGKILL')
      }, 45_000)
      child.once('error', error => {
        clearTimeout(deadline)
        reject(error)
      })
      child.once('close', code => {
        clearTimeout(deadline)
        if (timedOut) {
          reject(new Error(`native quit drain fixture timed out:\n${output}`))
        } else {
          resolve(code)
        }
      })
    })

    return { exitCode, output }
  } finally {
    await fs.rm(profileRoot, { recursive: true, force: true })
  }
}

const success = await runFixture()
if (success.exitCode !== 0 || !success.output.includes(passSentinel)) {
  throw new Error(`native quit drain fixture failed (exit ${success.exitCode}):\n${success.output}`)
}
console.log(success.output.trim())

for (const phase of ['first', 'retry']) {
  const failure = await runFixture(phase)
  const rejectionMarker = `QUIT_DRAIN_PREPARATION_REJECTED:${phase}`
  if (
    failure.exitCode === 0 ||
    !failure.output.includes(rejectionMarker) ||
    failure.output.includes(passSentinel)
  ) {
    throw new Error(
      `native quit drain fixture did not fail closed for ${phase} rejection ` +
        `(exit ${failure.exitCode}):\n${failure.output}`
    )
  }
  console.log(`QUIT_DRAIN_REJECTION_GUARD_PASS:${phase}`)
}

console.log('QUIT_DRAIN_NATIVE_FAILURE_GUARDS_PASS')
