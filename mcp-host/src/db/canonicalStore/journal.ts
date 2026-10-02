import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { type FsPort, nodeFs } from './fsPort'
import {
  SQLITE_FILES,
  assertUuid,
  candidateDirectory,
  compareBinding,
  exists,
  isReservedSqliteName,
  objectHash,
  operationDirectory,
  privateDirectory,
  safePath,
  syncDirectory,
} from './paths'
import {
  type Binding,
  type CandidateManifest,
  CanonicalStoreError,
  type FinalMarker,
  LIMITS,
  type LegacyLayoutMarker,
  type MigrationJournal,
  type MoveOperation,
  type NewStoreProvenance,
  type OperatorMigrationContext,
  REASON_EXITS,
  type WriterFence,
} from './types'

export const FINAL_MARKER = '.clerum-canonical-store'
export const MIGRATING_MARKER = '.clerum-canonical-store-migrating'
export const LEGACY_MARKER = '.clerum-canonical-store-legacy'
export const LEGACY_STATE_RECORD = 'legacy-layout.json'
export function activeJournalPath(root: string): string {
  return path.join(root, 'state', '.canonical-store', 'journal.json')
}
const hashPattern = /^[0-9a-f]{64}$/
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
function keys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key)))
    throw new CanonicalStoreError('JournalInvalid')
}
function hash(value: unknown): void {
  if (typeof value !== 'string' || !hashPattern.test(value))
    throw new CanonicalStoreError('JournalInvalid')
}
function operation(value: MoveOperation): void {
  if (!object(value)) throw new CanonicalStoreError('JournalInvalid')
  keys(value, ['kind', 'candidate', 'name', 'fingerprint', 'size', 'state', 'identity', 'entries'])
  if (
    !['sqlite', 'workspace', 'promotion'].includes(value.kind) ||
    !['pending', 'intent', 'done'].includes(value.state) ||
    typeof value.name !== 'string' ||
    !value.name ||
    value.name === '.' ||
    value.name === '..' ||
    /[\/\\\x00]/.test(value.name) ||
    !Number.isSafeInteger(value.size) ||
    value.size < 0 ||
    value.size > LIMITS.maxBytes
  )
    throw new CanonicalStoreError('JournalInvalid')
  hash(value.fingerprint)
  if (value.kind === 'sqlite') {
    if (!SQLITE_FILES.includes(value.name as (typeof SQLITE_FILES)[number]) || !value.candidate)
      throw new CanonicalStoreError('JournalInvalid')
    candidateDirectory('/', value.candidate)
  } else if (
    value.candidate !== undefined ||
    (value.kind === 'promotion' && value.name !== 'state.db')
  )
    throw new CanonicalStoreError('JournalInvalid')
  if (value.kind === 'workspace') {
    if (
      !object(value.identity) ||
      !Number.isSafeInteger(value.identity.dev) ||
      !Number.isSafeInteger(value.identity.ino) ||
      !Number.isSafeInteger(value.entries) ||
      value.entries! < 1 ||
      value.entries! > LIMITS.maxEntries
    )
      throw new CanonicalStoreError('JournalInvalid')
    keys(value.identity, ['dev', 'ino'])
  } else if (value.identity !== undefined || value.entries !== undefined)
    throw new CanonicalStoreError('JournalInvalid')
  if (
    value.kind === 'workspace' &&
    (['workspace', 'state', 'lost+found'].includes(value.name) ||
      value.name.startsWith('.canonical-store') ||
      value.name.startsWith('.clerum-canonical-store') ||
      isReservedSqliteName(value.name))
  )
    throw new CanonicalStoreError('JournalInvalid')
}
function candidate(value: CandidateManifest): void {
  if (!object(value)) throw new CanonicalStoreError('JournalInvalid')
  keys(value, ['id', 'files', 'sourceHash', 'inspection'])
  candidateDirectory('/', value.id)
  hash(value.sourceHash)
  if (!Array.isArray(value.files) || value.files.length !== SQLITE_FILES.length)
    throw new CanonicalStoreError('JournalInvalid')
  for (let i = 0; i < value.files.length; i++) {
    const file = value.files[i]
    if (!object(file)) throw new CanonicalStoreError('JournalInvalid')
    keys(file, ['name', 'present', 'size', 'sha256'])
    if (
      file.name !== SQLITE_FILES[i] ||
      typeof file.present !== 'boolean' ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      file.size > LIMITS.maxBytes ||
      (!file.present && (file.size !== 0 || file.sha256 !== null))
    )
      throw new CanonicalStoreError('JournalInvalid')
    if (file.present) hash(file.sha256)
  }
  if (objectHash(value.files) !== value.sourceHash) throw new CanonicalStoreError('JournalInvalid')
  if (value.inspection) {
    keys(value.inspection as unknown as Record<string, unknown>, [
      'schemaVersion',
      'catalogHash',
      'tableHashes',
      'counts',
      'empty',
      'identity',
    ])
    hash(value.inspection.catalogHash)
    if (
      !Number.isSafeInteger(value.inspection.schemaVersion) ||
      value.inspection.schemaVersion < 1 ||
      typeof value.inspection.empty !== 'boolean' ||
      !object(value.inspection.tableHashes) ||
      !object(value.inspection.counts)
    )
      throw new CanonicalStoreError('JournalInvalid')
    for (const entry of Object.values(value.inspection.tableHashes)) hash(entry)
    for (const entry of Object.values(value.inspection.counts))
      if (!Number.isSafeInteger(entry) || entry < 0) throw new CanonicalStoreError('JournalInvalid')
  }
}
export function validateJournal(value: unknown, binding: Binding): MigrationJournal {
  try {
    if (!object(value)) throw new CanonicalStoreError('JournalInvalid')
    keys(value, [
      'journalVersion',
      'migrationId',
      'writer',
      'phase',
      'hostUid',
      'pvcUid',
      'candidates',
      'manifestHash',
      'workspace',
      'operations',
      'decision',
      'selected',
      'variant',
      'expectedCatalogHash',
      'stagingSha256',
      'identity',
      'blockedReason',
      'provenance',
      'adoption',
      'recovery',
      'allocation',
      'operator',
    ])
    const journal = value as unknown as MigrationJournal
    if (
      journal.journalVersion !== 1 ||
      !['canonical-store', 'layout-precheck'].includes(journal.writer) ||
      ![
        'started',
        'snapshotted',
        'staged',
        'retiring',
        'promoted',
        'relocating',
        'completed',
      ].includes(journal.phase)
    )
      throw new CanonicalStoreError('JournalInvalid')
    assertUuid(journal.migrationId)
    compareBinding(journal, binding)
    if (
      !Array.isArray(journal.candidates) ||
      journal.candidates.length > LIMITS.maxCandidates ||
      !Array.isArray(journal.workspace) ||
      !Array.isArray(journal.operations) ||
      journal.workspace.length + journal.operations.length > LIMITS.maxEntries
    ) {
      throw new CanonicalStoreError('JournalInvalid')
    }
    journal.candidates.forEach(candidate)
    if (
      new Set(journal.candidates.map(candidate => candidate.id)).size !== journal.candidates.length
    )
      throw new CanonicalStoreError('JournalInvalid')
    journal.workspace.forEach(operation)
    journal.operations.forEach(operation)
    if (
      journal.workspace.some(op => op.kind !== 'workspace') ||
      journal.operations.some(op => op.kind === 'workspace')
    )
      throw new CanonicalStoreError('JournalInvalid')
    const ops = [...journal.workspace, ...journal.operations].map(
      op => `${op.kind}/${op.candidate ?? ''}/${op.name}`
    )
    if (new Set(ops).size !== ops.length) throw new CanonicalStoreError('JournalInvalid')
    for (const value of [journal.manifestHash, journal.expectedCatalogHash, journal.stagingSha256])
      if (value !== undefined) hash(value)
    if (journal.blockedReason && !(journal.blockedReason in REASON_EXITS))
      throw new CanonicalStoreError('JournalInvalid')
    if (
      journal.phase !== 'started' &&
      journal.selected &&
      !journal.candidates.some(candidate => candidate.id === journal.selected)
    )
      throw new CanonicalStoreError('JournalInvalid')
    if (
      journal.decision &&
      ![
        'Created',
        'SingleCandidate',
        'EquivalentCandidates',
        'EmptyCandidateRetired',
        'Adopted',
      ].includes(journal.decision)
    )
      throw new CanonicalStoreError('JournalInvalid')
    if (journal.variant && !['keep-existing-state', 'promote-staging'].includes(journal.variant))
      throw new CanonicalStoreError('JournalInvalid')
    if (journal.identity) {
      keys(journal.identity as unknown as Record<string, unknown>, [
        'storeId',
        'layoutVersion',
        'createdAt',
        'provenance',
        'hostUid',
        'pvcUid',
      ])
      assertUuid(journal.identity.storeId)
      compareBinding(journal.identity, binding)
      if (
        journal.identity.layoutVersion !== 1 ||
        typeof journal.identity.createdAt !== 'string' ||
        !Number.isFinite(Date.parse(journal.identity.createdAt)) ||
        typeof journal.identity.provenance !== 'string' ||
        !journal.identity.provenance
      )
        throw new CanonicalStoreError('JournalInvalid')
    }
    if (journal.operator) {
      keys(journal.operator as unknown as Record<string, unknown>, [
        'kind',
        'storageContract',
        'requestId',
        'maintenanceId',
        'principal',
        'sourceClass',
        'verifiedManifestHash',
        'requestHash',
        'provisioning',
      ])
      const operator = journal.operator
      assertUuid(operator.requestId)
      hash(operator.verifiedManifestHash)
      hash(operator.requestHash)
      const legacy =
        operator.kind === 'legacy-floor-migration' ||
        operator.kind === 'legacy-floor-new-host-initialization'
      if (
        journal.writer !== (legacy ? 'layout-precheck' : 'canonical-store') ||
        journal.recovery ||
        (legacy
          ? operator.storageContract !== 'legacy-floor'
          : operator.storageContract !== undefined && operator.storageContract !== 'canonical') ||
        ![
          'canonical-migration',
          'canonical-new-host-initialization',
          'legacy-floor-migration',
          'legacy-floor-new-host-initialization',
        ].includes(operator.kind) ||
        !['sqlite-pvc', 'sqlite-external-exported', 'new-host'].includes(operator.sourceClass) ||
        typeof operator.maintenanceId !== 'string' ||
        !operator.maintenanceId ||
        operator.maintenanceId.length > 256 ||
        typeof operator.principal !== 'string' ||
        !operator.principal ||
        operator.principal.length > 256
      )
        throw new CanonicalStoreError('JournalInvalid')
      if (
        operator.kind === 'canonical-new-host-initialization' ||
        operator.kind === 'legacy-floor-new-host-initialization'
      ) {
        if (
          !object(operator.provisioning) ||
          operator.sourceClass !== 'new-host' ||
          journal.provenance?.kind !== 'new-host' ||
          journal.provenance.maintenanceId !== operator.maintenanceId
        )
          throw new CanonicalStoreError('JournalInvalid')
        keys(operator.provisioning, ['hostUid', 'pvcUid', 'createdAt'])
        compareBinding(operator.provisioning, binding)
        if (
          typeof operator.provisioning.createdAt !== 'string' ||
          !Number.isFinite(Date.parse(operator.provisioning.createdAt))
        )
          throw new CanonicalStoreError('JournalInvalid')
      } else if (
        operator.sourceClass === 'new-host' ||
        operator.provisioning !== undefined ||
        journal.provenance !== undefined
      )
        throw new CanonicalStoreError('JournalInvalid')
    }
    if (journal.writer === 'layout-precheck' && journal.identity)
      throw new CanonicalStoreError('JournalInvalid')
    if (journal.provenance) {
      keys(journal.provenance as unknown as Record<string, unknown>, [
        'kind',
        'hostUid',
        'pvcUid',
        'maintenanceId',
      ])
      compareBinding(journal.provenance, binding)
      if (
        !['new-host', 'verified-empty-sqlite'].includes(journal.provenance.kind) ||
        typeof journal.provenance.maintenanceId !== 'string' ||
        !journal.provenance.maintenanceId ||
        journal.provenance.maintenanceId.length > 256
      )
        throw new CanonicalStoreError('JournalInvalid')
    }
    if (journal.adoption) {
      keys(journal.adoption as unknown as Record<string, unknown>, [
        'request',
        'principal',
        'consumed',
      ])
      const request = journal.adoption.request
      keys(request as unknown as Record<string, unknown>, [
        'schemaVersion',
        'requestId',
        'maintenanceId',
        'migrationId',
        'manifestHash',
        'candidateHash',
        'hostUid',
        'pvcUid',
        'storageContract',
        'expectedStoreId',
        'expectedMigrationId',
        'expectedCurrentCatalogHash',
      ])
      const floor = journal.writer === 'layout-precheck'
      if (
        (floor &&
          (!('storageContract' in request) ||
            request.storageContract !== 'legacy-floor' ||
            'expectedStoreId' in request)) ||
        (!floor &&
          (('storageContract' in request && request.storageContract !== 'canonical') ||
            'expectedMigrationId' in request))
      )
        throw new CanonicalStoreError('JournalInvalid')
      assertUuid(request.requestId)
      assertUuid(request.migrationId)
      compareBinding(request, binding)
      hash(request.manifestHash)
      hash(request.candidateHash)
      if (
        request.schemaVersion !== 1 ||
        request.migrationId !== journal.migrationId ||
        (journal.phase !== 'started' &&
          journal.candidates.every(candidate => candidate.inspection) &&
          request.manifestHash !== journal.manifestHash) ||
        typeof request.maintenanceId !== 'string' ||
        !request.maintenanceId ||
        typeof journal.adoption.principal !== 'string' ||
        !journal.adoption.principal ||
        journal.adoption.consumed !== true
      )
        throw new CanonicalStoreError('JournalInvalid')
    }
    if (journal.recovery) {
      keys(journal.recovery as unknown as Record<string, unknown>, [
        'request',
        'principal',
        'selectedCandidate',
        'previousMarker',
        'previousMarkerMove',
        'previousStateMarkerMove',
      ])
      if (
        !journal.adoption ||
        objectHash(journal.recovery.request) !== objectHash(journal.adoption.request) ||
        journal.recovery.principal !== journal.adoption.principal ||
        !['pending', 'intent', 'done'].includes(journal.recovery.previousMarkerMove)
      )
        throw new CanonicalStoreError('JournalInvalid')
      const request = journal.recovery.request
      candidateDirectory('/', journal.recovery.selectedCandidate)
      if (
        !journal.recovery.selectedCandidate.startsWith('C_import:') ||
        journal.selected !== journal.recovery.selectedCandidate ||
        journal.decision !== 'Adopted'
      )
        throw new CanonicalStoreError('JournalInvalid')
      const floor = journal.writer === 'layout-precheck'
      hash(request.expectedCurrentCatalogHash)
      const marker = journal.recovery.previousMarker
      compareBinding(marker, binding)
      assertUuid(marker.migrationId)
      if (floor) {
        keys(marker as unknown as Record<string, unknown>, [
          'markerVersion',
          'layoutVersion',
          'storageContract',
          'hostUid',
          'pvcUid',
          'migrationId',
          'databasePath',
          'writerFenceRoot',
        ])
        if (
          !('expectedMigrationId' in request) ||
          !('storageContract' in marker) ||
          request.storageContract !== 'legacy-floor' ||
          marker.storageContract !== 'legacy-floor' ||
          marker.migrationId !== request.expectedMigrationId ||
          marker.databasePath !== 'state/state.db' ||
          marker.writerFenceRoot !== 'state' ||
          !['pending', 'intent', 'done'].includes(journal.recovery.previousStateMarkerMove ?? '')
        )
          throw new CanonicalStoreError('JournalInvalid')
        assertUuid(request.expectedMigrationId)
      } else {
        keys(marker as unknown as Record<string, unknown>, [
          'markerVersion',
          'layoutVersion',
          'storeId',
          'hostUid',
          'pvcUid',
          'migrationId',
        ])
        if (
          !('expectedStoreId' in request) ||
          !('storeId' in marker) ||
          marker.storeId !== request.expectedStoreId ||
          journal.recovery.previousStateMarkerMove !== undefined
        )
          throw new CanonicalStoreError('JournalInvalid')
        assertUuid(request.expectedStoreId)
        if (journal.identity && journal.identity.storeId !== request.expectedStoreId)
          throw new CanonicalStoreError('JournalInvalid')
      }
      if (marker.markerVersion !== 1 || marker.layoutVersion !== 1)
        throw new CanonicalStoreError('JournalInvalid')
      if (
        journal.candidates.find(candidate => candidate.id === 'C_state')?.inspection &&
        journal.candidates.find(candidate => candidate.id === 'C_state')?.inspection
          ?.catalogHash !== request.expectedCurrentCatalogHash
      )
        throw new CanonicalStoreError('JournalInvalid')
      if (
        journal.phase === 'completed' &&
        (journal.recovery.previousMarkerMove !== 'done' ||
          (floor && journal.recovery.previousStateMarkerMove !== 'done'))
      )
        throw new CanonicalStoreError('JournalInvalid')
    }
    if (journal.recovery && !journal.allocation) throw new CanonicalStoreError('JournalInvalid')
    if (journal.allocation) {
      keys(journal.allocation as unknown as Record<string, unknown>, [
        'state',
        'ownerUid',
        'ownerGid',
        'identity',
      ])
      if (
        !journal.recovery ||
        !['intent', 'done'].includes(journal.allocation.state) ||
        !Number.isSafeInteger(journal.allocation.ownerUid) ||
        journal.allocation.ownerUid < 0 ||
        !Number.isSafeInteger(journal.allocation.ownerGid) ||
        journal.allocation.ownerGid < 0 ||
        (journal.allocation.state === 'intent' && journal.phase !== 'started')
      )
        throw new CanonicalStoreError('JournalInvalid')
      if (journal.allocation.state === 'done') {
        const identity = journal.allocation.identity
        if (!object(identity)) throw new CanonicalStoreError('JournalInvalid')
        keys(identity, ['dev', 'ino'])
        if (!Number.isSafeInteger(identity.dev) || !Number.isSafeInteger(identity.ino))
          throw new CanonicalStoreError('JournalInvalid')
      } else if (journal.allocation.identity !== undefined)
        throw new CanonicalStoreError('JournalInvalid')
    }
    if (
      journal.phase !== 'started' &&
      (!journal.manifestHash || journal.manifestHash !== manifestHash(journal))
    )
      throw new CanonicalStoreError('JournalInvalid')
    if (
      !['started', 'snapshotted'].includes(journal.phase) &&
      (!journal.decision ||
        !journal.variant ||
        (journal.writer === 'canonical-store' && !journal.identity) ||
        (journal.variant === 'promote-staging' && !journal.stagingSha256))
    )
      throw new CanonicalStoreError('JournalInvalid')
    if (!['started', 'snapshotted'].includes(journal.phase)) {
      const expectedOperations: Array<Omit<MoveOperation, 'state'>> = journal.candidates.flatMap(
        candidate =>
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
                }))
      )
      if (journal.variant === 'promote-staging') {
        const promotion = journal.operations.filter(operation => operation.kind === 'promotion')
        if (promotion.length !== 1 || promotion[0].fingerprint !== journal.stagingSha256)
          throw new CanonicalStoreError('JournalInvalid')
        expectedOperations.push({
          kind: 'promotion',
          name: 'state.db',
          fingerprint: journal.stagingSha256!,
          size: promotion[0].size,
        })
      }
      if (
        objectHash(journal.operations.map(({ state: _state, ...operation }) => operation)) !==
        objectHash(expectedOperations)
      )
        throw new CanonicalStoreError('JournalInvalid')
      if (
        journal.selected &&
        journal.expectedCatalogHash !==
          journal.candidates.find(candidate => candidate.id === journal.selected)?.inspection
            ?.catalogHash
      )
        throw new CanonicalStoreError('JournalInvalid')
      if (
        journal.phase === 'completed' &&
        [...journal.operations, ...journal.workspace].some(operation => operation.state !== 'done')
      )
        throw new CanonicalStoreError('JournalInvalid')
    }
    return journal
  } catch (error) {
    if (error instanceof CanonicalStoreError) throw error
    throw new CanonicalStoreError('JournalInvalid')
  }
}
export function manifestHash(journal: Pick<MigrationJournal, 'candidates' | 'workspace'>): string {
  return objectHash({
    candidates: journal.candidates,
    workspace: journal.workspace.map(({ state: _state, ...operation }) => operation),
  })
}
export function readJson(root: string, file: string): unknown {
  safePath(root, file)
  if (fs.statSync(file).size > LIMITS.maxJournalBytes)
    throw new CanonicalStoreError('ManifestTooLarge')
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  try {
    return JSON.parse(fs.readFileSync(fd, 'utf8'))
  } catch {
    throw new CanonicalStoreError('JournalInvalid')
  } finally {
    fs.closeSync(fd)
  }
}
export function readJournal(root: string, binding: Binding): MigrationJournal | undefined {
  const file = activeJournalPath(root)
  return exists(file) ? validateJournal(readJson(root, file), binding) : undefined
}
export function atomicJson(
  root: string,
  file: string,
  value: unknown,
  port: FsPort = nodeFs
): void {
  safePath(root, file, true)
  const bytes = JSON.stringify(value)
  if (Buffer.byteLength(bytes) > LIMITS.maxJournalBytes)
    throw new CanonicalStoreError('ManifestTooLarge')
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}-${randomUUID()}.tmp`)
  safePath(root, temporary, true)
  const fd = port.openSync(
    temporary,
    fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW,
    0o600
  )
  try {
    port.writeFileSync(fd, bytes)
    port.fsyncSync(fd)
  } finally {
    port.closeSync(fd)
  }
  safePath(root, temporary)
  safePath(root, file, true)
  port.renameSync(temporary, file)
  syncDirectory(root, path.dirname(file), port)
}
export function writeJournal(root: string, journal: MigrationJournal, port: FsPort = nodeFs): void {
  validateJournal(journal, journal)
  atomicJson(root, activeJournalPath(root), journal, port)
}
export function archiveJournal(
  root: string,
  journal: MigrationJournal,
  port: FsPort = nodeFs
): void {
  const source = activeJournalPath(root)
  const destination = path.join(operationDirectory(root, journal.migrationId), 'journal.json')
  safePath(root, source)
  safePath(root, destination, true)
  if (exists(destination)) throw new CanonicalStoreError('FileMoveConflict')
  port.renameSync(source, destination)
  syncDirectory(root, path.dirname(source), port)
  syncDirectory(root, path.dirname(destination), port)
}
export function readMarker(root: string, binding: Binding): FinalMarker | undefined {
  const file = path.join(root, FINAL_MARKER)
  if (!exists(file)) return undefined
  const value = readJson(root, file)
  if (!object(value)) throw new CanonicalStoreError('MarkerMismatch')
  try {
    keys(value, ['markerVersion', 'layoutVersion', 'storeId', 'hostUid', 'pvcUid', 'migrationId'])
    const marker = value as unknown as FinalMarker
    assertUuid(marker.storeId)
    assertUuid(marker.migrationId)
    compareBinding(marker, binding)
    if (marker.markerVersion !== 1 || marker.layoutVersion !== 1)
      throw new CanonicalStoreError('MarkerMismatch')
    return marker
  } catch (error) {
    if (
      error instanceof CanonicalStoreError &&
      ['HostUidMismatch', 'PvcUidMismatch'].includes(error.reason)
    )
      throw error
    throw new CanonicalStoreError('MarkerMismatch')
  }
}
export function readLegacyMarker(root: string, binding: Binding): LegacyLayoutMarker | undefined {
  return readLegacyRecord(root, path.join(root, LEGACY_MARKER), binding)
}
export function readLegacyStateRecord(
  stateDir: string,
  binding: Binding
): LegacyLayoutMarker | undefined {
  return readLegacyRecord(
    stateDir,
    path.join(stateDir, '.canonical-store', LEGACY_STATE_RECORD),
    binding
  )
}
function readLegacyRecord(
  root: string,
  file: string,
  binding: Binding
): LegacyLayoutMarker | undefined {
  if (!exists(file)) return undefined
  const value = readJson(root, file)
  if (!object(value)) throw new CanonicalStoreError('MarkerMismatch')
  try {
    keys(value, [
      'markerVersion',
      'layoutVersion',
      'storageContract',
      'hostUid',
      'pvcUid',
      'migrationId',
      'databasePath',
      'writerFenceRoot',
    ])
    const marker = value as unknown as LegacyLayoutMarker
    assertUuid(marker.migrationId)
    compareBinding(marker, binding)
    if (
      marker.markerVersion !== 1 ||
      marker.layoutVersion !== 1 ||
      marker.storageContract !== 'legacy-floor' ||
      marker.databasePath !== 'state/state.db' ||
      marker.writerFenceRoot !== 'state'
    )
      throw new CanonicalStoreError('MarkerMismatch')
    return marker
  } catch (error) {
    if (
      error instanceof CanonicalStoreError &&
      ['HostUidMismatch', 'PvcUidMismatch'].includes(error.reason)
    )
      throw error
    throw new CanonicalStoreError('MarkerMismatch')
  }
}
export function ensureMigratingMarker(
  root: string,
  journal: MigrationJournal,
  port: FsPort = nodeFs
): void {
  const file = path.join(root, MIGRATING_MARKER)
  const expected = {
    markerVersion: 1,
    migrationId: journal.migrationId,
    hostUid: journal.hostUid,
    pvcUid: journal.pvcUid,
  }
  if (exists(file)) {
    if (objectHash(readJson(root, file)) !== objectHash(expected))
      throw new CanonicalStoreError('MarkerMismatch')
  } else atomicJson(root, file, expected, port)
}
/** Complete only a name reserved by the durable started journal. No unknown directory can acquire this exception. */
export function completeDirectoryAllocation(
  root: string,
  journal: MigrationJournal,
  port: FsPort = nodeFs
): void {
  const allocation = journal.allocation
  if (!allocation) return
  const durable = readJournal(root, journal)
  if (!durable || objectHash(durable) !== objectHash(journal))
    throw new CanonicalStoreError('JournalInvalid')
  const directory = operationDirectory(root, journal.migrationId)
  safePath(root, directory, true)
  if (!exists(directory)) {
    if (allocation.state !== 'intent') throw new CanonicalStoreError('FileMoveConflict')
    port.mkdirSync(directory, { mode: 0o700 })
  }
  safePath(root, directory)
  const stat = fs.lstatSync(directory)
  if (
    !stat.isDirectory() ||
    stat.uid !== allocation.ownerUid ||
    stat.gid !== allocation.ownerGid ||
    (stat.mode & 0o777) !== 0o700
  )
    throw new CanonicalStoreError('LayoutUnsafe')
  if (allocation.state === 'done') {
    if (stat.dev !== allocation.identity!.dev || stat.ino !== allocation.identity!.ino)
      throw new CanonicalStoreError('FileMoveConflict')
    return
  }
  if (journal.phase !== 'started' || fs.readdirSync(directory).length !== 0)
    throw new CanonicalStoreError('FileMoveConflict')
  syncDirectory(root, directory, port)
  syncDirectory(root, path.dirname(directory), port)
  allocation.identity = { dev: stat.dev, ino: stat.ino }
  allocation.state = 'done'
  writeJournal(root, journal, port)
}
export function beginMigration(
  root: string,
  options: {
    binding: Binding
    writer: MigrationJournal['writer']
    fs?: FsPort
    provenance?: MigrationJournal['provenance']
    recovery?: MigrationJournal['recovery']
    operator?: OperatorMigrationContext
    fence: WriterFence
  }
): MigrationJournal {
  options.fence.assertHeld()
  const port = options.fs ?? nodeFs
  const migrationId = options.recovery?.request.migrationId ?? randomUUID()
  assertUuid(migrationId)
  privateDirectory(root, path.join(root, 'state', '.canonical-store'), port)
  if (exists(activeJournalPath(root))) throw new CanonicalStoreError('MigrationInProgress')
  const directory = operationDirectory(root, migrationId)
  safePath(root, directory, true)
  // Check before reserving: an existing directory without this operation's durable intent is never adopted.
  if (exists(directory)) throw new CanonicalStoreError('MigrationIdCollision')
  const journal: MigrationJournal = {
    journalVersion: 1,
    migrationId,
    ...options.binding,
    writer: options.writer,
    phase: 'started',
    candidates: [],
    workspace: [],
    operations: [],
    ...(options.provenance ? { provenance: options.provenance } : {}),
    ...(options.operator ? { operator: options.operator } : {}),
    ...(options.recovery
      ? {
          recovery: options.recovery,
          selected: options.recovery.selectedCandidate,
          decision: 'Adopted' as const,
          adoption: {
            request: options.recovery.request,
            principal: options.recovery.principal,
            consumed: true as const,
          },
        }
      : {}),
  }
  if (options.recovery) {
    if (!process.getuid || !process.getgid) throw new CanonicalStoreError('LayoutUnsafe')
    const parent = fs.statSync(path.dirname(directory))
    journal.allocation = {
      state: 'intent',
      ownerUid: process.getuid(),
      ownerGid: parent.mode & 0o2000 ? parent.gid : process.getgid(),
    }
    // This active record blocks normal boot and durably reserves exactly the request/pins before any mkdir.
    writeJournal(root, journal, port)
    completeDirectoryAllocation(root, journal, port)
  } else {
    try {
      port.mkdirSync(directory, { mode: 0o700 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST')
        throw new CanonicalStoreError('MigrationIdCollision')
      throw error
    }
    syncDirectory(root, directory, port)
    syncDirectory(root, path.dirname(directory), port)
    writeJournal(root, journal, port)
  }
  ensureMigratingMarker(root, journal, port)
  return journal
}

/** Operator CLI retries require the same authoritative request and original provisioning, not merely matching Host/PVC. */
export function assertOperatorMigrationContext(
  journal: MigrationJournal,
  operator: OperatorMigrationContext,
  provenance?: NewStoreProvenance
): void {
  const legacy =
    operator.kind === 'legacy-floor-migration' ||
    operator.kind === 'legacy-floor-new-host-initialization'
  if (
    journal.writer !== (legacy ? 'layout-precheck' : 'canonical-store') ||
    journal.recovery ||
    journal.adoption
  )
    throw new CanonicalStoreError('MigrationInProgress')
  if (
    !journal.operator ||
    objectHash(journal.operator) !== objectHash(operator) ||
    objectHash(journal.provenance ?? null) !== objectHash(provenance ?? null)
  )
    throw new CanonicalStoreError('AdoptBindingMismatch')
}
