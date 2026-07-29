/**
 * Reconciles the cluster-wide Global File System (gfs) singleton.
 *
 * On reconcile(gfs): ensure the PVC, the gfsc writer (RW, 1) + reader (RO,
 * readerReplicas) Deployments, read and write ClusterIP Services, and the
 * ingress/egress NetworkPolicies; then publish status.phase. When the writer
 * becomes Ready, trigger control-api ONCE to materialize spec.layout.rootDirectories
 * as gfs_resources rows — the governance plane owns the permission store (CC6);
 * the reconciler never writes Postgres.
 *
 * On reconcileDelete(gfs): respect spec.retainOnDelete (default true). When
 * false, tear down Deployments, Service, NetworkPolicies, then the PVC last.
 *
 * This mirrors sharedFileSystemReconciler's reconcile shape ONLY; the gfs
 * semantics (two Deployments, control-api seed, gfs namespace) come from the
 * spec. The Kubernetes surface is injected (GfsK8sApi) so the reconcile logic
 * is unit-testable without a cluster; the real adapter is wired in k8sClient.
 */
import type * as k8s from '@kubernetes/client-node'
import {
  GfsFactoryConfig,
  buildDeployment,
  buildEgressNetworkPolicy,
  buildIngressNetworkPolicy,
  buildPodDisruptionBudget,
  buildPvc,
  buildService,
  buildWriterService,
  egressPolicyName,
  ingressPolicyName,
  pdbName,
  pvcName,
  readerDeploymentName,
  serviceName,
  serviceUrl,
  writerDeploymentName,
  writerServiceName,
} from './k8s/gfsFactory'
import type { GlobalFileSystemCRD, GlobalFileSystemStatus } from './types'

/**
 * Minimal Kubernetes surface the reconciler needs. PVCs are create-if-absent
 * (their spec is immutable post-bind); everything else is create-or-replace.
 */
export interface GfsK8sApi {
  applyPvc(pvc: k8s.V1PersistentVolumeClaim, namespace: string): Promise<void>
  deploymentNeedsUpdate(dep: k8s.V1Deployment, namespace: string): Promise<boolean>
  scaleDeployment(name: string, namespace: string, replicas: number): Promise<void>
  applyDeployment(dep: k8s.V1Deployment, namespace: string): Promise<void>
  applyPodDisruptionBudget(pdb: k8s.V1PodDisruptionBudget, namespace: string): Promise<void>
  applyService(svc: k8s.V1Service, namespace: string): Promise<void>
  applyNetworkPolicy(np: k8s.V1NetworkPolicy, namespace: string): Promise<void>
  /** True when the named Deployment reports at least one available replica. */
  isDeploymentAvailable(name: string, namespace: string): Promise<boolean>
  deleteDeployment(name: string, namespace: string): Promise<void>
  deletePodDisruptionBudget(name: string, namespace: string): Promise<void>
  deleteService(name: string, namespace: string): Promise<void>
  deleteNetworkPolicy(name: string, namespace: string): Promise<void>
  deletePvc(name: string, namespace: string): Promise<void>
  patchStatus(name: string, namespace: string, status: GlobalFileSystemStatus): Promise<void>
}

/**
 * control-api seed trigger. The governance plane (control-api) is the ONLY
 * writer of gfs_resources rows (CC6), so the reconciler asks it to materialize
 * rootDirectories rather than writing Postgres itself. Must be idempotent.
 */
export interface GfsSeedClient {
  seedRootDirectories(gfs: GlobalFileSystemCRD): Promise<void>
}

function gfsKey(gfs: Pick<GlobalFileSystemCRD, 'name' | 'namespace'>): string {
  return `${gfs.namespace}/${gfs.name}`
}

export class GfsReconciler {
  /** gfs keys whose rootDirectories seed has already succeeded this process. */
  private readonly seeded = new Set<string>()

  constructor(
    private readonly api: GfsK8sApi,
    private readonly config: GfsFactoryConfig,
    private readonly seedClient?: GfsSeedClient,
    private readonly writerRolloutWaitMs = 240_000,
    private readonly writerRolloutPollMs = 2_000
  ) {}

  private async waitForWriterAvailable(gfs: GlobalFileSystemCRD, ns: string): Promise<boolean> {
    const name = writerDeploymentName(gfs)
    const deadline = Date.now() + this.writerRolloutWaitMs
    do {
      if (await this.api.isDeploymentAvailable(name, ns)) return true
      if (Date.now() >= deadline) return false
      await new Promise(resolve => setTimeout(resolve, this.writerRolloutPollMs))
    } while (true)
  }

  private async writeStatus(
    gfs: GlobalFileSystemCRD,
    status: GlobalFileSystemStatus
  ): Promise<void> {
    // Compare against status observed on this exact LIST/watch object, not
    // process memory keyed only by name. A local name cache could suppress the
    // repair of a recreated object when its DELETE event was missed, or of
    // status that another actor removed. Conversely, an identical observed
    // status proves this is our own status-only MODIFIED event and closes the
    // patch -> watch -> reconcile loop without another API write.
    if (
      gfs.status?.phase === status.phase &&
      gfs.status?.pvcName === status.pvcName &&
      gfs.status?.serviceName === status.serviceName &&
      gfs.status?.serviceUrl === status.serviceUrl
    ) {
      return
    }
    await this.api.patchStatus(gfs.name, gfs.namespace, status)
  }

  async reconcile(gfs: GlobalFileSystemCRD): Promise<void> {
    const ns = this.config.gfsNamespace
    const writerDeployment = buildDeployment(gfs, this.config, 'writer')
    const readerDeployment = buildDeployment(gfs, this.config, 'reader')
    const writerName = writerDeploymentName(gfs)
    const readerName = readerDeploymentName(gfs)

    await this.api.applyPvc(buildPvc(gfs, this.config), ns)
    const writerNeedsUpdate = await this.api.deploymentNeedsUpdate(writerDeployment, ns)
    if (writerNeedsUpdate) {
      // With standard-rwo, reader pods keep RO mounts on the writer's node.
      // During a writer template rollout, scale them down before applying the
      // writer so Kubernetes can attach the PVC to the writer's next node.
      await this.api.scaleDeployment(readerName, ns, 0)
    }

    await this.api.applyPodDisruptionBudget(buildPodDisruptionBudget(gfs, this.config), ns)
    await this.api.applyService(buildService(gfs, this.config), ns)
    await this.api.applyService(buildWriterService(gfs, this.config), ns)
    await this.api.applyNetworkPolicy(buildIngressNetworkPolicy(gfs, this.config), ns)
    await this.api.applyNetworkPolicy(buildEgressNetworkPolicy(gfs, this.config), ns)
    if (writerNeedsUpdate) {
      await this.api.applyDeployment(writerDeployment, ns)
    }

    let writerReady = writerNeedsUpdate
      ? await this.waitForWriterAvailable(gfs, ns)
      : await this.api.isDeploymentAvailable(writerName, ns)
    if (!writerNeedsUpdate && !writerReady) {
      // A current writer template can still be unavailable after a node drain or
      // pod eviction. Readers may retain RO mounts on the old node; release them
      // so the single RWO writer can attach first, then restore readers below.
      await this.api.scaleDeployment(readerName, ns, 0)
      writerReady = await this.waitForWriterAvailable(gfs, ns)
    }
    if (writerReady) {
      await this.api.applyDeployment(readerDeployment, ns)
    }
    const phase = writerReady ? 'Ready' : 'Initializing'

    await this.writeStatus(gfs, {
      phase,
      pvcName: pvcName(gfs),
      serviceName: serviceName(gfs),
      serviceUrl: serviceUrl(gfs, this.config),
    })

    // The drive only becomes usable once the writer is Ready; seed exactly once.
    if (phase === 'Ready' && this.seedClient && !this.seeded.has(gfsKey(gfs))) {
      await this.seedClient.seedRootDirectories(gfs)
      this.seeded.add(gfsKey(gfs))
    }
  }

  /**
   * Reconcile every desired GlobalFileSystem (startup load + periodic resync).
   * A per-item failure is logged loudly and does NOT block the others — the
   * next resync retries it. This is the standard controller convergence loop,
   * not a swallowed error: the failure is surfaced and the loop is idempotent.
   */
  async fullReconcile(gfses: GlobalFileSystemCRD[]): Promise<void> {
    for (const gfs of gfses) {
      try {
        await this.reconcile(gfs)
      } catch (err) {
        console.error(
          `[gfsReconciler] reconcile failed for "${gfsKey(gfs)}": ${
            err instanceof Error ? err.message : String(err)
          }`
        )
      }
    }
  }

  async reconcileDelete(gfs: GlobalFileSystemCRD): Promise<void> {
    const ns = this.config.gfsNamespace
    const retain = gfs.spec.retainOnDelete ?? true

    // Tear down the broker first so nothing serves a half-deleted drive.
    await this.api.deleteDeployment(writerDeploymentName(gfs), ns)
    await this.api.deleteDeployment(readerDeploymentName(gfs), ns)
    await this.api.deletePodDisruptionBudget(pdbName(gfs), ns)
    await this.api.deleteService(writerServiceName(gfs), ns)
    await this.api.deleteService(serviceName(gfs), ns)
    await this.api.deleteNetworkPolicy(ingressPolicyName(gfs), ns)
    await this.api.deleteNetworkPolicy(egressPolicyName(gfs), ns)

    // The PVC (the actual bytes) is removed LAST, and only when not retained.
    if (!retain) {
      await this.api.deletePvc(pvcName(gfs), ns)
    }

    this.seeded.delete(gfsKey(gfs))
  }
}
