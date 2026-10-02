import type {
  V1Job,
  V1PersistentVolumeClaim,
  V1Pod,
  V1SelfSubjectReview,
} from '@kubernetes/client-node'
import { createHash } from 'node:crypto'
import { posix } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { isDeepStrictEqual } from 'node:util'
import {
  type AdoptionRequest,
  type Binding,
  CanonicalStoreError,
  type LegacyAdoptionRequest,
  type LegacyOperatorAuthorization,
  type LegacyRecoveryRequest,
  type OperatorAuthorization,
  type RecoveryRequest,
} from '../db/canonicalStore/types'

export type ConversationStoreStorageContract = 'legacy-floor' | 'canonical'
export type CanonicalOperatorResolveInput =
  | { requestId: string; operation: 'adopt'; action: 'adopt' | 'verify-current' }
  | {
      requestId: string
      operation: 'prepare'
      action: 'migrate' | 'layout-precheck' | 'verify-preparation' | 'verify-current'
    }
  | { requestId: string; operation: 'release'; action: 'verify-current' }

interface OperatorRequestBase extends Binding {
  schemaVersion: 1
  requestId: string
  storageContract: ConversationStoreStorageContract
  maintenanceId: string
  principal: { kind: 'control-admin'; subject: string }
  targetImage?: string
  templateRevision?: string
  sourceClass?: string
  manifestHash?: string
  exportId?: string
  migrationId?: string
  candidateHash?: string
  expectedStoreId?: string
  expectedMigrationId?: string
  expectedCurrentCatalogHash?: string
}
export interface CanonicalAdoptOperatorRequest extends OperatorRequestBase {
  operation: 'adopt'
  migrationId: string
  manifestHash: string
  candidateHash: string
}
export interface CanonicalPrepareOperatorRequest extends OperatorRequestBase {
  operation: 'prepare'
  targetImage: string
  templateRevision: string
  sourceClass: 'sqlite-pvc' | 'sqlite-external-exported' | 'new-host'
  manifestHash?: string
}
export interface CanonicalReleaseOperatorRequest extends OperatorRequestBase {
  operation: 'release'
  expectedCurrentCatalogHash: string
}
export type CanonicalOperatorRequest =
  | CanonicalAdoptOperatorRequest
  | CanonicalPrepareOperatorRequest
  | CanonicalReleaseOperatorRequest

interface CapabilityBinding extends Binding {
  requestId: string
  requestHash: string
  storageContract: ConversationStoreStorageContract
  maintenanceId: string
  principal: string
  jobUid: string
  podUid: string
  image: string
  templateRevision: string
}
export interface CanonicalMigrationAuthorization extends CapabilityBinding {
  kind: 'canonical-migration'
  storageContract: 'canonical'
  verifiedManifestHash: string
  operation: 'prepare'
  action: 'migrate'
}
export interface CanonicalNewHostInitializationAuthorization extends CapabilityBinding {
  kind: 'canonical-new-host-initialization'
  storageContract: 'canonical'
  verifiedManifestHash: string
  operation: 'prepare'
  action: 'migrate'
  provisioning: { hostUid: string; pvcUid: string; createdAt: string }
}
export interface CanonicalFinalizationVerificationAuthorization extends CapabilityBinding {
  kind: 'canonical-finalization-verification'
  storageContract: 'canonical'
  operation: 'prepare' | 'adopt'
  action: 'verify-current'
  expectedStoreId: string
  expectedCurrentCatalogHash: string
  mutatorJobUid: string
}
export interface CanonicalPreparationVerificationAuthorization extends CapabilityBinding {
  kind: 'canonical-preparation-verification'
  storageContract: 'canonical'
  operation: 'prepare'
  action: 'verify-preparation'
}
export interface CanonicalVerificationAuthorization extends CapabilityBinding {
  kind: 'canonical-verification'
  storageContract: 'canonical'
  operation: 'release'
  action: 'verify-current'
}
export interface LegacyFloorMigrationAuthorization extends CapabilityBinding {
  kind: 'legacy-floor-migration'
  storageContract: 'legacy-floor'
  verifiedManifestHash: string
  operation: 'prepare'
  action: 'layout-precheck'
}
export interface LegacyFloorNewHostInitializationAuthorization extends CapabilityBinding {
  kind: 'legacy-floor-new-host-initialization'
  storageContract: 'legacy-floor'
  verifiedManifestHash: string
  operation: 'prepare'
  action: 'layout-precheck'
  provisioning: { hostUid: string; pvcUid: string; createdAt: string }
}
export interface LegacyFloorPreparationVerificationAuthorization extends CapabilityBinding {
  kind: 'legacy-floor-preparation-verification'
  storageContract: 'legacy-floor'
  operation: 'prepare'
  action: 'verify-preparation'
}
export interface LegacyFloorFinalizationVerificationAuthorization extends CapabilityBinding {
  kind: 'legacy-floor-finalization-verification'
  storageContract: 'legacy-floor'
  operation: 'prepare' | 'adopt'
  action: 'verify-current'
  expectedMigrationId: string
  expectedCurrentCatalogHash: string
  mutatorJobUid: string
}
export interface LegacyFloorVerificationAuthorization extends CapabilityBinding {
  kind: 'legacy-floor-verification'
  storageContract: 'legacy-floor'
  operation: 'release'
  action: 'verify-current'
}

export interface CanonicalOperatorProof extends Binding {
  requestId: string
  requestHash: string
  storageContract: ConversationStoreStorageContract
  hostResourceVersion: string
  pvcName: string
  pvcResourceVersion: string
  podName: string
  podUid: string
  podResourceVersion: string
  jobName: string
  jobUid: string
  jobResourceVersion: string
  image: string
  templateRevision: string
  rootMountPath: string
  rootReadOnly: boolean
}
interface ResolvedBase extends Binding {
  storageContract: ConversationStoreStorageContract
  binding: Binding
  maintenanceId: string
  principal: string
  proof: CanonicalOperatorProof
}
export interface ResolvedCanonicalAdoption extends ResolvedBase {
  storageContract: 'canonical'
  operation: 'adopt'
  action: 'adopt'
  request: AdoptionRequest | RecoveryRequest
  operatorRequest: CanonicalAdoptOperatorRequest
  authorization: OperatorAuthorization & {
    kind: 'canonical-adoption'
    storageContract: 'canonical'
    requestHash: string
  }
}
export interface ResolvedLegacyFloorAdoption extends ResolvedBase {
  storageContract: 'legacy-floor'
  operation: 'adopt'
  action: 'adopt'
  request: LegacyAdoptionRequest | LegacyRecoveryRequest
  operatorRequest: CanonicalAdoptOperatorRequest
  authorization: LegacyOperatorAuthorization & { requestHash: string }
}
export interface ResolvedCanonicalMigration extends ResolvedBase {
  storageContract: 'canonical'
  operation: 'prepare'
  action: 'migrate'
  request: CanonicalPrepareOperatorRequest
  authorization: CanonicalMigrationAuthorization
}
export interface ResolvedLegacyFloorMigration extends ResolvedBase {
  storageContract: 'legacy-floor'
  operation: 'prepare'
  action: 'layout-precheck'
  request: CanonicalPrepareOperatorRequest
  authorization: LegacyFloorMigrationAuthorization
}
export interface ResolvedCanonicalNewHostInitialization extends ResolvedBase {
  storageContract: 'canonical'
  operation: 'prepare'
  action: 'migrate'
  request: CanonicalPrepareOperatorRequest
  authorization: CanonicalNewHostInitializationAuthorization
}
export interface ResolvedLegacyFloorNewHostInitialization extends ResolvedBase {
  storageContract: 'legacy-floor'
  operation: 'prepare'
  action: 'layout-precheck'
  request: CanonicalPrepareOperatorRequest
  authorization: LegacyFloorNewHostInitializationAuthorization
}
export interface ResolvedCanonicalFinalizationVerification extends ResolvedBase {
  storageContract: 'canonical'
  operation: 'prepare' | 'adopt'
  action: 'verify-current'
  request: CanonicalPrepareOperatorRequest | CanonicalAdoptOperatorRequest
  expectedStoreId: string
  expectedCurrentCatalogHash: string
  authorization: CanonicalFinalizationVerificationAuthorization
}
export interface ResolvedLegacyFloorFinalizationVerification extends ResolvedBase {
  storageContract: 'legacy-floor'
  operation: 'prepare' | 'adopt'
  action: 'verify-current'
  request: CanonicalPrepareOperatorRequest | CanonicalAdoptOperatorRequest
  expectedMigrationId: string
  expectedCurrentCatalogHash: string
  authorization: LegacyFloorFinalizationVerificationAuthorization
}
export interface ResolvedCanonicalPreparationVerification extends ResolvedBase {
  storageContract: 'canonical'
  operation: 'prepare'
  action: 'verify-preparation'
  request: CanonicalPrepareOperatorRequest
  authorization: CanonicalPreparationVerificationAuthorization
}
export interface ResolvedLegacyFloorPreparationVerification extends ResolvedBase {
  storageContract: 'legacy-floor'
  operation: 'prepare'
  action: 'verify-preparation'
  request: CanonicalPrepareOperatorRequest
  authorization: LegacyFloorPreparationVerificationAuthorization
}
export interface ResolvedCanonicalVerification extends ResolvedBase {
  storageContract: 'canonical'
  operation: 'release'
  action: 'verify-current'
  request: CanonicalReleaseOperatorRequest
  authorization: CanonicalVerificationAuthorization
}
export interface ResolvedLegacyFloorVerification extends ResolvedBase {
  storageContract: 'legacy-floor'
  operation: 'release'
  action: 'verify-current'
  request: CanonicalReleaseOperatorRequest
  authorization: LegacyFloorVerificationAuthorization
}
export type ResolvedCanonicalOperatorRequest =
  | ResolvedCanonicalAdoption
  | ResolvedLegacyFloorAdoption
  | ResolvedCanonicalMigration
  | ResolvedLegacyFloorMigration
  | ResolvedCanonicalNewHostInitialization
  | ResolvedLegacyFloorNewHostInitialization
  | ResolvedCanonicalFinalizationVerification
  | ResolvedLegacyFloorFinalizationVerification
  | ResolvedCanonicalPreparationVerification
  | ResolvedLegacyFloorPreparationVerification
  | ResolvedCanonicalVerification
  | ResolvedLegacyFloorVerification

export interface CanonicalOperatorContext {
  hostName: string
  namespace: string
  podUid: string
}
export interface CanonicalOperatorHost {
  metadata?: {
    name?: string
    namespace?: string
    uid?: string
    resourceVersion?: string
    annotations?: Record<string, string>
    creationTimestamp?: unknown
    deletionTimestamp?: unknown
  }
  status?: { conversationStore?: Record<string, unknown> }
}
/** Injected readers are an explicit programmatic unit boundary, never CLI input. */
export interface CanonicalOperatorReaders {
  selfSubjectReview(): Promise<V1SelfSubjectReview>
  readHost(name: string, namespace: string): Promise<CanonicalOperatorHost>
  readPod(name: string, namespace: string): Promise<V1Pod>
  readJob(name: string, namespace: string): Promise<V1Job>
  readPvc(name: string, namespace: string): Promise<V1PersistentVolumeClaim>
}
export interface CanonicalOperatorTestBoundary {
  context: CanonicalOperatorContext
  readers: CanonicalOperatorReaders
  bootstrapWaitMs?: number
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const SHA256 = /^[0-9a-f]{64}$/
const DNS_NAME = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/
const REQUEST_FIELDS = new Set([
  'schemaVersion',
  'requestId',
  'operation',
  'hostUid',
  'pvcUid',
  'maintenanceId',
  'principal',
  'targetImage',
  'templateRevision',
  'sourceClass',
  'manifestHash',
  'exportId',
  'migrationId',
  'candidateHash',
  'expectedStoreId',
  'expectedMigrationId',
  'expectedCurrentCatalogHash',
  'storageContract',
])
const BOOTSTRAP_WAIT_MS = 30_000
const RESOLUTION_TIMEOUT_MS = 60_000
const API_TIMEOUT_MS = 10_000

function deny(): never {
  throw new CanonicalStoreError('AdoptUnauthorized')
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) deny()
  return value as Record<string, unknown>
}
function string(value: unknown, pattern?: RegExp): string {
  if (
    typeof value !== 'string' ||
    !value ||
    /[\u0000-\u001f\u007f]/.test(value) ||
    (pattern && !pattern.test(value))
  )
    deny()
  return value
}
function assertContext(context: CanonicalOperatorContext): void {
  if (context.hostName.length > 253 || context.namespace.length > 63) deny()
  string(context.hostName, DNS_NAME)
  string(context.namespace, DNS_NAME)
  string(context.podUid)
}
function metadata(value: unknown, name: string, namespace: string) {
  const meta = object(object(value).metadata)
  if (meta.name !== name || meta.namespace !== namespace || meta.deletionTimestamp !== undefined)
    deny()
  return { uid: string(meta.uid), resourceVersion: string(meta.resourceVersion) }
}
function authenticatedPod(review: V1SelfSubjectReview, context: CanonicalOperatorContext) {
  const user = object(review.status?.userInfo)
  const username = string(user.username)
  const prefix = `system:serviceaccount:${context.namespace}:`
  if (!username.startsWith(prefix) || !username.slice(prefix.length)) deny()
  const extra = object(user.extra)
  const names = extra['authentication.kubernetes.io/pod-name']
  const uids = extra['authentication.kubernetes.io/pod-uid']
  if (
    !Array.isArray(names) ||
    names.length !== 1 ||
    !Array.isArray(uids) ||
    uids.length !== 1 ||
    uids[0] !== context.podUid
  )
    deny()
  return {
    username,
    serviceAccount: username.slice(prefix.length),
    userUid: string(user.uid),
    podName: string(names[0], DNS_NAME),
    podUid: string(uids[0]),
  }
}
/** Same stable JSON algorithm as HCC; field order never changes a request identity. */
export function computeCanonicalOperatorRequestHash(request: CanonicalOperatorRequest): string {
  function ordered(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(ordered)
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value)
          .filter(([, item]) => item !== undefined)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, item]) => [key, ordered(item)])
      )
    }
    return value
  }
  return createHash('sha256')
    .update(JSON.stringify(ordered(request)))
    .digest('hex')
}

function desiredStorageContract(host: CanonicalOperatorHost): ConversationStoreStorageContract {
  const store = object(host.status?.conversationStore)
  const layout = store.layout === undefined ? undefined : object(store.layout)
  const outcome = store.operationOutcome === undefined ? undefined : object(store.operationOutcome)
  const committed =
    layout?.version === 1 ||
    typeof layout?.storeId === 'string' ||
    (outcome?.storageContract === 'canonical' && typeof outcome.storeId === 'string')
  return committed || host.metadata?.annotations?.['clerum.io/canonical-store'] === 'enabled'
    ? 'canonical'
    : 'legacy-floor'
}

function floorCurrentProof(raw: unknown, binding: Binding) {
  const proof = object(raw)
  if (
    proof.storageContract !== 'legacy-floor' ||
    proof.hostUid !== binding.hostUid ||
    proof.pvcUid !== binding.pvcUid ||
    proof.layoutVersion !== 1 ||
    proof.databasePath !== 'state/state.db' ||
    proof.writerFenceRoot !== 'state' ||
    proof.storeId !== undefined ||
    (proof.currentCatalogHash !== undefined && proof.currentCatalogHash !== proof.catalogHash)
  )
    deny()
  return {
    migrationId: string(proof.migrationId, UUID),
    catalogHash: string(proof.catalogHash, SHA256),
  }
}

function validateRequest(
  raw: unknown,
  input: CanonicalOperatorResolveInput
): CanonicalOperatorRequest {
  const request = object(raw)
  if (
    Object.keys(request).some(key => !REQUEST_FIELDS.has(key)) ||
    request.schemaVersion !== 1 ||
    request.operation !== input.operation ||
    request.requestId !== input.requestId
  )
    deny()
  string(request.requestId, UUID)
  string(request.hostUid)
  string(request.pvcUid)
  string(request.maintenanceId, UUID)
  if (request.storageContract !== 'canonical' && request.storageContract !== 'legacy-floor') deny()
  const principal = object(request.principal)
  if (
    principal.kind !== 'control-admin' ||
    Object.keys(principal).some(key => key !== 'kind' && key !== 'subject') ||
    string(principal.subject).length > 256
  )
    deny()
  for (const key of [
    'manifestHash',
    'templateRevision',
    'candidateHash',
    'expectedCurrentCatalogHash',
  ]) {
    if (Object.hasOwn(request, key)) string(request[key], SHA256)
  }
  for (const key of ['migrationId', 'exportId', 'expectedStoreId', 'expectedMigrationId']) {
    if (Object.hasOwn(request, key)) string(request[key], UUID)
  }
  const currentIdentity =
    request.storageContract === 'canonical' ? request.expectedStoreId : request.expectedMigrationId
  if (
    (request.storageContract === 'canonical' && request.expectedMigrationId !== undefined) ||
    (request.storageContract === 'legacy-floor' && request.expectedStoreId !== undefined) ||
    (currentIdentity === undefined) !== (request.expectedCurrentCatalogHash === undefined)
  )
    deny()
  if (
    input.operation === 'prepare' &&
    ((input.action === 'migrate' && request.storageContract !== 'canonical') ||
      (input.action === 'layout-precheck' && request.storageContract !== 'legacy-floor'))
  )
    deny()
  if (input.operation === 'adopt') {
    string(request.migrationId, UUID)
    string(request.manifestHash, SHA256)
    string(request.candidateHash, SHA256)
  } else if (input.operation === 'prepare') {
    string(request.targetImage)
    string(request.templateRevision, SHA256)
    // Memory/unknown have no supported export capability. New-host instead
    // requires an actual controller-created PVC receipt and physical probe.
    if (
      request.sourceClass !== 'sqlite-pvc' &&
      request.sourceClass !== 'sqlite-external-exported' &&
      request.sourceClass !== 'new-host'
    )
      deny()
    if (request.sourceClass !== 'new-host') string(request.manifestHash, SHA256)
    if (request.sourceClass === 'sqlite-external-exported') string(request.exportId, UUID)
  } else {
    string(currentIdentity, UUID)
    string(request.expectedCurrentCatalogHash, SHA256)
  }
  return structuredClone(request) as unknown as CanonicalOperatorRequest
}
function controllerOwner(value: unknown, kind: string, apiVersion: string) {
  const owners = object(object(value).metadata).ownerReferences
  if (!Array.isArray(owners)) deny()
  const controllers = owners.map(object).filter(owner => owner.controller === true)
  if (
    controllers.length !== 1 ||
    controllers[0].kind !== kind ||
    controllers[0].apiVersion !== apiVersion
  )
    deny()
  return { name: string(controllers[0].name, DNS_NAME), uid: string(controllers[0].uid) }
}
function rootMount(spec: unknown) {
  const pod = object(spec)
  if (
    !Array.isArray(pod.containers) ||
    pod.containers.length !== 1 ||
    (Array.isArray(pod.initContainers) && pod.initContainers.length > 0)
  )
    deny()
  const container = object(pod.containers[0])
  const volumes = pod.volumes
  if (!Array.isArray(volumes) || !Array.isArray(container.volumeMounts)) deny()
  const claims = volumes.map(object).filter(volume => volume.persistentVolumeClaim !== undefined)
  if (claims.length !== 1) deny()
  const volume = claims[0]
  const claim = object(volume.persistentVolumeClaim)
  const mounts = container.volumeMounts.map(object).filter(mount => mount.name === volume.name)
  if (mounts.length !== 1) deny()
  const mount = mounts[0]
  if (
    (mount.subPath !== undefined && mount.subPath !== '') ||
    (mount.subPathExpr !== undefined && mount.subPathExpr !== '')
  )
    deny()
  const mountPath = string(mount.mountPath)
  if (!posix.isAbsolute(mountPath) || mountPath === '/' || posix.normalize(mountPath) !== mountPath)
    deny()
  return {
    claimName: string(claim.claimName, DNS_NAME),
    mountPath,
    image: string(container.image),
    serviceAccount: string(pod.serviceAccountName),
    readOnly: mount.readOnly === true || claim.readOnly === true,
  }
}
function adoptionPins(request: CanonicalAdoptOperatorRequest): AdoptionRequest {
  return {
    schemaVersion: 1,
    requestId: request.requestId,
    hostUid: request.hostUid,
    pvcUid: request.pvcUid,
    maintenanceId: request.maintenanceId,
    migrationId: request.migrationId,
    manifestHash: request.manifestHash,
    candidateHash: request.candidateHash,
  }
}
function adoptPins(request: CanonicalAdoptOperatorRequest): AdoptionRequest | RecoveryRequest {
  const pins = adoptionPins(request)
  return request.expectedStoreId === undefined
    ? pins
    : {
        ...pins,
        expectedStoreId: request.expectedStoreId,
        expectedCurrentCatalogHash: request.expectedCurrentCatalogHash!,
      }
}
function legacyAdoptPins(
  request: CanonicalAdoptOperatorRequest
): LegacyAdoptionRequest | LegacyRecoveryRequest {
  const pins: LegacyAdoptionRequest = { ...adoptionPins(request), storageContract: 'legacy-floor' }
  return request.expectedMigrationId === undefined
    ? pins
    : {
        ...pins,
        expectedMigrationId: request.expectedMigrationId,
        expectedCurrentCatalogHash: request.expectedCurrentCatalogHash!,
      }
}
function isoTimestamp(value: unknown): string {
  if (!(value instanceof Date) && typeof value !== 'string') deny()
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) deny()
  return date.toISOString()
}
function assertProvisioning(
  store: Record<string, unknown>,
  request: CanonicalPrepareOperatorRequest,
  pvc: V1PersistentVolumeClaim,
  host: CanonicalOperatorHost
) {
  const intent = object(store.provisioningIntent)
  if (
    intent.schemaVersion !== 1 ||
    intent.source !== 'watch-added' ||
    intent.hostUid !== request.hostUid ||
    isoTimestamp(intent.hostCreatedAt) !== isoTimestamp(host.metadata?.creationTimestamp)
  )
    deny()
  string(intent.observedResourceVersion)
  string(intent.watchResourceVersion)
  isoTimestamp(intent.recordedAt)
  const receipt = object(store.provisioning)
  if (
    receipt.hostUid !== request.hostUid ||
    receipt.pvcUid !== request.pvcUid ||
    isoTimestamp(receipt.createdAt) !== isoTimestamp(pvc.metadata?.creationTimestamp)
  )
    deny()
  // A retained receipt never authorizes recreation of an established catalog.
  const layout = store.layout === undefined ? undefined : object(store.layout)
  if (layout?.storeId !== undefined || store.compatibility !== undefined) deny()
  return {
    hostUid: request.hostUid,
    pvcUid: request.pvcUid,
    createdAt: isoTimestamp(receipt.createdAt),
  }
}
function assertSuccessfulJob(
  job: V1Job,
  name: string,
  uid: string,
  hostName: string,
  hostUid: string,
  namespace: string,
  requestId: string,
  requestHash: string,
  templateRevision: string,
  image: string,
  mount: ReturnType<typeof rootMount>
) {
  const meta = metadata(job, name, namespace)
  const owner = controllerOwner(job, 'Host', 'clerum.io/v1alpha1')
  const annotations = object(job.metadata?.annotations)
  const physical = rootMount(job.spec?.template.spec)
  if (
    meta.uid !== uid ||
    owner.name !== hostName ||
    owner.uid !== hostUid ||
    annotations['clerum.io/conversation-store-request-id'] !== requestId ||
    annotations['clerum.io/conversation-store-request-hash'] !== requestHash ||
    annotations['clerum.io/host-uid'] !== hostUid ||
    annotations['clerum.io/conversation-store-template-revision'] !== templateRevision ||
    physical.image !== image ||
    physical.claimName !== mount.claimName ||
    physical.mountPath !== mount.mountPath ||
    !job.status?.conditions?.some(
      condition => condition.type === 'Complete' && condition.status === 'True'
    ) ||
    typeof job.status.succeeded !== 'number' ||
    job.status.succeeded < 1 ||
    (job.status.active !== undefined && job.status.active !== 0) ||
    job.status.conditions.some(
      condition => condition.type === 'Failed' && condition.status === 'True'
    )
  )
    deny()
  return meta
}
class PendingOwnPodGrant extends Error {
  constructor(readonly authority: unknown) {
    super('pending-own-pod-read-grant')
  }
}

async function resolveOnce(
  input: CanonicalOperatorResolveInput,
  context: CanonicalOperatorContext,
  readers: CanonicalOperatorReaders
) {
  const [initialReview, initialHost] = await Promise.all([
    readers.selfSubjectReview(),
    readers.readHost(context.hostName, context.namespace),
  ])
  const actor = authenticatedPod(initialReview, context)
  const host = structuredClone(initialHost)
  const hostMeta = metadata(host, context.hostName, context.namespace)
  const store = object(host.status?.conversationStore)
  const request = validateRequest(store.request, input)
  if (request.hostUid !== hostMeta.uid || request.storageContract !== desiredStorageContract(host))
    deny()
  const requestHash = computeCanonicalOperatorRequestHash(request)
  const maintenance = object(store.maintenance)
  if (
    maintenance.hostUid !== request.hostUid ||
    maintenance.pvcUid !== request.pvcUid ||
    maintenance.maintenanceId !== request.maintenanceId
  )
    deny()
  const finalizing = input.action === 'verify-current' && input.operation !== 'release'
  const phases =
    input.action === 'verify-current'
      ? finalizing
        ? ['completing']
        : ['completed']
      : input.action === 'verify-preparation'
        ? ['quiescing', 'fenced', 'failed']
        : ['fenced', 'migrating', 'failed']
  if (!phases.includes(String(maintenance.phase))) deny()
  const result = object(store.requestResult)
  if (
    result.requestId !== request.requestId ||
    result.hostUid !== request.hostUid ||
    result.pvcUid !== request.pvcUid ||
    result.state !== 'accepted'
  )
    deny()
  const execution = object(store.execution)
  const phase =
    input.action === 'verify-preparation'
      ? 'preparation'
      : input.action === 'verify-current'
        ? 'current'
        : input.action
  if (
    execution.requestId !== request.requestId ||
    execution.operation !== input.operation ||
    execution.phase !== phase ||
    execution.hostUid !== request.hostUid ||
    execution.pvcUid !== request.pvcUid ||
    execution.maintenanceId !== request.maintenanceId ||
    execution.storageContract !== request.storageContract ||
    execution.requestHash !== requestHash
  )
    deny()
  const jobName = string(execution.jobName, DNS_NAME)
  const jobUid = string(execution.jobUid)
  const image = string(execution.image)
  const templateRevision = string(execution.templateRevision, SHA256)
  if (
    (request.targetImage !== undefined && request.targetImage !== image) ||
    (request.templateRevision !== undefined && request.templateRevision !== templateRevision)
  )
    deny()
  if (request.operation === 'adopt' && input.action === 'adopt') {
    if (request.storageContract === 'canonical') {
      const layout = store.layout === undefined ? undefined : object(store.layout)
      if (layout?.storeId !== undefined && request.expectedStoreId === undefined) deny()
      if (
        request.expectedStoreId !== undefined &&
        (layout?.hostUid !== request.hostUid ||
          layout?.pvcUid !== request.pvcUid ||
          layout?.storeId !== request.expectedStoreId)
      )
        deny()
    } else {
      const compatibility =
        store.compatibility === undefined ? undefined : object(store.compatibility)
      if (compatibility?.storageContract === 'legacy-floor') {
        const current = floorCurrentProof(compatibility, request)
        // This receipt's catalog hash describes establishment, before later accepted writes.
        // The fresh current pin stays in the immutable request/Job hash and is checked
        // against the physical full catalog under the fence by CLI/recovery before mutation.
        if (request.expectedMigrationId !== current.migrationId) deny()
      } else if (request.expectedMigrationId !== undefined) deny()
    }
  }
  if (input.operation === 'release') {
    if (request.storageContract === 'canonical') {
      const layout = object(store.layout)
      if (
        layout.hostUid !== request.hostUid ||
        layout.pvcUid !== request.pvcUid ||
        layout.storeId !== request.expectedStoreId ||
        layout.state !== 'ready'
      )
        deny()
    } else {
      const current = floorCurrentProof(store.compatibility, request)
      // Establishment hashes may predate accepted writes; release is only a verification
      // capability. CLI must match the immutable request's current hash under the fence.
      if (request.expectedMigrationId !== current.migrationId) deny()
    }
  }
  const authority = {
    request,
    execution: {
      requestId: execution.requestId,
      operation: execution.operation,
      phase: execution.phase,
      storageContract: request.storageContract,
      requestHash,
      jobName,
      jobUid,
      image,
      templateRevision,
    },
    maintenance: {
      hostUid: maintenance.hostUid,
      pvcUid: maintenance.pvcUid,
      maintenanceId: maintenance.maintenanceId,
      phase: maintenance.phase,
    },
  }
  const job = structuredClone(await readers.readJob(jobName, context.namespace))
  const jobMeta = metadata(job, jobName, context.namespace)
  const hostOwner = controllerOwner(job, 'Host', 'clerum.io/v1alpha1')
  if (
    jobMeta.uid !== jobUid ||
    hostOwner.uid !== hostMeta.uid ||
    hostOwner.name !== context.hostName
  )
    deny()
  const annotations = object(job.metadata?.annotations)
  if (
    annotations['clerum.io/conversation-store-request-id'] !== request.requestId ||
    annotations['clerum.io/conversation-store-request-hash'] !== requestHash ||
    annotations['clerum.io/host-uid'] !== request.hostUid ||
    annotations['clerum.io/conversation-store-template-revision'] !== templateRevision
  )
    deny()
  const jobMount = rootMount(job.spec?.template.spec)
  if (jobMount.image !== image || jobMount.serviceAccount !== actor.serviceAccount) deny()
  let pod: V1Pod
  try {
    pod = structuredClone(await readers.readPod(actor.podName, context.namespace))
  } catch (error) {
    // Kubernetes generates the Job Pod name after Job creation. HCC grants
    // get on that exact name once observed; this bounded wait never widens RBAC.
    if (error && typeof error === 'object' && (error as { code?: number }).code === 403)
      throw new PendingOwnPodGrant(authority)
    throw error
  }
  const podMeta = metadata(pod, actor.podName, context.namespace)
  const jobOwner = controllerOwner(pod, 'Job', 'batch/v1')
  const podMount = rootMount(pod.spec)
  if (
    podMeta.uid !== actor.podUid ||
    jobOwner.name !== jobName ||
    jobOwner.uid !== jobUid ||
    pod.status?.phase !== 'Running' ||
    !isDeepStrictEqual(jobMount, podMount)
  )
    deny()
  if (input.action === 'verify-preparation' ? !podMount.readOnly : podMount.readOnly) deny()
  const pvc = structuredClone(await readers.readPvc(podMount.claimName, context.namespace))
  const pvcMeta = metadata(pvc, podMount.claimName, context.namespace)
  if (pvcMeta.uid !== request.pvcUid || pvc.status?.phase !== 'Bound') deny()
  let provisioning: { hostUid: string; pvcUid: string; createdAt: string } | undefined
  if (request.operation === 'prepare' && request.sourceClass === 'new-host' && !finalizing)
    provisioning = assertProvisioning(store, request, pvc, host)
  const previousJobs: Array<{ name: string; uid: string; resourceVersion: string }> = []
  let verifiedManifestHash: string | undefined
  if (
    input.operation === 'prepare' &&
    (input.action === 'migrate' || input.action === 'layout-precheck')
  ) {
    const preparation = object(store.preparation)
    if (
      preparation.requestId !== request.requestId ||
      preparation.hostUid !== request.hostUid ||
      preparation.pvcUid !== request.pvcUid ||
      preparation.maintenanceId !== request.maintenanceId ||
      preparation.sourceClass !== request.sourceClass ||
      preparation.templateRevision !== templateRevision ||
      preparation.image !== image ||
      preparation.storageContract !== request.storageContract ||
      (request.manifestHash !== undefined && preparation.manifestHash !== request.manifestHash)
    )
      deny()
    verifiedManifestHash = string(preparation.manifestHash, SHA256)
    if (request.sourceClass === 'new-host' && preparation.provenance !== 'new') deny()
    const name = string(preparation.verificationJobName, DNS_NAME)
    const uid = string(preparation.verificationJobUid)
    const verification = structuredClone(await readers.readJob(name, context.namespace))
    const meta = assertSuccessfulJob(
      verification,
      name,
      uid,
      context.hostName,
      request.hostUid,
      context.namespace,
      request.requestId,
      requestHash,
      templateRevision,
      image,
      podMount
    )
    if (!rootMount(verification.spec?.template.spec).readOnly) deny()
    previousJobs.push({ name, ...meta })
  }
  let expectedStoreId: string | undefined
  let expectedMigrationId: string | undefined
  let expectedCurrentCatalogHash: string | undefined
  let mutatorJobUid: string | undefined
  if (finalizing) {
    const completed = object(store.operationOutcome)
    const reasons =
      request.storageContract === 'legacy-floor'
        ? [
            'Created',
            'NoCollision',
            'AlreadyLegacy',
            'SingleCandidate',
            'EquivalentCandidates',
            'EmptyCandidateRetired',
            'Adopted',
          ]
        : [
            'Created',
            'AlreadyCanonical',
            'SingleCandidate',
            'EquivalentCandidates',
            'EmptyCandidateRetired',
            'Adopted',
          ]
    if (
      completed.requestId !== request.requestId ||
      completed.operation !== input.operation ||
      completed.hostUid !== request.hostUid ||
      completed.pvcUid !== request.pvcUid ||
      completed.maintenanceId !== request.maintenanceId ||
      completed.storageContract !== request.storageContract ||
      !reasons.includes(String(completed.reason))
    )
      deny()
    if (request.storageContract === 'legacy-floor') {
      const current = floorCurrentProof(completed, request)
      expectedMigrationId = current.migrationId
      expectedCurrentCatalogHash = current.catalogHash
    } else {
      expectedStoreId = string(completed.storeId, UUID)
      expectedCurrentCatalogHash = string(completed.catalogHash, SHA256)
    }
    const name = string(completed.jobName, DNS_NAME)
    mutatorJobUid = string(completed.jobUid)
    const mutator = structuredClone(await readers.readJob(name, context.namespace))
    const meta = assertSuccessfulJob(
      mutator,
      name,
      mutatorJobUid,
      context.hostName,
      request.hostUid,
      context.namespace,
      request.requestId,
      requestHash,
      templateRevision,
      image,
      podMount
    )
    if (rootMount(mutator.spec?.template.spec).readOnly) deny()
    previousJobs.push({ name, ...meta })
  }
  const [finalReview, finalHost, finalPod, finalJob, finalPvc, finalPreviousJobs] =
    await Promise.all([
      readers.selfSubjectReview(),
      readers.readHost(context.hostName, context.namespace),
      readers.readPod(actor.podName, context.namespace),
      readers.readJob(jobName, context.namespace),
      readers.readPvc(podMount.claimName, context.namespace),
      Promise.all(previousJobs.map(previous => readers.readJob(previous.name, context.namespace))),
    ])
  // Reject every replacement or status update while resolving; no cache or
  // same-name resource can carry an old authorization into a new operation.
  if (
    !isDeepStrictEqual(authenticatedPod(finalReview, context), actor) ||
    !isDeepStrictEqual(metadata(finalHost, context.hostName, context.namespace), hostMeta) ||
    !isDeepStrictEqual(metadata(finalPod, actor.podName, context.namespace), podMeta) ||
    !isDeepStrictEqual(metadata(finalJob, jobName, context.namespace), jobMeta) ||
    !isDeepStrictEqual(metadata(finalPvc, podMount.claimName, context.namespace), pvcMeta)
  )
    deny()
  for (let index = 0; index < previousJobs.length; index++) {
    const previous = previousJobs[index]
    if (
      !isDeepStrictEqual(metadata(finalPreviousJobs[index], previous.name, context.namespace), {
        uid: previous.uid,
        resourceVersion: previous.resourceVersion,
      })
    )
      deny()
  }
  const finalStore = object(finalHost.status?.conversationStore)
  if (
    !isDeepStrictEqual(finalStore.request, store.request) ||
    !isDeepStrictEqual(finalStore.maintenance, store.maintenance) ||
    !isDeepStrictEqual(finalStore.execution, store.execution) ||
    !isDeepStrictEqual(finalStore.requestResult, store.requestResult) ||
    !isDeepStrictEqual(finalStore.provisioningIntent, store.provisioningIntent) ||
    !isDeepStrictEqual(finalStore.provisioning, store.provisioning) ||
    !isDeepStrictEqual(finalStore.preparation, store.preparation) ||
    !isDeepStrictEqual(finalStore.operationOutcome, store.operationOutcome) ||
    !isDeepStrictEqual(finalStore.layout, store.layout) ||
    !isDeepStrictEqual(finalStore.compatibility, store.compatibility) ||
    desiredStorageContract(finalHost) !== request.storageContract
  )
    deny()
  const proof: CanonicalOperatorProof = {
    hostUid: request.hostUid,
    pvcUid: request.pvcUid,
    requestId: request.requestId,
    requestHash,
    storageContract: request.storageContract,
    hostResourceVersion: hostMeta.resourceVersion,
    pvcName: podMount.claimName,
    pvcResourceVersion: pvcMeta.resourceVersion,
    podName: actor.podName,
    podUid: actor.podUid,
    podResourceVersion: podMeta.resourceVersion,
    jobName,
    jobUid,
    jobResourceVersion: jobMeta.resourceVersion,
    image,
    templateRevision,
    rootMountPath: podMount.mountPath,
    rootReadOnly: podMount.readOnly,
  }
  const base: ResolvedBase = {
    storageContract: request.storageContract,
    hostUid: request.hostUid,
    pvcUid: request.pvcUid,
    binding: { hostUid: request.hostUid, pvcUid: request.pvcUid },
    maintenanceId: request.maintenanceId,
    principal: request.principal.subject,
    proof,
  }
  const capability: CapabilityBinding = {
    ...base.binding,
    requestId: request.requestId,
    requestHash,
    storageContract: request.storageContract,
    maintenanceId: request.maintenanceId,
    principal: request.principal.subject,
    jobUid,
    podUid: actor.podUid,
    image,
    templateRevision,
  }
  let resolved: ResolvedCanonicalOperatorRequest
  if (finalizing) {
    if (request.operation === 'release' || !expectedCurrentCatalogHash || !mutatorJobUid) deny()
    if (request.storageContract === 'legacy-floor') {
      if (!expectedMigrationId) deny()
      resolved = {
        ...base,
        storageContract: 'legacy-floor',
        operation: request.operation,
        action: 'verify-current',
        request,
        expectedMigrationId,
        expectedCurrentCatalogHash,
        authorization: {
          ...capability,
          storageContract: 'legacy-floor',
          kind: 'legacy-floor-finalization-verification',
          operation: request.operation,
          action: 'verify-current',
          expectedMigrationId,
          expectedCurrentCatalogHash,
          mutatorJobUid,
        },
      }
    } else {
      if (!expectedStoreId) deny()
      resolved = {
        ...base,
        storageContract: 'canonical',
        operation: request.operation,
        action: 'verify-current',
        request,
        expectedStoreId,
        expectedCurrentCatalogHash,
        authorization: {
          ...capability,
          storageContract: 'canonical',
          kind: 'canonical-finalization-verification',
          operation: request.operation,
          action: 'verify-current',
          expectedStoreId,
          expectedCurrentCatalogHash,
          mutatorJobUid,
        },
      }
    }
  } else if (request.operation === 'adopt') {
    if (request.storageContract === 'legacy-floor') {
      resolved = {
        ...base,
        storageContract: 'legacy-floor',
        operation: 'adopt',
        action: 'adopt',
        request: legacyAdoptPins(request),
        operatorRequest: request,
        authorization: {
          ...capability,
          storageContract: 'legacy-floor',
          kind: 'legacy-floor-adoption',
          authorized: true,
        },
      }
    } else {
      resolved = {
        ...base,
        storageContract: 'canonical',
        operation: 'adopt',
        action: 'adopt',
        request: adoptPins(request),
        operatorRequest: request,
        authorization: {
          ...capability,
          storageContract: 'canonical',
          kind: 'canonical-adoption',
          authorized: true,
        },
      }
    }
  } else if (request.operation === 'release') {
    resolved =
      request.storageContract === 'legacy-floor'
        ? {
            ...base,
            storageContract: 'legacy-floor',
            operation: 'release',
            action: 'verify-current',
            request,
            authorization: {
              ...capability,
              storageContract: 'legacy-floor',
              kind: 'legacy-floor-verification',
              operation: 'release',
              action: 'verify-current',
            },
          }
        : {
            ...base,
            storageContract: 'canonical',
            operation: 'release',
            action: 'verify-current',
            request,
            authorization: {
              ...capability,
              storageContract: 'canonical',
              kind: 'canonical-verification',
              operation: 'release',
              action: 'verify-current',
            },
          }
  } else if (input.action === 'verify-preparation') {
    resolved =
      request.storageContract === 'legacy-floor'
        ? {
            ...base,
            storageContract: 'legacy-floor',
            operation: 'prepare',
            action: 'verify-preparation',
            request,
            authorization: {
              ...capability,
              storageContract: 'legacy-floor',
              kind: 'legacy-floor-preparation-verification',
              operation: 'prepare',
              action: 'verify-preparation',
            },
          }
        : {
            ...base,
            storageContract: 'canonical',
            operation: 'prepare',
            action: 'verify-preparation',
            request,
            authorization: {
              ...capability,
              storageContract: 'canonical',
              kind: 'canonical-preparation-verification',
              operation: 'prepare',
              action: 'verify-preparation',
            },
          }
  } else if (request.sourceClass === 'new-host') {
    if (!provisioning || !verifiedManifestHash) deny()
    resolved =
      request.storageContract === 'legacy-floor'
        ? {
            ...base,
            storageContract: 'legacy-floor',
            operation: 'prepare',
            action: 'layout-precheck',
            request,
            authorization: {
              ...capability,
              storageContract: 'legacy-floor',
              kind: 'legacy-floor-new-host-initialization',
              verifiedManifestHash,
              operation: 'prepare',
              action: 'layout-precheck',
              provisioning,
            },
          }
        : {
            ...base,
            storageContract: 'canonical',
            operation: 'prepare',
            action: 'migrate',
            request,
            authorization: {
              ...capability,
              storageContract: 'canonical',
              kind: 'canonical-new-host-initialization',
              verifiedManifestHash,
              operation: 'prepare',
              action: 'migrate',
              provisioning,
            },
          }
  } else {
    if (!verifiedManifestHash) deny()
    resolved =
      request.storageContract === 'legacy-floor'
        ? {
            ...base,
            storageContract: 'legacy-floor',
            operation: 'prepare',
            action: 'layout-precheck',
            request,
            authorization: {
              ...capability,
              storageContract: 'legacy-floor',
              kind: 'legacy-floor-migration',
              verifiedManifestHash,
              operation: 'prepare',
              action: 'layout-precheck',
            },
          }
        : {
            ...base,
            storageContract: 'canonical',
            operation: 'prepare',
            action: 'migrate',
            request,
            authorization: {
              ...capability,
              storageContract: 'canonical',
              kind: 'canonical-migration',
              verifiedManifestHash,
              operation: 'prepare',
              action: 'migrate',
            },
          }
  }
  return { resolved, authority }
}

async function resolveWithReaders(
  input: CanonicalOperatorResolveInput,
  boundary: CanonicalOperatorTestBoundary
): Promise<ResolvedCanonicalOperatorRequest> {
  assertContext(boundary.context)
  string(input.requestId, UUID)
  if (
    !(
      (input.operation === 'adopt' &&
        (input.action === 'adopt' || input.action === 'verify-current')) ||
      (input.operation === 'prepare' &&
        (input.action === 'migrate' ||
          input.action === 'layout-precheck' ||
          input.action === 'verify-preparation' ||
          input.action === 'verify-current')) ||
      (input.operation === 'release' && input.action === 'verify-current')
    )
  )
    deny()
  const deadline = Date.now() + (boundary.bootstrapWaitMs ?? 0)
  let pendingAuthority: unknown
  for (;;) {
    try {
      const result = await resolveOnce(input, boundary.context, boundary.readers)
      if (pendingAuthority !== undefined && !isDeepStrictEqual(pendingAuthority, result.authority))
        deny()
      return result.resolved
    } catch (error) {
      if (error instanceof PendingOwnPodGrant && Date.now() < deadline) {
        if (pendingAuthority !== undefined && !isDeepStrictEqual(pendingAuthority, error.authority))
          deny()
        pendingAuthority = error.authority
        await delay(Math.min(250, deadline - Date.now()))
        continue
      }
      if (error instanceof CanonicalStoreError) throw error
      // SDK errors can contain request headers or private endpoints. Never
      // include them in a CLI error, journal, diagnostic or authorization.
      deny()
    }
  }
}

async function inClusterReaders(): Promise<CanonicalOperatorReaders> {
  const k8s = await import('@kubernetes/client-node')
  const configuration = new k8s.KubeConfig()
  configuration.loadFromCluster()
  const objects = configuration.makeApiClient(k8s.CustomObjectsApi)
  const core = configuration.makeApiClient(k8s.CoreV1Api)
  const batch = configuration.makeApiClient(k8s.BatchV1Api)
  const authentication = configuration.makeApiClient(k8s.AuthenticationV1Api)
  const overallDeadline = AbortSignal.timeout(RESOLUTION_TIMEOUT_MS)
  const timeoutMiddleware = k8s.createConfiguration({
    promiseMiddleware: [
      {
        pre: async context => {
          context.setSignal(AbortSignal.any([overallDeadline, AbortSignal.timeout(API_TIMEOUT_MS)]))
          return context
        },
        post: async context => context,
      },
    ],
  }).middleware
  const options: NonNullable<Parameters<typeof objects.getNamespacedCustomObject>[1]> = {
    middleware: timeoutMiddleware,
    middlewareMergeStrategy: 'append',
  }
  return {
    selfSubjectReview: () =>
      authentication.createSelfSubjectReview(
        { body: { apiVersion: 'authentication.k8s.io/v1', kind: 'SelfSubjectReview' } },
        options
      ),
    readHost: async (name, namespace) =>
      (await objects.getNamespacedCustomObject(
        { group: 'clerum.io', version: 'v1alpha1', plural: 'hosts', name, namespace },
        options
      )) as CanonicalOperatorHost,
    readPod: (name, namespace) => core.readNamespacedPod({ name, namespace }, options),
    readJob: (name, namespace) => batch.readNamespacedJob({ name, namespace }, options),
    readPvc: (name, namespace) =>
      core.readNamespacedPersistentVolumeClaim({ name, namespace }, options),
  }
}

/** Real default: only a projected in-cluster identity may resolve a capability. */
export async function resolveCanonicalOperatorRequest(
  input: CanonicalOperatorResolveInput
): Promise<ResolvedCanonicalOperatorRequest> {
  try {
    const context = {
      hostName: string(process.env.CLERUM_HOST_NAME),
      namespace: string(process.env.CLERUM_HOST_NAMESPACE),
      podUid: string(process.env.CLERUM_CANONICAL_POD_UID),
    }
    assertContext(context)
    return await resolveWithReaders(input, {
      context,
      readers: await inClusterReaders(),
      bootstrapWaitMs: BOOTSTRAP_WAIT_MS,
    })
  } catch (error) {
    if (error instanceof CanonicalStoreError) throw error
    deny()
  }
}

/** Explicit test seam; CLI flags and environment variables cannot inject readers. */
export function resolveCanonicalOperatorRequestForTesting(
  input: CanonicalOperatorResolveInput,
  boundary: CanonicalOperatorTestBoundary
): Promise<ResolvedCanonicalOperatorRequest> {
  return resolveWithReaders(input, boundary)
}

export async function authorizeCanonicalOperator(input: {
  binding: Binding
  request: AdoptionRequest | RecoveryRequest
  maintenanceId: string
  principal: string
  operation: 'adopt'
}): Promise<OperatorAuthorization> {
  if (input.operation !== 'adopt') deny()
  const resolved = await resolveCanonicalOperatorRequest({
    requestId: input.request.requestId,
    operation: 'adopt',
    action: 'adopt',
  })
  if (
    resolved.storageContract !== 'canonical' ||
    resolved.operation !== 'adopt' ||
    resolved.action !== 'adopt' ||
    !isDeepStrictEqual(resolved.request, input.request) ||
    !isDeepStrictEqual(resolved.binding, input.binding) ||
    resolved.maintenanceId !== input.maintenanceId ||
    resolved.principal !== input.principal
  )
    deny()
  return resolved.authorization
}
