import { isDeepStrictEqual } from 'node:util'

export type ConversationStoreStorageContract = 'legacy-floor' | 'canonical'
export type ConversationStoreOperation = 'maintenance' | 'prepare' | 'adopt' | 'release'
export type ConversationStoreSourceClass =
  | 'sqlite-pvc'
  | 'sqlite-external-exported'
  | 'new-host'
  | 'memory'
  | 'unknown'

export interface ConversationStoreRequest {
  schemaVersion: 1
  requestId: string
  operation: ConversationStoreOperation
  storageContract: ConversationStoreStorageContract
  hostUid: string
  pvcUid: string
  maintenanceId: string
  principal: { kind: 'control-admin'; subject: string }
  targetImage?: string
  templateRevision?: string
  sourceClass?: ConversationStoreSourceClass
  manifestHash?: string
  exportId?: string
  migrationId?: string
  candidateHash?: string
  expectedStoreId?: string
  expectedMigrationId?: string
  expectedCurrentCatalogHash?: string
}

export interface ConversationStoreHostSnapshot {
  metadata?: { uid?: string; resourceVersion?: string; annotations?: Record<string, string> }
  status?: Record<string, unknown>
}

export interface ConversationStoreJsonPatchOperation {
  op: 'test' | 'add'
  path: string
  value: unknown
}

export class ConversationStoreRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string
  ) {
    super(code)
    this.name = 'ConversationStoreRequestError'
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const SHA256 = /^[0-9a-f]{64}$/
const IDENTITY = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/
const SOURCES: ReadonlySet<string> = new Set([
  'sqlite-pvc',
  'sqlite-external-exported',
  'new-host',
  'memory',
  'unknown',
])
const FIELDS: ReadonlySet<string> = new Set([
  'schemaVersion',
  'requestId',
  'hostUid',
  'pvcUid',
  'maintenanceId',
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

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function requiredString(body: Record<string, unknown>, key: string, pattern: RegExp): string {
  const value = body[key]
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new ConversationStoreRequestError(400, `invalid_${key}`)
  }
  return value
}

/** Layout commitment is monotonic; request hints cannot change the desired contract. */
export function deriveConversationStoreContract(
  host: ConversationStoreHostSnapshot
): ConversationStoreStorageContract {
  if (!host.metadata?.uid || !host.metadata.resourceVersion) {
    throw new ConversationStoreRequestError(503, 'host_identity_unavailable')
  }
  const store = conversationStoreStatus(host)
  const layout = record(store.layout)
  const outcome = record(store.operationOutcome)
  const committed =
    layout?.version === 1 ||
    typeof layout?.storeId === 'string' ||
    (outcome?.storageContract === 'canonical' && typeof outcome.storeId === 'string')
  return committed || host.metadata.annotations?.['clerum.io/canonical-store'] === 'enabled'
    ? 'canonical'
    : 'legacy-floor'
}

/** The authenticated middleware supplies principal; the fresh Host supplies the contract. */
export function parseConversationStoreRequest(
  raw: unknown,
  operation: ConversationStoreOperation,
  subject: string,
  host: ConversationStoreHostSnapshot
): ConversationStoreRequest {
  const body = record(raw)
  if (!body || Object.keys(body).some(key => !FIELDS.has(key))) {
    throw new ConversationStoreRequestError(400, 'invalid_request_fields')
  }
  if (body.schemaVersion !== 1) {
    throw new ConversationStoreRequestError(400, 'invalid_schemaVersion')
  }
  const storageContract = deriveConversationStoreContract(host)
  if (Object.hasOwn(body, 'storageContract')) {
    if (body.storageContract !== 'legacy-floor' && body.storageContract !== 'canonical') {
      throw new ConversationStoreRequestError(400, 'invalid_storageContract')
    }
    if (body.storageContract !== storageContract) {
      throw new ConversationStoreRequestError(409, 'storage_contract_mismatch')
    }
  }
  const request: ConversationStoreRequest = {
    schemaVersion: 1,
    requestId: requiredString(body, 'requestId', UUID),
    operation,
    storageContract,
    hostUid: requiredString(body, 'hostUid', IDENTITY),
    pvcUid: requiredString(body, 'pvcUid', IDENTITY),
    maintenanceId: requiredString(body, 'maintenanceId', UUID),
    principal: { kind: 'control-admin', subject },
  }
  for (const key of [
    'manifestHash',
    'templateRevision',
    'candidateHash',
    'expectedCurrentCatalogHash',
  ] as const) {
    if (Object.hasOwn(body, key)) request[key] = requiredString(body, key, SHA256)
  }
  for (const key of [
    'exportId',
    'migrationId',
    'expectedStoreId',
    'expectedMigrationId',
  ] as const) {
    if (Object.hasOwn(body, key)) request[key] = requiredString(body, key, UUID)
  }
  if (Object.hasOwn(body, 'targetImage')) {
    const value = body.targetImage
    if (
      typeof value !== 'string' ||
      value.length > 2048 ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._:/@-]*$/.test(value)
    ) {
      throw new ConversationStoreRequestError(400, 'invalid_targetImage')
    }
    request.targetImage = value
  }
  if (Object.hasOwn(body, 'sourceClass')) {
    if (typeof body.sourceClass !== 'string' || !SOURCES.has(body.sourceClass)) {
      throw new ConversationStoreRequestError(400, 'invalid_sourceClass')
    }
    request.sourceClass = body.sourceClass as ConversationStoreSourceClass
  }
  const currentIdentity =
    storageContract === 'canonical' ? request.expectedStoreId : request.expectedMigrationId
  if (
    (storageContract === 'canonical' && request.expectedMigrationId !== undefined) ||
    (storageContract === 'legacy-floor' && request.expectedStoreId !== undefined)
  ) {
    throw new ConversationStoreRequestError(400, 'wrong_current_store_contract')
  }
  if ((currentIdentity === undefined) !== (request.expectedCurrentCatalogHash === undefined)) {
    throw new ConversationStoreRequestError(400, 'incomplete_current_store_binding')
  }
  if (operation === 'prepare') {
    if (!request.targetImage || !request.templateRevision || !request.sourceClass) {
      throw new ConversationStoreRequestError(400, 'incomplete_preparation_binding')
    }
    if (
      (request.sourceClass === 'sqlite-pvc' ||
        request.sourceClass === 'sqlite-external-exported') &&
      !request.manifestHash
    ) {
      throw new ConversationStoreRequestError(400, 'missing_manifestHash')
    }
    if (request.sourceClass === 'sqlite-external-exported' && !request.exportId) {
      throw new ConversationStoreRequestError(400, 'missing_exportId')
    }
  }
  if (
    operation === 'adopt' &&
    (!request.migrationId || !request.manifestHash || !request.candidateHash)
  ) {
    throw new ConversationStoreRequestError(400, 'incomplete_adoption_binding')
  }
  if (operation === 'release' && (!currentIdentity || !request.expectedCurrentCatalogHash)) {
    throw new ConversationStoreRequestError(400, 'incomplete_release_binding')
  }
  return request
}

export function conversationStoreStatus(
  host: ConversationStoreHostSnapshot
): Record<string, unknown> {
  // Legacy Hosts have no conversation-store status until the first operator request.
  return record(host.status?.conversationStore) ?? {}
}

/** Fresh identity and controller acknowledgement prevent replacing an in-flight request. */
export function validateConversationStoreRequest(
  host: ConversationStoreHostSnapshot,
  request: ConversationStoreRequest
): 'new' | 'repeated' {
  if (!host.metadata?.uid || !host.metadata.resourceVersion) {
    throw new ConversationStoreRequestError(503, 'host_identity_unavailable')
  }
  if (host.metadata.uid !== request.hostUid) {
    throw new ConversationStoreRequestError(409, 'host_binding_mismatch')
  }
  if (deriveConversationStoreContract(host) !== request.storageContract) {
    throw new ConversationStoreRequestError(409, 'storage_contract_mismatch')
  }
  const store = conversationStoreStatus(host)
  const previous = record(store.request)
  if (previous?.requestId === request.requestId) {
    if (!isDeepStrictEqual(previous, request)) {
      throw new ConversationStoreRequestError(409, 'request_replay')
    }
    return 'repeated'
  }
  if (previous) {
    const result = record(store.requestResult)
    const settled = result?.state === 'completed' || result?.state === 'rejected'
    if (
      !result ||
      result.requestId !== previous.requestId ||
      previous.hostUid !== request.hostUid ||
      previous.pvcUid !== request.pvcUid ||
      result.hostUid !== previous.hostUid ||
      result.pvcUid !== previous.pvcUid ||
      !settled
    ) {
      throw new ConversationStoreRequestError(409, 'operator_request_pending')
    }
  }
  const maintenance = record(store.maintenance)
  if (request.operation !== 'maintenance') {
    if (
      !maintenance ||
      maintenance.maintenanceId !== request.maintenanceId ||
      maintenance.hostUid !== request.hostUid ||
      maintenance.pvcUid !== request.pvcUid
    ) {
      throw new ConversationStoreRequestError(409, 'maintenance_binding_mismatch')
    }
    // A verified operator preparation attestation is the supported next
    // transition from quiescing. It submits intent; only HCC may establish
    // fenced state and a preparation receipt after checking the actual source.
    const allowedPhases =
      request.operation === 'release'
        ? ['completed']
        : request.operation === 'prepare'
          ? ['quiescing', 'fenced', 'failed']
          : ['fenced', 'migrating', 'failed']
    if (!allowedPhases.includes(String(maintenance.phase))) {
      throw new ConversationStoreRequestError(409, 'maintenance_not_ready')
    }
  } else if (
    maintenance &&
    !['released', 'completed'].includes(String(maintenance.phase)) &&
    (maintenance.maintenanceId !== request.maintenanceId ||
      maintenance.hostUid !== request.hostUid ||
      maintenance.pvcUid !== request.pvcUid)
  ) {
    throw new ConversationStoreRequestError(409, 'maintenance_already_active')
  }
  const layout = record(store.layout)
  if (
    request.operation === 'adopt' &&
    layout?.storeId &&
    (!request.expectedStoreId || !request.expectedCurrentCatalogHash)
  ) {
    throw new ConversationStoreRequestError(400, 'incomplete_current_store_binding')
  }
  if (request.expectedStoreId && layout?.storeId && request.expectedStoreId !== layout.storeId) {
    throw new ConversationStoreRequestError(409, 'store_binding_mismatch')
  }
  const floor = record(store.compatibility)
  const completedFloor =
    floor?.storageContract === 'legacy-floor' && typeof floor.migrationId === 'string'
  if (
    request.storageContract === 'legacy-floor' &&
    request.operation === 'adopt' &&
    completedFloor &&
    (!request.expectedMigrationId || !request.expectedCurrentCatalogHash)
  ) {
    throw new ConversationStoreRequestError(400, 'incomplete_current_store_binding')
  }
  if (
    request.expectedMigrationId &&
    completedFloor &&
    request.expectedMigrationId !== floor.migrationId
  ) {
    throw new ConversationStoreRequestError(409, 'store_binding_mismatch')
  }
  return 'new'
}

/** RFC 6902 tests bind the narrow status mutation to the exact fresh Host read. */
export function buildConversationStoreRequestPatch(
  host: ConversationStoreHostSnapshot,
  request: ConversationStoreRequest
): ConversationStoreJsonPatchOperation[] {
  if (
    !host.metadata?.uid ||
    !host.metadata.resourceVersion ||
    host.metadata.uid !== request.hostUid
  ) {
    throw new ConversationStoreRequestError(409, 'host_binding_mismatch')
  }
  if (deriveConversationStoreContract(host) !== request.storageContract) {
    throw new ConversationStoreRequestError(409, 'storage_contract_mismatch')
  }
  const patch: ConversationStoreJsonPatchOperation[] = [
    { op: 'test', path: '/metadata/uid', value: host.metadata.uid },
    { op: 'test', path: '/metadata/resourceVersion', value: host.metadata.resourceVersion },
  ]
  if (!host.status) {
    patch.push({ op: 'add', path: '/status', value: { conversationStore: { request } } })
  } else if (!record(host.status.conversationStore)) {
    patch.push({ op: 'add', path: '/status/conversationStore', value: { request } })
  } else {
    patch.push({ op: 'add', path: '/status/conversationStore/request', value: request })
  }
  return patch
}
