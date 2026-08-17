import electronPath from 'electron'
import fs from 'node:fs'

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
