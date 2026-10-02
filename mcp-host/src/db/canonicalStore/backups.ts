import * as fs from 'node:fs'
import * as path from 'node:path'
import { type ExportManifest, exportCanonicalStore } from './export'
import { inspectCandidate } from './inspectCandidate'
import {
  SQLITE_FILES,
  compareBinding,
  exists,
  fileHash,
  objectHash,
  safePath,
  syncDirectory,
  syncFile,
} from './paths'
import { createPrivateScratch } from './privateScratch'
import {
  type Binding,
  CanonicalStoreError,
  type FileFingerprint,
  LIMITS,
  type OperatorAuthorization,
  type WriterFence,
} from './types'
import { acquireWriterFence } from './writerFence'

export type BackupLocation = 'root' | 'workspace' | 'state'
export interface BackupSet {
  location: BackupLocation
  suffix: string
  files: FileFingerprint[]
  sourceHash: string
  complete: boolean
}
const backupPattern =
  /^(state\.db(?:-wal|-shm|-journal)?)\.pre-([A-Za-z0-9][A-Za-z0-9_.-]{0,127})\.bak$/
function directory(root: string, location: BackupLocation): string {
  if (!['root', 'workspace', 'state'].includes(location))
    throw new CanonicalStoreError('JournalInvalid')
  return location === 'root' ? root : path.join(root, location)
}
/** Group by the shared historical suffix, never by mtime or file size. Backups are not automatic candidates. */
export function discoverBackupSets(root: string): BackupSet[] {
  const result: BackupSet[] = []
  for (const location of ['root', 'workspace', 'state'] as const) {
    const base = directory(root, location)
    if (!exists(base)) continue
    safePath(root, base)
    const suffixes = new Set<string>()
    for (const name of fs.readdirSync(base)) {
      const match = backupPattern.exec(name)
      if (match) suffixes.add(match[2])
    }
    for (const suffix of [...suffixes].sort()) {
      if (result.length >= LIMITS.maxCandidates) throw new CanonicalStoreError('ManifestTooLarge')
      const files = SQLITE_FILES.map(name => {
        const file = path.join(base, `${name}.pre-${suffix}.bak`)
        if (!exists(file)) return { name, present: false, size: 0, sha256: null }
        safePath(root, file)
        const size = fs.statSync(file).size
        if (size > LIMITS.maxBytes) throw new CanonicalStoreError('ManifestTooLarge')
        return { name, present: true, size, sha256: fileHash(root, file) }
      })
      result.push({
        location,
        suffix,
        files,
        sourceHash: objectHash(files),
        complete: files[0].present,
      })
    }
  }
  return result
}
export interface BackupExportOptions {
  root: string
  binding: Binding
  location: BackupLocation
  suffix: string
  sourceHash: string
  exportId: string
  authorization: OperatorAuthorization
  fence?: WriterFence
}
/** Explicit operator recovery retains the complete historical set before creating a validated import.
 * This does not select a lineage or reconcile accepted-write deltas; adoption remains a separate operation. */
export async function exportHistoricalBackup(
  options: BackupExportOptions
): Promise<ExportManifest> {
  const root = path.resolve(options.root)
  if (
    !options.authorization ||
    options.authorization.authorized !== true ||
    !options.authorization.principal ||
    options.authorization.requestId !== options.exportId ||
    !options.authorization.maintenanceId
  )
    throw new CanonicalStoreError('AdoptUnauthorized')
  compareBinding(options.authorization, options.binding)
  const ownedFence = options.fence
    ? undefined
    : acquireWriterFence({ stateDir: path.join(root, 'state') })
  const fence = options.fence ?? ownedFence!
  let privateScratch: ReturnType<typeof createPrivateScratch> | undefined
  let inspected: Awaited<ReturnType<typeof inspectCandidate>> | undefined
  try {
    fence.assertHeld()
    const backup = discoverBackupSets(root).find(
      backup => backup.location === options.location && backup.suffix === options.suffix
    )
    if (!backup || backup.sourceHash !== options.sourceHash)
      throw new CanonicalStoreError('AdoptFingerprintUnknown')
    if (!backup.complete) throw new CanonicalStoreError('CandidateIncomplete')
    privateScratch = createPrivateScratch(
      root,
      path.join(root, 'state', '.canonical-store', 'backup-exports')
    )
    const scratch = privateScratch.directory
    for (const file of backup.files.filter(file => file.present)) {
      const source = path.join(
        directory(root, backup.location),
        `${file.name}.pre-${backup.suffix}.bak`
      )
      const target = path.join(scratch, file.name)
      safePath(root, source)
      safePath(root, target, true)
      fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL)
      fs.chmodSync(target, 0o600)
      syncFile(root, target)
    }
    syncDirectory(root, scratch)
    inspected = await inspectCandidate(scratch, {
      root,
      scratchDir: path.join(scratch, 'normalization'),
      binding: options.binding,
      fence,
    })
    const result = await exportCanonicalStore({
      root,
      sourcePath: inspected.normalizedPath,
      exportId: options.exportId,
      binding: options.binding,
      maintenanceId: options.authorization.maintenanceId,
      fence,
    })
    const after = discoverBackupSets(root).find(
      candidate => candidate.location === backup.location && candidate.suffix === backup.suffix
    )
    if (!after || after.sourceHash !== backup.sourceHash)
      throw new CanonicalStoreError('CandidateChangedDuringMigration')
    return result
  } finally {
    try {
      inspected?.dispose()
      privateScratch?.dispose()
    } finally {
      ownedFence?.close()
    }
  }
}
