import { isDeepStrictEqual } from 'node:util'
import type { ConversationStoreInitOutcome } from './conversationStoreObservation'
import {
  isCanonicalSuccessOutcome,
  isLegacyFloorSuccessOutcome,
} from './conversationStoreObservation'
import type {
  ConversationStoreMaintenance,
  ConversationStorePreparation,
  ConversationStoreRequest,
  ConversationStoreRequestResult,
  ConversationStoreStorageContract,
  HostCRD,
  HostConversationStoreStatus,
} from './types'

export interface ConversationStorePhysicalProof {
  proofVersion: 1
  storageContract: ConversationStoreStorageContract
  requestId?: string
  requestHash?: string
  controllerUid?: string
  capabilityId?: string
  layoutVersion?: 1
  databasePath?: 'state/state.db'
  writerFenceRoot?: 'state'
  hostUid: string
  pvcUid: string
  maintenanceId: string
  sourceClass?: string
  exportId?: string
  manifestHash?: string
  sourceHash?: string
  sourceSnapshotHash?: string
  catalogHash?: string
  currentCatalogHash?: string
  migrationId?: string
  candidateHash?: string
  storeId?: string
}

/** Verified kernel/supervisor evidence, not an operator supplied acknowledgement. */
export interface ConversationStoreWriterProof {
  storageContract: ConversationStoreStorageContract
  hostUid: string
  pvcUid: string
  maintenanceId: string
  sourcePodUid: string
  sourceImageId: string
  sourceRestartCount: number
  nodeName: string
  exportId: string
  manifestHash: string
  sourceSnapshotHash: string
  verifiedAt: string
}

export type ConversationStoreExecution =
  | { state: 'pending' }
  | { state: 'blocked'; reason: string }
  | {
      state: 'succeeded'
      outcome: ConversationStoreInitOutcome
      proof?: ConversationStorePhysicalProof
    }

export interface ConversationStoreOperatorContext {
  host: HostCRD
  pvcName: string
  pvcUid: string
  image: string
  templateRevision: string
  canonicalRequested: boolean
  storageContract: ConversationStoreStorageContract
}

export interface ConversationStoreOperatorPort {
  readFreshHost(host: HostCRD): Promise<HostCRD>
  readPvcUid(host: HostCRD, pvcName: string): Promise<string>
  /** Atomic narrow controller fields under UID + resourceVersion + current request tests. */
  writeStatus(
    context: ConversationStoreOperatorContext,
    request: ConversationStoreRequest,
    fields: Partial<Omit<HostConversationStoreStatus, 'request'>>
  ): Promise<HostCRD>
  verifyStoppedWriter(
    context: ConversationStoreOperatorContext,
    request: ConversationStoreRequest
  ): Promise<
    { verified: true; proof: ConversationStoreWriterProof } | { verified: false; reason: string }
  >
  execute(
    context: ConversationStoreOperatorContext,
    request: ConversationStoreRequest,
    phase: 'preparation' | 'migrate' | 'layout-precheck' | 'adopt' | 'current',
    writerProof?: ConversationStoreWriterProof
  ): Promise<ConversationStoreExecution>
  /** Never invoked before the source/export and writer evidence are verified. */
  stopLegacyDeployment(
    context: ConversationStoreOperatorContext,
    request: ConversationStoreRequest,
    proof: ConversationStoreWriterProof
  ): Promise<void>
  now(): Date
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const HASH = /^[0-9a-f]{64}$/
const IMMUTABLE_IMAGE = /@sha256:[0-9a-f]{64}$/

function bound(
  value: {
    hostUid: string
    pvcUid: string
    maintenanceId: string
    storageContract?: ConversationStoreStorageContract
  },
  request: ConversationStoreRequest
): boolean {
  return (
    value.storageContract === request.storageContract &&
    value.hostUid === request.hostUid &&
    value.pvcUid === request.pvcUid &&
    value.maintenanceId === request.maintenanceId
  )
}

/** A request is intent. Only this durable controller flow produces rollout authority. */
export class ConversationStoreOperator {
  constructor(private readonly port: ConversationStoreOperatorPort) {}

  private result(
    request: ConversationStoreRequest,
    state: ConversationStoreRequestResult['state'],
    reason?: string
  ): ConversationStoreRequestResult {
    return {
      storageContract: request.storageContract,
      requestId: request.requestId,
      hostUid: request.hostUid,
      pvcUid: request.pvcUid,
      state,
      updatedAt: this.port.now().toISOString(),
      ...(reason ? { reason } : {}),
    }
  }

  private phase(
    request: ConversationStoreRequest,
    previous: ConversationStoreMaintenance | undefined,
    phase: ConversationStoreMaintenance['phase'],
    reason?: string
  ): ConversationStoreMaintenance {
    const now = this.port.now().toISOString()
    return {
      storageContract: request.storageContract,
      maintenanceId: request.maintenanceId,
      hostUid: request.hostUid,
      pvcUid: request.pvcUid,
      phase,
      startedAt: previous && bound(previous, request) ? previous.startedAt : now,
      updatedAt: now,
      ...(reason ? { reason } : {}),
    }
  }

  private validate(
    context: ConversationStoreOperatorContext,
    request: ConversationStoreRequest
  ): string | undefined {
    if (
      request.schemaVersion !== 1 ||
      !UUID.test(request.requestId) ||
      !UUID.test(request.maintenanceId) ||
      request.principal?.kind !== 'control-admin' ||
      !request.principal.subject
    )
      return 'OperatorRequestInvalid'
    if (request.hostUid !== context.host.uid || request.pvcUid !== context.pvcUid)
      return 'OperatorBindingChanged'
    if (
      !['legacy-floor', 'canonical'].includes(request.storageContract) ||
      request.storageContract !== context.storageContract
    )
      return 'StorageContractChanged'
    if (request.storageContract === 'canonical' && !context.canonicalRequested)
      return 'CanonicalActivationNotRequested'
    if (request.targetImage !== undefined && request.targetImage !== context.image)
      return 'OperatorImageChanged'
    if (
      request.templateRevision !== undefined &&
      request.templateRevision !== context.templateRevision
    )
      return 'OperatorTemplateChanged'
    const maintenance = context.host.status?.conversationStore?.maintenance
    if (request.operation !== 'maintenance' && (!maintenance || !bound(maintenance, request)))
      return 'MaintenanceBindingMismatch'
    if (request.operation === 'prepare') {
      if (
        !IMMUTABLE_IMAGE.test(context.image) ||
        request.targetImage !== context.image ||
        request.templateRevision !== context.templateRevision
      )
        return 'PreparationPinsRequired'
      if (
        !['quiescing', 'fenced', 'migrating', 'completing', 'failed'].includes(maintenance!.phase)
      )
        return 'MaintenanceNotReady'
      if (
        request.sourceClass === 'memory' ||
        request.sourceClass === 'unknown' ||
        !request.sourceClass
      )
        return 'SourceExportRequired'
      if (
        request.sourceClass !== 'new-host' &&
        (!request.exportId ||
          !UUID.test(request.exportId) ||
          !request.manifestHash ||
          !HASH.test(request.manifestHash))
      )
        return 'SourceExportRequired'
      if (request.sourceClass === 'new-host') {
        const provisioned = context.host.status?.conversationStore?.provisioning
        if (
          !provisioned ||
          provisioned.hostUid !== request.hostUid ||
          provisioned.pvcUid !== request.pvcUid
        )
          return 'NewHostProvenanceMissing'
      }
    }
    if (request.operation === 'adopt') {
      if (
        !['fenced', 'migrating', 'completing', 'failed'].includes(maintenance!.phase) ||
        !request.migrationId ||
        !UUID.test(request.migrationId) ||
        !request.manifestHash ||
        !HASH.test(request.manifestHash) ||
        !request.candidateHash ||
        !HASH.test(request.candidateHash)
      )
        return 'AdoptionPinsRequired'
      const floor = request.storageContract === 'legacy-floor'
      const compatibility = context.host.status?.conversationStore?.compatibility
      const currentIdentity = floor
        ? compatibility?.storageContract === 'legacy-floor'
          ? compatibility.migrationId
          : undefined
        : context.host.status?.conversationStore?.layout?.storeId
      const expectedIdentity = floor ? request.expectedMigrationId : request.expectedStoreId
      if (
        (expectedIdentity === undefined) !== (request.expectedCurrentCatalogHash === undefined) ||
        !!currentIdentity !== !!expectedIdentity ||
        (currentIdentity && currentIdentity !== expectedIdentity) ||
        (floor ? request.expectedStoreId !== undefined : request.expectedMigrationId !== undefined)
      )
        return 'AdoptBindingMismatch'
    }
    if (request.operation === 'release') {
      const floor = request.storageContract === 'legacy-floor'
      const expectedIdentity = floor ? request.expectedMigrationId : request.expectedStoreId
      if (
        maintenance!.phase !== 'completed' ||
        !expectedIdentity ||
        !UUID.test(expectedIdentity) ||
        (floor
          ? request.expectedStoreId !== undefined
          : request.expectedMigrationId !== undefined) ||
        !request.expectedCurrentCatalogHash ||
        !HASH.test(request.expectedCurrentCatalogHash)
      )
        return 'ReleasePinsRequired'
    }
    return undefined
  }

  private async reject(
    context: ConversationStoreOperatorContext,
    request: ConversationStoreRequest,
    reason: string,
    failMaintenance = false
  ): Promise<HostCRD> {
    return this.port.writeStatus(context, request, {
      requestResult: this.result(request, 'rejected', reason),
      ready: { ready: false, reason: 'MigrationBlocked', message: reason },
      ...(failMaintenance
        ? {
            maintenance: this.phase(
              request,
              context.host.status?.conversationStore?.maintenance,
              'failed',
              reason
            ),
          }
        : {}),
    })
  }

  private async proofStillCurrent(
    context: ConversationStoreOperatorContext,
    request: ConversationStoreRequest
  ): Promise<void> {
    const fresh = await this.port.readFreshHost(context.host)
    const currentPvcUid = await this.port.readPvcUid(fresh, context.pvcName)
    if (
      fresh.uid !== request.hostUid ||
      !isDeepStrictEqual(fresh.spec, context.host.spec) ||
      currentPvcUid !== request.pvcUid ||
      !isDeepStrictEqual(fresh.status?.conversationStore?.request, request)
    )
      throw new Error('OperatorBindingChanged')
    const state = fresh.status?.conversationStore
    const canonicalAuthority =
      fresh.annotations?.['clerum.io/canonical-store'] === 'enabled' ||
      (state?.layout?.version === 1 &&
        state.layout.hostUid === request.hostUid &&
        state.layout.pvcUid === request.pvcUid) ||
      (state?.operationOutcome?.storageContract === 'canonical' &&
        state.operationOutcome.hostUid === request.hostUid &&
        state.operationOutcome.pvcUid === request.pvcUid &&
        !!state.operationOutcome.storeId)
    if ((request.storageContract === 'canonical') !== canonicalAuthority)
      throw new Error('StorageContractChanged')
    context.host = fresh
  }

  private validPhysicalProof(
    proof: ConversationStorePhysicalProof | undefined,
    request: ConversationStoreRequest
  ): proof is ConversationStorePhysicalProof {
    return !!proof && proof.proofVersion === 1 && bound(proof, request)
  }

  /** One bounded step per reconcile. Pending Jobs are resumed by watch/resync, never a success timeout. */
  async reconcile(
    context: ConversationStoreOperatorContext
  ): Promise<{ held: boolean; host: HostCRD }> {
    const expectedSpec = context.host.spec
    context.host = await this.port.readFreshHost(context.host)
    if (!isDeepStrictEqual(context.host.spec, expectedSpec))
      throw new Error('OperatorBindingChanged')
    const store = context.host.status?.conversationStore
    const request = store?.request
    const maintenance = store?.maintenance
    if (!request)
      return { held: !!maintenance && maintenance.phase !== 'released', host: context.host }
    const freshPvcUid = await this.port.readPvcUid(context.host, context.pvcName)
    if (freshPvcUid !== context.pvcUid) throw new Error('OperatorBindingChanged')
    const result = store?.requestResult
    const terminal =
      result?.requestId === request.requestId &&
      result.storageContract === request.storageContract &&
      result.hostUid === request.hostUid &&
      result.pvcUid === request.pvcUid &&
      (result.state === 'completed' || result.state === 'rejected')
    if (terminal)
      return { held: !!maintenance && maintenance.phase !== 'released', host: context.host }
    const invalid = this.validate(context, request)
    if (invalid) return { held: true, host: await this.reject(context, request, invalid) }

    if (request.operation === 'maintenance') {
      if (maintenance && !bound(maintenance, request) && maintenance.phase !== 'released') {
        return { held: true, host: await this.reject(context, request, 'MaintenanceAlreadyActive') }
      }
      // A completed request acknowledges latching admission, not releasing it.
      // It allows the operator to submit prepare without replacing pending execution.
      const host = await this.port.writeStatus(context, request, {
        maintenance:
          maintenance && bound(maintenance, request) && maintenance.phase !== 'released'
            ? maintenance
            : this.phase(request, undefined, 'quiescing'),
        requestResult: this.result(request, 'completed'),
        ready: { ready: false, reason: 'MigrationPending', message: 'MaintenanceQuiescing' },
      })
      return { held: true, host }
    }

    if (request.operation === 'release') {
      context.host = await this.port.writeStatus(context, request, {
        requestResult: this.result(request, 'accepted'),
      })
      const current = await this.port.execute(context, request, 'current', store?.writerProof)
      if (current.state === 'pending') return { held: true, host: context.host }
      if (current.state === 'blocked')
        return { held: true, host: await this.reject(context, request, current.reason) }
      const proof = current.proof
      const matchesIdentity =
        request.storageContract === 'legacy-floor'
          ? proof?.storeId === undefined &&
            proof?.migrationId === request.expectedMigrationId &&
            proof?.layoutVersion === 1 &&
            proof.databasePath === 'state/state.db' &&
            proof.writerFenceRoot === 'state'
          : proof?.storeId === request.expectedStoreId
      if (
        !this.validPhysicalProof(proof, request) ||
        !matchesIdentity ||
        proof.currentCatalogHash !== request.expectedCurrentCatalogHash ||
        (request.migrationId !== undefined && proof.migrationId !== request.migrationId) ||
        (request.manifestHash !== undefined && proof.manifestHash !== request.manifestHash) ||
        (request.candidateHash !== undefined && proof.candidateHash !== request.candidateHash)
      ) {
        return { held: true, host: await this.reject(context, request, 'ReleaseBindingMismatch') }
      }
      await this.proofStillCurrent(context, request)
      return {
        held: false,
        host: await this.port.writeStatus(context, request, {
          maintenance: this.phase(request, maintenance, 'released'),
          requestResult: this.result(request, 'completed'),
          ready: {
            ready: true,
            reason: request.storageContract === 'legacy-floor' ? 'LayoutReady' : 'Canonical',
          },
        }),
      }
    }

    context.host = await this.port.writeStatus(context, request, {
      requestResult: this.result(request, 'accepted'),
    })
    let writerProof = store?.writerProof
    let preparation = store?.preparation
    if (request.operation === 'prepare' && preparation?.requestId !== request.requestId) {
      if (request.sourceClass !== 'new-host') {
        const stopped = await this.port.verifyStoppedWriter(context, request)
        if (!stopped.verified)
          return { held: true, host: await this.reject(context, request, stopped.reason) }
        writerProof = stopped.proof
        if (
          !bound(writerProof, request) ||
          writerProof.exportId !== request.exportId ||
          writerProof.manifestHash !== request.manifestHash
        ) {
          return {
            held: true,
            host: await this.reject(context, request, 'WriterProofBindingMismatch'),
          }
        }
      }
      const physical = await this.port.execute(context, request, 'preparation', writerProof)
      if (physical.state === 'pending') return { held: true, host: context.host }
      if (physical.state === 'blocked')
        return { held: true, host: await this.reject(context, request, physical.reason) }
      const proof = physical.proof
      if (
        !this.validPhysicalProof(proof, request) ||
        !proof.manifestHash ||
        !HASH.test(proof.manifestHash) ||
        proof.sourceClass !== request.sourceClass ||
        (request.manifestHash !== undefined && proof.manifestHash !== request.manifestHash) ||
        (request.exportId !== undefined && proof.exportId !== request.exportId) ||
        (writerProof &&
          request.sourceClass === 'sqlite-external-exported' &&
          proof.sourceSnapshotHash !== writerProof.sourceSnapshotHash)
      ) {
        return {
          held: true,
          host: await this.reject(context, request, 'PreparationEvidenceMismatch'),
        }
      }
      await this.proofStillCurrent(context, request)
      const evidenceJob = context.host.status?.conversationStore?.execution
      if (
        !evidenceJob?.jobName ||
        !evidenceJob.jobUid ||
        evidenceJob.requestId !== request.requestId ||
        evidenceJob.phase !== 'preparation'
      ) {
        return {
          held: true,
          host: await this.reject(context, request, 'OperatorExecutionIdentityMissing'),
        }
      }
      preparation = {
        schemaVersion: 1,
        storageContract: request.storageContract,
        requestId: request.requestId,
        hostUid: request.hostUid,
        pvcUid: request.pvcUid,
        image: context.image,
        templateRevision: context.templateRevision,
        sourceClass: request.sourceClass!,
        maintenanceId: request.maintenanceId,
        verificationJobName: context.host.status?.conversationStore?.execution?.jobName,
        verificationJobUid: context.host.status?.conversationStore?.execution?.jobUid,
        preparedAt: this.port.now().toISOString(),
        provenance: request.sourceClass === 'new-host' ? 'new' : 'existing',
        ...(proof.manifestHash ? { manifestHash: proof.manifestHash } : {}),
        ...(request.exportId ? { exportId: request.exportId } : {}),
      }
      context.host = await this.port.writeStatus(context, request, {
        preparation,
        ...(writerProof ? { writerProof } : {}),
        maintenance: this.phase(request, maintenance, 'fenced'),
        requestResult: this.result(request, 'accepted'),
      })
    }
    if (
      !preparation ||
      preparation.storageContract !== request.storageContract ||
      preparation.hostUid !== request.hostUid ||
      preparation.pvcUid !== request.pvcUid ||
      preparation.maintenanceId !== request.maintenanceId ||
      !IMMUTABLE_IMAGE.test(preparation.image)
    ) {
      return { held: true, host: await this.reject(context, request, 'PreparationReceiptMissing') }
    }
    if (preparation.sourceClass !== 'new-host') {
      if (!writerProof || !bound(writerProof, request))
        return { held: true, host: await this.reject(context, request, 'WriterProofMissing') }
      await this.port.stopLegacyDeployment(context, request, writerProof)
    }
    await this.proofStillCurrent(context, request)
    if (request.storageContract === 'canonical') {
      const layout = context.host.status?.conversationStore?.layout
      if (
        layout &&
        (layout.hostUid !== request.hostUid ||
          layout.pvcUid !== request.pvcUid ||
          layout.version !== 1)
      ) {
        return {
          held: true,
          host: await this.reject(context, request, 'CanonicalLayoutBindingMismatch', true),
        }
      }
      if (!layout) {
        // Commit before the first canonical mutation, so removing opt-in while
        // its journal is active cannot reclassify the operation as legacy floor.
        context.host = await this.port.writeStatus(context, request, {
          layout: {
            version: 1,
            hostUid: request.hostUid,
            pvcUid: request.pvcUid,
            state: 'pending',
            committedAt: this.port.now().toISOString(),
          },
        })
      }
    }
    const savedOutcome = context.host.status?.conversationStore?.operationOutcome
    const mutationPhase =
      request.operation === 'adopt'
        ? 'adopt'
        : request.storageContract === 'legacy-floor'
          ? 'layout-precheck'
          : 'migrate'
    if (savedOutcome?.requestId !== request.requestId) {
      context.host = await this.port.writeStatus(context, request, {
        maintenance: this.phase(
          request,
          context.host.status?.conversationStore?.maintenance,
          'migrating'
        ),
        requestResult: this.result(request, 'accepted'),
      })
    }
    const execution: ConversationStoreExecution =
      savedOutcome?.requestId === request.requestId &&
      savedOutcome.storageContract === request.storageContract
        ? {
            state: 'succeeded',
            outcome: {
              outcome: 'ok',
              storageContract: savedOutcome.storageContract,
              reason: savedOutcome.reason as ConversationStoreInitOutcome['reason'],
              layoutVersion: 1,
              storeId: savedOutcome.storeId,
              migrationId: savedOutcome.migrationId,
              catalogHash: savedOutcome.catalogHash,
              databasePath: savedOutcome.databasePath,
              writerFenceRoot: savedOutcome.writerFenceRoot,
            },
          }
        : await this.port.execute(context, request, mutationPhase, writerProof)
    if (execution.state === 'pending') return { held: true, host: context.host }
    if (execution.state === 'blocked')
      return { held: true, host: await this.reject(context, request, execution.reason, true) }
    if (
      execution.outcome.storageContract !== request.storageContract ||
      !(request.storageContract === 'legacy-floor'
        ? isLegacyFloorSuccessOutcome(execution.outcome)
        : isCanonicalSuccessOutcome(execution.outcome))
    )
      return {
        held: true,
        host: await this.reject(context, request, 'OperatorOutcomeMismatch', true),
      }
    if (savedOutcome?.requestId !== request.requestId) {
      const mutationJob = context.host.status?.conversationStore?.execution
      if (
        !mutationJob?.jobName ||
        !mutationJob.jobUid ||
        mutationJob.requestId !== request.requestId ||
        mutationJob.storageContract !== request.storageContract ||
        mutationJob.phase !== mutationPhase
      ) {
        return {
          held: true,
          host: await this.reject(context, request, 'OperatorExecutionIdentityMissing', true),
        }
      }
      context.host = await this.port.writeStatus(context, request, {
        operationOutcome: {
          layoutVersion: 1,
          storageContract: request.storageContract,
          requestId: request.requestId,
          operation: request.operation as 'prepare' | 'adopt',
          hostUid: request.hostUid,
          pvcUid: request.pvcUid,
          maintenanceId: request.maintenanceId,
          ...(execution.outcome.storeId ? { storeId: execution.outcome.storeId } : {}),
          ...(execution.outcome.migrationId ? { migrationId: execution.outcome.migrationId } : {}),
          ...(execution.outcome.catalogHash ? { catalogHash: execution.outcome.catalogHash } : {}),
          ...(request.storageContract === 'legacy-floor'
            ? { databasePath: 'state/state.db', writerFenceRoot: 'state' }
            : {}),
          reason: execution.outcome.reason,
          jobName: mutationJob.jobName,
          jobUid: mutationJob.jobUid,
        },
      })
    }
    context.host = await this.port.writeStatus(context, request, {
      maintenance: this.phase(
        request,
        context.host.status?.conversationStore?.maintenance,
        'completing'
      ),
    })
    const current = await this.port.execute(context, request, 'current', writerProof)
    if (current.state === 'pending') return { held: true, host: context.host }
    if (current.state === 'blocked')
      return { held: true, host: await this.reject(context, request, current.reason, true) }
    const proof = current.proof
    const floor = request.storageContract === 'legacy-floor'
    const currentIdentityMatches = floor
      ? proof?.storeId === undefined &&
        proof?.migrationId === execution.outcome.migrationId &&
        proof?.layoutVersion === 1 &&
        proof.databasePath === 'state/state.db' &&
        proof.writerFenceRoot === 'state'
      : !!proof?.storeId && UUID.test(proof.storeId) && proof.storeId === execution.outcome.storeId
    if (
      !this.validPhysicalProof(proof, request) ||
      !currentIdentityMatches ||
      !proof.migrationId ||
      !UUID.test(proof.migrationId) ||
      !proof.currentCatalogHash ||
      !HASH.test(proof.currentCatalogHash) ||
      (proof.catalogHash !== undefined && proof.catalogHash !== proof.currentCatalogHash) ||
      (execution.outcome.catalogHash !== undefined &&
        execution.outcome.catalogHash !== proof.currentCatalogHash) ||
      (request.operation === 'adopt' && proof.migrationId !== request.migrationId)
    ) {
      return {
        held: true,
        host: await this.reject(context, request, 'OperatorOutcomeMismatch', true),
      }
    }
    await this.proofStillCurrent(context, request)
    const now = this.port.now().toISOString()
    return {
      held: true,
      host: await this.port.writeStatus(context, request, {
        maintenance: this.phase(request, maintenance, 'completed'),
        requestResult: this.result(request, 'completed'),
        ...(!floor
          ? {
              layout: {
                version: 1 as const,
                hostUid: request.hostUid,
                pvcUid: request.pvcUid,
                state: 'ready' as const,
                storeId: proof.storeId,
                committedAt: store?.layout?.committedAt ?? now,
              },
            }
          : {}),
        compatibility: {
          schemaVersion: 1,
          storageContract: request.storageContract,
          hostUid: request.hostUid,
          pvcUid: request.pvcUid,
          contractVersion: 1,
          ...(floor
            ? {
                layoutVersion: 1 as const,
                migrationId: proof.migrationId,
                databasePath: 'state/state.db' as const,
                writerFenceRoot: 'state' as const,
                catalogHash: proof.currentCatalogHash,
              }
            : {}),
          establishedAt: now,
        },
        completion: proof,
        ready: { ready: true, reason: floor ? 'LayoutReady' : 'Canonical' },
      }),
    }
  }
}
