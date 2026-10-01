import * as k8s from '@kubernetes/client-node'
import { createHash } from 'node:crypto'
import { PassThrough, Readable } from 'node:stream'
import { isDeepStrictEqual } from 'node:util'
import { CONVERSATION_STORE_BOOTSTRAP_VERIFY_PROGRAM } from './conversationStoreBootstrapProgram'
import {
  computeConversationStoreRequestHash,
  conversationStoreInitBindingMatches,
  resolveConversationStoreOwnerChain,
  verifyConversationStoreInitOutcome,
} from './conversationStoreObservation'
import type {
  ConversationStoreExecution,
  ConversationStoreOperatorContext,
  ConversationStoreOperatorPort,
  ConversationStorePhysicalProof,
  ConversationStoreWriterProof,
} from './conversationStoreOperator'
import { CANONICAL_STORE_CLI_PATH, WORKSPACE_PVC_ROOT_MOUNT_PATH } from './statelessDeployment'
import type { ConversationStoreRequest, HostCRD, HostConversationStoreStatus } from './types'
import {
  deploymentMatchesDesired,
  getErrorCode,
  observeCreate,
  replaceWithConflictRetry,
} from './utils'

const HOST_UID = 'clerum.io/host-uid'
const REQUEST_ID = 'clerum.io/conversation-store-request-id'
const CONTRACT = 'clerum.io/conversation-store-contract'
const REQUEST_HASH = 'clerum.io/conversation-store-request-hash'
const CONTAINER = 'conversation-store-operator'
const DEADLINE_SECONDS = 240
const SCRATCH_ROOT = '/canonical-scratch'

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}
function controlledBy(value: { metadata?: k8s.V1ObjectMeta }, uid: string): boolean {
  return (
    value.metadata?.ownerReferences?.some(
      owner => owner.controller === true && owner.uid === uid
    ) ?? false
  )
}
function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}
function sameBinding(proof: Record<string, unknown>, request: ConversationStoreRequest): boolean {
  return (
    proof.storageContract === request.storageContract &&
    proof.hostUid === request.hostUid &&
    proof.pvcUid === request.pvcUid &&
    proof.maintenanceId === request.maintenanceId
  )
}

export interface ConversationStoreKubernetesDependencies {
  kubeConfig: k8s.KubeConfig
  appsApi: k8s.AppsV1Api
  coreApi: k8s.CoreV1Api
  batchApi: () => k8s.BatchV1Api
  rbacApi: k8s.RbacAuthorizationV1Api
  readFreshHost(host: HostCRD): Promise<HostCRD>
  writeStatus(
    context: ConversationStoreOperatorContext,
    request: ConversationStoreRequest,
    fields: Partial<Omit<HostConversationStoreStatus, 'request'>>
  ): Promise<HostCRD>
  now(): Date
  imagePullSecrets?: k8s.V1LocalObjectReference[]
  /** Test transport only. Production transfers the trusted inline program through Kubernetes exec. */
  execProgram?: (
    namespace: string,
    pod: string,
    container: string,
    program: string,
    args: string[]
  ) => Promise<string>
}

/** Kubernetes transport for the production operator. No local files or flags confer authority. */
export class ConversationStoreKubernetesOperatorPort implements ConversationStoreOperatorPort {
  constructor(private readonly deps: ConversationStoreKubernetesDependencies) {}
  now(): Date {
    return this.deps.now()
  }
  readFreshHost(host: HostCRD): Promise<HostCRD> {
    return this.deps.readFreshHost(host)
  }
  writeStatus(
    context: ConversationStoreOperatorContext,
    request: ConversationStoreRequest,
    fields: Partial<Omit<HostConversationStoreStatus, 'request'>>
  ): Promise<HostCRD> {
    return this.deps.writeStatus(context, request, fields)
  }
  async readPvcUid(host: HostCRD, pvcName: string): Promise<string> {
    const pvc = await this.deps.coreApi.readNamespacedPersistentVolumeClaim({
      namespace: host.namespace,
      name: pvcName,
    })
    if (
      !pvc.metadata?.uid ||
      !pvc.metadata.resourceVersion ||
      pvc.metadata.deletionTimestamp ||
      pvc.metadata.name !== pvcName ||
      (pvc.metadata.namespace !== undefined && pvc.metadata.namespace !== host.namespace)
    )
      throw new Error('OperatorPvcUnverified')
    return pvc.metadata.uid
  }
  private async requireCurrent(
    context: ConversationStoreOperatorContext,
    request: ConversationStoreRequest
  ): Promise<void> {
    const fresh = await this.readFreshHost(context.host)
    if (
      fresh.uid !== request.hostUid ||
      !fresh.resourceVersion ||
      !isDeepStrictEqual(fresh.spec, context.host.spec) ||
      !isDeepStrictEqual(fresh.status?.conversationStore?.request, request) ||
      (await this.readPvcUid(fresh, context.pvcName)) !== request.pvcUid
    )
      throw new Error('OperatorBindingChanged')
    context.host = fresh
  }
  private async readDeployment(
    context: ConversationStoreOperatorContext
  ): Promise<k8s.V1Deployment | undefined> {
    try {
      const deployment = await this.deps.appsApi.readNamespacedDeployment({
        namespace: context.host.namespace,
        name: context.host.name,
      })
      if (
        !deployment.metadata?.uid ||
        !deployment.metadata.resourceVersion ||
        deployment.metadata.deletionTimestamp ||
        deployment.metadata.annotations?.[HOST_UID] !== context.host.uid ||
        deployment.metadata.name !== context.host.name
      )
        throw new Error('SourceDeploymentUnverified')
      return deployment
    } catch (error) {
      if (getErrorCode(error) === 404) return undefined
      throw error
    }
  }
  private async sourcePods(context: ConversationStoreOperatorContext): Promise<k8s.V1Pod[]> {
    const deployment = await this.readDeployment(context)
    if (!deployment) return []
    const [replicaSets, pods] = await Promise.all([
      this.deps.appsApi.listNamespacedReplicaSet({
        namespace: context.host.namespace,
        labelSelector: `app=${context.host.name}`,
      }),
      this.deps.coreApi.listNamespacedPod({
        namespace: context.host.namespace,
        labelSelector: `app=${context.host.name}`,
      }),
    ])
    const chain = resolveConversationStoreOwnerChain({
      hostUid: context.host.uid!,
      deployment,
      replicaSets: replicaSets.items,
      pods: pods.items,
    })
    if (!chain.ok) throw new Error('SourceOwnerChainUnverified')
    return chain.pods.map(entry => entry.pod)
  }
  private async executeProgram(
    namespace: string,
    pod: string,
    container: string,
    program: string,
    args: string[]
  ): Promise<string> {
    if (this.deps.execProgram)
      return this.deps.execProgram(namespace, pod, container, program, args)
    const exec = new k8s.Exec(this.deps.kubeConfig)
    const output = new PassThrough()
    const errors = new PassThrough()
    const chunks: Buffer[] = []
    let size = 0
    let overflow = false
    output.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size <= 32768) chunks.push(chunk)
      else overflow = true
    })
    // Diagnostic stderr is never an authorization channel and is not logged.
    errors.resume()
    return new Promise<string>((resolve, reject) => {
      let socket: Awaited<ReturnType<k8s.Exec['exec']>> | undefined
      let settled = false
      const finish = (error?: Error): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        socket?.close()
        if (error || overflow) reject(error ?? new Error('BootstrapOutcomeTooLarge'))
        else resolve(Buffer.concat(chunks).toString('utf8'))
      }
      const timer = setTimeout(() => finish(new Error('BootstrapVerificationDeadline')), 30000)
      void exec
        .exec(
          namespace,
          pod,
          container,
          ['node', '--input-type=module', '-', ...args],
          output,
          errors,
          Readable.from([program]),
          false,
          status => {
            if (status.status !== 'Success') finish(new Error('BootstrapVerificationFailed'))
            else finish()
          }
        )
        .then(value => {
          socket = value
          if (settled) value.close()
        })
        .catch(() => finish(new Error('BootstrapVerificationUnavailable')))
    })
  }
  async verifyStoppedWriter(
    context: ConversationStoreOperatorContext,
    request: ConversationStoreRequest
  ): Promise<
    { verified: true; proof: ConversationStoreWriterProof } | { verified: false; reason: string }
  > {
    if (
      request.sourceClass !== 'sqlite-external-exported' ||
      !request.exportId ||
      !request.manifestHash
    ) {
      return { verified: false, reason: 'VerifiedBootstrapExportRequired' }
    }
    await this.requireCurrent(context, request)
    const pods = (await this.sourcePods(context)).filter(
      pod => !pod.metadata?.deletionTimestamp && pod.status?.phase === 'Running'
    )
    if (pods.length !== 1) return { verified: false, reason: 'SourceWriterIdentityUnknown' }
    const pod = pods[0]
    const container = pod.spec?.containers?.find(value => value.name === 'mcp-host')
    const status = pod.status?.containerStatuses?.find(value => value.name === 'mcp-host')
    const volume = pod.spec?.volumes?.find(value => value.name === 'workspace')
    const rootMount = container?.volumeMounts?.find(
      value => value.name === 'workspace' && !value.subPath && !value.readOnly
    )
    // A legacy off-PVC process cannot disappear before its filesystem is exported.
    // This verifier executes inside that exact still-running Pod and never stops it.
    if (
      !pod.metadata?.uid ||
      !pod.metadata.resourceVersion ||
      !pod.metadata.name ||
      !pod.spec?.nodeName ||
      !container?.image ||
      !status?.imageID ||
      !status.state?.running ||
      volume?.persistentVolumeClaim?.claimName !== context.pvcName ||
      !rootMount
    ) {
      return { verified: false, reason: 'SourceWriterIdentityUnknown' }
    }
    let raw: string
    try {
      raw = await this.executeProgram(
        context.host.namespace,
        pod.metadata.name,
        'mcp-host',
        CONVERSATION_STORE_BOOTSTRAP_VERIFY_PROGRAM,
        [
          '--host-name',
          context.host.name,
          '--namespace',
          context.host.namespace,
          '--host-uid',
          request.hostUid,
          '--pvc-uid',
          request.pvcUid,
          '--pod-uid',
          pod.metadata.uid,
          '--request-id',
          request.requestId,
          '--maintenance-id',
          request.maintenanceId,
          '--export-id',
          request.exportId,
          '--manifest-hash',
          request.manifestHash,
          '--root',
          rootMount.mountPath,
        ]
      )
    } catch {
      return { verified: false, reason: 'BootstrapVerificationUnavailable' }
    }
    let parsed: Record<string, unknown> | undefined
    try {
      parsed = record(JSON.parse(raw.trim()))
    } catch {
      return { verified: false, reason: 'BootstrapOutcomeInvalid' }
    }
    if (
      !parsed ||
      parsed.proofVersion !== 1 ||
      parsed.outcome !== 'ok' ||
      !sameBinding(parsed, request) ||
      parsed.sourcePodUid !== pod.metadata.uid ||
      parsed.requestId !== request.requestId ||
      parsed.exportId !== request.exportId ||
      parsed.manifestHash !== request.manifestHash ||
      typeof parsed.sourceSnapshotHash !== 'string' ||
      !/^[0-9a-f]{64}$/.test(parsed.sourceSnapshotHash)
    )
      return { verified: false, reason: 'BootstrapEvidenceMismatch' }
    const freshPod = await this.deps.coreApi.readNamespacedPod({
      namespace: context.host.namespace,
      name: pod.metadata.name,
    })
    const freshStatus = freshPod.status?.containerStatuses?.find(value => value.name === 'mcp-host')
    if (
      freshPod.metadata?.uid !== pod.metadata.uid ||
      freshPod.metadata.deletionTimestamp ||
      freshStatus?.imageID !== status.imageID ||
      freshStatus?.restartCount !== status.restartCount ||
      !freshStatus?.state?.running
    ) {
      return { verified: false, reason: 'SourceWriterChanged' }
    }
    await this.requireCurrent(context, request)
    return {
      verified: true,
      proof: {
        storageContract: request.storageContract,
        hostUid: request.hostUid,
        pvcUid: request.pvcUid,
        maintenanceId: request.maintenanceId,
        sourcePodUid: pod.metadata.uid,
        sourceImageId: status.imageID,
        sourceRestartCount: status.restartCount,
        nodeName: pod.spec.nodeName,
        exportId: request.exportId,
        manifestHash: request.manifestHash,
        sourceSnapshotHash: parsed.sourceSnapshotHash,
        verifiedAt: this.now().toISOString(),
      },
    }
  }
  async stopLegacyDeployment(
    context: ConversationStoreOperatorContext,
    request: ConversationStoreRequest,
    proof: ConversationStoreWriterProof
  ): Promise<void> {
    await this.requireCurrent(context, request)
    const deployment = await this.readDeployment(context)
    if (!deployment || (deployment.spec?.replicas ?? 1) === 0) return
    // Revalidate kernel/supervisor proof after the potentially long read-only Job.
    const stopped = await this.verifyStoppedWriter(context, {
      ...request,
      sourceClass: 'sqlite-external-exported',
      exportId: proof.exportId,
      manifestHash: proof.manifestHash,
    })
    if (
      !stopped.verified ||
      stopped.proof.sourcePodUid !== proof.sourcePodUid ||
      stopped.proof.sourceImageId !== proof.sourceImageId ||
      stopped.proof.sourceRestartCount !== proof.sourceRestartCount ||
      stopped.proof.sourceSnapshotHash !== proof.sourceSnapshotHash
    )
      throw new Error('SourceWriterChanged')
    await this.requireCurrent(context, request)
    // source/export verification precedes this first destructive source transition.
    await replaceWithConflictRetry({
      description: `Source Deployment ${context.host.name}`,
      logPrefix: '[ConversationStoreOperator]',
      read: () =>
        this.deps.appsApi.readNamespacedDeployment({
          namespace: context.host.namespace,
          name: context.host.name,
        }),
      resolveBody: async () => {
        await this.requireCurrent(context, request)
        const current = await this.readDeployment(context)
        if (!current || current.metadata?.uid !== deployment.metadata?.uid)
          throw new Error('SourceDeploymentChanged')
        const rechecked = await this.verifyStoppedWriter(context, {
          ...request,
          sourceClass: 'sqlite-external-exported',
          exportId: proof.exportId,
          manifestHash: proof.manifestHash,
        })
        if (
          !rechecked.verified ||
          rechecked.proof.sourcePodUid !== proof.sourcePodUid ||
          rechecked.proof.sourceImageId !== proof.sourceImageId ||
          rechecked.proof.sourceRestartCount !== proof.sourceRestartCount ||
          rechecked.proof.sourceSnapshotHash !== proof.sourceSnapshotHash
        )
          throw new Error('SourceWriterChanged')
        return { ...current, spec: { ...current.spec!, replicas: 0 } }
      },
      mergeExisting: (desired, existing) => ({
        ...existing,
        spec: { ...existing.spec!, replicas: desired.spec!.replicas },
      }),
      isUpToDate: deploymentMatchesDesired,
      validateExisting: existing => {
        if (
          existing.metadata?.uid !== deployment.metadata?.uid ||
          existing.metadata?.annotations?.[HOST_UID] !== request.hostUid
        )
          throw new Error('SourceDeploymentChanged')
      },
      missingIsError: true,
      replace: async body => {
        await this.requireCurrent(context, request)
        return this.deps.appsApi.replaceNamespacedDeployment({
          namespace: context.host.namespace,
          name: context.host.name,
          body,
        })
      },
    })
  }
  private job(
    context: ConversationStoreOperatorContext,
    request: ConversationStoreRequest,
    phase: 'preparation' | 'migrate' | 'layout-precheck' | 'adopt' | 'current',
    proof?: ConversationStoreWriterProof
  ): k8s.V1Job {
    const name = `cs-${hash([request.hostUid, request.requestId, phase]).slice(0, 36)}`
    const readOnly = phase === 'preparation'
    const command =
      phase === 'preparation'
        ? 'verify-preparation'
        : phase === 'current'
          ? 'verify-current'
          : phase
    const args = [
      CANONICAL_STORE_CLI_PATH,
      command,
      '--root',
      WORKSPACE_PVC_ROOT_MOUNT_PATH,
      '--host-uid',
      request.hostUid,
      '--pvc-uid',
      request.pvcUid,
      '--maintenance-id',
      request.maintenanceId,
      '--request-id',
      request.requestId,
      '--controller-uid',
      request.hostUid,
      '--storage-contract',
      request.storageContract,
      ...(phase === 'current' ? ['--operation', request.operation] : []),
      ...(phase === 'preparation' || phase === 'current' ? ['--scratch-root', SCRATCH_ROOT] : []),
      ...(readOnly
        ? [
            '--source-class',
            request.sourceClass!,
            ...(request.manifestHash ? ['--manifest-hash', request.manifestHash] : []),
            ...(request.exportId ? ['--export-id', request.exportId] : []),
          ]
        : []),
      ...((phase === 'migrate' || phase === 'layout-precheck') && request.sourceClass === 'new-host'
        ? ['--provenance', 'new-host']
        : []),
    ]
    const annotations = {
      [HOST_UID]: request.hostUid,
      [REQUEST_ID]: request.requestId,
      [REQUEST_HASH]: computeConversationStoreRequestHash(request),
      'clerum.io/conversation-store-template-revision': context.templateRevision,
      [CONTRACT]: hash({
        storageContract: request.storageContract,
        requestHash: computeConversationStoreRequestHash(request),
        image: context.image,
        templateRevision: context.templateRevision,
        pvcUid: context.pvcUid,
        phase,
        args,
        writer: proof
          ? [
              proof.sourcePodUid,
              proof.sourceImageId,
              proof.sourceRestartCount,
              proof.sourceSnapshotHash,
            ]
          : null,
      }),
    }
    return {
      apiVersion: 'batch/v1',
      kind: 'Job',
      metadata: {
        name,
        namespace: context.host.namespace,
        annotations,
        labels: {
          'app.kubernetes.io/managed-by': 'host-context-controller',
          'clerum.io/conversation-store-operator': name,
        },
        ownerReferences: [
          {
            apiVersion: 'clerum.io/v1alpha1',
            kind: 'Host',
            name: context.host.name,
            uid: request.hostUid,
            controller: true,
          },
        ],
      },
      spec: {
        backoffLimit: 0,
        activeDeadlineSeconds: DEADLINE_SECONDS,
        template: {
          metadata: { annotations, labels: { 'clerum.io/conversation-store-operator': name } },
          spec: {
            restartPolicy: 'Never',
            serviceAccountName: name,
            ...(proof ? { nodeName: proof.nodeName } : {}),
            imagePullSecrets: this.deps.imagePullSecrets,
            securityContext: {
              runAsNonRoot: true,
              runAsUser: 1001,
              runAsGroup: 1001,
              fsGroup: 1001,
            },
            containers: [
              {
                name: CONTAINER,
                image: context.image,
                imagePullPolicy: 'IfNotPresent',
                command: [
                  '/bin/sh',
                  '-ec',
                  'exec node "$@" --capability-id "$CLERUM_CANONICAL_OPERATOR_CAPABILITY_ID" > /dev/termination-log',
                ],
                args: ['canonical-store', ...args],
                env: [
                  { name: 'CLERUM_HOST_NAME', value: context.host.name },
                  { name: 'CLERUM_HOST_NAMESPACE', value: context.host.namespace },
                  { name: 'CLERUM_HOST_UID', value: request.hostUid },
                  { name: 'CLERUM_PVC_UID', value: request.pvcUid },
                  { name: 'CLERUM_CANONICAL_OPERATOR_JOB', value: name },
                  { name: 'CLERUM_CANONICAL_OPERATOR_REQUEST_ID', value: request.requestId },
                  {
                    name: 'CLERUM_CANONICAL_OPERATOR_REQUEST_HASH',
                    value: computeConversationStoreRequestHash(request),
                  },
                  { name: 'CLERUM_CANONICAL_STORE_CONTRACT', value: request.storageContract },
                  {
                    name: 'CLERUM_CANONICAL_POD_UID',
                    valueFrom: { fieldRef: { fieldPath: 'metadata.uid' } },
                  },
                  {
                    name: 'CLERUM_CANONICAL_OPERATOR_CAPABILITY_ID',
                    valueFrom: {
                      fieldRef: {
                        fieldPath: "metadata.labels['batch.kubernetes.io/controller-uid']",
                      },
                    },
                  },
                ],
                terminationMessagePolicy: 'File',
                terminationMessagePath: '/dev/termination-log',
                securityContext: {
                  allowPrivilegeEscalation: false,
                  readOnlyRootFilesystem: true,
                  capabilities: { drop: ['ALL'] },
                },
                resources: {
                  requests: { cpu: '100m', memory: '128Mi' },
                  limits: { cpu: '1', memory: '512Mi' },
                },
                volumeMounts: [
                  { name: 'workspace', mountPath: WORKSPACE_PVC_ROOT_MOUNT_PATH, readOnly },
                  { name: 'scratch', mountPath: SCRATCH_ROOT },
                  { name: 'tmp', mountPath: '/tmp' },
                ],
              },
            ],
            volumes: [
              {
                name: 'workspace',
                persistentVolumeClaim: { claimName: context.pvcName, readOnly },
              },
              { name: 'scratch', emptyDir: { sizeLimit: '64Gi' } },
              { name: 'tmp', emptyDir: { sizeLimit: '16Mi' } },
            ],
          },
        },
      },
    }
  }
  private async ensureIdentity(
    context: ConversationStoreOperatorContext,
    job: k8s.V1Job,
    podNames: string[]
  ): Promise<void> {
    const name = job.metadata!.name!,
      namespace = context.host.namespace
    const metadata = {
      name,
      namespace,
      ownerReferences: job.metadata!.ownerReferences,
      annotations: job.metadata!.annotations,
    }
    const role: k8s.V1Role = {
      apiVersion: 'rbac.authorization.k8s.io/v1',
      kind: 'Role',
      metadata,
      rules: [
        {
          apiGroups: ['clerum.io'],
          resources: ['hosts'],
          resourceNames: [context.host.name],
          verbs: ['get'],
        },
        {
          apiGroups: ['batch'],
          resources: ['jobs'],
          resourceNames: [
            ...new Set(
              [
                name,
                context.host.status?.conversationStore?.operationOutcome?.jobName,
                context.host.status?.conversationStore?.preparation?.verificationJobName,
              ].filter((value): value is string => !!value)
            ),
          ],
          verbs: ['get'],
        },
        {
          apiGroups: [''],
          resources: ['persistentvolumeclaims'],
          resourceNames: [context.pvcName],
          verbs: ['get'],
        },
        ...(podNames.length
          ? [{ apiGroups: [''], resources: ['pods'], resourceNames: podNames, verbs: ['get'] }]
          : []),
      ],
    }
    for (const [read, create, replace, desired] of [
      [
        () => this.deps.coreApi.readNamespacedServiceAccount({ namespace, name }),
        () =>
          observeCreate('ServiceAccount', () =>
            this.deps.coreApi.createNamespacedServiceAccount({
              namespace,
              body: { apiVersion: 'v1', kind: 'ServiceAccount', metadata },
            })
          ),
        undefined,
        { apiVersion: 'v1', kind: 'ServiceAccount', metadata },
      ],
      [
        () => this.deps.rbacApi.readNamespacedRole({ namespace, name }),
        () =>
          observeCreate('Role', () =>
            this.deps.rbacApi.createNamespacedRole({ namespace, body: role })
          ),
        (body: k8s.V1Role) => this.deps.rbacApi.replaceNamespacedRole({ namespace, name, body }),
        role,
      ],
      [
        () => this.deps.rbacApi.readNamespacedRoleBinding({ namespace, name }),
        () =>
          observeCreate('RoleBinding', () =>
            this.deps.rbacApi.createNamespacedRoleBinding({
              namespace,
              body: {
                apiVersion: 'rbac.authorization.k8s.io/v1',
                kind: 'RoleBinding',
                metadata,
                roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'Role', name },
                subjects: [{ kind: 'ServiceAccount', name, namespace }],
              },
            })
          ),
        undefined,
        { apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'RoleBinding', metadata },
      ],
    ] as Array<
      [() => Promise<any>, () => Promise<any>, ((body: any) => Promise<any>) | undefined, any]
    >) {
      let existing
      try {
        existing = await read()
      } catch (error) {
        if (getErrorCode(error) !== 404) throw error
      }
      if (!existing) {
        await create()
        continue
      }
      if (
        !controlledBy(existing, context.host.uid!) ||
        existing.metadata?.annotations?.[CONTRACT] !== job.metadata!.annotations![CONTRACT]
      )
        throw new Error('OperatorIdentityConflict')
      if (
        replace &&
        (podNames.length > 0 ||
          !existing.rules?.some((rule: k8s.V1PolicyRule) => rule.resources?.includes('pods'))) &&
        !isDeepStrictEqual(existing.rules, desired.rules)
      )
        await replace({
          ...desired,
          metadata: { ...desired.metadata, resourceVersion: existing.metadata.resourceVersion },
        })
      if (
        existing.kind === 'RoleBinding' &&
        (existing.roleRef?.name !== name ||
          existing.subjects?.length !== 1 ||
          existing.subjects[0].name !== name ||
          existing.subjects[0].namespace !== namespace)
      )
        throw new Error('OperatorIdentityConflict')
    }
  }
  private podContainersTerminated(pod: k8s.V1Pod): boolean {
    if (!['Succeeded', 'Failed'].includes(pod.status?.phase ?? '') || !pod.spec?.containers?.length)
      return false
    return [
      { containers: pod.spec.containers, statuses: pod.status?.containerStatuses ?? [] },
      {
        containers: pod.spec.initContainers ?? [],
        statuses: pod.status?.initContainerStatuses ?? [],
      },
      {
        containers: pod.spec.ephemeralContainers ?? [],
        statuses: pod.status?.ephemeralContainerStatuses ?? [],
      },
    ].every(({ containers, statuses }) => {
      if (!containers || !statuses || containers.length !== statuses.length) return false
      const names = containers.map(container => container.name)
      if (
        new Set(names).size !== names.length ||
        new Set(statuses.map(status => status.name)).size !== names.length
      )
        return false
      return statuses.every(
        status =>
          names.includes(status.name) &&
          !!status.state?.terminated &&
          Object.keys(status.state).length === 1
      )
    })
  }
  private async requireNoLegacyWriter(
    context: ConversationStoreOperatorContext,
    proof?: ConversationStoreWriterProof
  ): Promise<boolean> {
    const deployment = await this.readDeployment(context)
    if (deployment && (deployment.spec?.replicas ?? 1) !== 0)
      throw new Error('LegacyWriterNotFenced')
    const pods = await this.deps.coreApi.listNamespacedPod({ namespace: context.host.namespace })
    let sourcePending = false
    for (const pod of pods.items) {
      if (
        !pod.spec?.volumes?.some(
          volume => volume.persistentVolumeClaim?.claimName === context.pvcName
        )
      ) {
        if (proof && pod.metadata?.uid === proof.sourcePodUid)
          throw new Error('SourceWriterChanged')
        continue
      }
      const owner = pod.metadata?.ownerReferences?.find(
        value => value.controller && value.kind === 'Job'
      )
      if (
        owner &&
        pod.metadata?.annotations?.[HOST_UID] === context.host.uid &&
        pod.metadata?.labels?.['clerum.io/conversation-store-operator']
      ) {
        const helper = await this.deps
          .batchApi()
          .readNamespacedJob({ namespace: context.host.namespace, name: owner.name })
        if (
          helper.metadata?.uid !== owner.uid ||
          !controlledBy(helper, context.host.uid!) ||
          helper.metadata?.annotations?.[REQUEST_ID] !== pod.metadata?.annotations?.[REQUEST_ID]
        )
          throw new Error('UnverifiedPvcWriterPresent')
        const pvc = pod.spec.volumes?.find(
          value => value.persistentVolumeClaim?.claimName === context.pvcName
        )?.persistentVolumeClaim
        const ended = this.podContainersTerminated(pod)
        const ownExecution =
          context.host.status?.conversationStore?.execution?.jobUid === helper.metadata.uid
        if (pvc?.readOnly || ended || ownExecution) continue
        throw new Error('OperatorConcurrentWriter')
      }
      if (
        proof &&
        pod.metadata?.uid === proof.sourcePodUid &&
        !!pod.metadata.resourceVersion &&
        pod.spec?.nodeName === proof.nodeName &&
        pod.status?.containerStatuses?.find(value => value.name === 'mcp-host')?.imageID ===
          proof.sourceImageId &&
        pod.status?.containerStatuses?.find(value => value.name === 'mcp-host')?.restartCount ===
          proof.sourceRestartCount
      ) {
        // The closure report and a zero replica count precede source deletion.
        // Only native terminal states or absence stop the old process from reopening SQLite.
        if (!this.podContainersTerminated(pod)) sourcePending = true
        continue
      }
      throw new Error('UnverifiedPvcWriterPresent')
    }
    return !sourcePending
  }
  async execute(
    context: ConversationStoreOperatorContext,
    request: ConversationStoreRequest,
    phase: 'preparation' | 'migrate' | 'layout-precheck' | 'adopt' | 'current',
    writerProof?: ConversationStoreWriterProof
  ): Promise<ConversationStoreExecution> {
    await this.requireCurrent(context, request)
    if (phase !== 'preparation' && !(await this.requireNoLegacyWriter(context, writerProof)))
      return { state: 'pending' }
    const desired = this.job(context, request, phase, writerProof)
    const name = desired.metadata!.name!,
      namespace = context.host.namespace
    await this.ensureIdentity(context, desired, [])
    let job: k8s.V1Job | undefined
    try {
      job = await this.deps.batchApi().readNamespacedJob({ namespace, name })
    } catch (error) {
      if (getErrorCode(error) !== 404) throw error
    }
    if (!job) {
      await this.requireCurrent(context, request)
      // Identity provisioning and Job lookup may await API calls. Reobserve source closure
      // immediately before admitting a new writable helper.
      if (phase !== 'preparation' && !(await this.requireNoLegacyWriter(context, writerProof)))
        return { state: 'pending' }
      job = await observeCreate('Job', () =>
        this.deps.batchApi().createNamespacedJob({ namespace, body: desired })
      )
    }
    if (
      !job.metadata?.uid ||
      !job.metadata.resourceVersion ||
      job.metadata.deletionTimestamp ||
      job.metadata.name !== name ||
      job.metadata.ownerReferences?.length !== 1 ||
      job.metadata.ownerReferences[0].kind !== 'Host' ||
      job.metadata.ownerReferences[0].name !== context.host.name ||
      !controlledBy(job, request.hostUid) ||
      job.metadata.annotations?.[CONTRACT] !== desired.metadata!.annotations![CONTRACT] ||
      job.metadata.annotations?.[REQUEST_ID] !== request.requestId ||
      job.metadata.annotations?.[REQUEST_HASH] !== computeConversationStoreRequestHash(request) ||
      !isDeepStrictEqual(
        job.spec?.template?.spec?.containers?.[0]?.args,
        desired.spec!.template.spec!.containers![0].args
      ) ||
      job.spec?.template?.spec?.containers?.[0]?.image !== context.image
    )
      return { state: 'blocked', reason: 'OperatorJobConflict' }
    const execution = context.host.status?.conversationStore?.execution
    if (
      execution?.jobUid !== job.metadata.uid ||
      execution.phase !== phase ||
      execution.storageContract !== request.storageContract ||
      execution.requestHash !== computeConversationStoreRequestHash(request)
    ) {
      context.host = await this.writeStatus(context, request, {
        execution: {
          storageContract: request.storageContract,
          requestHash: computeConversationStoreRequestHash(request),
          requestId: request.requestId,
          hostUid: request.hostUid,
          pvcUid: request.pvcUid,
          maintenanceId: request.maintenanceId,
          jobName: name,
          jobUid: job.metadata.uid,
          image: context.image,
          templateRevision: context.templateRevision,
          phase,
          operation: request.operation as 'prepare' | 'adopt' | 'release',
          createdAt: this.now().toISOString(),
        },
      })
    }
    const pods = await this.deps.coreApi.listNamespacedPod({
      namespace,
      labelSelector: `batch.kubernetes.io/job-name=${name}`,
    })
    const owned = pods.items.filter(
      pod => controlledBy(pod, job!.metadata!.uid!) && pod.metadata?.uid && pod.metadata.name
    )
    if (owned.length > 1) return { state: 'blocked', reason: 'OperatorJobPodConflict' }
    await this.ensureIdentity(
      context,
      desired,
      owned.map(pod => pod.metadata!.name!)
    )
    const failed = job.status?.conditions?.some(
      condition => condition.type === 'Failed' && condition.status === 'True'
    )
    if (!owned.length)
      return failed ? { state: 'blocked', reason: 'OperatorJobFailed' } : { state: 'pending' }
    const pod = owned[0],
      expected = desired.spec!.template.spec!,
      spec = pod.spec
    const container = spec?.containers?.find(value => value.name === CONTAINER)
    const status = pod.status?.containerStatuses?.find(value => value.name === CONTAINER)
    const expectedContainer = expected.containers![0]
    if (
      !container ||
      spec?.containers?.length !== 1 ||
      (spec.initContainers?.length ?? 0) !== 0 ||
      pod.metadata?.deletionTimestamp ||
      pod.metadata?.annotations?.[CONTRACT] !== desired.metadata!.annotations![CONTRACT] ||
      spec?.serviceAccountName !== name ||
      container?.image !== context.image ||
      !conversationStoreInitBindingMatches(container!, request.hostUid, request.pvcUid) ||
      !isDeepStrictEqual(container?.env, expectedContainer.env) ||
      !isDeepStrictEqual(container?.command, expectedContainer.command) ||
      !isDeepStrictEqual(container?.args, expectedContainer.args) ||
      !isDeepStrictEqual(
        spec?.volumes?.find(value => value.name === 'workspace')?.persistentVolumeClaim,
        expected.volumes![0].persistentVolumeClaim
      ) ||
      !isDeepStrictEqual(container?.volumeMounts, expectedContainer.volumeMounts)
    )
      return { state: 'blocked', reason: 'OperatorPodBindingMismatch' }
    const terminated = status?.state?.terminated
    if (!terminated)
      return failed ? { state: 'blocked', reason: 'OperatorJobFailed' } : { state: 'pending' }
    // OCI manifest digests and CRI image IDs describe different artifacts. The
    // admitted immutable Pod image reference is the authority; retain the CRI
    // identity as separate native provenance rather than inventing suffix equality.
    if (
      status!.restartCount !== 0 ||
      !terminated.finishedAt ||
      !status!.imageID ||
      !/(?:^|[@/:])sha256:[0-9a-f]{64}$/.test(status!.imageID) ||
      !/@sha256:[0-9a-f]{64}$/.test(context.image)
    ) {
      return { state: 'blocked', reason: 'OperatorAttemptIdentityMismatch' }
    }
    const measuredExecution = context.host.status?.conversationStore?.execution
    if (!measuredExecution || measuredExecution.jobUid !== job.metadata.uid)
      return { state: 'blocked', reason: 'OperatorExecutionIdentityMissing' }
    if (measuredExecution.resolvedImageId !== status!.imageID) {
      context.host = await this.writeStatus(context, request, {
        execution: {
          ...measuredExecution,
          resolvedImageId: status!.imageID,
          imageProvenance: 'pod-immutable-reference',
        },
      })
    }
    const verified = verifyConversationStoreInitOutcome(terminated.message, terminated.exitCode)
    if (!verified.valid || !verified.parsed) return { state: 'blocked', reason: verified.reason }
    if (verified.parsed.outcome !== 'ok')
      return { state: 'blocked', reason: verified.parsed.reason }
    await this.requireCurrent(context, request)
    const freshPod = await this.deps.coreApi.readNamespacedPod({
      namespace,
      name: pod.metadata!.name!,
    })
    const freshJob = await this.deps.batchApi().readNamespacedJob({ namespace, name })
    const freshTerminated = freshPod.status?.containerStatuses?.find(
      value => value.name === CONTAINER
    )?.state?.terminated
    if (
      freshPod.metadata?.uid !== pod.metadata?.uid ||
      !freshPod.metadata?.resourceVersion ||
      freshPod.metadata?.deletionTimestamp ||
      freshJob.metadata?.uid !== job.metadata.uid ||
      !freshJob.metadata.resourceVersion ||
      freshJob.metadata.deletionTimestamp ||
      !controlledBy(freshPod, job.metadata.uid) ||
      freshPod.status?.containerStatuses?.find(value => value.name === CONTAINER)?.imageID !==
        status!.imageID ||
      freshPod.spec?.containers?.find(value => value.name === CONTAINER)?.image !== context.image ||
      !isDeepStrictEqual(freshTerminated, terminated)
    ) {
      return { state: 'blocked', reason: 'OperatorEvidenceStale' }
    }
    if ((freshJob.status?.succeeded ?? 0) !== 1) return { state: 'pending' }
    if (verified.parsed.storageContract !== request.storageContract && phase !== 'preparation')
      return { state: 'blocked', reason: 'OperatorOutcomeMismatch' }
    if (phase === 'preparation' || phase === 'current') {
      let proof: Record<string, unknown> | undefined
      try {
        proof = record(JSON.parse(terminated.message!))
      } catch {
        return { state: 'blocked', reason: 'OperatorOutcomeMismatch' }
      }
      if (
        !proof ||
        proof.proofVersion !== 1 ||
        !sameBinding(proof, request) ||
        proof.requestId !== request.requestId ||
        proof.requestHash !== computeConversationStoreRequestHash(request) ||
        proof.controllerUid !== request.hostUid ||
        proof.capabilityId !== job.metadata.uid
      ) {
        return { state: 'blocked', reason: 'OperatorEvidenceBindingMismatch' }
      }
      return {
        state: 'succeeded',
        outcome: verified.parsed,
        proof: proof as unknown as ConversationStorePhysicalProof,
      }
    }
    return { state: 'succeeded', outcome: verified.parsed }
  }
}
