/**
 * Bounded per-operation Host execution job factory (PR #932 / issue #986).
 *
 * Pure encoder for one `batch/v1` Job in the Host's own namespace: no I/O, no
 * environment reads, no image resolution and no activation. Admission, gateway
 * authorization and the attach transport stay with the caller, and unit
 * coverage is not a physical isolation verdict.
 */
import type * as k8s from '@kubernetes/client-node'
import { createHash } from 'node:crypto'
import { MANAGED_BY_LABEL, MANAGED_BY_VALUE } from '../constants'

/** Hard input bound, mirrored from the receiver's `EXECUTION_INPUT_MAX_BYTES`. */
export const EXECUTION_INPUT_MAX_BYTES = 11_534_336
export const EXECUTION_TIMEOUT_MIN_MS = 1_000
/** Mirrors the receiver's own stream-deadline ceiling so it passes through. */
export const EXECUTION_TIMEOUT_MAX_MS = 1_500_000
export const EXECUTION_SCRATCH_MIN_BYTES = 1_048_576
/** Aggregate bound of the single memory-backed scratch volume. */
export const EXECUTION_SCRATCH_MAX_BYTES = 268_435_456
/** Aggregate UTF-8 bound of the approved argument vector. */
export const EXECUTION_ARGV_MAX_BYTES = 65_536

/** Only served Host version; a collected ownerReference must name it exactly. */
export const HOST_OWNER_API_VERSION = 'clerum.io/v1alpha1'

export const EXECUTION_EXECUTOR_CONTAINER_NAME = 'executor'
export const EXECUTION_INPUT_RECEIVER_CONTAINER_NAME = 'input-receiver'
/** Fixed receiver entrypoint inside the server-resolved Host image. */
export const EXECUTION_RECEIVE_INPUT_ENTRYPOINT =
  '/app/mcp-host/dist/core/execution/receiveSession.js'
export const EXECUTION_INPUT_PORT = 9301
/** PID 1 retains captured results privately and serves only the scoped portal. */
export const EXECUTION_RUN_ENTRYPOINT = '/app/mcp-host/dist/core/execution/runSession.js'
export const EXECUTION_RESULT_PORT = 9300
export const EXECUTION_POD_UID_ENV = 'EXECUTION_POD_UID'
export const EXECUTION_WORKSPACE_MOUNT_PATH = '/workspace'
export const EXECUTION_SCRATCH_MOUNT_PATH = '/scratch'
export const EXECUTION_TMP_MOUNT_PATH = '/tmp'
/** The receiver hardcodes this directory; the executor reads `source` under it. */
export const EXECUTION_INPUT_MOUNT_PATH = '/input'

/** Labels on the Job and on the Pod template, for cancellation and policy. */
export const EXECUTION_OPERATION_LABEL = 'clerum.io/operation'
export const EXECUTION_HOST_UID_LABEL = 'clerum.io/host-uid'
export const EXECUTION_ROLE_LABEL = 'clerum.io/role'
export const EXECUTION_ROLE_VALUE = 'host-execution'

/**
 * Server-owned annotations on the Job and the Pod template. Labels only select
 * records; this pair is what proves which Host generation and which full
 * execution contract the record was emitted for.
 */
export const EXECUTION_HOST_GENERATION_ANNOTATION = 'clerum.io/host-generation'
export const EXECUTION_CONTRACT_FINGERPRINT_ANNOTATION = 'clerum.io/execution-fingerprint'

const WORKSPACE_VOLUME_NAME = 'workspace'
const INPUT_VOLUME_NAME = 'input'
const SCRATCH_VOLUME_NAME = 'scratch'
const RUN_AS_UID = 1001
const RUN_AS_GID = 1001
const MEBIBYTE = 1024 * 1024
/** Node working set the memory limit adds above the scratch volume and input. */
const EXECUTOR_MEMORY_BASE_BYTES = 256 * MEBIBYTE

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const SHA256_PATTERN = /^[0-9a-f]{64}$/
const DNS1123_LABEL_PATTERN = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/
const DNS1123_SUBDOMAIN_PATTERN = /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/
/** Lowercase image reference shape; the registry resolves the real authority. */
const IMAGE_REFERENCE_PATTERN = /^[a-z0-9][A-Za-z0-9._\-/:@]*$/

const REQUEST_KEYS = new Set(['kind', 'argv', 'timeoutMs', 'scratchBytes', 'input'])
const INPUT_KEYS = new Set(['byteLength', 'sha256'])

/**
 * Server-resolved identity of the Host and of the single operation; only these
 * resolved values reach the emitted Job.
 */
export interface TrustedHostExecutionIdentity {
  hostName: string
  hostUid: string
  namespace: string
  operationId: string
  hostGeneration: number
  image: string
  workspacePvcName: string
  userKey: string
  /** `workspace/` for the dual-subPath layout, `''` for the legacy PVC root. */
  workspaceLayoutPrefix: 'workspace/' | ''
}

export interface ApprovedExecutionInput {
  byteLength: number
  sha256: string
}

/**
 * Bounded request that an admission path already approved. The vector is
 * executed as-is: no wrapper shell is added.
 */
export interface ApprovedExecutionRequest {
  kind: 'workspace' | 'attachment'
  argv: string[]
  timeoutMs: number
  scratchBytes: number
  input?: ApprovedExecutionInput
}

export class HostExecutionJobError extends Error {
  constructor(
    readonly field: string,
    detail: string
  ) {
    super(`${field} ${detail}`)
    this.name = 'HostExecutionJobError'
  }
}

function fail(field: string, detail: string): never {
  throw new HostExecutionJobError(field, detail)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireName(value: unknown, field: string, maxLength: number, pattern: RegExp): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maxLength ||
    !pattern.test(value)
  ) {
    fail(field, `must be a 1..${maxLength} character DNS-1123 name`)
  }
  return value
}

function requireUuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    fail(field, 'must be a lowercase UUID')
  }
  return value
}

function requireBoundedInteger(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    fail(field, 'must be a safe integer')
  }
  if (value < min || value > max) {
    fail(field, `must be between ${min} and ${max}`)
  }
  return value
}

/**
 * The executable must be non-empty; later entries may be legitimately empty
 * arguments. NUL bytes are rejected and the aggregate UTF-8 size is bounded.
 */
function requireArgv(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    fail('request.argv', 'must be a non-empty argument vector')
  }
  let bytes = 0
  const argv = value.map((entry, index) => {
    if (typeof entry !== 'string') {
      fail(`request.argv[${index}]`, 'must be a string')
    }
    if (index === 0 && entry.length === 0) {
      fail('request.argv[0]', 'must be a non-empty executable')
    }
    if (entry.includes('\0')) {
      fail(`request.argv[${index}]`, 'must not contain a NUL byte')
    }
    bytes += Buffer.byteLength(entry, 'utf8')
    return entry
  })
  if (bytes > EXECUTION_ARGV_MAX_BYTES) {
    fail('request.argv', `must total at most ${EXECUTION_ARGV_MAX_BYTES} UTF-8 bytes`)
  }
  return argv
}

function requireInput(value: unknown): ApprovedExecutionInput {
  if (!isRecord(value)) {
    fail('request.input', 'must be an object')
  }
  for (const key of Object.keys(value)) {
    if (!INPUT_KEYS.has(key)) {
      fail(`request.input.${key}`, 'is not part of the approved input contract')
    }
  }
  const byteLength = requireBoundedInteger(
    value.byteLength,
    'request.input.byteLength',
    0,
    EXECUTION_INPUT_MAX_BYTES
  )
  if (typeof value.sha256 !== 'string' || !SHA256_PATTERN.test(value.sha256)) {
    fail('request.input.sha256', 'must be a lowercase SHA-256 hex digest')
  }
  return { byteLength, sha256: value.sha256 }
}

function resolveIdentity(value: TrustedHostExecutionIdentity): TrustedHostExecutionIdentity {
  if (!isRecord(value)) {
    fail('identity', 'must be an object')
  }
  const {
    hostName,
    hostUid,
    namespace,
    operationId,
    hostGeneration,
    image,
    workspacePvcName,
    userKey,
    workspaceLayoutPrefix,
  } = value
  requireName(hostName, 'identity.hostName', 253, DNS1123_SUBDOMAIN_PATTERN)
  requireUuid(hostUid, 'identity.hostUid')
  requireName(namespace, 'identity.namespace', 63, DNS1123_LABEL_PATTERN)
  requireUuid(operationId, 'identity.operationId')
  requireBoundedInteger(hostGeneration, 'identity.hostGeneration', 1, Number.MAX_SAFE_INTEGER)
  if (
    typeof image !== 'string' ||
    image.length === 0 ||
    image.length > 512 ||
    !IMAGE_REFERENCE_PATTERN.test(image)
  ) {
    fail('identity.image', 'must be a 1..512 character lowercase container image reference')
  }
  requireName(workspacePvcName, 'identity.workspacePvcName', 253, DNS1123_SUBDOMAIN_PATTERN)
  if (typeof userKey !== 'string' || (userKey !== '_system' && !/^[0-9a-f]{16}$/.test(userKey))) {
    fail('identity.userKey', "must be 16 lowercase hex characters or '_system'")
  }
  if (workspaceLayoutPrefix !== 'workspace/' && workspaceLayoutPrefix !== '') {
    fail('identity.workspaceLayoutPrefix', "must be 'workspace/' or ''")
  }
  return {
    hostName,
    hostUid,
    namespace,
    operationId,
    hostGeneration,
    image,
    workspacePvcName,
    userKey,
    workspaceLayoutPrefix,
  }
}

type ResolvedExecutionRequest =
  | { kind: 'workspace'; argv: string[]; timeoutMs: number; scratchBytes: number }
  | {
      kind: 'attachment'
      argv: string[]
      timeoutMs: number
      scratchBytes: number
      input: ApprovedExecutionInput
    }

/** The strict key check is what keeps a PVC or image override out of the spec. */
function resolveRequest(value: ApprovedExecutionRequest): ResolvedExecutionRequest {
  if (!isRecord(value)) {
    fail('request', 'must be an object')
  }
  for (const key of Object.keys(value)) {
    if (!REQUEST_KEYS.has(key)) {
      fail(`request.${key}`, 'is not part of the approved execution request')
    }
  }
  const kind = value.kind
  if (kind !== 'workspace' && kind !== 'attachment') {
    fail('request.kind', "must be 'workspace' or 'attachment'")
  }
  const argv = requireArgv(value.argv)
  const timeoutMs = requireBoundedInteger(
    value.timeoutMs,
    'request.timeoutMs',
    EXECUTION_TIMEOUT_MIN_MS,
    EXECUTION_TIMEOUT_MAX_MS
  )
  const scratchBytes = requireBoundedInteger(
    value.scratchBytes,
    'request.scratchBytes',
    EXECUTION_SCRATCH_MIN_BYTES,
    EXECUTION_SCRATCH_MAX_BYTES
  )
  if (kind === 'workspace') {
    if (value.input !== undefined) {
      fail('request.input', 'is only valid for an attachment operation')
    }
    return { kind, argv, timeoutMs, scratchBytes }
  }
  if (value.input === undefined) {
    fail('request.input', 'is required for an attachment operation')
  }
  return { kind, argv, timeoutMs, scratchBytes, input: requireInput(value.input) }
}

function containerSecurityContext(): k8s.V1SecurityContext {
  return {
    allowPrivilegeEscalation: false,
    privileged: false,
    readOnlyRootFilesystem: true,
    runAsNonRoot: true,
    runAsUser: RUN_AS_UID,
    runAsGroup: RUN_AS_GID,
    capabilities: { drop: ['ALL'] },
    seccompProfile: { type: 'RuntimeDefault' },
  }
}

/** Deterministic Job name; the operation UUID is the only variable part. */
export function hostExecutionJobName(operationId: string): string {
  return `host-exec-${operationId}`
}

/** The effective request parameters, in one fixed order. */
function requestParts(request: ResolvedExecutionRequest): unknown[] {
  return [
    request.kind,
    request.argv,
    request.timeoutMs,
    request.scratchBytes,
    request.kind === 'attachment' ? [request.input.byteLength, request.input.sha256] : null,
  ]
}

/** The server-resolved identity fields the emitted Job depends on. */
function identityParts(identity: TrustedHostExecutionIdentity): unknown[] {
  return [
    identity.hostName,
    identity.hostUid,
    identity.namespace,
    identity.hostGeneration,
    identity.operationId,
    identity.image,
    identity.workspacePvcName,
    identity.userKey,
    identity.workspaceLayoutPrefix,
  ]
}

function fingerprintOf(parts: unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex')
}

/** SHA-256 over one approved request, independent of any Host identity. */
export function hostExecutionRequestFingerprint(request: ApprovedExecutionRequest): string {
  return fingerprintOf(requestParts(resolveRequest(request)))
}

/**
 * SHA-256 over the server-resolved identity plus the normalized request the Job
 * actually emits. A re-read proves the record was emitted for exactly this
 * contract: Host object and generation, operation, image, workspace PVC, layout
 * and user, and the approved arguments. It is not isolation proof.
 */
export function hostExecutionContractFingerprint(
  identity: TrustedHostExecutionIdentity,
  request: ApprovedExecutionRequest
): string {
  return fingerprintOf([
    identityParts(resolveIdentity(identity)),
    requestParts(resolveRequest(request)),
  ])
}

/**
 * Builds the Job for one approved operation; any unknown request field, invalid
 * name or out-of-bound integer rejects the request before a Job exists.
 */
export function buildHostExecutionJob(
  identity: TrustedHostExecutionIdentity,
  request: ApprovedExecutionRequest
): k8s.V1Job {
  const resolved = resolveIdentity(identity)
  const approved = resolveRequest(request)

  const labels: Record<string, string> = {
    [MANAGED_BY_LABEL]: MANAGED_BY_VALUE,
    [EXECUTION_OPERATION_LABEL]: resolved.operationId,
    [EXECUTION_HOST_UID_LABEL]: resolved.hostUid,
    [EXECUTION_ROLE_LABEL]: EXECUTION_ROLE_VALUE,
  }
  const annotations: Record<string, string> = {
    [EXECUTION_HOST_GENERATION_ANNOTATION]: String(resolved.hostGeneration),
    [EXECUTION_CONTRACT_FINGERPRINT_ANNOTATION]: fingerprintOf([
      identityParts(resolved),
      requestParts(approved),
    ]),
  }
  // /scratch and /tmp are the same volume, so scratchBytes is the aggregate
  // hard bound for both paths.
  const scratchVolume: k8s.V1Volume = {
    name: SCRATCH_VOLUME_NAME,
    emptyDir: { medium: 'Memory', sizeLimit: String(approved.scratchBytes) },
  }
  const scratchMounts: k8s.V1VolumeMount[] = [
    { name: SCRATCH_VOLUME_NAME, mountPath: EXECUTION_SCRATCH_MOUNT_PATH, readOnly: false },
    { name: SCRATCH_VOLUME_NAME, mountPath: EXECUTION_TMP_MOUNT_PATH, readOnly: false },
  ]

  const workingDir =
    approved.kind === 'workspace' ? EXECUTION_WORKSPACE_MOUNT_PATH : EXECUTION_SCRATCH_MOUNT_PATH
  const executorMounts: k8s.V1VolumeMount[] =
    approved.kind === 'workspace'
      ? [
          {
            name: WORKSPACE_VOLUME_NAME,
            mountPath: EXECUTION_WORKSPACE_MOUNT_PATH,
            // One explicit user workspace subdirectory: never the PVC root,
            // never `users/`, never `state/`.
            subPath: `${resolved.workspaceLayoutPrefix}users/${resolved.userKey}`,
            readOnly: false,
          },
          ...scratchMounts,
        ]
      : [
          {
            name: INPUT_VOLUME_NAME,
            mountPath: EXECUTION_INPUT_MOUNT_PATH,
            // The receiver is the only writer; the executor can never rewrite
            // the published input.
            readOnly: true,
          },
          ...scratchMounts,
        ]

  const volumes: k8s.V1Volume[] = [scratchVolume]
  let initContainers: k8s.V1Container[] | undefined

  if (approved.kind === 'workspace') {
    volumes.unshift({
      name: WORKSPACE_VOLUME_NAME,
      persistentVolumeClaim: { claimName: resolved.workspacePvcName, readOnly: false },
    })
  } else {
    volumes.unshift({
      name: INPUT_VOLUME_NAME,
      emptyDir: { medium: 'Memory', sizeLimit: String(EXECUTION_INPUT_MAX_BYTES) },
    })
    initContainers = [
      {
        name: EXECUTION_INPUT_RECEIVER_CONTAINER_NAME,
        image: resolved.image,
        command: [
          'node',
          EXECUTION_RECEIVE_INPUT_ENTRYPOINT,
          String(approved.input.byteLength),
          approved.input.sha256,
          String(approved.timeoutMs),
        ],
        // One private HTTP stream is verified before this init process exits.
        // No attach/exec subresource or service-account token is required.
        env: [
          { name: EXECUTION_POD_UID_ENV, valueFrom: { fieldRef: { fieldPath: 'metadata.uid' } } },
        ],
        volumeMounts: [
          { name: INPUT_VOLUME_NAME, mountPath: EXECUTION_INPUT_MOUNT_PATH, readOnly: false },
        ],
        resources: {
          requests: { cpu: '50m', memory: '32Mi' },
          limits: { cpu: '250m', memory: '256Mi' },
        },
        securityContext: containerSecurityContext(),
      },
    ]
  }

  const executor: k8s.V1Container = {
    name: EXECUTION_EXECUTOR_CONTAINER_NAME,
    image: resolved.image,
    // The fixed launcher passes the approved vector literally to spawn, with
    // no added shell. It bounds stdout/stderr at the producer, not just at the
    // eventual API response. Separate arguments avoid JSON escape inflation.
    command: ['node', EXECUTION_RUN_ENTRYPOINT, String(approved.timeoutMs), ...approved.argv],
    workingDir,
    // Fixed server-owned, non-secret values only; `serviceLinks` stays disabled
    // so the API server cannot inject service environment into this pod.
    env: [
      { name: 'HOME', value: workingDir },
      { name: 'TMPDIR', value: EXECUTION_TMP_MOUNT_PATH },
      { name: EXECUTION_POD_UID_ENV, valueFrom: { fieldRef: { fieldPath: 'metadata.uid' } } },
    ],
    ports: [{ name: 'result', containerPort: EXECUTION_RESULT_PORT, protocol: 'TCP' }],
    readinessProbe: {
      tcpSocket: { port: 'result' },
      periodSeconds: 1,
      timeoutSeconds: 1,
      failureThreshold: 5,
    },
    volumeMounts: executorMounts,
    resources: {
      requests: { cpu: '100m', memory: '64Mi' },
      limits: {
        cpu: '1',
        // The single scratch volume, the maximum input and the Node working set
        // are the only unbounded-looking consumers; this covers all three.
        memory: `${Math.ceil(
          (EXECUTOR_MEMORY_BASE_BYTES + EXECUTION_INPUT_MAX_BYTES + approved.scratchBytes) /
            MEBIBYTE
        )}Mi`,
      },
    },
    securityContext: containerSecurityContext(),
  }

  const podSpec: k8s.V1PodSpec = {
    restartPolicy: 'Never',
    automountServiceAccountToken: false,
    enableServiceLinks: false,
    hostPID: false,
    hostIPC: false,
    hostNetwork: false,
    shareProcessNamespace: false,
    securityContext: {
      runAsNonRoot: true,
      runAsUser: RUN_AS_UID,
      runAsGroup: RUN_AS_GID,
      fsGroup: RUN_AS_GID,
      seccompProfile: { type: 'RuntimeDefault' },
    },
    ...(initContainers ? { initContainers } : {}),
    containers: [executor],
    volumes,
  }

  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: {
      // The operation UUID keeps the name unambiguous; the prefix keeps the
      // generated pod name inside the 63-character label bound.
      name: hostExecutionJobName(resolved.operationId),
      namespace: resolved.namespace,
      labels,
      annotations,
      ownerReferences: [
        {
          apiVersion: HOST_OWNER_API_VERSION,
          kind: 'Host',
          name: resolved.hostName,
          uid: resolved.hostUid,
          controller: true,
        },
      ],
    },
    spec: {
      backoffLimit: 0,
      // Includes the bounded private-result delivery window. Command runtime
      // itself is still limited by the launcher to the approved timeout.
      activeDeadlineSeconds: Math.ceil(approved.timeoutMs / 1000) + 60,
      template: {
        metadata: { labels, annotations },
        spec: podSpec,
      },
    },
  }
}

export type HostExecutionRecordErrorCode =
  | 'job_record_invalid'
  | 'job_identity_mismatch'
  | 'job_owner_mismatch'
  | 'job_generation_mismatch'
  | 'job_contract_mismatch'
  | 'job_uid_replaced'
  | 'pod_record_invalid'
  | 'pod_namespace_mismatch'
  | 'pod_owner_mismatch'
  | 'pod_uid_replaced'

export class HostExecutionRecordError extends Error {
  constructor(readonly code: HostExecutionRecordErrorCode) {
    super(code)
    this.name = 'HostExecutionRecordError'
  }
}

function failRecord(code: HostExecutionRecordErrorCode): never {
  throw new HostExecutionRecordError(code)
}

interface RecordMetadata {
  name: string
  namespace: string
  uid: string
  annotations: Record<string, unknown>
  ownerReferences: k8s.V1OwnerReference[]
}

function requireRecordMetadata(
  record: unknown,
  code: HostExecutionRecordErrorCode
): RecordMetadata {
  const metadata = (record as { metadata?: unknown } | null | undefined)?.metadata
  if (typeof metadata !== 'object' || metadata === null) failRecord(code)
  const { name, namespace, uid, annotations, ownerReferences } = metadata as Record<string, unknown>
  if (
    typeof name !== 'string' ||
    name.length === 0 ||
    typeof namespace !== 'string' ||
    namespace.length === 0 ||
    typeof uid !== 'string' ||
    uid.length === 0
  ) {
    failRecord(code)
  }
  if (annotations !== undefined && (typeof annotations !== 'object' || annotations === null)) {
    failRecord(code)
  }
  if (ownerReferences !== undefined && !Array.isArray(ownerReferences)) failRecord(code)
  return {
    name,
    namespace,
    uid,
    annotations: (annotations as Record<string, unknown> | undefined) ?? {},
    ownerReferences: (ownerReferences as k8s.V1OwnerReference[] | undefined) ?? [],
  }
}

/** Exactly one owner of the expected kind; a second candidate is ambiguous. */
function requireExactOwner(
  ownerReferences: k8s.V1OwnerReference[],
  apiVersion: string,
  kind: string,
  code: HostExecutionRecordErrorCode
): k8s.V1OwnerReference {
  const owners = ownerReferences.filter(
    ref => ref && ref.apiVersion === apiVersion && ref.kind === kind
  )
  if (owners.length !== 1) failRecord(code)
  return owners[0]
}

/**
 * Validates a Job re-read from the API against the approved identity and
 * request. Labels select a record; only the deterministic name, the exact Host
 * ownerReference and the server-owned annotations prove it. Pass the UID bound
 * by an earlier validation to reject a replaced Job.
 */
export function validateHostExecutionJob(
  job: k8s.V1Job,
  identity: TrustedHostExecutionIdentity,
  request: ApprovedExecutionRequest,
  expectedUid?: string
): void {
  const resolved = resolveIdentity(identity)
  const fingerprint = hostExecutionContractFingerprint(resolved, request)
  const metadata = requireRecordMetadata(job, 'job_record_invalid')
  if (expectedUid !== undefined && metadata.uid !== expectedUid) failRecord('job_uid_replaced')
  if (
    metadata.namespace !== resolved.namespace ||
    metadata.name !== hostExecutionJobName(resolved.operationId)
  ) {
    failRecord('job_identity_mismatch')
  }
  const owner = requireExactOwner(
    metadata.ownerReferences,
    HOST_OWNER_API_VERSION,
    'Host',
    'job_owner_mismatch'
  )
  if (
    owner.name !== resolved.hostName ||
    owner.uid !== resolved.hostUid ||
    owner.controller !== true
  ) {
    failRecord('job_owner_mismatch')
  }
  if (
    metadata.annotations[EXECUTION_HOST_GENERATION_ANNOTATION] !== String(resolved.hostGeneration)
  ) {
    failRecord('job_generation_mismatch')
  }
  if (metadata.annotations[EXECUTION_CONTRACT_FINGERPRINT_ANNOTATION] !== fingerprint) {
    failRecord('job_contract_mismatch')
  }
}

/**
 * Validates the Pod the caller is about to attach to or log for: it must be
 * owned by the exact validated Job UID, in the Job's namespace. The Job is
 * validated first so the chain can never start from an unproven record. Pass
 * the pod UID bound by an earlier validation to reject a replaced Pod.
 */
export function validateHostExecutionPod(
  pod: k8s.V1Pod,
  job: k8s.V1Job,
  identity: TrustedHostExecutionIdentity,
  request: ApprovedExecutionRequest,
  expectedPodUid?: string
): void {
  validateHostExecutionJob(job, identity, request)
  const jobMetadata = requireRecordMetadata(job, 'job_record_invalid')
  const podMetadata = requireRecordMetadata(pod, 'pod_record_invalid')
  if (expectedPodUid !== undefined && podMetadata.uid !== expectedPodUid) {
    failRecord('pod_uid_replaced')
  }
  if (podMetadata.namespace !== jobMetadata.namespace) failRecord('pod_namespace_mismatch')
  const owner = requireExactOwner(
    podMetadata.ownerReferences,
    'batch/v1',
    'Job',
    'pod_owner_mismatch'
  )
  if (
    owner.name !== jobMetadata.name ||
    owner.uid !== jobMetadata.uid ||
    owner.controller !== true
  ) {
    failRecord('pod_owner_mismatch')
  }
}
