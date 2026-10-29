import { mkdtemp, realpath, rm } from 'node:fs/promises'
import fsSync from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = await mkdtemp(path.join(os.tmpdir(), 'evenfire-realpath-probe-'))
try {
  const asyncFirst = await realpath(root)
  const asyncSecond = await realpath(asyncFirst)
  const syncFirst = fsSync.realpathSync(root)
  const syncFromAsync = fsSync.realpathSync(asyncFirst)
  const normalize = (value) => {
    const withoutExtendedPrefix = value
      .replace(/^\\\\\?\\UNC\\/i, '\\\\')
      .replace(/^\\\\\?\\/i, '')
    return path.win32.normalize(withoutExtendedPrefix).replace(/[\\/]+$/, '').toLowerCase()
  }
  console.log(
    JSON.stringify({
      asyncToSyncExact: asyncSecond === syncFirst,
      asyncToSyncCanonical: normalize(asyncSecond) === normalize(syncFirst),
      asyncInputToSyncExact: asyncFirst === syncFromAsync,
      asyncInputToSyncCanonical: normalize(asyncFirst) === normalize(syncFromAsync),
      pathLengths: [asyncSecond.length, syncFirst.length, asyncFirst.length, syncFromAsync.length],
    })
  )
} finally {
  await rm(root, { recursive: true, force: true })
}
