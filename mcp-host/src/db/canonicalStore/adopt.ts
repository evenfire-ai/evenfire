import * as fs from 'node:fs'
import * as path from 'node:path'
import { validateCanonicalStore, validateLegacyStore } from './bootGuard'
import { continueMigration } from './canonicalStoreInit'
import { activeJournalPath, readJournal, readJson, writeJournal } from './journal'
import {
  assertUuid,
  candidateDirectory,
  compareBinding,
  exists,
  fingerprints,
  objectHash,
  operationDirectory,
  safePath,
} from './paths'
import {
  type AdoptionRequest,
  type Binding,
  CanonicalStoreError,
  type InitOutcome,
  type LegacyAdoptionRequest,
  type LegacyOperatorAuthorization,
  type LegacyRecoveryRequest,
  type MigrationOptions,
  type OperatorAuthorization,
  type RecoveryRequest,
  legacyOutcome,
  outcome,
} from './types'
import { acquireWriterFence } from './writerFence'

type StoreAdoptionRequest =
  | AdoptionRequest
  | RecoveryRequest
  | LegacyAdoptionRequest
  | LegacyRecoveryRequest
function validateRequest(request: StoreAdoptionRequest): void {
  if (!request || request.schemaVersion !== 1) throw new CanonicalStoreError('AdoptBindingMismatch')
  assertUuid(request.requestId, 'AdoptBindingMismatch')
  assertUuid(request.migrationId, 'AdoptBindingMismatch')
  if (
    !/^[0-9a-f]{64}$/.test(request.manifestHash) ||
    !/^[0-9a-f]{64}$/.test(request.candidateHash) ||
    !request.maintenanceId ||
    request.maintenanceId.length > 256 ||
    Object.keys(request).some(
      key =>
        ![
          'schemaVersion',
          'requestId',
          'hostUid',
          'pvcUid',
          'maintenanceId',
          'migrationId',
          'manifestHash',
          'candidateHash',
          'storageContract',
          'expectedStoreId',
          'expectedMigrationId',
          'expectedCurrentCatalogHash',
        ].includes(key)
    )
  ) {
    throw new CanonicalStoreError('AdoptBindingMismatch')
  }
  const floor = request.storageContract === 'legacy-floor'
  if (
    request.storageContract !== undefined &&
    !['canonical', 'legacy-floor'].includes(request.storageContract)
  )
    throw new CanonicalStoreError('AdoptBindingMismatch')
  const recovered =
    'expectedStoreId' in request ||
    'expectedMigrationId' in request ||
    'expectedCurrentCatalogHash' in request
  if (recovered) {
    if (
      !('expectedCurrentCatalogHash' in request) ||
      !/^[0-9a-f]{64}$/.test(request.expectedCurrentCatalogHash)
    )
      throw new CanonicalStoreError('AdoptBindingMismatch')
    if (floor) {
      if (!('expectedMigrationId' in request) || 'expectedStoreId' in request)
        throw new CanonicalStoreError('AdoptBindingMismatch')
      assertUuid(request.expectedMigrationId, 'AdoptBindingMismatch')
    } else {
      if (!('expectedStoreId' in request) || 'expectedMigrationId' in request)
        throw new CanonicalStoreError('AdoptBindingMismatch')
      assertUuid(request.expectedStoreId, 'AdoptBindingMismatch')
    }
  }
}
export function lookupConsumedAdoption(
  root: string,
  request: StoreAdoptionRequest,
  authorization: OperatorAuthorization,
  binding: Binding
): InitOutcome | undefined {
  const active = readJournal(root, binding)
  if (
    active?.adoption?.request.requestId === request.requestId &&
    (objectHash(active.adoption.request) !== objectHash(request) ||
      active.adoption.principal !== authorization.principal)
  )
    throw new CanonicalStoreError('AdoptReplay')
  const records = path.join(root, 'state', '.canonical-store')
  for (const entry of fs.readdirSync(records)) {
    if (!/^[0-9a-f-]{36}$/i.test(entry)) continue
    assertUuid(entry)
    const receiptPath = path.join(
      operationDirectory(root, entry),
      `adoption-${request.requestId}.json`
    )
    if (!exists(receiptPath)) continue
    const receipt = readJson(root, receiptPath) as AdoptionRequest & {
      storeId: string
      consumed: boolean
      principal: string
    }
    const {
      receiptVersion: _version,
      storeId: _storeId,
      consumed: _consumed,
      principal: _principal,
      ...receiptRequest
    } = receipt as typeof receipt & { receiptVersion: number }
    if (
      entry !== request.migrationId ||
      objectHash(receiptRequest) !== objectHash(request) ||
      receipt.principal !== authorization.principal ||
      receipt.consumed !== true
    )
      throw new CanonicalStoreError('AdoptReplay')
    if (!exists(activeJournalPath(root))) {
      if (request.storageContract === 'legacy-floor') {
        const marker = validateLegacyStore({ root, stateDir: path.join(root, 'state'), binding })
        if (receipt.storeId !== undefined || marker.migrationId !== request.migrationId)
          throw new CanonicalStoreError('AdoptReplay')
        return legacyOutcome('Adopted', marker)
      }
      const identity = validateCanonicalStore({
        root,
        stateDir: path.join(root, 'state'),
        binding: binding,
      })
      if (identity.storeId !== receipt.storeId) throw new CanonicalStoreError('AdoptReplay')
      return outcome('Adopted', identity)
    }
  }
  return undefined
}
/** The caller authenticates the operator. Untrusted metadata alone must never construct this authorization. */
export async function adoptCanonicalStore(
  rootInput: string,
  request: StoreAdoptionRequest,
  authorization: OperatorAuthorization | LegacyOperatorAuthorization,
  options: MigrationOptions
): Promise<InitOutcome> {
  const root = path.resolve(rootInput)
  safePath(root, root)
  validateRequest(request)
  if (
    !authorization ||
    authorization.authorized !== true ||
    !authorization.principal ||
    authorization.principal.length > 256 ||
    authorization.requestId !== request.requestId ||
    authorization.maintenanceId !== request.maintenanceId
  )
    throw new CanonicalStoreError('AdoptUnauthorized')
  const floor = request.storageContract === 'legacy-floor'
  if (
    floor &&
    (!('kind' in authorization) ||
      authorization.kind !== 'legacy-floor-adoption' ||
      authorization.storageContract !== 'legacy-floor')
  )
    throw new CanonicalStoreError('AdoptUnauthorized')
  if (!floor && authorization.storageContract === 'legacy-floor')
    throw new CanonicalStoreError('AdoptUnauthorized')
  try {
    compareBinding(request, options.binding)
    compareBinding(authorization, options.binding)
  } catch {
    throw new CanonicalStoreError('AdoptBindingMismatch')
  }
  const ownedFence = options.fence
    ? undefined
    : acquireWriterFence({
        stateDir: path.join(root, 'state'),
        timeoutMs: options.timeoutMs ?? 1000,
      })
  const effective = { ...options, fence: options.fence ?? ownedFence! }
  try {
    effective.fence.assertHeld()
    const consumed = lookupConsumedAdoption(root, request, authorization, options.binding)
    if (consumed) return consumed
    const journal = readJournal(root, options.binding)
    if (
      !journal ||
      journal.migrationId !== request.migrationId ||
      (journal.manifestHash !== request.manifestHash &&
        !(
          journal.recovery &&
          (journal.phase === 'started' ||
            journal.candidates.some(candidate => !candidate.inspection)) &&
          objectHash(journal.recovery.request) === objectHash(request)
        ))
    )
      throw new CanonicalStoreError('AdoptBindingMismatch')
    if (journal.writer !== (floor ? 'layout-precheck' : 'canonical-store'))
      throw new CanonicalStoreError('AdoptUnauthorized')
    if (('expectedStoreId' in request || 'expectedMigrationId' in request) && !journal.recovery)
      throw new CanonicalStoreError('AdoptUnauthorized')
    if (journal.adoption) {
      if (
        objectHash(journal.adoption.request) !== objectHash(request) ||
        journal.adoption.principal !== authorization.principal
      )
        throw new CanonicalStoreError('AdoptReplay')
      return await continueMigration(root, journal, effective)
    }
    if (
      journal.phase !== 'snapshotted' ||
      journal.blockedReason !== 'DivergentCandidates' ||
      journal.operations.length !== 0
    ) {
      throw new CanonicalStoreError('AdoptUnauthorized')
    }
    const selected = journal.candidates.find(
      candidate => candidate.sourceHash === request.candidateHash
    )
    if (!selected) throw new CanonicalStoreError('AdoptFingerprintUnknown')
    for (const candidate of journal.candidates) {
      if (
        objectHash(fingerprints(root, candidateDirectory(root, candidate.id))) !==
        candidate.sourceHash
      ) {
        throw new CanonicalStoreError('CandidateChangedDuringMigration')
      }
    }
    journal.adoption = { request, principal: authorization.principal, consumed: true }
    journal.selected = selected.id
    journal.decision = 'Adopted'
    journal.blockedReason = undefined
    writeJournal(root, journal, options.fs)
    return await continueMigration(root, journal, effective)
  } finally {
    ownedFence?.close()
  }
}
