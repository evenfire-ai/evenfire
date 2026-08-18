import fs from 'node:fs'

// Desktop validation is the one place the Node major is contractual: the
// Electron postinstall and the prebuilt runtime are matched to Node 24, and CI
// pins node-version 24. The quickstart prereq check only enforces a >= 24
// floor, so assert the exact major here instead of blocking the whole install.
// This runs before Electron is imported: a static import hoists above the check
// and would report ERR_MODULE_NOT_FOUND on a wrong runtime instead of saying so.
const nodeMajor = Number.parseInt(process.versions.node.split('.')[0], 10)
if (nodeMajor !== 24) {
  throw new Error(
    `Desktop validation requires Node 24.x; found v${process.versions.node}. ` +
      'Switch to Node 24 and rerun npm ci with lifecycle scripts enabled.'
  )
}

let electronPath
try {
  electronPath = (await import('electron')).default
} catch (cause) {
  throw new Error(
    'Electron is not installed; run npm ci with lifecycle scripts enabled (never --ignore-scripts)',
    { cause }
  )
}

const runtimePath = typeof electronPath === 'string' ? electronPath : ''
if (!runtimePath) {
  throw new Error('Electron runtime path is unavailable; run npm ci with lifecycle scripts enabled')
}

const stat = fs.statSync(runtimePath)
if (!stat.isFile()) {
  throw new Error(`Electron runtime is not a file: ${runtimePath}`)
}

const accessMode = process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK
fs.accessSync(runtimePath, accessMode)
console.log(`Electron runtime executable: ${runtimePath}`)
