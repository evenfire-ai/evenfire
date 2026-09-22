import * as k8s from '@kubernetes/client-node'
import type { GfsK8sApi } from '../gfsReconciler'
import { createsTotal } from '../metrics'
import type { GlobalFileSystemStatus } from '../types'
import {
  type ResourceApplyResult,
  applyNetworkPolicy,
  deploymentMatchesDesired,
  ensureResource,
  getErrorCode,
  observeCreate,
  observeExistenceRead,
  podDisruptionBudgetMatchesDesired,
  preserveObjectAnnotations,
  replaceWithConflictRetry,
} from '../utils'
import { GFS_TEMPLATE_HASH_ANNOTATION } from './gfsFactory'

/** Live-only pod-template key kubectl stamps on `rollout restart`. */
const RESTARTED_AT_ANNOTATION = 'kubectl.kubernetes.io/restartedAt'

const GROUP = 'clerum.io'
const VERSION = 'v1alpha1'
const PLURAL = 'globalfilesystems'
const LOG = '[gfsReconciler]'

/**
 * Object annotations stay fully merged so last-applied-configuration and
 * deployment.kubernetes.io/revision do not churn the no-op gate. Pod-template
 * annotations keep what the builder authored, plus restartedAt. Any other
 * live-only template key is dropped so a foreign annotation cannot stick
 * across a skipped replace.
 */
function preserveGfsDeploymentAnnotations(
  desired: k8s.V1Deployment,
  existing: k8s.V1Deployment
): k8s.V1Deployment {
  const objectPreserved = preserveObjectAnnotations(desired, existing)
  const templateAnnotations: Record<string, string> = {
    ...(desired.spec?.template?.metadata?.annotations ?? {}),
  }
  const restartedAt = existing.spec?.template?.metadata?.annotations?.[RESTARTED_AT_ANNOTATION]
  if (restartedAt !== undefined && templateAnnotations[RESTARTED_AT_ANNOTATION] === undefined) {
    templateAnnotations[RESTARTED_AT_ANNOTATION] = restartedAt
  }
  return {
    ...objectPreserved,
    spec: {
      ...objectPreserved.spec,
      template: {
        ...objectPreserved.spec?.template,
        metadata: {
          ...objectPreserved.spec?.template?.metadata,
          annotations:
            Object.keys(templateAnnotations).length > 0 ? templateAnnotations : undefined,
        },
      },
    },
  }
}

/**
 * Real Kubernetes adapter for the gfs reconciler. Wraps @kubernetes/client-node
 * with the same create-or-replace / idempotent-delete conventions the
 * SharedFileSystem reconciler uses. The reconcile LOGIC lives in GfsReconciler
 * (unit-tested against the GfsK8sApi interface); this class is the thin cluster
 * binding wired in k8sClient.
 */
export class K8sGfsApi implements GfsK8sApi {
  constructor(
    private readonly coreApi: k8s.CoreV1Api,
    private readonly appsApi: k8s.AppsV1Api,
    private readonly networkingApi: k8s.NetworkingV1Api,
    private readonly policyApi: k8s.PolicyV1Api,
    private readonly customApi: k8s.CustomObjectsApi
  ) {}

  private async ignoreNotFound(fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn()
    } catch (err) {
      // A delete of an already-absent resource is a successful idempotent
      // teardown — anything other than 404 is a real failure and propagates.
      if (getErrorCode(err) !== 404) throw err
    }
  }

  async applyPvc(
    pvc: k8s.V1PersistentVolumeClaim,
    namespace: string
  ): Promise<ResourceApplyResult> {
    const name = pvc.metadata?.name ?? ''
    return ensureResource<k8s.V1PersistentVolumeClaim>({
      read: () =>
        observeExistenceRead('PersistentVolumeClaim', () =>
          this.coreApi.readNamespacedPersistentVolumeClaim({ name, namespace })
        ),
      create: () =>
        observeCreate('PersistentVolumeClaim', () =>
          this.coreApi.createNamespacedPersistentVolumeClaim({ namespace, body: pvc })
        ),
      onSkipped: () => createsTotal.inc({ kind: 'PersistentVolumeClaim', outcome: 'skipped' }),
      // Bound PVCs stay unchanged. A create conflict must consume a fresh read;
      // disappearance remains benign, while permission/transport failures propagate.
      converge: read => this.ignoreNotFound(read),
    })
  }

  async deploymentNeedsUpdate(dep: k8s.V1Deployment, namespace: string): Promise<boolean> {
    const name = dep.metadata?.name ?? ''
    const desired = dep.metadata?.annotations?.[GFS_TEMPLATE_HASH_ANNOTATION]
    try {
      const existing = await observeExistenceRead('Deployment', () =>
        this.appsApi.readNamespacedDeployment({ name, namespace })
      )
      const current = existing.metadata?.annotations?.[GFS_TEMPLATE_HASH_ANNOTATION]
      return !desired || current !== desired
    } catch (err) {
      if (getErrorCode(err) === 404) return true
      throw err
    }
  }

  async scaleDeployment(
    name: string,
    namespace: string,
    replicas: number
  ): Promise<ResourceApplyResult> {
    let existing: k8s.V1Deployment
    try {
      existing = await this.appsApi.readNamespacedDeployment({ name, namespace })
    } catch (err) {
      if (getErrorCode(err) === 404) return 'missing'
      throw err
    }
    if ((existing.spec?.replicas ?? 0) === replicas) return 'up_to_date'

    return replaceWithConflictRetry<k8s.V1Deployment>({
      description: `deployment "${name}" scale in ${namespace}`,
      logPrefix: LOG,
      body: existing,
      read: () => this.appsApi.readNamespacedDeployment({ name, namespace }),
      replace: body => this.appsApi.replaceNamespacedDeployment({ name, namespace, body }),
      mergeExisting: (_body, fresh) => {
        if (!fresh.spec) {
          throw new Error(`deployment "${name}" in ${namespace} is missing spec`)
        }
        return {
          ...fresh,
          spec: { ...fresh.spec, replicas },
        }
      },
    })
  }

  async applyDeployment(dep: k8s.V1Deployment, namespace: string): Promise<ResourceApplyResult> {
    const name = dep.metadata?.name ?? ''
    return ensureResource<k8s.V1Deployment>({
      read: () =>
        observeExistenceRead('Deployment', () =>
          this.appsApi.readNamespacedDeployment({ name, namespace })
        ),
      create: () =>
        observeCreate('Deployment', () =>
          this.appsApi.createNamespacedDeployment({ namespace, body: dep })
        ),
      onSkipped: () => createsTotal.inc({ kind: 'Deployment', outcome: 'skipped' }),
      converge: read =>
        replaceWithConflictRetry<k8s.V1Deployment>({
          description: `deployment "${name}" in ${namespace}`,
          logPrefix: LOG,
          body: dep,
          read,
          replace: body => this.appsApi.replaceNamespacedDeployment({ name, namespace, body }),
          mergeExisting: preserveGfsDeploymentAnnotations,
          isUpToDate: deploymentMatchesDesired,
        }),
    })
  }

  async applyPodDisruptionBudget(
    pdb: k8s.V1PodDisruptionBudget,
    namespace: string
  ): Promise<ResourceApplyResult> {
    const name = pdb.metadata?.name ?? ''
    return ensureResource<k8s.V1PodDisruptionBudget>({
      read: () =>
        observeExistenceRead('PodDisruptionBudget', () =>
          this.policyApi.readNamespacedPodDisruptionBudget({ name, namespace })
        ),
      create: () =>
        observeCreate('PodDisruptionBudget', () =>
          this.policyApi.createNamespacedPodDisruptionBudget({ namespace, body: pdb })
        ),
      onSkipped: () => createsTotal.inc({ kind: 'PodDisruptionBudget', outcome: 'skipped' }),
      converge: read =>
        replaceWithConflictRetry<k8s.V1PodDisruptionBudget>({
          description: `pod disruption budget "${name}" in ${namespace}`,
          logPrefix: LOG,
          body: pdb,
          mergeExisting: preserveObjectAnnotations,
          isUpToDate: podDisruptionBudgetMatchesDesired,
          read,
          replace: body =>
            this.policyApi.replaceNamespacedPodDisruptionBudget({ name, namespace, body }),
        }),
    })
  }

  async applyService(svc: k8s.V1Service, namespace: string): Promise<ResourceApplyResult> {
    const name = svc.metadata?.name ?? ''
    return ensureResource<k8s.V1Service>({
      read: () =>
        observeExistenceRead('Service', () =>
          this.coreApi.readNamespacedService({ name, namespace })
        ),
      create: () =>
        observeCreate('Service', () =>
          this.coreApi.createNamespacedService({ namespace, body: svc })
        ),
      onSkipped: () => createsTotal.inc({ kind: 'Service', outcome: 'skipped' }),
      // Preserve the stable Service, including its immutable clusterIP. Read
      // through a create conflict without introducing an update or another POST.
      converge: read => this.ignoreNotFound(read),
    })
  }

  async applyNetworkPolicy(
    np: k8s.V1NetworkPolicy,
    namespace: string
  ): Promise<ResourceApplyResult> {
    return applyNetworkPolicy(this.networkingApi, np.metadata?.name ?? '', namespace, np, LOG)
  }

  async isDeploymentAvailable(name: string, namespace: string): Promise<boolean> {
    try {
      const dep = await this.appsApi.readNamespacedDeployment({ name, namespace })
      const desiredReplicas = Math.max(1, dep.spec?.replicas ?? 1)
      const generation = dep.metadata?.generation ?? 0
      const observedGeneration = dep.status?.observedGeneration ?? 0
      return (
        observedGeneration >= generation && (dep.status?.availableReplicas ?? 0) >= desiredReplicas
      )
    } catch (err) {
      if (getErrorCode(err) === 404) return false
      throw err
    }
  }

  async deleteDeployment(name: string, namespace: string): Promise<void> {
    await this.ignoreNotFound(() => this.appsApi.deleteNamespacedDeployment({ name, namespace }))
  }

  async deletePodDisruptionBudget(name: string, namespace: string): Promise<void> {
    await this.ignoreNotFound(() =>
      this.policyApi.deleteNamespacedPodDisruptionBudget({ name, namespace })
    )
  }

  async deleteService(name: string, namespace: string): Promise<void> {
    await this.ignoreNotFound(() => this.coreApi.deleteNamespacedService({ name, namespace }))
  }

  async deleteNetworkPolicy(name: string, namespace: string): Promise<void> {
    await this.ignoreNotFound(() =>
      this.networkingApi.deleteNamespacedNetworkPolicy({ name, namespace })
    )
  }

  async deletePvc(name: string, namespace: string): Promise<void> {
    await this.ignoreNotFound(() =>
      this.coreApi.deleteNamespacedPersistentVolumeClaim({ name, namespace })
    )
  }

  async patchStatus(
    name: string,
    namespace: string,
    status: GlobalFileSystemStatus
  ): Promise<void> {
    // @kubernetes/client-node patch* defaults to JSON Patch (RFC 6902); send a
    // patch array so client and server agree on the content type.
    await this.customApi.patchNamespacedCustomObjectStatus({
      group: GROUP,
      version: VERSION,
      namespace,
      plural: PLURAL,
      name,
      body: [{ op: 'replace', path: '/status', value: status }],
    })
  }
}
