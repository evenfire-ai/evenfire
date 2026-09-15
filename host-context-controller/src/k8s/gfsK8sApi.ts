import * as k8s from '@kubernetes/client-node'
import type { GfsK8sApi } from '../gfsReconciler'
import { createsTotal } from '../metrics'
import type { GlobalFileSystemStatus } from '../types'
import {
  applyNetworkPolicy,
  ensureResource,
  getErrorCode,
  observeCreate,
  observeExistenceRead,
  replaceWithConflictRetry,
} from '../utils'
import { GFS_TEMPLATE_HASH_ANNOTATION } from './gfsFactory'

const GROUP = 'clerum.io'
const VERSION = 'v1alpha1'
const PLURAL = 'globalfilesystems'
const LOG = '[gfsReconciler]'

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

  async applyPvc(pvc: k8s.V1PersistentVolumeClaim, namespace: string): Promise<void> {
    const name = pvc.metadata?.name ?? ''
    await ensureResource<k8s.V1PersistentVolumeClaim>({
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

  async scaleDeployment(name: string, namespace: string, replicas: number): Promise<void> {
    let existing: k8s.V1Deployment
    try {
      existing = await this.appsApi.readNamespacedDeployment({ name, namespace })
    } catch (err) {
      if (getErrorCode(err) === 404) return
      throw err
    }
    if ((existing.spec?.replicas ?? 0) === replicas) return

    await replaceWithConflictRetry<k8s.V1Deployment>({
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

  async applyDeployment(dep: k8s.V1Deployment, namespace: string): Promise<void> {
    const name = dep.metadata?.name ?? ''
    await ensureResource<k8s.V1Deployment>({
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
        }),
    })
  }

  async applyPodDisruptionBudget(pdb: k8s.V1PodDisruptionBudget, namespace: string): Promise<void> {
    const name = pdb.metadata?.name ?? ''
    await ensureResource<k8s.V1PodDisruptionBudget>({
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
          read,
          replace: body =>
            this.policyApi.replaceNamespacedPodDisruptionBudget({ name, namespace, body }),
        }),
    })
  }

  async applyService(svc: k8s.V1Service, namespace: string): Promise<void> {
    const name = svc.metadata?.name ?? ''
    await ensureResource<k8s.V1Service>({
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

  async applyNetworkPolicy(np: k8s.V1NetworkPolicy, namespace: string): Promise<void> {
    await applyNetworkPolicy(this.networkingApi, np.metadata?.name ?? '', namespace, np, LOG)
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
