import fs from 'node:fs'
import { assertNodeVersion } from '../../scripts/check-node-version.cjs'

// Desktop validation is the one place the Node major is contractual: the
// Electron postinstall and the prebuilt runtime are matched to Node 24, and CI
// pins the security patch in .nvmrc. The quickstart permits newer majors;
// Desktop requires the same patched runtime within Node 24.
// This runs before Electron is imported: a static import hoists above the check
// and would report ERR_MODULE_NOT_FOUND on a wrong runtime instead of saying so.
assertNodeVersion(process.versions.node, { major: 24 })

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
