import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { parseArgs } from 'node:util'
import {
  type CanonicalOperatorResolveInput,
  type ResolvedCanonicalOperatorRequest,
  computeCanonicalOperatorRequestHash,
  resolveCanonicalOperatorRequest,
} from '../../runtime/canonicalOperatorAuthorization'
import { adoptCanonicalStore } from './adopt'
import { discoverBackupSets } from './backups'
import { bootCheck, legacyBootCheck } from './bootGuard'
import { discoverCandidates, runMigration } from './canonicalStoreInit'
import { isImportConsumed, readImportManifest } from './imports'
import { inspectCandidate } from './inspectCandidate'
import {
  MIGRATING_MARKER,
  assertOperatorMigrationContext,
  readJournal,
  readJson,
  readLegacyMarker,
  readMarker,
  validateJournal,
} from './journal'
import { layoutPrecheck } from './layoutPrecheck'
import {
  SQLITE_FILES,
  UUID,
  assertUuid,
  candidateDirectory,
  exists,
  operationDirectory,
  safePath,
  validateBinding,
} from './paths'
import {
  beginLegacyRecovery,
  beginRecovery,
  inspectLegacyRecovery,
  inspectRecovery,
} from './recovery'
import {
  type AdoptionRequest,
  type Binding,
  type CandidateId,
  CanonicalStoreError,
  type InitOutcome,
  type NewStoreProvenance,
  type OperatorMigrationContext,
  REASON_EXITS,
  type RecoveryRequest,
  outcome,
} from './types'
import { type PreparationSourceClass, verifyCurrent, verifyPreparation } from './verification'
import { acquireWriterFence } from './writerFence'

function diagnosticCandidateIds(root: string, binding: Binding): CandidateId[] {
  const ids: CandidateId[] = ['C_state', 'C_root', 'C_ws']
  const imports = path.join(root, '.canonical-store-import')
  if (exists(imports)) {
    safePath(root, imports)
    for (const id of fs.readdirSync(imports)) {
      assertUuid(id)
      const manifest = readImportManifest(root, id, binding)
      if (!isImportConsumed(root, id, binding, manifest, true)) ids.push(`C_import:${id}`)
    }
  }
  return ids.filter(id => {
    const directory = candidateDirectory(root, id)
    if (!exists(directory)) return false
    safePath(root, directory)
    if (!fs.statSync(directory).isDirectory()) throw new CanonicalStoreError('LayoutUnsafe')
    if (!exists(path.join(directory, 'state.db'))) {
      if (SQLITE_FILES.some(name => exists(path.join(directory, name))))
        throw new CanonicalStoreError('CandidateIncomplete')
      return false
    }
    return true
  })
}
export interface CliOptions {
  resolveOperatorRequest?: typeof resolveCanonicalOperatorRequest
  fs?: import('./fsPort').FsPort
}
export async function runCli(
  argv: string[],
  options: CliOptions = {}
): Promise<{ exitCode: number; result: unknown }> {
  const args = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      root: { type: 'string' },
      'storage-contract': { type: 'string' },
      'host-uid': { type: 'string' },
      'pvc-uid': { type: 'string' },
      operation: { type: 'string' },
      'source-class': { type: 'string' },
      'manifest-hash': { type: 'string' },
      'request-id': { type: 'string' },
      'controller-uid': { type: 'string' },
      'capability-id': { type: 'string' },
      'scratch-root': { type: 'string' },
      live: { type: 'boolean' },
      'source-path': { type: 'string' },
      'export-id': { type: 'string' },
      'maintenance-id': { type: 'string' },
      provenance: { type: 'string' },
      request: { type: 'string' },
      'operator-principal': { type: 'string' },
      'operator-authorized': { type: 'boolean' },
      'recovery-import-id': { type: 'string' },
      'backup-location': { type: 'string' },
      'backup-suffix': { type: 'string' },
      'backup-hash': { type: 'string' },
    },
  })
  const command = args.positionals[0]
  const hintedContract = args.values['storage-contract']
  if (hintedContract && !['canonical', 'legacy-floor'].includes(hintedContract))
    throw new CanonicalStoreError('AdoptBindingMismatch')
  if (
    args.positionals.length !== 1 ||
    !args.values.root ||
    !args.values['host-uid'] ||
    !args.values['pvc-uid']
  )
    throw new CanonicalStoreError('JournalInvalid')
  const root = path.resolve(args.values.root)
  const binding: Binding = { hostUid: args.values['host-uid'], pvcUid: args.values['pvc-uid'] }
  validateBinding(binding)
  const resolver = options.resolveOperatorRequest ?? resolveCanonicalOperatorRequest
  async function resolve(
    input: CanonicalOperatorResolveInput
  ): Promise<ResolvedCanonicalOperatorRequest> {
    if (args.values.operation && args.values.operation !== input.operation)
      throw new CanonicalStoreError('AdoptBindingMismatch')
    const resolved = await resolver(input)
    const authoritative =
      resolved.operation === 'adopt' && resolved.action === 'adopt'
        ? resolved.operatorRequest
        : resolved.request
    const requestHash = computeCanonicalOperatorRequestHash(authoritative)
    if (
      resolved.proof.requestHash !== requestHash ||
      resolved.authorization.requestHash !== requestHash ||
      resolved.proof.storageContract !== resolved.storageContract ||
      !['canonical', 'legacy-floor'].includes(resolved.storageContract) ||
      resolved.authorization.storageContract !== resolved.storageContract ||
      (hintedContract && hintedContract !== resolved.storageContract)
    )
      throw new CanonicalStoreError('AdoptBindingMismatch')
    const measuredRoot = path.resolve(resolved.proof.rootMountPath)
    safePath(root, root)
    if (
      root !== measuredRoot ||
      !isDeepStrictEqual(resolved.binding, binding) ||
      (args.values['maintenance-id'] && args.values['maintenance-id'] !== resolved.maintenanceId) ||
      (args.values['operator-principal'] &&
        args.values['operator-principal'] !== resolved.principal) ||
      (args.values['controller-uid'] && args.values['controller-uid'] !== binding.hostUid) ||
      (args.values['capability-id'] && args.values['capability-id'] !== resolved.proof.jobUid)
    )
      throw new CanonicalStoreError('AdoptBindingMismatch')
    return resolved
  }
  let result: InitOutcome
  if (command === 'boot-check') {
    result =
      hintedContract === 'legacy-floor' ? legacyBootCheck(root, binding) : bootCheck(root, binding)
  } else if (command === 'verify-preparation' || command === 'verify-current') {
    if (!args.values['request-id']) throw new CanonicalStoreError('AdoptUnauthorized')
    const currentOperation = args.values.operation ?? 'release'
    if (command === 'verify-current' && !['prepare', 'adopt', 'release'].includes(currentOperation))
      throw new CanonicalStoreError('AdoptUnauthorized')
    const resolved =
      command === 'verify-preparation'
        ? await resolve({
            requestId: args.values['request-id'],
            operation: 'prepare',
            action: 'verify-preparation',
          })
        : await resolve({
            requestId: args.values['request-id'],
            operation: currentOperation as 'prepare' | 'adopt' | 'release',
            action: 'verify-current',
          })
    const physical = {
      root,
      binding,
      maintenanceId: resolved.maintenanceId,
      storageContract: resolved.storageContract,
      scratchRoot: args.values['scratch-root']
        ? path.resolve(args.values['scratch-root'])
        : fs.realpathSync(os.tmpdir()),
    }
    let proof
    if (resolved.operation === 'prepare' && resolved.action === 'verify-preparation') {
      if (
        (args.values['source-class'] &&
          args.values['source-class'] !== resolved.request.sourceClass) ||
        (args.values['export-id'] && args.values['export-id'] !== resolved.request.exportId) ||
        (args.values['manifest-hash'] &&
          args.values['manifest-hash'] !== resolved.request.manifestHash)
      )
        throw new CanonicalStoreError('AdoptBindingMismatch')
      if (
        resolved.authorization.kind !==
        (resolved.storageContract === 'legacy-floor'
          ? 'legacy-floor-preparation-verification'
          : 'canonical-preparation-verification')
      )
        throw new CanonicalStoreError('AdoptUnauthorized')
      proof = await verifyPreparation(resolved.request.sourceClass, {
        ...physical,
        exportId: resolved.request.exportId,
        expectedManifestHash: resolved.request.manifestHash,
      })
    } else if (resolved.operation === 'release' && resolved.action === 'verify-current') {
      if (
        resolved.authorization.kind !==
        (resolved.storageContract === 'legacy-floor'
          ? 'legacy-floor-verification'
          : 'canonical-verification')
      )
        throw new CanonicalStoreError('AdoptUnauthorized')
      proof = await verifyCurrent({
        ...physical,
        expectedManifestHash: resolved.request.manifestHash,
      })
      if (
        (resolved.storageContract === 'legacy-floor'
          ? proof.storeId !== undefined ||
            proof.migrationId !== resolved.request.expectedMigrationId
          : proof.storeId !== resolved.request.expectedStoreId) ||
        proof.currentCatalogHash !== resolved.request.expectedCurrentCatalogHash ||
        (resolved.request.migrationId && proof.migrationId !== resolved.request.migrationId) ||
        (resolved.request.candidateHash && proof.candidateHash !== resolved.request.candidateHash)
      )
        throw new CanonicalStoreError('AdoptBindingMismatch')
    } else if (
      (resolved.operation === 'prepare' || resolved.operation === 'adopt') &&
      resolved.action === 'verify-current'
    ) {
      proof = await verifyCurrent(physical)
      if (resolved.storageContract === 'legacy-floor') {
        if (
          resolved.authorization.kind !== 'legacy-floor-finalization-verification' ||
          proof.storeId !== undefined ||
          proof.migrationId !== resolved.expectedMigrationId ||
          resolved.authorization.expectedMigrationId !== resolved.expectedMigrationId
        )
          throw new CanonicalStoreError('AdoptBindingMismatch')
      } else if (
        resolved.authorization.kind !== 'canonical-finalization-verification' ||
        proof.storeId !== resolved.expectedStoreId ||
        resolved.authorization.expectedStoreId !== resolved.expectedStoreId
      )
        throw new CanonicalStoreError('AdoptBindingMismatch')
      if (
        proof.currentCatalogHash !== resolved.expectedCurrentCatalogHash ||
        resolved.authorization.expectedCurrentCatalogHash !== resolved.expectedCurrentCatalogHash
      )
        throw new CanonicalStoreError('AdoptBindingMismatch')
    } else throw new CanonicalStoreError('AdoptUnauthorized')
    return {
      exitCode: 0,
      result: {
        ...proof,
        storageContract: resolved.storageContract,
        requestHash: resolved.proof.requestHash,
        requestId: resolved.request.requestId,
        controllerUid: binding.hostUid,
        capabilityId: resolved.proof.jobUid,
      },
    }
  } else if (command === 'migrate' || command === 'layout-precheck') {
    const floor = command === 'layout-precheck'
    if (hintedContract && hintedContract !== (floor ? 'legacy-floor' : 'canonical'))
      throw new CanonicalStoreError('AdoptBindingMismatch')
    if (!args.values['request-id']) throw new CanonicalStoreError('AdoptUnauthorized')
    const resolved = await resolve({
      requestId: args.values['request-id'],
      operation: 'prepare',
      action: floor ? 'layout-precheck' : 'migrate',
    })
    if (
      resolved.operation !== 'prepare' ||
      (resolved.action !== 'migrate' && resolved.action !== 'layout-precheck') ||
      resolved.storageContract !== (floor ? 'legacy-floor' : 'canonical') ||
      (args.values['manifest-hash'] &&
        args.values['manifest-hash'] !== resolved.authorization.verifiedManifestHash)
    )
      throw new CanonicalStoreError('AdoptBindingMismatch')
    const value = args.values.provenance
    if (value && !['new-host', 'verified-empty-sqlite'].includes(value))
      throw new CanonicalStoreError('StoreModeUnknown')
    const isNewHost =
      resolved.authorization.kind === 'canonical-new-host-initialization' ||
      resolved.authorization.kind === 'legacy-floor-new-host-initialization'
    if (isNewHost) {
      if (
        resolved.authorization.kind !==
          (floor ? 'legacy-floor-new-host-initialization' : 'canonical-new-host-initialization') ||
        resolved.request.sourceClass !== 'new-host' ||
        (value && value !== 'new-host') ||
        !('provisioning' in resolved.authorization) ||
        !isDeepStrictEqual(
          {
            hostUid: resolved.authorization.provisioning.hostUid,
            pvcUid: resolved.authorization.provisioning.pvcUid,
          },
          binding
        )
      ) {
        throw new CanonicalStoreError('AdoptBindingMismatch')
      }
    } else if (
      resolved.authorization.kind !== (floor ? 'legacy-floor-migration' : 'canonical-migration') ||
      value ||
      resolved.request.sourceClass === 'new-host'
    ) {
      throw new CanonicalStoreError('AdoptBindingMismatch')
    }
    const boundProvenance: NewStoreProvenance | undefined = isNewHost
      ? { ...binding, kind: 'new-host', maintenanceId: resolved.maintenanceId }
      : undefined
    const operator: OperatorMigrationContext = {
      kind: resolved.authorization.kind,
      storageContract: resolved.storageContract,
      requestId: resolved.request.requestId,
      maintenanceId: resolved.maintenanceId,
      principal: resolved.principal,
      sourceClass: resolved.request.sourceClass,
      verifiedManifestHash: resolved.authorization.verifiedManifestHash,
      requestHash: computeCanonicalOperatorRequestHash(resolved.request),
      ...('provisioning' in resolved.authorization
        ? { provisioning: resolved.authorization.provisioning }
        : {}),
    }
    const physical = {
      root,
      binding,
      maintenanceId: resolved.maintenanceId,
      storageContract: resolved.storageContract,
      scratchRoot: args.values['scratch-root']
        ? path.resolve(args.values['scratch-root'])
        : fs.realpathSync(os.tmpdir()),
      exportId: resolved.request.exportId,
      expectedManifestHash: resolved.authorization.verifiedManifestHash,
    }
    const held = acquireWriterFence({ stateDir: path.join(root, 'state') })
    try {
      const active = readJournal(root, binding)
      const marker = active
        ? undefined
        : floor
          ? readLegacyMarker(root, binding)
          : readMarker(root, binding)
      if (active) {
        assertOperatorMigrationContext(active, operator, boundProvenance)
      } else if (marker) {
        const archived = validateJournal(
          readJson(root, path.join(operationDirectory(root, marker.migrationId), 'journal.json')),
          binding
        )
        assertOperatorMigrationContext(archived, operator, boundProvenance)
      } else {
        if (exists(path.join(root, MIGRATING_MARKER)))
          throw new CanonicalStoreError('JournalInvalid')
        await verifyPreparation(resolved.request.sourceClass, physical)
      }
      // The original request owns continuation; partially retired source sets are never reclassified as new candidates.
      result = await (floor
        ? layoutPrecheck(root, {
            binding,
            fence: held,
            provenance: boundProvenance,
            operator,
            fs: options.fs,
          })
        : runMigration(root, {
            binding,
            fence: held,
            provenance: boundProvenance,
            operator,
            fs: options.fs,
          }))
      const proof = await verifyCurrent({
        ...physical,
        expectedManifestHash: undefined,
        fence: held,
      })
      result = {
        ...result,
        storageContract: resolved.storageContract,
        requestId: resolved.request.requestId,
        requestHash: resolved.proof.requestHash,
        controllerUid: binding.hostUid,
        capabilityId: resolved.proof.jobUid,
        ...{
          catalogHash: proof.currentCatalogHash,
          currentCatalogHash: proof.currentCatalogHash,
          migrationId: proof.migrationId,
          manifestHash: proof.manifestHash,
          ...(proof.candidateHash ? { candidateHash: proof.candidateHash } : {}),
        },
      }
    } finally {
      held.close()
    }
  } else if (command === 'inspect') {
    const fence = args.values['recovery-import-id']
      ? acquireWriterFence({ stateDir: path.join(root, 'state') })
      : undefined
    try {
      if (args.values['recovery-import-id']) {
        if (args.values.live) throw new CanonicalStoreError('MigrationMaintenanceRequired')
        const proof = await (
          hintedContract === 'legacy-floor' ? inspectLegacyRecovery : inspectRecovery
        )(root, `C_import:${args.values['recovery-import-id']}`, { binding, fence })
        return { exitCode: 0, result: { outcome: 'ok', reason: 'NoCollision', proof } }
      }
      const journal = readJournal(root, binding)
      const migration = journal
        ? {
            migrationId: journal.migrationId,
            writer: journal.writer,
            phase: journal.phase,
            manifestHash: journal.manifestHash,
            blockedReason: journal.blockedReason,
            candidates: journal.candidates.map(candidate => ({
              id: candidate.id,
              candidateHash: candidate.sourceHash,
              ...(candidate.inspection
                ? {
                    catalogHash: candidate.inspection.catalogHash,
                    schemaVersion: candidate.inspection.schemaVersion,
                    empty: candidate.inspection.empty,
                    counts: candidate.inspection.counts,
                  }
                : {}),
            })),
          }
        : undefined
      const scratchRoot = args.values['scratch-root']
        ? path.resolve(args.values['scratch-root'])
        : fs.realpathSync(os.tmpdir())
      const ids = diagnosticCandidateIds(root, binding)
      const candidates = []
      for (const id of ids) {
        const inspection = await inspectCandidate(candidateDirectory(root, id), {
          root,
          scratchRoot,
          scratchDir: path.join(scratchRoot, '.canonical-store-inspection'),
          binding,
          live: true,
        })
        const { normalizedPath: _privatePath, dispose: _dispose, ...safeResult } = inspection
        candidates.push({ id, ...safeResult })
        inspection.dispose()
      }
      return {
        exitCode: 0,
        result: {
          outcome: 'ok',
          reason: 'NoCollision',
          candidates,
          ...(migration ? { migration } : {}),
          backups: discoverBackupSets(root),
        },
      }
    } finally {
      fence?.close()
    }
  } else if (command === 'export') {
    // Export runs only through the reviewed bootstrap/shared-library caller with independently verified writer closure.
    // Local flags cannot authenticate that invocation or create an export capability.
    throw new CanonicalStoreError('AdoptUnauthorized')
  } else if (command === 'adopt') {
    let requestFile: string | undefined
    let requestId = args.values['request-id']
    if (args.values.request) {
      requestFile = path.resolve(args.values.request)
      const requestDirectory = path.join(root, 'state', '.canonical-store', 'requests')
      const filenameId = path.basename(requestFile, '.json')
      if (
        path.dirname(requestFile) !== requestDirectory ||
        !requestFile.endsWith('.json') ||
        !UUID.test(filenameId)
      )
        throw new CanonicalStoreError('LayoutUnsafe')
      if (requestId && requestId !== filenameId)
        throw new CanonicalStoreError('AdoptBindingMismatch')
      requestId = filenameId
    }
    if (!requestId) throw new CanonicalStoreError('AdoptUnauthorized')
    const resolved = await resolve({ requestId, operation: 'adopt', action: 'adopt' })
    if (resolved.operation !== 'adopt' || resolved.action !== 'adopt')
      throw new CanonicalStoreError('AdoptUnauthorized')
    if (requestFile) {
      const hinted = readJson(root, requestFile)
      if (
        !isDeepStrictEqual(hinted, resolved.request) &&
        !isDeepStrictEqual(hinted, resolved.operatorRequest)
      )
        throw new CanonicalStoreError('AdoptBindingMismatch')
    }
    if (resolved.storageContract === 'legacy-floor') {
      if (resolved.authorization.kind !== 'legacy-floor-adoption')
        throw new CanonicalStoreError('AdoptUnauthorized')
      result =
        'expectedMigrationId' in resolved.request
          ? await beginLegacyRecovery(root, resolved.request, resolved.authorization, {
              binding,
              fs: options.fs,
            })
          : await adoptCanonicalStore(root, resolved.request, resolved.authorization, {
              binding,
              fs: options.fs,
            })
    } else {
      if (resolved.authorization.kind !== 'canonical-adoption')
        throw new CanonicalStoreError('AdoptUnauthorized')
      result =
        'expectedStoreId' in resolved.request
          ? await beginRecovery(root, resolved.request, resolved.authorization, {
              binding,
              fs: options.fs,
            })
          : await adoptCanonicalStore(root, resolved.request, resolved.authorization, {
              binding,
              fs: options.fs,
            })
    }
    const measured = await verifyCurrent({
      root,
      binding,
      storageContract: resolved.storageContract,
      maintenanceId: resolved.maintenanceId,
      scratchRoot: args.values['scratch-root']
        ? path.resolve(args.values['scratch-root'])
        : fs.realpathSync(os.tmpdir()),
    })
    result = {
      ...result,
      storageContract: resolved.storageContract,
      requestId: resolved.request.requestId,
      requestHash: resolved.proof.requestHash,
      controllerUid: binding.hostUid,
      capabilityId: resolved.proof.jobUid,
      ...{
        catalogHash: measured.currentCatalogHash,
        currentCatalogHash: measured.currentCatalogHash,
        migrationId: measured.migrationId,
        manifestHash: measured.manifestHash,
        ...(measured.candidateHash ? { candidateHash: measured.candidateHash } : {}),
      },
    }
  } else throw new CanonicalStoreError('JournalInvalid')
  return { exitCode: REASON_EXITS[result.reason], result }
}
if (require.main === module) {
  void runCli(process.argv.slice(2))
    .then(({ exitCode, result }) => {
      process.stdout.write(`${JSON.stringify(result)}\n`)
      process.exitCode = exitCode
    })
    .catch(error => {
      if (error instanceof CanonicalStoreError) {
        process.stdout.write(`${JSON.stringify(outcome(error.reason))}\n`)
        process.exitCode = error.exitCode
      } else {
        // Unclassified failures deliberately remain nonzero without leaking SQLite errors or paths.
        process.exitCode = 1
      }
    })
}
