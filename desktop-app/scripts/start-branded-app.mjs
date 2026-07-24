import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const APP_NAME = 'Evenfire'
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url))
const projectDirectory = path.resolve(scriptDirectory, '..')
const forgeCli = path.join(
  projectDirectory,
  'node_modules',
  '@electron-forge',
  'cli',
  'dist',
  'electron-forge.js'
)

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', ...options })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve()
        return
      }
      reject(
        new Error(
          signal
            ? `${APP_NAME} development packaging stopped with ${signal}`
            : `${APP_NAME} development packaging exited with code ${code ?? 'unknown'}`
        )
      )
    })
  })
}

function packagedExecutablePath() {
  const packageDirectory = path.join(
    projectDirectory,
    'out',
    `${APP_NAME}-${process.platform}-${process.arch}`
  )

  if (process.platform === 'darwin') {
    return path.join(packageDirectory, `${APP_NAME}.app`, 'Contents', 'MacOS', APP_NAME)
  }
  if (process.platform === 'win32') {
    return path.join(packageDirectory, `${APP_NAME}.exe`)
  }
  return path.join(packageDirectory, APP_NAME)
}

async function main() {
  if (!fs.existsSync(forgeCli)) {
    throw new Error('Electron Forge is not installed. Run npm ci in desktop-app first.')
  }

  await run(
    process.execPath,
    [forgeCli, 'package', `--platform=${process.platform}`, `--arch=${process.arch}`],
    {
      cwd: projectDirectory,
      env: { ...process.env, EVENFIRE_SKIP_PACKAGE_BUILD: '1' },
    }
  )

  const executable = packagedExecutablePath()
  if (!fs.existsSync(executable)) {
    throw new Error(`The branded ${APP_NAME} executable was not created at ${executable}.`)
  }

  const appProcess = spawn(executable, [], {
    cwd: projectDirectory,
    env: { ...process.env, EVENFIRE_DESKTOP_DEV_PACKAGE: '1' },
    stdio: 'inherit',
  })

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => appProcess.kill(signal))
  }

  await new Promise((resolve, reject) => {
    appProcess.once('error', reject)
    appProcess.once('exit', (code, signal) => {
      if (signal || code === 0) {
        resolve()
        return
      }
      reject(new Error(`${APP_NAME} exited with code ${code ?? 'unknown'}`))
    })
  })
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
