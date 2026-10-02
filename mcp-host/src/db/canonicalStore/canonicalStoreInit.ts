import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { runMigrations } from '../migrate'
import { discoverBackupSets } from './backups'
import {
  assertNoForeignLayoutCandidates,
  validateCanonicalStore,
  validateLegacyStore,
} from './bootGuard'
import { classifyCandidates } from './classifyCandidates'
import { type FsPort, nodeFs } from './fsPort'
import { insertIdentity, readIdentity } from './identity'
import { isImportConsumed, readImportManifest } from './imports'
import { catalogFingerprint, inspectCandidate, validateSupportedSchema } from './inspectCandidate'
import {
  FINAL_MARKER,
  LEGACY_MARKER,
  LEGACY_STATE_RECORD,
  MIGRATING_MARKER,
  activeJournalPath,
  archiveJournal,
  assertOperatorMigrationContext,
  atomicJson,
  beginMigration,
  completeDirectoryAllocation,
  ensureMigratingMarker,
  manifestHash,
  readJournal,
  readJson,
  readLegacyMarker,
  readLegacyStateRecord,
  readMarker,
  validateJournal,
  writeJournal,
} from './journal'
import {
  SQLITE_FILES,
  assertNotUnknownSqliteArtifact,
  assertUuid,
  candidateDirectory,
  candidateKey,
  compareBinding,
  exists,
  fileHash,
  fingerprints,
  isReservedSqliteName,
  objectHash,
  operationDirectory,
  privateDirectory,
  safePath,
  syncDirectory,
  syncFile,
  treeFingerprint,
  validateBinding,
} from './paths'
import {
  type CandidateId,
  type CandidateManifest,
  type CanonicalIdentity,
  CanonicalStoreError,
  type InitOutcome,
  LIMITS,
  type LegacyLayoutMarker,
  type MigrationJournal,
  type MigrationOptions,
  type MoveOperation,
  legacyOutcome,
  outcome,
} from './types'
import { acquireWriterFence } from './writerFence'

export function discoverCandidates(
  root: string,
  binding: MigrationOptions['binding']
): CandidateId[] {
  const ids: CandidateId[] = ['C_state', 'C_root', 'C_ws']
  const imports = path.join(root, '.canonical-store-import')
  if (exists(imports)) {
    safePath(root, imports)
    for (const id of fs.readdirSync(imports).sort()) {
      assertUuid(id)
      const directory = path.join(imports, id)
      safePath(root, directory)
      const manifest = readImportManifest(root, id, binding)
      if (isImportConsumed(root, id, binding, manifest)) continue
      if (objectHash(manifest.files) !== objectHash(fingerprints(root, directory)))
        throw new CanonicalStoreError('CandidateChangedDuringMigration')
      ids.push(`C_import:${id}`)
    }
  }
  const result: CandidateId[] = []
  for (const id of ids) {
    const directory = candidateDirectory(root, id)
    if (!exists(directory)) continue
    safePath(root, directory)
    if (!fs.statSync(directory).isDirectory()) throw new CanonicalStoreError('LayoutUnsafe')
    const files = fingerprints(root, directory)
    if (!files[0].present && files.some(file => file.present))
      throw new CanonicalStoreError('CandidateIncomplete')
    if (files[0].present) result.push(id)
  }
  if (result.length > LIMITS.maxCandidates) throw new CanonicalStoreError('ManifestTooLarge')
  return result
}
export function assertNoPendingWorkspaceRelocation(root: string): void {
  if (workspaceManifest(root).length !== 0)
    throw new CanonicalStoreError(
      'WorkspaceEntryCollision',
      'Canonical recovery requires an already relocated workspace'
    )
}
export function workspaceManifest(root: string): MoveOperation[] {
  const result: MoveOperation[] = []
  const destination = path.join(root, 'workspace')
  safePath(root, destination, true)
  if (exists(destination) && !fs.statSync(destination).isDirectory())
    throw new CanonicalStoreError('LayoutUnsafe')
  for (const name of fs.readdirSync(root).sort()) {
    if (
      ['workspace', 'state', 'lost+found'].includes(name) ||
      name.startsWith('.canonical-store') ||
      name.startsWith('.clerum-canonical-store') ||
      isReservedSqliteName(name)
    )
      continue
    assertNotUnknownSqliteArtifact(root, name)
    if (result.length >= LIMITS.maxEntries) throw new CanonicalStoreError('ManifestTooLarge')
    const source = path.join(root, name)
    safePath(root, source)
    const target = path.join(destination, name)
    safePath(root, target, true)
    if (exists(target)) throw new CanonicalStoreError('WorkspaceEntryCollision')
    const tree = treeFingerprint(root, source)
    result.push({ kind: 'workspace', name, ...tree, state: 'pending' })
  }
  if (
    result.reduce((sum, op) => sum + op.size, 0) > LIMITS.maxBytes ||
    result.reduce((sum, op) => sum + op.entries!, 0) > LIMITS.maxEntries
  )
    throw new CanonicalStoreError('ManifestTooLarge')
  return result
}
function checkDisk(root: string, bytes: number, options: MigrationOptions): void {
  const stat = options.statfs ? options.statfs(root) : (options.fs ?? nodeFs).statfsSync(root)
  const available = BigInt(stat.bsize) * BigInt(stat.bavail)
  // Retained bytes, scratch normalization and staging coexist until completion.
  const required = BigInt(bytes) * 8n + 16n * 1024n * 1024n
  if (available < required) throw new CanonicalStoreError('InsufficientSpace')
}
function snapshots(root: string, journal: MigrationJournal): string {
  return path.join(operationDirectory(root, journal.migrationId), 'sources')
}
function snapshotDirectory(root: string, journal: MigrationJournal, id: CandidateId): string {
  return path.join(snapshots(root, journal), candidateKey(id))
}
function verifySnapshots(root: string, journal: MigrationJournal): void {
  for (const candidate of journal.candidates) {
    if (
      objectHash(fingerprints(root, snapshotDirectory(root, journal, candidate.id))) !==
      candidate.sourceHash
    ) {
      throw new CanonicalStoreError('CandidateChangedDuringMigration')
    }
  }
}
async function snapshot(
  root: string,
  journal: MigrationJournal,
  options: MigrationOptions
): Promise<void> {
  const port = options.fs ?? nodeFs
  const ids = discoverCandidates(root, options.binding)
  journal.workspace = workspaceManifest(root)
  journal.candidates = ids.map(id => {
    const files = fingerprints(root, candidateDirectory(root, id))
    return { id, files, sourceHash: objectHash(files) }
  })
  const bytes = journal.candidates.reduce(
    (sum, candidate) => sum + candidate.files.reduce((sum, file) => sum + file.size, 0),
    0
  )
  if (bytes > LIMITS.maxBytes) throw new CanonicalStoreError('ManifestTooLarge')
  checkDisk(root, bytes, options)
  privateDirectory(root, snapshots(root, journal), port)
  for (const candidate of journal.candidates) {
    const destination = snapshotDirectory(root, journal, candidate.id)
    privateDirectory(root, destination, port)
    for (const file of candidate.files.filter(file => file.present)) {
      options.fence!.assertHeld()
      const source = path.join(candidateDirectory(root, candidate.id), file.name)
      const target = path.join(destination, file.name)
      safePath(root, source)
      safePath(root, target, true)
      // started owns these incomplete copies; no snapshotted evidence is overwritten.
      port.copyFileSync(source, target)
      fs.chmodSync(target, 0o600)
      syncFile(root, target, port)
    }
    syncDirectory(root, destination, port)
    if (
      objectHash(fingerprints(root, candidateDirectory(root, candidate.id))) !==
        candidate.sourceHash ||
      objectHash(fingerprints(root, destination)) !== candidate.sourceHash
    )
      throw new CanonicalStoreError('CandidateChangedDuringMigration')
  }
  syncDirectory(root, snapshots(root, journal), port)
  journal.phase = 'snapshotted'
  journal.manifestHash = manifestHash(journal)
  writeJournal(root, journal, port)
  await inspectSnapshots(root, journal, options)
}
async function inspectSnapshots(
  root: string,
  journal: MigrationJournal,
  options: MigrationOptions
): Promise<void> {
  verifySnapshots(root, journal)
  for (const candidate of journal.candidates) {
    const inspection = await inspectCandidate(snapshotDirectory(root, journal, candidate.id), {
      root,
      scratchDir: path.join(operationDirectory(root, journal.migrationId), 'scratch'),
      binding: options.binding,
      fs: options.fs,
      fence: options.fence,
      timeoutMs: options.timeoutMs,
    })
    candidate.inspection = {
      schemaVersion: inspection.schemaVersion,
      catalogHash: inspection.catalogHash,
      tableHashes: inspection.tableHashes,
      counts: inspection.counts,
      empty: inspection.empty,
      ...(inspection.identity ? { identity: inspection.identity } : {}),
    }
    inspection.dispose()
  }
  journal.manifestHash = manifestHash(journal)
  writeJournal(root, journal, options.fs)
}
/** The only recursive removal in production. Only this attempt's real, unpromoted staging is disposable. */
export function resetStaging(
  root: string,
  journal: MigrationJournal,
  port: FsPort = nodeFs
): string {
  if (journal.phase !== 'snapshotted') throw new CanonicalStoreError('JournalInvalid')
  const directory = operationDirectory(root, journal.migrationId)
  safePath(root, directory)
  const staging = path.join(directory, 'staging')
  safePath(root, staging, true)
  if (path.relative(fs.realpathSync(directory), path.resolve(staging)) !== 'staging')
    throw new CanonicalStoreError('LayoutUnsafe')
  if (exists(staging)) treeFingerprint(root, staging)
  port.rmSync(staging, { recursive: true, force: true })
  port.mkdirSync(staging, { recursive: true, mode: 0o700 })
  safePath(root, staging)
  syncDirectory(root, staging, port)
  syncDirectory(root, directory, port)
  return staging
}
async function stage(
  root: string,
  journal: MigrationJournal,
  options: MigrationOptions
): Promise<void> {
  const port = options.fs ?? nodeFs
  verifySnapshots(root, journal)
  if (journal.candidates.some(candidate => !candidate.inspection))
    await inspectSnapshots(root, journal, options)
  if (!journal.recovery && journal.candidates.some(candidate => candidate.inspection?.identity)) {
    if (journal.writer === 'layout-precheck') throw new Error('CanonicalStoreLayoutRollback')
    throw new CanonicalStoreError('MarkerMismatch')
  }
  if (!journal.adoption) {
    if (journal.candidates.length === 0) {
      const provenance = options.provenance ?? journal.provenance
      if (!provenance) throw new CanonicalStoreError('SourceExportRequired')
      compareBinding(provenance, options.binding)
      if (
        !['new-host', 'verified-empty-sqlite'].includes(provenance.kind) ||
        !provenance.maintenanceId
      )
        throw new CanonicalStoreError('StoreModeUnknown')
      for (const directory of [root, path.join(root, 'state'), path.join(root, 'workspace')]) {
        if (
          exists(directory) &&
          fs.readdirSync(directory).some(name => /^state\.db.*\.bak$/.test(name))
        )
          throw new CanonicalStoreError('SourceExportRequired')
      }
      journal.provenance = provenance
      journal.decision = 'Created'
    } else {
      try {
        const decision = classifyCandidates(journal.candidates)
        journal.selected = decision.selected
        journal.decision = decision.decision
      } catch (error) {
        if (error instanceof CanonicalStoreError) {
          journal.blockedReason = error.reason
          writeJournal(root, journal, port)
        }
        throw error
      }
    }
  }
  journal.blockedReason = undefined
  const selected = journal.candidates.find(candidate => candidate.id === journal.selected)
  journal.variant =
    journal.writer === 'layout-precheck' && journal.selected === 'C_state'
      ? 'keep-existing-state'
      : 'promote-staging'
  let stagingDb: string | undefined
  if (journal.variant === 'promote-staging') {
    const staging = resetStaging(root, journal, port)
    stagingDb = path.join(staging, 'state.db')
    options.fence!.assertHeld()
    if (selected) {
      const normalized = await inspectCandidate(snapshotDirectory(root, journal, selected.id), {
        root,
        scratchDir: path.join(operationDirectory(root, journal.migrationId), 'scratch'),
        binding: options.binding,
        fs: port,
        fence: options.fence,
        timeoutMs: options.timeoutMs,
      })
      const source = new Database(normalized.normalizedPath, {
        readonly: true,
        fileMustExist: true,
      })
      try {
        const deadline = Date.now() + (options.timeoutMs ?? LIMITS.timeoutMs)
        await source.backup(stagingDb, {
          progress() {
            options.fence!.assertHeld()
            if (Date.now() > deadline) throw new CanonicalStoreError('ManifestTooLarge')
            return 128
          },
        })
      } finally {
        source.close()
        normalized.dispose()
      }
    }
    const db = new Database(stagingDb, { fileMustExist: !!selected })
    try {
      options.fence!.assertHeld()
      runMigrations(db)
      validateSupportedSchema(db)
      const identity = readIdentity(db, options.binding)
      if (journal.writer === 'canonical-store') {
        journal.identity =
          identity ??
          (journal.recovery
            ? journal.candidates.find(candidate => candidate.id === 'C_state')!.inspection!
                .identity!
            : {
                ...options.binding,
                storeId: randomUUID(),
                layoutVersion: 1,
                createdAt: new Date().toISOString(),
                provenance: journal.provenance?.kind ?? `migration:${journal.migrationId}`,
              })
        insertIdentity(db, journal.identity)
      } else if (identity) throw new Error('CanonicalStoreLayoutRollback')
      const fingerprint = catalogFingerprint(db)
      if (selected && fingerprint.catalogHash !== selected.inspection!.catalogHash)
        throw new CanonicalStoreError('CandidateChangedDuringMigration')
      journal.expectedCatalogHash = fingerprint.catalogHash
      db.pragma('journal_mode = DELETE')
    } finally {
      db.close()
    }
    for (const suffix of ['-wal', '-shm', '-journal'])
      if (exists(`${stagingDb}${suffix}`)) throw new CanonicalStoreError('CandidateIncomplete')
    fs.chmodSync(stagingDb, 0o600)
    syncFile(root, stagingDb, port)
    syncDirectory(root, path.dirname(stagingDb), port)
    journal.stagingSha256 = fileHash(root, stagingDb)
  } else journal.expectedCatalogHash = selected!.inspection!.catalogHash
  journal.operations = journal.candidates.flatMap(candidate =>
    journal.variant === 'keep-existing-state' && candidate.id === 'C_state'
      ? []
      : candidate.files
          .filter(file => file.present)
          .map(file => ({
            kind: 'sqlite' as const,
            candidate: candidate.id,
            name: file.name,
            fingerprint: file.sha256!,
            size: file.size,
            state: 'pending' as const,
          }))
  )
  if (journal.variant === 'promote-staging')
    journal.operations.push({
      kind: 'promotion',
      name: 'state.db',
      fingerprint: journal.stagingSha256!,
      size: fs.statSync(stagingDb!).size,
      state: 'pending',
    })
  journal.phase = 'staged'
  writeJournal(root, journal, port)
}
function operationPaths(
  root: string,
  journal: MigrationJournal,
  operation: MoveOperation
): { source: string; destination: string } {
  if (operation.kind === 'sqlite')
    return {
      source: path.join(candidateDirectory(root, operation.candidate!), operation.name),
      destination: path.join(
        operationDirectory(root, journal.migrationId),
        'retired',
        candidateKey(operation.candidate!),
        operation.name
      ),
    }
  if (operation.kind === 'promotion')
    return {
      source: path.join(operationDirectory(root, journal.migrationId), 'staging', 'state.db'),
      destination: path.join(root, 'state', 'state.db'),
    }
  return {
    source: path.join(root, operation.name),
    destination: path.join(root, 'workspace', operation.name),
  }
}
function matches(root: string, file: string, operation: MoveOperation): boolean {
  if (operation.kind === 'workspace') {
    const tree = treeFingerprint(root, file)
    return (
      tree.fingerprint === operation.fingerprint &&
      tree.size === operation.size &&
      tree.entries === operation.entries &&
      objectHash(tree.identity) === objectHash(operation.identity)
    )
  }
  safePath(root, file)
  return (
    fs.statSync(file).isFile() &&
    fs.statSync(file).size === operation.size &&
    fileHash(root, file) === operation.fingerprint
  )
}
function validatePendingLayout(root: string, journal: MigrationJournal): void {
  verifySnapshots(root, journal)
  const known = new Map(journal.candidates.map(candidate => [candidate.id, candidate]))
  const ids: CandidateId[] = ['C_root', 'C_ws', 'C_state']
  const imports = path.join(root, '.canonical-store-import')
  if (exists(imports))
    for (const id of fs.readdirSync(imports)) {
      assertUuid(id)
      ids.push(`C_import:${id}`)
    }
  const promotion = journal.operations.find(operation => operation.kind === 'promotion')
  for (const id of ids) {
    const directory = candidateDirectory(root, id)
    if (!exists(directory)) continue
    for (const name of SQLITE_FILES) {
      const file = path.join(directory, name)
      if (!exists(file)) continue
      const candidate = known.get(id)
      const fingerprint = candidate?.files.find(file => file.name === name && file.present)
      const isPromoted =
        id === 'C_state' &&
        name === 'state.db' &&
        promotion &&
        promotion.state !== 'pending' &&
        !exists(operationPaths(root, journal, promotion).source) &&
        matches(root, file, promotion)
      if (
        !isPromoted &&
        (!fingerprint ||
          fileHash(root, file) !== fingerprint.sha256 ||
          fs.statSync(file).size !== fingerprint.size)
      ) {
        throw new CanonicalStoreError(
          candidate ? 'CandidateChangedDuringMigration' : 'ForeignCandidateDuringMigration'
        )
      }
    }
  }
  const names = new Set(journal.workspace.map(operation => operation.name))
  for (const name of fs.readdirSync(root)) {
    if (
      ['workspace', 'state', 'lost+found'].includes(name) ||
      name.startsWith('.canonical-store') ||
      name.startsWith('.clerum-canonical-store') ||
      isReservedSqliteName(name)
    )
      continue
    assertNotUnknownSqliteArtifact(root, name)
    if (!names.has(name)) throw new CanonicalStoreError('ForeignCandidateDuringMigration')
  }
  // Revalidate all workspace sinks before any database retirement, and on every resume.
  for (const operation of journal.workspace) {
    const locations = operationPaths(root, journal, operation)
    const source = exists(locations.source)
    const destination = exists(locations.destination)
    if (
      source === destination ||
      (source && !matches(root, locations.source, operation)) ||
      (destination &&
        (operation.state === 'pending' || !matches(root, locations.destination, operation)))
    ) {
      throw new CanonicalStoreError('WorkspaceEntryCollision')
    }
  }
}
function move(
  root: string,
  journal: MigrationJournal,
  operation: MoveOperation,
  options: MigrationOptions
): void {
  const port = options.fs ?? nodeFs
  const { source, destination } = operationPaths(root, journal, operation)
  options.fence!.assertHeld()
  safePath(root, source, true)
  safePath(root, destination, true)
  const atSource = exists(source)
  const atDestination = exists(destination)
  if (operation.state === 'done') {
    if (!atDestination || !matches(root, destination, operation))
      throw new CanonicalStoreError('FileMoveConflict')
    if (atSource) {
      const promoted = journal.operations.find(op => op.kind === 'promotion')
      const reusedByPromotion =
        operation.kind === 'sqlite' &&
        operation.candidate === 'C_state' &&
        operation.name === 'state.db' &&
        promoted &&
        promoted.state !== 'pending' &&
        !exists(operationPaths(root, journal, promoted).source) &&
        matches(root, source, promoted)
      if (!reusedByPromotion) throw new CanonicalStoreError('FileMoveConflict')
    }
    return
  }
  if (
    atSource === atDestination ||
    (atSource && !matches(root, source, operation)) ||
    (atDestination && !matches(root, destination, operation))
  ) {
    throw new CanonicalStoreError('FileMoveConflict')
  }
  if (operation.state === 'pending' && atDestination)
    throw new CanonicalStoreError('FileMoveConflict')
  if (operation.state === 'pending') {
    operation.state = 'intent'
    writeJournal(root, journal, port)
  }
  if (atSource) {
    privateDirectory(root, path.dirname(destination), port)
    safePath(root, source)
    safePath(root, destination, true)
    if (exists(destination) || !matches(root, source, operation))
      throw new CanonicalStoreError('FileMoveConflict')
    options.fence!.assertHeld()
    port.renameSync(source, destination)
  }
  // Also repeat both fsyncs after a crash between rename and either sync.
  syncDirectory(root, path.dirname(source), port)
  syncDirectory(root, path.dirname(destination), port)
  operation.state = 'done'
  writeJournal(root, journal, port)
}
async function validatePromoted(
  root: string,
  journal: MigrationJournal,
  options: MigrationOptions
): Promise<void> {
  const result = await inspectCandidate(path.join(root, 'state'), {
    root,
    scratchDir: path.join(operationDirectory(root, journal.migrationId), 'scratch'),
    binding: options.binding,
    fs: options.fs,
    fence: options.fence,
    timeoutMs: options.timeoutMs,
  })
  result.dispose()
  if (
    result.catalogHash !== journal.expectedCatalogHash ||
    (journal.identity && result.identity?.storeId !== journal.identity.storeId)
  ) {
    throw new CanonicalStoreError('CandidateChangedDuringMigration')
  }
}
function legacyMarker(journal: MigrationJournal): LegacyLayoutMarker {
  return {
    markerVersion: 1,
    layoutVersion: 1,
    storageContract: 'legacy-floor',
    hostUid: journal.hostUid,
    pvcUid: journal.pvcUid,
    migrationId: journal.migrationId,
    databasePath: 'state/state.db',
    writerFenceRoot: 'state',
  }
}
function journalOutcome(journal: MigrationJournal): InitOutcome {
  return journal.writer === 'layout-precheck'
    ? legacyOutcome(journal.decision!, legacyMarker(journal))
    : outcome(journal.decision!, journal.identity)
}
/** Each correlated marker retirement has its own durable intent/done and both directory syncs. */
function retireRecoveryMarker(
  root: string,
  journal: MigrationJournal,
  source: string,
  retained: string,
  moveField: 'previousMarkerMove' | 'previousStateMarkerMove',
  port: FsPort
): void {
  const recovery = journal.recovery!
  const atSource =
    exists(source) && objectHash(readJson(root, source)) === objectHash(recovery.previousMarker)
  const atRetained = exists(retained)
  if (
    (atSource && atRetained) ||
    (!atSource && !atRetained) ||
    (atRetained && objectHash(readJson(root, retained)) !== objectHash(recovery.previousMarker))
  )
    throw new CanonicalStoreError('MarkerMismatch')
  if (recovery[moveField] === 'pending') {
    if (atRetained) throw new CanonicalStoreError('MarkerMismatch')
    recovery[moveField] = 'intent'
    writeJournal(root, journal, port)
  }
  if (recovery[moveField] === 'intent') {
    if (atSource) {
      safePath(root, retained, true)
      port.renameSync(source, retained)
    }
    syncDirectory(root, path.dirname(source), port)
    syncDirectory(root, path.dirname(retained), port)
    recovery[moveField] = 'done'
    writeJournal(root, journal, port)
  } else if (atSource || !atRetained) throw new CanonicalStoreError('MarkerMismatch')
}
function finish(root: string, journal: MigrationJournal, options: MigrationOptions): void {
  const port = options.fs ?? nodeFs
  options.fence!.assertHeld()
  // The committed layout includes both real subPath directories even when no workspace entry needed relocation.
  privateDirectory(root, path.join(root, 'workspace'), port)
  const moving = path.join(root, MIGRATING_MARKER)
  const directory = operationDirectory(root, journal.migrationId)
  const receipt = path.join(directory, 'migration-marker.json')
  if (journal.writer === 'canonical-store') {
    const expected = {
      markerVersion: 1,
      layoutVersion: 1,
      storeId: journal.identity!.storeId,
      ...options.binding,
      migrationId: journal.migrationId,
    }
    if (journal.recovery)
      retireRecoveryMarker(
        root,
        journal,
        path.join(root, FINAL_MARKER),
        path.join(directory, 'previous-marker.json'),
        'previousMarkerMove',
        port
      )
    const previous = readMarker(root, options.binding)
    if (previous && objectHash(previous) !== objectHash(expected))
      throw new CanonicalStoreError('MarkerMismatch')
    if (!previous) atomicJson(root, path.join(root, FINAL_MARKER), expected, port)
  } else {
    const expected = legacyMarker(journal)
    const rootFile = path.join(root, LEGACY_MARKER)
    const stateFile = path.join(root, 'state', '.canonical-store', LEGACY_STATE_RECORD)
    if (journal.recovery) {
      retireRecoveryMarker(
        root,
        journal,
        rootFile,
        path.join(directory, 'previous-marker.json'),
        'previousMarkerMove',
        port
      )
      retireRecoveryMarker(
        root,
        journal,
        stateFile,
        path.join(directory, 'previous-state-marker.json'),
        'previousStateMarkerMove',
        port
      )
    }
    for (const [file, previous] of [
      [rootFile, readLegacyMarker(root, options.binding)],
      [stateFile, readLegacyStateRecord(path.join(root, 'state'), options.binding)],
    ] as const) {
      if (previous && objectHash(previous) !== objectHash(expected))
        throw new CanonicalStoreError('MarkerMismatch')
      if (!previous) atomicJson(root, file, expected, port)
    }
    // Both floor records are durable before completion; a crash leaves the active journal as the only continuation authority.
    syncDirectory(root, root, port)
    syncDirectory(root, path.dirname(stateFile), port)
  }
  if (exists(moving)) {
    ensureMigratingMarker(root, journal, port)
    if (exists(receipt)) throw new CanonicalStoreError('MarkerMismatch')
    safePath(root, receipt, true)
    port.renameSync(moving, receipt)
    syncDirectory(root, root, port)
    syncDirectory(root, directory, port)
  } else if (!exists(receipt)) throw new CanonicalStoreError('MarkerMismatch')
  else {
    const expected = {
      markerVersion: 1,
      migrationId: journal.migrationId,
      hostUid: journal.hostUid,
      pvcUid: journal.pvcUid,
    }
    if (objectHash(readJson(root, receipt)) !== objectHash(expected))
      throw new CanonicalStoreError('MarkerMismatch')
    syncDirectory(root, root, port)
    syncDirectory(root, directory, port)
  }
  if (journal.adoption) {
    const file = path.join(directory, `adoption-${journal.adoption.request.requestId}.json`)
    const receipt = {
      receiptVersion: 1,
      ...journal.adoption.request,
      ...(journal.identity
        ? { storeId: journal.identity.storeId }
        : { storageContract: 'legacy-floor' }),
      principal: journal.adoption.principal,
      consumed: true,
    }
    if (exists(file) && objectHash(readJson(root, file)) !== objectHash(receipt))
      throw new CanonicalStoreError('AdoptReplay')
    if (!exists(file)) atomicJson(root, file, receipt, port)
  }
  for (const candidate of journal.candidates.filter(candidate =>
    candidate.id.startsWith('C_import:')
  )) {
    const exportId = candidate.id.slice(9)
    const file = path.join(root, '.canonical-store-import', exportId, 'consumed.json')
    const receipt = {
      consumptionVersion: 1,
      ...options.binding,
      exportId,
      migrationId: journal.migrationId,
      sourceHash: candidate.sourceHash,
    }
    if (exists(file) && objectHash(readJson(root, file)) !== objectHash(receipt))
      throw new CanonicalStoreError('JournalInvalid')
    if (!exists(file)) atomicJson(root, file, receipt, port)
  }
  journal.phase = 'completed'
  writeJournal(root, journal, port)
  archiveJournal(root, journal, port)
}
/** Resume only the durable operation decision after staged; never reclassify partial retired sets. */
export async function continueMigration(
  root: string,
  journal: MigrationJournal,
  options: MigrationOptions
): Promise<InitOutcome> {
  const port = options.fs ?? nodeFs
  options.fence!.assertHeld()
  completeDirectoryAllocation(root, journal, port)
  if (journal.phase === 'completed') {
    finish(root, journal, options)
    return journalOutcome(journal)
  }
  if (exists(path.join(root, MIGRATING_MARKER))) ensureMigratingMarker(root, journal, port)
  else if (['started', 'snapshotted', 'staged', 'retiring', 'promoted'].includes(journal.phase))
    ensureMigratingMarker(root, journal, port)
  if (journal.phase === 'started') await snapshot(root, journal, options)
  if (journal.phase === 'snapshotted') await stage(root, journal, options)
  if (journal.phase === 'staged') {
    journal.phase = 'retiring'
    writeJournal(root, journal, port)
  }
  if (journal.phase === 'retiring') {
    validatePendingLayout(root, journal)
    for (const operation of journal.operations.filter(operation => operation.kind === 'sqlite'))
      move(root, journal, operation, options)
    for (const operation of journal.operations.filter(operation => operation.kind === 'promotion'))
      move(root, journal, operation, options)
    await validatePromoted(root, journal, options)
    journal.phase = 'promoted'
    writeJournal(root, journal, port)
  }
  if (journal.phase === 'promoted') {
    journal.phase = 'relocating'
    writeJournal(root, journal, port)
  }
  if (journal.phase === 'relocating') {
    validatePendingLayout(root, journal)
    for (const operation of journal.workspace) move(root, journal, operation, options)
    await validatePromoted(root, journal, options)
    finish(root, journal, options)
  }
  return journalOutcome(journal)
}
export async function runMigration(
  rootInput: string,
  options: MigrationOptions
): Promise<InitOutcome> {
  const root = path.resolve(rootInput)
  safePath(root, root)
  validateBinding(options.binding)
  const port = options.fs ?? nodeFs
  privateDirectory(root, path.join(root, 'state'), port)
  const ownedFence = options.fence
    ? undefined
    : acquireWriterFence({
        stateDir: path.join(root, 'state'),
        timeoutMs: options.timeoutMs ?? 1000,
      })
  const effective = { ...options, fence: options.fence ?? ownedFence! }
  try {
    effective.fence.assertHeld()
    let journal = readJournal(root, options.binding)
    if (journal) {
      if (options.operator || journal.operator) {
        if (!options.operator) throw new CanonicalStoreError('AdoptUnauthorized')
        assertOperatorMigrationContext(journal, options.operator, options.provenance)
      }
      if (journal.writer !== (options.writer ?? 'canonical-store'))
        throw new CanonicalStoreError('MigrationInProgress')
      return await continueMigration(root, journal, effective)
    }
    if (exists(path.join(root, MIGRATING_MARKER))) throw new CanonicalStoreError('JournalInvalid')
    const marker = readMarker(root, options.binding)
    if (marker) {
      if (options.writer === 'layout-precheck') throw new Error('CanonicalStoreLayoutRollback')
      assertNoForeignLayoutCandidates(root, options.binding)
      const identity = validateCanonicalStore({
        stateDir: path.join(root, 'state'),
        binding: options.binding,
        root,
      })
      const archivedPath = path.join(operationDirectory(root, marker.migrationId), 'journal.json')
      if (!exists(archivedPath)) throw new CanonicalStoreError('MarkerMismatch')
      const archived = validateJournal(readJson(root, archivedPath), options.binding)
      if (options.operator)
        assertOperatorMigrationContext(archived, options.operator, options.provenance)
      if (
        archived.phase !== 'completed' ||
        archived.identity?.storeId !== identity.storeId ||
        archived.migrationId !== marker.migrationId
      )
        throw new CanonicalStoreError('MarkerMismatch')
      syncDirectory(root, path.dirname(archivedPath), port)
      syncDirectory(root, path.dirname(activeJournalPath(root)), port)
      return outcome('AlreadyCanonical', identity)
    }
    const legacy = readLegacyMarker(root, options.binding)
    if (legacy) {
      const committed = validateLegacyStore({
        root,
        stateDir: path.join(root, 'state'),
        binding: options.binding,
      })
      assertNoForeignLayoutCandidates(root, options.binding)
      if (options.writer === 'layout-precheck') {
        const archivedPath = path.join(operationDirectory(root, legacy.migrationId), 'journal.json')
        const archived = validateJournal(readJson(root, archivedPath), options.binding)
        if (options.operator)
          assertOperatorMigrationContext(archived, options.operator, options.provenance)
        syncDirectory(root, path.dirname(archivedPath), port)
        syncDirectory(root, path.dirname(activeJournalPath(root)), port)
        return legacyOutcome('AlreadyLegacy', committed)
      }
      // Canonical activation adds identity to the floor's current catalog; the workspace is already relocated.
      assertNoPendingWorkspaceRelocation(root)
    }
    const ids = discoverCandidates(root, options.binding)
    // Check all sources and workspace destinations before making any durable transition.
    const workspace = workspaceManifest(root)
    const bytes = ids
      .flatMap(id => fingerprints(root, candidateDirectory(root, id)))
      .reduce((sum, file) => sum + file.size, 0)
    checkDisk(root, bytes, effective)
    if (ids.length === 0) {
      if (!options.provenance || discoverBackupSets(root).length > 0)
        throw new CanonicalStoreError('SourceExportRequired')
      const records = path.join(root, 'state', '.canonical-store')
      for (const entry of fs.readdirSync(records)) {
        if (/^[0-9a-f-]{36}$/i.test(entry) || entry === LEGACY_STATE_RECORD)
          throw new CanonicalStoreError('SourceExportRequired')
      }
    }
    if (
      ids.length === 0 &&
      options.writer === 'layout-precheck' &&
      (options.provenance?.kind !== 'new-host' ||
        options.operator?.kind !== 'legacy-floor-new-host-initialization' ||
        options.operator.storageContract !== 'legacy-floor' ||
        !options.operator.provisioning)
    )
      throw new CanonicalStoreError('SourceExportRequired')
    void workspace
    journal = beginMigration(root, {
      binding: options.binding,
      writer: options.writer ?? 'canonical-store',
      fs: port,
      provenance: options.provenance,
      operator: options.operator,
      fence: effective.fence,
    })
    if (options.provenance) journal.provenance = options.provenance
    return await continueMigration(root, journal, effective)
  } finally {
    ownedFence?.close()
  }
}
