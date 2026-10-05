import { describe, expect, it } from 'vitest'
import type * as k8s from '@kubernetes/client-node'
import { MANAGED_BY_LABEL, MANAGED_BY_VALUE } from '../constants'
import {
  ApprovedExecutionRequest,
  EXECUTION_ARGV_MAX_BYTES,
  EXECUTION_CONTRACT_FINGERPRINT_ANNOTATION,
  EXECUTION_HOST_GENERATION_ANNOTATION,
  EXECUTION_HOST_UID_LABEL,
  EXECUTION_INPUT_MAX_BYTES,
  EXECUTION_INPUT_MOUNT_PATH,
  EXECUTION_INPUT_RECEIVER_CONTAINER_NAME,
  EXECUTION_OPERATION_LABEL,
  EXECUTION_RECEIVE_INPUT_ENTRYPOINT,
  EXECUTION_ROLE_LABEL,
  EXECUTION_ROLE_VALUE,
  EXECUTION_RUN_ENTRYPOINT,
  EXECUTION_RUN_LAUNCHER_SCRIPT,
  EXECUTION_SCRATCH_MAX_BYTES,
  EXECUTION_SCRATCH_MOUNT_PATH,
  EXECUTION_TIMEOUT_MAX_MS,
  EXECUTION_TMP_MOUNT_PATH,
  EXECUTION_WORKSPACE_MOUNT_PATH,
  HOST_OWNER_API_VERSION,
  HostExecutionJobError,
  HostExecutionRecordError,
  TrustedHostExecutionIdentity,
  buildHostExecutionJob,
  hostExecutionContractFingerprint,
  hostExecutionJobName,
  hostExecutionRequestFingerprint,
  validateHostExecutionJob,
  validateHostExecutionPod,
} from './jobFactory'

const identity: TrustedHostExecutionIdentity = {
  hostName: 'chatllm',
  hostUid: '9f0e3a5c-5f1e-4a4e-9a2d-3f4c5b6a7d8e',
  namespace: 'mcp-host',
  operationId: '7b1f0d2c-3a4b-4c5d-8e9f-0a1b2c3d4e5f',
  hostGeneration: 7,
  image: 'registry.example.com/evenfire/mcp-host@sha256:0123456789abcdef',
  workspacePvcName: 'chatllm-workspace',
  userKey: '0123456789abcdef',
  workspaceLayoutPrefix: 'workspace/',
}

const workspaceRequest: ApprovedExecutionRequest = {
  kind: 'workspace',
  argv: ['/usr/bin/git', 'status', '--short'],
  timeoutMs: 60_000,
  scratchBytes: 33_554_432,
}

const attachmentRequest: ApprovedExecutionRequest = {
  kind: 'attachment',
  argv: ['node', '/app/mcp-host/dist/core/tools/attachmentRead.js', '/input/source'],
  timeoutMs: 120_000,
  scratchBytes: 16_777_216,
  input: { byteLength: 1_048_576, sha256: 'a'.repeat(64) },
}

const expectedLabels = {
  [MANAGED_BY_LABEL]: MANAGED_BY_VALUE,
  [EXECUTION_OPERATION_LABEL]: identity.operationId,
  [EXECUTION_HOST_UID_LABEL]: identity.hostUid,
  [EXECUTION_ROLE_LABEL]: EXECUTION_ROLE_VALUE,
}

function podSpec(job: k8s.V1Job): k8s.V1PodSpec {
  return job.spec!.template.spec!
}

function volume(job: k8s.V1Job, name: string): k8s.V1Volume {
  const found = podSpec(job).volumes!.find(candidate => candidate.name === name)
  if (!found) throw new Error(`volume ${name} missing`)
  return found
}

function mountAt(container: k8s.V1Container, mountPath: string): k8s.V1VolumeMount {
  const found = (container.volumeMounts ?? []).find(candidate => candidate.mountPath === mountPath)
  if (!found) throw new Error(`mount ${mountPath} missing`)
  return found
}

function collectNamespaces(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) collectNamespaces(item, found)
    return found
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (key === 'namespace' && typeof child === 'string') found.push(child)
      else collectNamespaces(child, found)
    }
  }
  return found
}

/** Returns the thrown validation error so the exact rejected field is asserted. */
function rejection(run: () => unknown): HostExecutionJobError {
  try {
    run()
  } catch (error) {
    if (error instanceof HostExecutionJobError) return error
    throw error
  }
  throw new Error('expected HostExecutionJobError')
}

function rejectionRecord(run: () => unknown): HostExecutionRecordError {
  try {
    run()
  } catch (error) {
    if (error instanceof HostExecutionRecordError) return error
    throw error
  }
  throw new Error('expected HostExecutionRecordError')
}

/** A Job as the API returns it: the emitted spec plus a server UID. */
function storedJob(uid = 'job-uid-0001'): k8s.V1Job {
  const job = buildHostExecutionJob(identity, workspaceRequest)
  job.metadata!.uid = uid
  return job
}

function ownedPod(job: k8s.V1Job): k8s.V1Pod {
  return {
    metadata: {
      name: `${job.metadata!.name}-abc12`,
      namespace: job.metadata!.namespace,
      uid: 'pod-uid-0001',
      annotations: { ...(job.spec!.template.metadata!.annotations ?? {}) },
      ownerReferences: [
        {
          apiVersion: 'batch/v1',
          kind: 'Job',
          name: job.metadata!.name,
          uid: job.metadata!.uid,
          controller: true,
        },
      ],
    },
  } as k8s.V1Pod
}

describe('bounded Host execution job factory', () => {
  it('requests native collection of finished Jobs and their private input Pods without a caller', () => {
    for (const request of [workspaceRequest, attachmentRequest]) {
      const job = buildHostExecutionJob(identity, request)
      // activeDeadlineSeconds stops work, but leaves terminated Pods and their
      // input volumes behind unless the Kubernetes TTL controller collects
      // the Job. A lost/disconnected caller must not retain those copies.
      expect(job.spec!.ttlSecondsAfterFinished).toBe(0)
      expect(job.spec!.activeDeadlineSeconds).toBeLessThanOrEqual(
        Math.ceil(EXECUTION_TIMEOUT_MAX_MS / 1000) + 60
      )
    }
  })

  it('encodes one workspace Job under the Host owner with targetable labels', () => {
    const job = buildHostExecutionJob(identity, workspaceRequest)

    expect(job.apiVersion).toBe('batch/v1')
    expect(job.kind).toBe('Job')
    expect(job.metadata!.name).toBe(`host-exec-${identity.operationId}`)
    expect(job.metadata!.name!.length).toBeLessThanOrEqual(63)
    expect(job.metadata!.namespace).toBe(identity.namespace)
    expect(job.metadata!.labels).toEqual(expectedLabels)
    expect(job.spec!.template.metadata!.labels).toEqual(expectedLabels)
    // blockOwnerDeletion would require owner/finalizer RBAC this feature does
    // not hold; the exact UID still binds the reference to one Host object.
    expect(job.metadata!.ownerReferences).toEqual([
      {
        apiVersion: HOST_OWNER_API_VERSION,
        kind: 'Host',
        name: identity.hostName,
        uid: identity.hostUid,
        controller: true,
      },
    ])

    expect(job.spec!.backoffLimit).toBe(0)
    expect(job.spec!.activeDeadlineSeconds).toBe(120)
    expect(podSpec(job).restartPolicy).toBe('Never')
    expect(podSpec(job).initContainers).toBeUndefined()
    expect(volume(job, 'workspace').persistentVolumeClaim).toEqual({
      claimName: identity.workspacePvcName,
      readOnly: false,
    })

    const executor = podSpec(job).containers![0]
    expect(executor.command).toEqual([
      '/bin/sh',
      '-c',
      EXECUTION_RUN_LAUNCHER_SCRIPT,
      'node',
      EXECUTION_RUN_ENTRYPOINT,
      String(workspaceRequest.timeoutMs),
      ...workspaceRequest.argv,
    ])
    expect(executor.args).toBeUndefined()
    expect(executor.workingDir).toBe(EXECUTION_WORKSPACE_MOUNT_PATH)
    expect(executor.env).toEqual([
      { name: 'HOME', value: EXECUTION_WORKSPACE_MOUNT_PATH },
      { name: 'TMPDIR', value: EXECUTION_TMP_MOUNT_PATH },
      { name: 'EXECUTION_POD_UID', valueFrom: { fieldRef: { fieldPath: 'metadata.uid' } } },
    ])
  })

  it('mounts exactly one explicit subPath for the dual layout, the legacy root and _system', () => {
    const cases: Array<[TrustedHostExecutionIdentity['workspaceLayoutPrefix'], string, string]> = [
      ['workspace/', identity.userKey, `workspace/users/${identity.userKey}`],
      ['', identity.userKey, `users/${identity.userKey}`],
      ['workspace/', '_system', 'workspace/users/_system'],
    ]
    for (const [workspaceLayoutPrefix, userKey, expectedSubPath] of cases) {
      const job = buildHostExecutionJob(
        { ...identity, workspaceLayoutPrefix, userKey },
        workspaceRequest
      )
      const executor = podSpec(job).containers![0]
      const subPaths = (executor.volumeMounts ?? [])
        .map(candidate => candidate.subPath)
        .filter((candidate): candidate is string => candidate !== undefined)
      expect(subPaths).toEqual([expectedSubPath])
      expect(subPaths[0]).not.toBe('')
      expect(subPaths[0]).not.toBe('users')
      expect(subPaths[0]).not.toBe('state')
      expect(mountAt(executor, EXECUTION_WORKSPACE_MOUNT_PATH).readOnly).toBe(false)
    }
  })

  it('never mounts the workspace PVC or store for an attachment operation', () => {
    const job = buildHostExecutionJob(identity, attachmentRequest)

    expect(podSpec(job).initContainers).toHaveLength(1)
    expect(
      podSpec(job)
        .volumes!.map(candidate => candidate.name)
        .sort()
    ).toEqual(['input', 'scratch'])
    for (const candidate of podSpec(job).volumes!) {
      expect(candidate.persistentVolumeClaim).toBeUndefined()
      expect(candidate.emptyDir).toBeDefined()
    }

    const executor = podSpec(job).containers![0]
    expect((executor.volumeMounts ?? []).map(candidate => candidate.mountPath).sort()).toEqual([
      EXECUTION_INPUT_MOUNT_PATH,
      EXECUTION_SCRATCH_MOUNT_PATH,
      EXECUTION_TMP_MOUNT_PATH,
    ])
    expect(mountAt(executor, EXECUTION_INPUT_MOUNT_PATH)).toEqual({
      name: 'input',
      mountPath: EXECUTION_INPUT_MOUNT_PATH,
      readOnly: true,
    })
    expect((executor.volumeMounts ?? []).every(candidate => candidate.subPath === undefined)).toBe(
      true
    )
    // The attachment workspace is the writable scratch volume, never the PVC.
    expect(executor.workingDir).toBe(EXECUTION_SCRATCH_MOUNT_PATH)
    expect(executor.env).toEqual([
      { name: 'HOME', value: EXECUTION_SCRATCH_MOUNT_PATH },
      { name: 'TMPDIR', value: EXECUTION_TMP_MOUNT_PATH },
      { name: 'EXECUTION_POD_UID', valueFrom: { fieldRef: { fieldPath: 'metadata.uid' } } },
    ])
    expect(collectNamespaces(job)).toEqual([identity.namespace])
  })

  it('gives the trusted init receiver exclusive read-write input and the exact arguments', () => {
    const receiver = podSpec(buildHostExecutionJob(identity, attachmentRequest)).initContainers![0]

    expect(receiver.name).toBe(EXECUTION_INPUT_RECEIVER_CONTAINER_NAME)
    expect(receiver.image).toBe(identity.image)
    expect(receiver.command).toEqual([
      'node',
      EXECUTION_RECEIVE_INPUT_ENTRYPOINT,
      String(attachmentRequest.input!.byteLength),
      attachmentRequest.input!.sha256,
      String(attachmentRequest.timeoutMs),
    ])
    expect(receiver.args).toBeUndefined()
    expect(receiver.stdin).toBeUndefined()
    expect(receiver.stdinOnce).toBeUndefined()
    expect(receiver.tty).toBeUndefined()
    expect(receiver.env).toEqual([
      { name: 'EXECUTION_POD_UID', valueFrom: { fieldRef: { fieldPath: 'metadata.uid' } } },
    ])
    expect(receiver.envFrom).toBeUndefined()
    expect(receiver.volumeMounts).toEqual([
      { name: 'input', mountPath: EXECUTION_INPUT_MOUNT_PATH, readOnly: false },
    ])
  })

  it('hardens every container and denies credential, runtime-env and host namespace access', () => {
    for (const request of [workspaceRequest, attachmentRequest]) {
      const job = buildHostExecutionJob(identity, request)
      const spec = podSpec(job)
      const containers = [...(spec.initContainers ?? []), ...spec.containers!]
      expect(containers.length).toBeGreaterThanOrEqual(1)
      for (const container of containers) {
        expect(container.securityContext).toEqual({
          allowPrivilegeEscalation: false,
          privileged: false,
          readOnlyRootFilesystem: true,
          runAsNonRoot: true,
          runAsUser: 1001,
          runAsGroup: 1001,
          capabilities: { drop: ['ALL'] },
          seccompProfile: { type: 'RuntimeDefault' },
        })
      }
      expect(spec.automountServiceAccountToken).toBe(false)
      expect(spec.enableServiceLinks).toBe(false)
      expect(spec.hostPID).toBe(false)
      expect(spec.hostIPC).toBe(false)
      expect(spec.hostNetwork).toBe(false)
      expect(spec.shareProcessNamespace).toBe(false)
      expect(spec.securityContext).toEqual({
        runAsNonRoot: true,
        runAsUser: 1001,
        runAsGroup: 1001,
        fsGroup: 1001,
        seccompProfile: { type: 'RuntimeDefault' },
      })
      for (const candidate of spec.volumes!) {
        expect(candidate.secret).toBeUndefined()
        expect(candidate.configMap).toBeUndefined()
        expect(candidate.hostPath).toBeUndefined()
        expect(candidate.projected).toBeUndefined()
      }
    }
  })

  it('bounds /scratch and /tmp with one memory volume and a finite memory limit', () => {
    const job = buildHostExecutionJob(identity, workspaceRequest)
    const scratch = volume(job, 'scratch')
    expect(scratch.emptyDir).toEqual({
      medium: 'Memory',
      sizeLimit: String(workspaceRequest.scratchBytes),
    })
    const executor = podSpec(job).containers![0]
    expect(mountAt(executor, EXECUTION_SCRATCH_MOUNT_PATH).name).toBe('scratch')
    expect(mountAt(executor, EXECUTION_TMP_MOUNT_PATH).name).toBe('scratch')
    expect(
      (executor.volumeMounts ?? []).filter(candidate => candidate.name === 'scratch')
    ).toHaveLength(2)
    expect(podSpec(job).volumes!.map(candidate => candidate.name)).not.toContain('tmp')
    expect(executor.resources!.requests).toEqual({ cpu: '100m', memory: '64Mi' })
    // 256Mi working set + 11Mi maximum input + the 32Mi aggregate scratch bound.
    expect(executor.resources!.limits).toEqual({ cpu: '1', memory: '299Mi' })

    const receiver = podSpec(buildHostExecutionJob(identity, attachmentRequest)).initContainers![0]
    expect(receiver.resources!.limits).toEqual({ cpu: '250m', memory: '256Mi' })
    expect(volume(buildHostExecutionJob(identity, attachmentRequest), 'input').emptyDir).toEqual({
      medium: 'Memory',
      sizeLimit: String(EXECUTION_INPUT_MAX_BYTES),
    })
  })

  it('derives the bounded deadline from the requested timeout and rejects the edges', () => {
    const at = (timeoutMs: number) =>
      buildHostExecutionJob(identity, { ...workspaceRequest, timeoutMs }).spec!
        .activeDeadlineSeconds

    expect(at(1_000)).toBe(61)
    expect(at(90_001)).toBe(151)
    expect(at(EXECUTION_TIMEOUT_MAX_MS)).toBe(1_560)
    for (const timeoutMs of [999, 0, -1, 1.5, EXECUTION_TIMEOUT_MAX_MS + 1, Number.NaN]) {
      expect(
        rejection(() => buildHostExecutionJob(identity, { ...workspaceRequest, timeoutMs })).field
      ).toBe('request.timeoutMs')
    }
  })

  it('preserves the approved vector, allows empty arguments after argv[0] and bounds its bytes', () => {
    const emptyTail: ApprovedExecutionRequest = {
      ...workspaceRequest,
      argv: ['/bin/sh', '-c', ''],
    }
    expect(
      podSpec(buildHostExecutionJob(identity, emptyTail)).containers![0].command!.slice(6)
    ).toEqual(['/bin/sh', '-c', ''])
    expect(
      podSpec(
        buildHostExecutionJob(identity, { ...workspaceRequest, argv: ['node', '', ''] })
      ).containers![0].command!.slice(6)
    ).toEqual(['node', '', ''])

    // The fixed launcher keeps the caller's array literal and unaliased.
    const argv = ['/usr/bin/git', 'status']
    const job = buildHostExecutionJob(identity, { ...workspaceRequest, argv })
    argv.push('--porcelain')
    expect(podSpec(job).containers![0].command!.slice(6)).toEqual(['/usr/bin/git', 'status'])
    expect(podSpec(job).containers![0].args).toBeUndefined()

    // Aggregate UTF-8 bound, measured in bytes rather than characters.
    const halfBound = 'é'.repeat(EXECUTION_ARGV_MAX_BYTES / 2)
    expect(
      podSpec(
        buildHostExecutionJob(identity, { ...workspaceRequest, argv: [halfBound] })
      ).containers![0].command!.slice(6)
    ).toEqual([halfBound])
    for (const bad of [
      [''],
      ['a'.repeat(EXECUTION_ARGV_MAX_BYTES), 'x'],
      ['node', halfBound],
      ['node', 'é'.repeat(EXECUTION_ARGV_MAX_BYTES / 2 + 1)],
    ]) {
      expect(
        rejection(() => buildHostExecutionJob(identity, { ...workspaceRequest, argv: bad })).field
      ).toMatch(/^request\.argv/)
    }
  })

  it('rejects a client PVC or image override and every unknown request field', () => {
    const overrides: Array<Record<string, unknown>> = [
      { workspacePvcName: 'other-workspace' },
      { image: 'registry.example.com/attacker/image:latest' },
      { pvc: 'other-workspace' },
      { namespace: 'other-namespace' },
    ]
    for (const override of overrides) {
      const raw = { ...workspaceRequest, ...override }
      const error = rejection(() =>
        buildHostExecutionJob(identity, raw as ApprovedExecutionRequest)
      )
      expect(error.field).toBe(`request.${Object.keys(override)[0]}`)
    }
  })

  it('rejects invalid argument vectors and out-of-bound integers upfront', () => {
    const argvCases: Array<[unknown, string]> = [
      [[], 'request.argv'],
      ['git status', 'request.argv'],
      [['ok', 42], 'request.argv[1]'],
      [['a\0b'], 'request.argv[0]'],
      [['ok', 'a\0b'], 'request.argv[1]'],
      [[''], 'request.argv[0]'],
    ]
    for (const [argv, field] of argvCases) {
      expect(
        rejection(() =>
          buildHostExecutionJob(identity, {
            ...workspaceRequest,
            argv: argv as string[],
          })
        ).field
      ).toBe(field)
    }
    for (const scratchBytes of [0, -1, 1.5, EXECUTION_SCRATCH_MAX_BYTES + 1]) {
      expect(
        rejection(() => buildHostExecutionJob(identity, { ...workspaceRequest, scratchBytes }))
          .field
      ).toBe('request.scratchBytes')
    }
  })

  it('requires the attachment input contract and rejects a workspace input', () => {
    expect(
      rejection(() =>
        buildHostExecutionJob(identity, {
          kind: 'attachment',
          argv: attachmentRequest.argv,
          timeoutMs: attachmentRequest.timeoutMs,
          scratchBytes: attachmentRequest.scratchBytes,
        })
      ).field
    ).toBe('request.input')
    expect(
      rejection(() =>
        buildHostExecutionJob(identity, { ...workspaceRequest, input: attachmentRequest.input })
      ).field
    ).toBe('request.input')

    const badInputs: Array<Record<string, unknown>> = [
      { byteLength: -1, sha256: 'a'.repeat(64) },
      { byteLength: 1.5, sha256: 'a'.repeat(64) },
      { byteLength: EXECUTION_INPUT_MAX_BYTES + 1, sha256: 'a'.repeat(64) },
      { byteLength: 1, sha256: 'A'.repeat(64) },
      { byteLength: 1, sha256: 'a'.repeat(63) },
      { byteLength: 1, sha256: 'z'.repeat(64) },
      { byteLength: 1, sha256: 'a'.repeat(64), path: '/etc/passwd' },
    ]
    for (const input of badInputs) {
      expect(
        rejection(() =>
          buildHostExecutionJob(identity, {
            ...attachmentRequest,
            input: input as unknown as ApprovedExecutionRequest['input'],
          })
        ).field
      ).toMatch(/^request\.input/)
    }

    // An exact empty input is a valid file, not a missing one.
    const emptyInput: ApprovedExecutionRequest = {
      ...attachmentRequest,
      input: {
        byteLength: 0,
        sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      },
    }
    expect(
      podSpec(buildHostExecutionJob(identity, emptyInput)).initContainers![0].command![2]
    ).toBe('0')
  })

  it('rejects identity values that would produce an invalid or cross-namespace Job', () => {
    const badIdentities: Array<Partial<TrustedHostExecutionIdentity>> = [
      { hostName: '' },
      { hostName: 'ChatLLM' },
      { hostName: '-chatllm' },
      { hostName: 'a'.repeat(254) },
      { hostUid: 'not-a-uuid' },
      { hostUid: identity.hostUid.toUpperCase() },
      { namespace: 'Bad_Namespace' },
      { namespace: 'a'.repeat(64) },
      { operationId: identity.operationId.toUpperCase() },
      { operationId: '7b1f0d2c' },
      { image: 'registry.example.com/img:tag with space' },
      { image: '' },
      { workspacePvcName: 'not/a/name' },
      { userKey: '0123456789ABCDEF' },
      { userKey: '0123456789abcde' },
      { userKey: '../etc' },
      {
        workspaceLayoutPrefix: 'workspace' as TrustedHostExecutionIdentity['workspaceLayoutPrefix'],
      },
    ]
    for (const override of badIdentities) {
      const error = rejection(() =>
        buildHostExecutionJob({ ...identity, ...override }, workspaceRequest)
      )
      expect(error.field).toBe(`identity.${Object.keys(override)[0]}`)
    }
    expect(rejection(() => buildHostExecutionJob(null as never, workspaceRequest)).field).toBe(
      'identity'
    )
    expect(rejection(() => buildHostExecutionJob(identity, null as never)).field).toBe('request')
    expect(
      rejection(() =>
        buildHostExecutionJob(identity, {
          ...workspaceRequest,
          kind: 'network' as ApprovedExecutionRequest['kind'],
        })
      ).field
    ).toBe('request.kind')
  })

  it('uses the server-resolved image for every container and keeps one Host namespace', () => {
    const job = buildHostExecutionJob(identity, {
      ...attachmentRequest,
      input: { byteLength: 5, sha256: 'b'.repeat(64) },
    })
    for (const container of [...(podSpec(job).initContainers ?? []), ...podSpec(job).containers!]) {
      expect(container.image).toBe(identity.image)
    }
    expect(collectNamespaces(job)).toEqual([identity.namespace])
    expect(identity.userKey).toBe('0123456789abcdef')
  })

  it('emits server-owned generation and full-contract fingerprint annotations', () => {
    const job = buildHostExecutionJob(identity, workspaceRequest)
    const fingerprint = hostExecutionContractFingerprint(identity, workspaceRequest)
    const expected = {
      [EXECUTION_HOST_GENERATION_ANNOTATION]: '7',
      [EXECUTION_CONTRACT_FINGERPRINT_ANNOTATION]: fingerprint,
    }

    expect(job.metadata!.annotations).toEqual(expected)
    expect(job.spec!.template.metadata!.annotations).toEqual(expected)
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/)
    // Contract fingerprint binds the server-resolved identity...
    for (const variant of [
      { image: 'registry.example.com/evenfire/mcp-host@sha256:ffffffffffffffff' },
      { workspacePvcName: 'other-workspace' },
      { userKey: 'fedcba9876543210' },
      { workspaceLayoutPrefix: '' as const },
      { hostGeneration: 8 },
      { hostUid: 'a1b2c3d4-0000-4000-8000-000000000000' },
    ]) {
      expect(
        hostExecutionContractFingerprint({ ...identity, ...variant }, workspaceRequest)
      ).not.toBe(fingerprint)
    }
    // ...and the approved request, in a fixed order.
    expect(hostExecutionContractFingerprint({ ...identity }, { ...workspaceRequest })).toBe(
      fingerprint
    )
    expect(
      hostExecutionContractFingerprint(identity, { ...workspaceRequest, timeoutMs: 60_001 })
    ).not.toBe(fingerprint)
    expect(
      hostExecutionContractFingerprint(identity, {
        ...workspaceRequest,
        argv: ['/usr/bin/git', 'diff'],
      })
    ).not.toBe(fingerprint)
    expect(
      hostExecutionContractFingerprint(identity, {
        ...attachmentRequest,
        input: { ...attachmentRequest.input!, sha256: 'c'.repeat(64) },
      })
    ).not.toBe(hostExecutionContractFingerprint(identity, attachmentRequest))
    // The request-only fingerprint stays identity-free.
    expect(hostExecutionRequestFingerprint(workspaceRequest)).not.toBe(fingerprint)
    expect(hostExecutionRequestFingerprint({ ...workspaceRequest, timeoutMs: 60_001 })).not.toBe(
      hostExecutionRequestFingerprint(workspaceRequest)
    )
    expect(hostExecutionRequestFingerprint(workspaceRequest)).toBe(
      hostExecutionRequestFingerprint({ ...workspaceRequest })
    )
  })

  it('validates a Job re-read from the API against identity and request', () => {
    const job = storedJob()
    const before = JSON.stringify(job)

    expect(() => validateHostExecutionJob(job, identity, workspaceRequest)).not.toThrow()
    // Re-reading must not rewrite the record it just proved.
    expect(JSON.stringify(job)).toBe(before)

    expect(
      rejectionRecord(() => validateHostExecutionJob(storedJob(''), identity, workspaceRequest))
        .code
    ).toBe('job_record_invalid')
  })

  it('rejects a Job owned by another or recreated Host, even with the exact labels', () => {
    const forgedOwners = [
      undefined,
      [],
      [
        {
          apiVersion: HOST_OWNER_API_VERSION,
          kind: 'Host',
          name: identity.hostName,
          uid: 'a1b2c3d4-0000-4000-8000-000000000000',
          controller: true,
        },
      ],
      [
        {
          apiVersion: HOST_OWNER_API_VERSION,
          kind: 'Host',
          name: identity.hostName,
          uid: identity.hostUid,
          controller: false,
        },
      ],
      [
        {
          apiVersion: 'clerum.io/v1',
          kind: 'Host',
          name: identity.hostName,
          uid: identity.hostUid,
          controller: true,
        },
      ],
      [
        {
          apiVersion: HOST_OWNER_API_VERSION,
          kind: 'Host',
          name: 'other-host',
          uid: identity.hostUid,
          controller: true,
        },
      ],
      [
        {
          apiVersion: HOST_OWNER_API_VERSION,
          kind: 'Host',
          name: identity.hostName,
          uid: identity.hostUid,
          controller: true,
        },
        {
          apiVersion: HOST_OWNER_API_VERSION,
          kind: 'Host',
          name: identity.hostName,
          uid: 'b1b2c3d4-1111-4111-8111-111111111111',
          controller: false,
        },
      ],
    ]
    for (const ownerReferences of forgedOwners) {
      const job = storedJob()
      job.metadata!.ownerReferences = ownerReferences as k8s.V1OwnerReference[] | undefined
      // The labels are untouched on purpose: they never prove anything.
      expect(job.metadata!.labels).toEqual(expectedLabels)
      expect(
        rejectionRecord(() => validateHostExecutionJob(job, identity, workspaceRequest)).code
      ).toBe('job_owner_mismatch')
    }
  })

  it('rejects a Job emitted for another image, PVC, userKey or layout', () => {
    const job = storedJob()
    const variants: Array<Partial<TrustedHostExecutionIdentity>> = [
      { image: 'registry.example.com/evenfire/mcp-host@sha256:ffffffffffffffff' },
      { workspacePvcName: 'other-workspace' },
      { userKey: 'fedcba9876543210' },
      { workspaceLayoutPrefix: '' },
    ]
    for (const variant of variants) {
      // Owner, name, generation, UID and labels stay exact on purpose: only the
      // contract binding can reject a Job emitted for another identity.
      expect(job.metadata!.labels).toEqual(expectedLabels)
      expect(
        rejectionRecord(() =>
          validateHostExecutionJob(
            job,
            { ...identity, ...variant },
            workspaceRequest,
            job.metadata!.uid
          )
        ).code
      ).toBe('job_contract_mismatch')
    }
  })

  it('rejects a stale generation or a different request on the stored Job', () => {
    const job = storedJob()
    expect(
      rejectionRecord(() =>
        validateHostExecutionJob(job, { ...identity, hostGeneration: 8 }, workspaceRequest)
      ).code
    ).toBe('job_generation_mismatch')
    const staleAnnotation = storedJob()
    staleAnnotation.metadata!.annotations![EXECUTION_HOST_GENERATION_ANNOTATION] = '6'
    expect(
      rejectionRecord(() => validateHostExecutionJob(staleAnnotation, identity, workspaceRequest))
        .code
    ).toBe('job_generation_mismatch')

    const otherRequest: ApprovedExecutionRequest = {
      ...workspaceRequest,
      argv: ['/usr/bin/git', 'status', '--porcelain'],
    }
    expect(rejectionRecord(() => validateHostExecutionJob(job, identity, otherRequest)).code).toBe(
      'job_contract_mismatch'
    )
    const replacedFingerprint = storedJob()
    replacedFingerprint.metadata!.annotations![EXECUTION_CONTRACT_FINGERPRINT_ANNOTATION] =
      'd'.repeat(64)
    expect(
      rejectionRecord(() =>
        validateHostExecutionJob(replacedFingerprint, identity, workspaceRequest)
      ).code
    ).toBe('job_contract_mismatch')
  })

  it('rejects a stored Job with another deterministic name, operation or namespace', () => {
    const renamed = storedJob()
    renamed.metadata!.name = hostExecutionJobName('a1b2c3d4-0000-4000-8000-000000000000')
    expect(
      rejectionRecord(() => validateHostExecutionJob(renamed, identity, workspaceRequest)).code
    ).toBe('job_identity_mismatch')
    const foreignNamespace = storedJob()
    foreignNamespace.metadata!.namespace = 'other-namespace'
    expect(
      rejectionRecord(() => validateHostExecutionJob(foreignNamespace, identity, workspaceRequest))
        .code
    ).toBe('job_identity_mismatch')
    expect(
      rejectionRecord(() =>
        validateHostExecutionJob(
          storedJob(),
          { ...identity, operationId: 'a1b2c3d4-0000-4000-8000-000000000000' },
          workspaceRequest
        )
      ).code
    ).toBe('job_identity_mismatch')
  })

  it('validates the Pod against the exact Job owner UID and namespace before attach', () => {
    const job = storedJob()
    const pod = ownedPod(job)

    expect(() => validateHostExecutionPod(pod, job, identity, workspaceRequest)).not.toThrow()
    expect(
      rejectionRecord(() =>
        validateHostExecutionPod({ ...pod, metadata: undefined }, job, identity, workspaceRequest)
      ).code
    ).toBe('pod_record_invalid')
  })

  it('rejects a Pod owned by another Job, another namespace or no owner', () => {
    const job = storedJob()
    const pod = ownedPod(job)
    const foreignOwner = {
      ...pod,
      metadata: {
        ...pod.metadata,
        ownerReferences: [
          {
            apiVersion: 'batch/v1',
            kind: 'Job',
            name: job.metadata!.name,
            uid: 'c1b2c3d4-2222-4222-8222-222222222222',
            controller: true,
          },
        ],
      },
    }
    const notController = {
      ...pod,
      metadata: {
        ...pod.metadata,
        ownerReferences: [{ ...pod.metadata!.ownerReferences![0], controller: false }],
      },
    }
    const ownerless = { ...pod, metadata: { ...pod.metadata, ownerReferences: [] } }
    const foreignNamespace = {
      ...pod,
      metadata: { ...pod.metadata, namespace: 'other-namespace' },
    }

    for (const candidate of [foreignOwner, notController, ownerless]) {
      expect(
        rejectionRecord(() =>
          validateHostExecutionPod(candidate as k8s.V1Pod, job, identity, workspaceRequest)
        ).code
      ).toBe('pod_owner_mismatch')
    }
    expect(
      rejectionRecord(() =>
        validateHostExecutionPod(foreignNamespace as k8s.V1Pod, job, identity, workspaceRequest)
      ).code
    ).toBe('pod_namespace_mismatch')
    // A Pod owned by a replaced Job (same name, different Job UID) is rejected.
    const replacedJob = storedJob('job-uid-0002')
    expect(
      rejectionRecord(() => validateHostExecutionPod(pod, replacedJob, identity, workspaceRequest))
        .code
    ).toBe('pod_owner_mismatch')
    // A re-read that resolves to another object UID is rejected when the
    // earlier UID is supplied, and accepted when it is the same object.
    expect(
      rejectionRecord(() =>
        validateHostExecutionJob(
          storedJob('job-uid-0002'),
          identity,
          workspaceRequest,
          'job-uid-0001'
        )
      ).code
    ).toBe('job_uid_replaced')
    expect(() =>
      validateHostExecutionJob(
        storedJob('job-uid-0001'),
        identity,
        workspaceRequest,
        'job-uid-0001'
      )
    ).not.toThrow()
    expect(
      rejectionRecord(() =>
        validateHostExecutionPod(pod, job, identity, workspaceRequest, 'pod-uid-0000')
      ).code
    ).toBe('pod_uid_replaced')
    expect(() =>
      validateHostExecutionPod(pod, job, identity, workspaceRequest, 'pod-uid-0001')
    ).not.toThrow()
  })

  it('requires a positive safe Host generation in the trusted identity', () => {
    for (const hostGeneration of [0, -1, 1.5, Number.NaN, '7' as unknown as number]) {
      expect(
        rejection(() => buildHostExecutionJob({ ...identity, hostGeneration }, workspaceRequest))
          .field
      ).toBe('identity.hostGeneration')
    }
  })
})
