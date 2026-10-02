import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { type FsPort, nodeFs } from './fsPort'
import { exists, privateDirectory, safePath, syncDirectory } from './paths'
import { CanonicalStoreError } from './types'

/** Only a freshly created private UUID directory receives this disposal capability. */
export function createPrivateScratch(
  root: string,
  parent: string,
  port: FsPort = nodeFs
): { directory: string; dispose(): void } {
  privateDirectory(root, parent, port)
  const directory = path.join(parent, randomUUID())
  safePath(root, directory, true)
  port.mkdirSync(directory, { mode: 0o700 })
  syncDirectory(root, directory, port)
  syncDirectory(root, parent, port)
  const original = fs.lstatSync(directory)
  let disposed = false
  return {
    directory,
    dispose() {
      if (disposed) return
      if (!exists(directory)) {
        disposed = true
        return
      }
      safePath(root, directory)
      const current = fs.lstatSync(directory)
      if (current.dev !== original.dev || current.ino !== original.ino)
        throw new CanonicalStoreError('LayoutUnsafe')
      function remove(file: string): void {
        safePath(root, file)
        const stat = fs.lstatSync(file)
        if (stat.isDirectory()) {
          for (const name of fs.readdirSync(file)) remove(path.join(file, name))
          fs.rmdirSync(file)
        } else fs.unlinkSync(file)
      }
      remove(directory)
      syncDirectory(root, parent, port)
      disposed = true
    },
  }
}
