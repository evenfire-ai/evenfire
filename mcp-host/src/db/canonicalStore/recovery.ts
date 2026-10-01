import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import * as path from 'node:path'
import { adoptCanonicalStore, lookupConsumedAdoption } from './adopt'
import { validateCanonicalStore, validateLegacyStore } from './bootGuard'
import {
  assertNoPendingWorkspaceRelocation,
  continueMigration,
  discoverCandidates,
} from './canonicalStoreInit'
import { inspectCandidate, typedColumnProjection } from './inspectCandidate'
import {
  activeJournalPath,
  beginMigration,
  manifestHash,
  readJournal,
  readJson,
  readLegacyMarker,
  readMarker,
} from './journal'
import {
  assertUuid,
  candidateDirectory,
  compareBinding,
  exists,
  objectHash,
  operationDirectory,
  safePath,
} from './paths'
import { validateRecoveryContinuity } from './recoveryContinuity'
import {
  type CandidateId,
  type CandidateManifest,
  CanonicalStoreError,
  LIMITS,
  type LegacyOperatorAuthorization,
  type LegacyRecoveryRequest,
  type MigrationOptions,
  type OperatorAuthorization,
  type RecoveryRequest,
} from './types'
import { acquireWriterFence } from './writerFence'

export { validateRecoveryContinuity } from './recoveryContinuity'

export interface LegacyRecoveryInspection {
  migrationId: string
  manifestHash: string
  candidateHash: string
  expectedMigrationId: string
  expectedCurrentCatalogHash: string
}
export interface RecoveryInspection {
  migrationId: string
  manifestHash: string
  candidateHash: string
  expectedStoreId: string
  expectedCurrentCatalogHash: string
}
async function recoveryInspection(
  root: string,
  candidateId: CandidateId,
  options: MigrationOptions,
  expected?: RecoveryRequest | LegacyRecoveryRequest
): Promise<{
  pins: RecoveryInspection | LegacyRecoveryInspection
  candidates: CandidateManifest[]
  currentPath: string
  candidatePath: string
}> {
  assertNoPendingWorkspaceRelocation(root)
  if (!candidateId.startsWith('C_import:')) throw new CanonicalStoreError('AdoptUnauthorized')
  const floor = options.writer === 'layout-precheck'
  const marker = floor
    ? validateLegacyStore({ root, stateDir: path.join(root, 'state'), binding: options.binding })
    : undefined
  const identity = floor
    ? undefined
    : validateCanonicalStore({ root, stateDir: path.join(root, 'state'), binding: options.binding })
  const ids = discoverCandidates(root, options.binding)
  if (ids.length !== 2 || !ids.includes('C_state') || !ids.includes(candidateId))
    throw new CanonicalStoreError('ForeignCandidateAfterCanonical')
  const candidates: CandidateManifest[] = []
  const inspectedCopies: Array<Awaited<ReturnType<typeof inspectCandidate>>> = []
  try {
    let currentPath: string | undefined
    let candidatePath: string | undefined
    for (const id of ids) {
      const result = await inspectCandidate(candidateDirectory(root, id), {
        root,
        scratchDir: path.join(root, 'state', '.canonical-store', 'recovery-inspection'),
        binding: options.binding,
        fence: options.fence,
        timeoutMs: options.timeoutMs,
      })
      inspectedCopies.push(result)
      candidates.push({
        id,
        files: result.sourceFiles,
        sourceHash: result.sourceHash,
        inspection: {
          schemaVersion: result.schemaVersion,
          catalogHash: result.catalogHash,
          tableHashes: result.tableHashes,
          counts: result.counts,
          empty: result.empty,
          ...(result.identity ? { identity: result.identity } : {}),
        },
      })
      if (id === 'C_state') currentPath = result.normalizedPath
      else {
        candidatePath = result.normalizedPath
        if (result.identity && (floor || result.identity.storeId !== identity!.storeId))
          throw new CanonicalStoreError('AdoptBindingMismatch')
      }
    }
    if (!currentPath || !candidatePath) throw new CanonicalStoreError('CandidateIncomplete')
    if (
      expected &&
      (candidates.find(candidate => candidate.id === 'C_state')!.inspection!.catalogHash !==
        expected.expectedCurrentCatalogHash ||
        (floor
          ? !('expectedMigrationId' in expected) ||
            marker!.migrationId !== expected.expectedMigrationId
          : !('expectedStoreId' in expected) || identity!.storeId !== expected.expectedStoreId) ||
        manifestHash({ candidates, workspace: [] }) !== expected.manifestHash ||
        candidates.find(candidate => candidate.id === candidateId)!.sourceHash !==
          expected.candidateHash)
    )
      throw new CanonicalStoreError('AdoptBindingMismatch')
    const current = new Database(currentPath, { readonly: true, fileMustExist: true })
    const candidate = new Database(candidatePath, { readonly: true, fileMustExist: true })
    try {
      validateRecoveryContinuity(
        current,
        candidate,
        Date.now() + (options.timeoutMs ?? LIMITS.timeoutMs)
      )
    } finally {
      current.close()
      candidate.close()
    }
    const selected = candidates.find(candidate => candidate.id === candidateId)!
    return {
      pins: {
        migrationId: randomUUID(),
        manifestHash: manifestHash({ candidates, workspace: [] }),
        candidateHash: selected.sourceHash,
        ...(floor
          ? { expectedMigrationId: marker!.migrationId }
          : { expectedStoreId: identity!.storeId }),
        expectedCurrentCatalogHash: candidates.find(candidate => candidate.id === 'C_state')!
          .inspection!.catalogHash,
      },
      candidates,
      currentPath,
      candidatePath,
    }
  } finally {
    inspectedCopies.forEach(copy => copy.dispose())
  }
}
/** Read-only proof under the existing fence; returned fields are data, not an authorization. */
export async function inspectRecovery(
  rootInput: string,
  candidateId: CandidateId,
  options: MigrationOptions
): Promise<RecoveryInspection> {
  const root = path.resolve(rootInput)
  safePath(root, root)
  const ownedFence = options.fence
    ? undefined
    : acquireWriterFence({ stateDir: path.join(root, 'state') })
  try {
    return (
      await recoveryInspection(root, candidateId, {
        ...options,
        writer: 'canonical-store',
        fence: options.fence ?? ownedFence!,
      })
    ).pins as RecoveryInspection
  } finally {
    ownedFence?.close()
  }
}
/** Floor recovery uses its completed migration binding, never a fabricated canonical store ID. */
export async function inspectLegacyRecovery(
  rootInput: string,
  candidateId: CandidateId,
  options: MigrationOptions
): Promise<LegacyRecoveryInspection> {
  const root = path.resolve(rootInput)
  safePath(root, root)
  const ownedFence = options.fence
    ? undefined
    : acquireWriterFence({ stateDir: path.join(root, 'state'), requireExisting: true })
  try {
    return (
      await recoveryInspection(root, candidateId, {
        ...options,
        writer: 'layout-precheck',
        fence: options.fence ?? ownedFence!,
      })
    ).pins as LegacyRecoveryInspection
  } finally {
    ownedFence?.close()
  }
}
/** Begin a distinct, operator-bound recovery only after proving the externally prepared source keeps every accepted write. */
export function beginRecovery(
  rootInput: string,
  request: RecoveryRequest,
  authorization: OperatorAuthorization,
  options: MigrationOptions
) {
  return beginBoundRecovery(rootInput, request, authorization, {
    ...options,
    writer: 'canonical-store',
  })
}
export function beginLegacyRecovery(
  rootInput: string,
  request: LegacyRecoveryRequest,
  authorization: LegacyOperatorAuthorization,
  options: MigrationOptions
) {
  return beginBoundRecovery(rootInput, request, authorization, {
    ...options,
    writer: 'layout-precheck',
  })
}
async function beginBoundRecovery(
  rootInput: string,
  request: RecoveryRequest | LegacyRecoveryRequest,
  authorization: OperatorAuthorization | LegacyOperatorAuthorization,
  options: MigrationOptions
) {
  const root = path.resolve(rootInput)
  safePath(root, root)
  const floor = options.writer === 'layout-precheck'
  assertUuid(request.migrationId, 'AdoptBindingMismatch')
  assertUuid(request.requestId, 'AdoptBindingMismatch')
  if (floor) {
    if (
      !('expectedMigrationId' in request) ||
      'expectedStoreId' in request ||
      request.storageContract !== 'legacy-floor' ||
      !('kind' in authorization) ||
      authorization.kind !== 'legacy-floor-adoption' ||
      authorization.storageContract !== 'legacy-floor'
    )
      throw new CanonicalStoreError('AdoptUnauthorized')
    assertUuid(request.expectedMigrationId, 'AdoptBindingMismatch')
  } else {
    if (
      !('expectedStoreId' in request) ||
      'expectedMigrationId' in request ||
      request.storageContract === 'legacy-floor'
    )
      throw new CanonicalStoreError('AdoptUnauthorized')
    assertUuid(request.expectedStoreId, 'AdoptBindingMismatch')
  }
  if (
    !authorization ||
    authorization.authorized !== true ||
    !authorization.principal ||
    authorization.requestId !== request.requestId ||
    authorization.maintenanceId !== request.maintenanceId ||
    request.schemaVersion !== 1 ||
    !/^[0-9a-f]{64}$/.test(request.expectedCurrentCatalogHash) ||
    !/^[0-9a-f]{64}$/.test(request.manifestHash) ||
    !/^[0-9a-f]{64}$/.test(request.candidateHash)
  )
    throw new CanonicalStoreError('AdoptUnauthorized')
  compareBinding(authorization, options.binding)
  compareBinding(request, options.binding)
  const ownedFence = options.fence
    ? undefined
    : acquireWriterFence({ stateDir: path.join(root, 'state') })
  const effective = { ...options, fence: options.fence ?? ownedFence! }
  try {
    effective.fence.assertHeld()
    const consumed = lookupConsumedAdoption(root, request, authorization, options.binding)
    if (consumed) return consumed
    const existing = readJournal(root, options.binding)
    const archivedPath = path.join(operationDirectory(root, request.migrationId), 'journal.json')
    if (existing || exists(archivedPath)) {
      if (existing && !existing.recovery) throw new CanonicalStoreError('MigrationInProgress')
      return await adoptCanonicalStore(root, request, authorization, effective)
    }
    const candidates = discoverCandidates(root, options.binding)
    let selected: CandidateId | undefined
    for (const id of candidates.filter(id => id.startsWith('C_import:'))) {
      const manifest = readJson(root, path.join(candidateDirectory(root, id), 'manifest.json')) as {
        files: unknown
      }
      if (objectHash(manifest.files) === request.candidateHash) selected = id
    }
    if (!selected) throw new CanonicalStoreError('AdoptFingerprintUnknown')
    const inspected = await recoveryInspection(root, selected, effective, request)
    const { migrationId: _proposal, ...actual } = inspected.pins
    const expected = {
      manifestHash: request.manifestHash,
      candidateHash: request.candidateHash,
      ...(floor
        ? { expectedMigrationId: (request as LegacyRecoveryRequest).expectedMigrationId }
        : { expectedStoreId: (request as RecoveryRequest).expectedStoreId }),
      expectedCurrentCatalogHash: request.expectedCurrentCatalogHash,
    }
    if (objectHash(actual) !== objectHash(expected))
      throw new CanonicalStoreError('AdoptBindingMismatch')
    const previousMarker = floor
      ? readLegacyMarker(root, options.binding)!
      : readMarker(root, options.binding)!
    const journal = beginMigration(root, {
      binding: options.binding,
      writer: floor ? 'layout-precheck' : 'canonical-store',
      fs: options.fs,
      fence: effective.fence,
      recovery: {
        request,
        principal: authorization.principal,
        selectedCandidate: selected,
        previousMarker,
        previousMarkerMove: 'pending',
        ...(floor ? { previousStateMarkerMove: 'pending' as const } : {}),
      },
    })
    return await continueMigration(root, journal, effective)
  } finally {
    ownedFence?.close()
  }
}
