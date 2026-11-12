import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { assertNodeVersion } from '../../scripts/check-node-version.cjs'

// Desktop validation is the one place the Node major is contractual: the
// prebuilt Electron runtime is matched to Node 24, and CI pins the security
// patch in .nvmrc. The quickstart permits newer majors; Desktop requires the
// same patched runtime within Node 24.
// This runs before Electron is imported: a static import hoists above the check
// and would report ERR_MODULE_NOT_FOUND on a wrong runtime instead of saying so.
assertNodeVersion(process.versions.node, { major: 24 })

// Electron 42+ has no postinstall download: resolving `electron` downloads the
// runtime on first use. The default mode below is therefore also what
// materializes the runtime after `npm ci`; run it in install/setup steps,
// where a ~100 MB download belongs. Time-bounded phases must use --check-only
// instead: it never imports `electron`, so it can never trigger that download,
// and it fails fast unless an earlier unbounded step already materialized the
// runtime.
const checkOnly = process.argv.includes('--check-only')

function materializedElectronPath() {
  // Mirror electron's index.js resolution without executing it: executing it
  // is exactly what starts the download this mode must avoid.
  const require = createRequire(import.meta.url)
  let packageDir
  try {
    packageDir = path.dirname(require.resolve('electron/package.json'))
  } catch (cause) {
    throw new Error(
      'Electron package is not installed; run npm ci (never --ignore-scripts), then npm run verify:electron without --check-only to download the runtime',
      { cause }
    )
  }
  const pathFile = path.join(packageDir, 'path.txt')
  const executablePath = fs.existsSync(pathFile) ? fs.readFileSync(pathFile, 'utf-8') : undefined
  if (process.env.ELECTRON_OVERRIDE_DIST_PATH) {
    return path.join(process.env.ELECTRON_OVERRIDE_DIST_PATH, executablePath || 'electron')
  }
  const fullPath = executablePath ? path.join(packageDir, 'dist', executablePath) : ''
  if (!fullPath || !fs.existsSync(fullPath)) {
    throw new Error(
      'Electron runtime is not materialized and --check-only never downloads it; run npm run verify:electron (without --check-only) in an unbounded setup step first'
    )
  }
  return fullPath
}

let electronPath
if (checkOnly) {
  electronPath = materializedElectronPath()
} else {
  // A failed download throws "Electron failed to install correctly".
  try {
    electronPath = (await import('electron')).default
  } catch (cause) {
    throw new Error(
      'Electron is not installed or its runtime download failed; delete node_modules/electron, run npm ci (never --ignore-scripts), and rerun this check',
      { cause }
    )
  }
}

const runtimePath = typeof electronPath === 'string' ? electronPath : ''
if (!runtimePath) {
  throw new Error('Electron runtime path is unavailable; run npm ci and rerun this check')
}

const stat = fs.statSync(runtimePath)
if (!stat.isFile()) {
  throw new Error(`Electron runtime is not a file: ${runtimePath}`)
}

const accessMode = process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK
fs.accessSync(runtimePath, accessMode)
console.log(`Electron runtime executable: ${runtimePath}`)
