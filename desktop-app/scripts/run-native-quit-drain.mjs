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
const profileRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'evenfire-quit-drain-profile-'))
const appDataRoot = path.join(profileRoot, 'app-data')
const userDataRoot = path.join(profileRoot, 'user-data')
const sessionDataRoot = path.join(profileRoot, 'session-data')
const configPath = path.join(profileRoot, 'runtime-config.json')
const childEnvironment = { ...process.env }
delete childEnvironment.ELECTRON_RUN_AS_NODE
childEnvironment.CLERUM_DESKTOP_CONFIG_PATH = configPath

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
    }, 15_000)
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

  if (exitCode !== 0 || !output.includes('QUIT_DRAIN_NATIVE_FIXTURE_PASS')) {
    throw new Error(`native quit drain fixture failed (exit ${exitCode}):\n${output}`)
  }
  console.log(output.trim())
} finally {
  await fs.rm(profileRoot, { recursive: true, force: true })
}
