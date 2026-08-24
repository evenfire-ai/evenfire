/**
 * SharedFileSystemReconciler — manages the per-SharedFileSystem K8s resources
 * (PVC, workspace-files-controller Deployment + seeding initContainer + Service +
 * ingress/egress NetworkPolicies) in the mcp-host namespace.
 *
 * Responsibilities:
 *  - On reconcile(sfs):
 *      1. Ensure PVC exists with the requested size/class/accessModes
 *      2. Reap any legacy standalone init Jobs (seeding is now the wfc initContainer)
 *      3. Ensure the per-SFS wfc Deployment + Service exist
 *      4. Ensure the per-SFS ingress + egress NetworkPolicies exist
 *      5. Write the SharedFileSystem.status (phase, pvcName, etc.)
 *  - On reconcileDelete(name, namespace):
 *      Respect spec.retainOnDelete (default true). When false, tear down
 *      Deployment, Service, NetPols, then PVC last.
 *  - On fullReconcile(desired): reconcile every desired SharedFileSystem.
 *
 * Phase transitions:
 *   Provisioning → Initializing → Ready
 *                ↘ Failed/Degraded on errors
 */
import * as k8s from '@kubernetes/client-node'
import { config } from './config'
import {
  SFS_LABEL,
  SFS_NAMESPACE_LABEL,
  type SharedFileSystemFactoryConfig,
  WFC_APP_LABEL,
  buildDeployment,
  buildEgressNetworkPolicy,
  buildIngressNetworkPolicy,
  buildPvc,
  buildService,
  pvcName,
  wfcDeploymentName,
  wfcEgressPolicyName,
  wfcIngressPolicyName,
  wfcInitJobNamePrefix,
  wfcServiceName,
} from './k8s/sharedFileSystemFactory'
import type {
  SharedFileSystemCRD,
  SharedFileSystemCondition,
  SharedFileSystemPhase,
  SharedFileSystemStatus,
} from './types'
import {
  applyNetworkPolicy,
  getErrorCode,
  preserveDeploymentAnnotations,
  replaceWithConflictRetry,
} from './utils'

const GROUP = 'clerum.io'
const VERSION = 'v1alpha1'
const PLURAL_SHAREDFILESYSTEMS = 'sharedfilesystems'
const LOG = '[SharedFileSystemReconciler]'

type Deps = {
  appsApi?: k8s.AppsV1Api
  coreApi?: k8s.CoreV1Api
  batchApi?: k8s.BatchV1Api
  networkingApi?: k8s.NetworkingV1Api
  customApi?: k8s.CustomObjectsApi
  /** Allows tests to inject a deterministic clock + freeze time. */
  now?: () => Date
  /** Allows tests to override how the factory config is built (default: from `config`). */
  factoryConfig?: SharedFileSystemFactoryConfig
}

/** SharedFileSystem cache key — resources are namespaced. */
function key(sfs: Pick<SharedFileSystemCRD, 'name' | 'namespace'>): string {
  return `${sfs.namespace}/${sfs.name}`
}

function defaultFactoryConfig(): SharedFileSystemFactoryConfig {
  return {
    hostNamespace: config.hostNamespace,
    controlPlaneNamespace: 'control-plane',
    wfcImage: config.wfcImage,
    wfcImagePullPolicy: config.wfcImagePullPolicy,
    wfcImagePullSecretName: config.wfcImagePullSecretName || undefined,
    wfcPort: config.wfcPort,
    wfcInitImage: config.wfcInitImage,
    wfcResources: config.wfcResources,
    wfcJwtPublicKeyConfigMapName: config.wfcJwtPublicKeyConfigMapName,
    wfcJwtPublicKeyConfigMapKey: config.wfcJwtPublicKeyConfigMapKey,
    wfcMaxUploadBytes: config.wfcMaxUploadBytes,
    wfcMaxListEntries: config.wfcMaxListEntries,
    wfcMaxPathDepth: config.wfcMaxPathDepth,
  }
}

export class SharedFileSystemReconciler {
  private readonly appsApi: k8s.AppsV1Api
  private readonly coreApi: k8s.CoreV1Api
  private readonly batchApi: k8s.BatchV1Api
  private readonly networkingApi: k8s.NetworkingV1Api
  private readonly customApi: k8s.CustomObjectsApi
  private readonly now: () => Date
  private readonly factoryConfig: SharedFileSystemFactoryConfig

  /** In-memory status mirror, keyed by "<namespace>/<name>". */
  private readonly statusMap: Map<string, SharedFileSystemStatus> = new Map()

  /**
   * Serialized status last written to the cluster, keyed by "<namespace>/<name>".
   * Lets writeStatusToCluster() skip a no-op /status patch (#592 oscillation
   * fix): a status subresource patch bumps resourceVersion → fires a MODIFIED
   * watch event → re-reconcile → write again. Without a dirty check a
   * steady-state Ready SFS spins that loop forever (and N Ready SFS amplify it).
   */
  private readonly lastWrittenStatus: Map<string, string> = new Map()

  /**
   * In-memory "the RO mount is usable" signal, keyed by "<namespace>/<name>".
   * True iff the SFS PVC is Bound — i.e. the volume is provisioned and its node
   * is determined (under WaitForFirstConsumer the wfc, as first consumer, has
   * been scheduled, so the podAffinity target exists). This is deliberately
   * DECOUPLED from the wfc HTTP server's readiness (`readyReplicas`): a consuming
   * mcp-host mounts the PVC directly read-only and never talks to the wfc, so a
   * transient wfc restart must NOT drop the mount. resolveContextMounts() gates
   * the mount on this, not on phase==='Ready', so the mount is RETAINED across
   * wfc blips and only dropped when the volume is genuinely unusable or the
   * Context stops referencing the SFS. NOT written to the cluster status (no CRD
   * schema change).
   *
   * Caveat: on Immediate-binding StorageClasses the PVC can bind BEFORE the wfc
   * pod is scheduled, so a consumer reconciled in that brief window may sit
   * Pending on its required podAffinity until the wfc schedules (self-resolving,
   * seconds). Production uses WaitForFirstConsumer (`standard-rwo`), where a Bound
   * PVC implies the wfc was already scheduled — no such window. Gating on a
   * "wfc pod scheduled" signal instead would close this but would re-introduce
   * the mount-thrash (the pod disappears during a Recreate roll), so Bound is the
   * correct, stable signal.
   */
  private readonly mountableMap: Map<string, boolean> = new Map()

  /**
   * Caller-supplied lookup that, given an SFS name, returns the Contexts
   * whose `spec.sharedFileSystems[]` reference it. Wired by the K8s client
   * once Context informer + SFS reconciler are both constructed (avoids a
   * circular dep). Defaults to "no contexts" so unit tests don't need it.
   */
  private listContextRefs: (sfsName: string) => Array<{ namespace: string; name: string }> =
    () => []

  setListContextRefs(fn: (sfsName: string) => Array<{ namespace: string; name: string }>): void {
    this.listContextRefs = fn
  }

  constructor(kc: k8s.KubeConfig | null, deps?: Deps) {
    if (kc) {
      this.appsApi = deps?.appsApi ?? kc.makeApiClient(k8s.AppsV1Api)
      this.coreApi = deps?.coreApi ?? kc.makeApiClient(k8s.CoreV1Api)
      this.batchApi = deps?.batchApi ?? kc.makeApiClient(k8s.BatchV1Api)
      this.networkingApi = deps?.networkingApi ?? kc.makeApiClient(k8s.NetworkingV1Api)
      this.customApi = deps?.customApi ?? kc.makeApiClient(k8s.CustomObjectsApi)
    } else {
      // Tests construct with kc=null and inject mocks via deps.
      if (
        !deps?.appsApi ||
        !deps?.coreApi ||
        !deps?.batchApi ||
        !deps?.networkingApi ||
        !deps?.customApi
      ) {
        throw new Error(
          'SharedFileSystemReconciler requires either a KubeConfig or all API clients via deps'
        )
      }
      this.appsApi = deps.appsApi
      this.coreApi = deps.coreApi
      this.batchApi = deps.batchApi
      this.networkingApi = deps.networkingApi
      this.customApi = deps.customApi
    }
    this.now = deps?.now ?? (() => new Date())
    this.factoryConfig = deps?.factoryConfig ?? defaultFactoryConfig()
  }

  // ─── Status ────────────────────────────────────────────────────────

  getStatus(sfs: Pick<SharedFileSystemCRD, 'name' | 'namespace'>): SharedFileSystemStatus {
    return this.statusMap.get(key(sfs)) ?? { phase: 'Provisioning' }
  }

  /**
   * Whether the SFS PVC is Bound and the RO mount is therefore usable. The mount
   * gate (resolveContextMounts) keys on THIS, not on phase==='Ready', so a
   * transient wfc HTTP outage (readyReplicas→0) does not rip the read-only mount
   * out of a running consumer pod. Defaults to false until proven Bound.
   */
  isMountable(sfs: Pick<SharedFileSystemCRD, 'name' | 'namespace'>): boolean {
    return this.mountableMap.get(key(sfs)) ?? false
  }

  private patchStatus(sfs: SharedFileSystemCRD, patch: Partial<SharedFileSystemStatus>): void {
    const k = key(sfs)
    const next = { ...(this.statusMap.get(k) ?? {}), ...patch } as SharedFileSystemStatus
    this.statusMap.set(k, next)
  }

  /**
   * Build a status condition, preserving the prior `lastTransitionTime` when the
   * condition's (type, status, reason) is unchanged — the Kubernetes convention
   * (the transition time tracks a STATUS change, not every re-assessment). This
   * keeps a steady-state status byte-identical across reconciles so
   * writeStatusToCluster()'s dirty check can skip the no-op /status patch and
   * break the status-write → MODIFIED → reconcile oscillation loop (#592).
   */
  private stampCondition(
    sfs: SharedFileSystemCRD,
    cond: Omit<SharedFileSystemCondition, 'lastTransitionTime'>
  ): SharedFileSystemCondition {
    const prev = this.statusMap.get(key(sfs))?.conditions?.[0]
    const unchanged =
      !!prev &&
      prev.type === cond.type &&
      prev.status === cond.status &&
      prev.reason === cond.reason
    return {
      ...cond,
      lastTransitionTime:
        unchanged && prev.lastTransitionTime ? prev.lastTransitionTime : this.now().toISOString(),
    }
  }

  /**
   * Patch the SharedFileSystem.status subresource. Errors are logged but not
   * thrown — status writes are best-effort and shouldn't block reconciliation.
   */
  private async writeStatusToCluster(sfs: SharedFileSystemCRD): Promise<void> {
    const k = key(sfs)
    const status = this.statusMap.get(k)
    if (!status) return
    // Dirty check (#592 oscillation fix): skip the /status patch when it would
    // be a no-op. A status subresource write bumps resourceVersion → fires a
    // MODIFIED watch event → re-reconcile → write again; without this guard a
    // steady-state SFS spins that loop indefinitely. stampCondition() keeps
    // lastTransitionTime stable across unchanged conditions so a converged
    // status serializes identically here.
    const serialized = JSON.stringify(status)
    if (this.lastWrittenStatus.get(k) === serialized) return
    try {
      // The @kubernetes/client-node patch* methods default to JSON Patch
      // (RFC 6902, application/json-patch+json) — sending a merge-patch
      // object body produces "error decoding patch" 400s. Send a JSON Patch
      // array instead so the client/server agree on the content type.
      await this.customApi.patchNamespacedCustomObjectStatus({
        group: GROUP,
        version: VERSION,
        namespace: sfs.namespace,
        plural: PLURAL_SHAREDFILESYSTEMS,
        name: sfs.name,
        body: [{ op: 'replace', path: '/status', value: status }],
      })
      this.lastWrittenStatus.set(k, serialized)
    } catch (err) {
      console.error(
        `${LOG} Failed to write status for "${key(sfs)}" (${getErrorCode(err) ?? 'no code'}):`,
        err
      )
    }
  }

  // ─── PVC ───────────────────────────────────────────────────────────

  private async ensurePvc(sfs: SharedFileSystemCRD): Promise<string> {
    const pvc = buildPvc(sfs, this.factoryConfig)
    const name = pvcName(sfs)
    try {
      await this.coreApi.createNamespacedPersistentVolumeClaim({
        namespace: this.factoryConfig.hostNamespace,
        body: pvc,
      })
      console.log(`${LOG} Created PVC "${name}"`)
    } catch (err) {
      if (getErrorCode(err) !== 409) {
        throw err
      }
      // PVC spec is largely immutable post-create (size can grow, accessModes
      // can't change). We don't attempt to replace — just log and continue.
      console.log(`${LOG} PVC "${name}" already exists`)
    }
    return name
  }

  // ─── Legacy init-Job cleanup ───────────────────────────────────────

  /**
   * Delete any legacy per-SFS init Jobs left over from before seeding moved
   * into the controller's initContainer (see buildDeployment). Those Jobs each
   * mounted the RWO PVC on a possibly-different node than the controller and
   * could wedge in ContainerCreating forever (Multi-Attach).
   *
   * Best-effort and NON-gating: a failure here must never block the Deployment
   * rewrite (seeding is handled by the initContainer regardless). Scoped by the
   * SFS's own clear labels — `clerum.io/sharedfilesystem` (name) and
   * `clerum.io/sharedfilesystem-namespace` — with the `wfc-init-<hash>-` name
   * prefix only as a final sanity guard so only an actual per-SFS init Job is
   * ever deleted.
   */
  private async cleanupLegacyInitJobs(sfs: SharedFileSystemCRD): Promise<void> {
    const prefix = wfcInitJobNamePrefix(sfs)
    try {
      // Scope by the two clear, human-readable labels that identify the SFS —
      // its name and its namespace. These are exactly the labels HCC stamps on
      // the per-SFS init resources, so the list returns only THIS SFS's legacy
      // init Jobs (no obscure hashed-name matching needed to identify them).
      const list = await this.batchApi.listNamespacedJob({
        namespace: this.factoryConfig.hostNamespace,
        labelSelector: `${SFS_LABEL}=${sfs.name},${SFS_NAMESPACE_LABEL}=${sfs.namespace}`,
      })
      for (const job of list.items ?? []) {
        const jobName = job.metadata?.name
        // Sanity guard: only ever delete an actual per-SFS init Job.
        if (!jobName || !jobName.startsWith(prefix)) continue
        try {
          await this.batchApi.deleteNamespacedJob({
            name: jobName,
            namespace: this.factoryConfig.hostNamespace,
            propagationPolicy: 'Background',
          })
          console.log(`${LOG} Deleted legacy init Job "${jobName}" for "${key(sfs)}"`)
        } catch (err) {
          const code = getErrorCode(err)
          if (code !== 404 && code !== 409) {
            console.error(`${LOG} Failed to delete legacy init Job "${jobName}":`, err)
          }
        }
      }
    } catch (err) {
      // Non-gating: log and continue — the initContainer seeds regardless.
      console.error(`${LOG} cleanupLegacyInitJobs list failed for "${key(sfs)}":`, err)
    }
  }

  // ─── Deployment ────────────────────────────────────────────────────

  private async ensureDeployment(sfs: SharedFileSystemCRD): Promise<string> {
    const dep = buildDeployment(sfs, this.factoryConfig)
    const name = wfcDeploymentName(sfs)
    try {
      await this.appsApi.createNamespacedDeployment({
        namespace: this.factoryConfig.hostNamespace,
        body: dep,
      })
      console.log(`${LOG} Created Deployment "${name}"`)
    } catch (err) {
      if (getErrorCode(err) !== 409) {
        throw err
      }
      await replaceWithConflictRetry({
        description: `Deployment "${name}"`,
        logPrefix: LOG,
        body: dep,
        read: () =>
          this.appsApi.readNamespacedDeployment({
            namespace: this.factoryConfig.hostNamespace,
            name,
          }),
        // The public auth-key reconciler may use `kubectl rollout restart` on
        // this HCC-owned Deployment. Preserve the pod-template restart marker
        // when the periodic SFS reconcile replaces the raw desired manifest;
        // otherwise HCC would immediately create a second Recreate outage and
        // defeat the reconciler's one-rollout contract.
        mergeExisting: preserveDeploymentAnnotations,
        replace: body =>
          this.appsApi.replaceNamespacedDeployment({
            namespace: this.factoryConfig.hostNamespace,
            name,
            body,
          }),
      })
    }
    return name
  }

  // ─── Service ───────────────────────────────────────────────────────

  private async ensureService(sfs: SharedFileSystemCRD): Promise<string> {
    const svc = buildService(sfs, this.factoryConfig)
    const name = wfcServiceName(sfs)
    try {
      await this.coreApi.createNamespacedService({
        namespace: this.factoryConfig.hostNamespace,
        body: svc,
      })
      console.log(`${LOG} Created Service "${name}"`)
    } catch (err) {
      if (getErrorCode(err) !== 409) {
        throw err
      }
      // Don't replace Service — clusterIP is immutable and the spec we build
      // is otherwise stable. Log and continue.
      console.log(`${LOG} Service "${name}" already exists`)
    }
    return name
  }

  // ─── NetworkPolicies ───────────────────────────────────────────────

  private async ensureNetworkPolicies(sfs: SharedFileSystemCRD): Promise<void> {
    const ingress = buildIngressNetworkPolicy(sfs, this.factoryConfig)
    const egress = buildEgressNetworkPolicy(sfs, this.factoryConfig)
    await applyNetworkPolicy(
      this.networkingApi,
      wfcIngressPolicyName(sfs),
      this.factoryConfig.hostNamespace,
      ingress,
      LOG
    )
    await applyNetworkPolicy(
      this.networkingApi,
      wfcEgressPolicyName(sfs),
      this.factoryConfig.hostNamespace,
      egress,
      LOG
    )
  }

  // ─── Readiness assessment (truthful status — issue #592) ───────────

  /**
   * Reads the real bind/run state of a SharedFileSystem and maps it to a
   * truthful status. NEVER assumes Ready.
   *
   * The PVC uses WaitForFirstConsumer on the RWO StorageClasses we run, so a
   * Pending PVC while the wfc pod is still scheduling is the NORMAL warm-up
   * path (→ Initializing), not a failure. Only a wfc pod that is genuinely
   * wedged — Unschedulable / FailedScheduling / crash- or image-pull-loop — or
   * a Bound PVC the wfc still can't serve is reported Degraded. The periodic
   * SFS resync re-runs reconcile, so a transient Initializing/Degraded
   * auto-recovers to Ready once the volume binds and the pod serves.
   *
   * Read-only: get PVC, get Deployment, list the wfc Pod (RBAC: pods get,list).
   * Status messages carry only public spec/scheduling facts (no raw error
   * bodies) — see issue #592 CWE-209 note.
   */
  private async assessReadiness(
    sfs: SharedFileSystemCRD
  ): Promise<Partial<SharedFileSystemStatus>> {
    const ns = this.factoryConfig.hostNamespace

    // 1. PVC bind state + capacity.
    let pvcPhase: string | undefined
    let capacity: string | undefined
    try {
      const pvc = await this.coreApi.readNamespacedPersistentVolumeClaim({
        name: pvcName(sfs),
        namespace: ns,
      })
      pvcPhase = pvc.status?.phase
      capacity = pvc.status?.capacity?.storage
    } catch (err) {
      if (getErrorCode(err) !== 404) {
        console.error(`${LOG} assessReadiness: read PVC "${pvcName(sfs)}" failed:`, err)
      }
      // 404 (not yet visible) or read error → treat as still provisioning below.
    }

    // The RO mount is usable as soon as the PVC is Bound — independent of the
    // wfc HTTP server's readiness. resolveContextMounts() gates on this so a
    // transient wfc restart (readyReplicas→0) never drops a still-valid mount.
    this.mountableMap.set(key(sfs), pvcPhase === 'Bound')

    // 2. wfc Deployment readiness.
    let readyReplicas = 0
    try {
      const dep = await this.appsApi.readNamespacedDeployment({
        name: wfcDeploymentName(sfs),
        namespace: ns,
      })
      readyReplicas = dep.status?.readyReplicas ?? 0
    } catch (err) {
      if (getErrorCode(err) !== 404) {
        console.error(`${LOG} assessReadiness: read Deployment failed:`, err)
      }
    }

    // Happy path: volume Bound AND the single wfc replica is serving.
    if (pvcPhase === 'Bound' && readyReplicas > 0) {
      return {
        phase: 'Ready',
        capacity,
        conditions: [
          this.stampCondition(sfs, { type: 'Reconciled', status: 'True', reason: 'Ready' }),
        ],
      }
    }

    // Not Ready yet — inspect the wfc Pod to tell "warming up" from "wedged".
    const wedge = await this.detectWfcWedge(sfs)
    if (wedge) {
      return {
        phase: 'Degraded',
        capacity,
        conditions: [
          this.stampCondition(sfs, {
            type: 'Reconciled',
            status: 'False',
            reason: wedge.reason,
            message: wedge.message,
          }),
        ],
      }
    }

    // No wedge → normal warm-up. PVC Pending under WaitForFirstConsumer until the
    // wfc pod schedules is expected; report Initializing, never a false Degraded.
    const bound = pvcPhase === 'Bound'
    return {
      phase: 'Initializing',
      capacity,
      conditions: [
        this.stampCondition(sfs, {
          type: 'Reconciled',
          status: 'Unknown',
          reason: bound ? 'WfcStarting' : 'PVCBinding',
          message: bound
            ? 'PVC bound; workspace-files-controller pod is starting.'
            : 'PVC is binding (WaitForFirstConsumer); waiting for the wfc pod to schedule.',
        }),
      ],
    }
  }

  /**
   * Inspects the per-SFS wfc Pod for a genuinely wedged state. Returns a
   * `{ reason, message }` when the Pod is Unschedulable/FailedScheduling or in a
   * crash/image-pull loop; returns null when the Pod is merely starting or not
   * yet created (→ caller treats as warm-up). Read-only; never throws (a list
   * failure returns null so we don't falsely Degrade).
   */
  private async detectWfcWedge(
    sfs: SharedFileSystemCRD
  ): Promise<{ reason: string; message: string } | null> {
    const ns = this.factoryConfig.hostNamespace
    let pods: k8s.V1Pod[] = []
    try {
      const list = await this.coreApi.listNamespacedPod({
        namespace: ns,
        labelSelector: `app=${WFC_APP_LABEL},${SFS_LABEL}=${sfs.name},${SFS_NAMESPACE_LABEL}=${sfs.namespace}`,
      })
      pods = list.items ?? []
    } catch (err) {
      console.error(`${LOG} detectWfcWedge: list pods failed for "${key(sfs)}":`, err)
      return null
    }
    if (pods.length === 0) return null // pod not created yet → warming up

    for (const pod of pods) {
      // Unschedulable: PodScheduled condition False with reason Unschedulable.
      const scheduled = pod.status?.conditions?.find(c => c.type === 'PodScheduled')
      if (scheduled?.status === 'False' && scheduled.reason === 'Unschedulable') {
        const detail = scheduled.message ?? 'no detail'
        // Distinguish a volume/PVC scheduling failure (the #592 RWX-on-RWO-class
        // wedge) from an unrelated Unschedulable cause (node taints, insufficient
        // CPU/memory, pod/node affinity). Labeling the latter PVCUnbound — and
        // appending a "check the PVC accessModes" hint — would misdirect the
        // operator away from the real cause.
        const volumeRelated =
          /persistentvolumeclaim|persistent volume|volume node affinity|unbound|first consumer|find available persistent/i.test(
            detail
          )
        return volumeRelated
          ? {
              reason: 'PVCUnbound',
              message: `wfc pod is Unschedulable: ${detail}. Check the PVC accessModes against the StorageClass capability.`,
            }
          : {
              reason: 'Unschedulable',
              message: `wfc pod is Unschedulable: ${detail}.`,
            }
      }
      // Crash / image-pull loop on the init or serving container.
      const statuses = [
        ...(pod.status?.initContainerStatuses ?? []),
        ...(pod.status?.containerStatuses ?? []),
      ]
      for (const cs of statuses) {
        const reason = cs.state?.waiting?.reason
        if (
          reason &&
          ['CrashLoopBackOff', 'ImagePullBackOff', 'ErrImagePull', 'CreateContainerError'].includes(
            reason
          )
        ) {
          return {
            reason: 'WfcNotReady',
            message: `wfc container "${cs.name}" is ${reason}: ${cs.state?.waiting?.message ?? 'no detail'}.`,
          }
        }
      }
    }
    return null // pods exist but only starting → warm-up
  }

  // ─── Reconcile ─────────────────────────────────────────────────────

  /**
   * Idempotent reconcile of one SharedFileSystem. Safe to call repeatedly.
   * Errors propagate to the caller; partial success leaves status at the
   * last successfully-completed phase.
   */
  async reconcile(sfs: SharedFileSystemCRD): Promise<void> {
    const k = key(sfs)

    // #592 race fix: never downgrade an already-converged (Ready) SFS to a
    // transitional phase while re-reconciling it. resolveContextMounts() gates
    // the RO mount on the in-memory phase being 'Ready'; an optimistic
    // Provisioning/Initializing write here is read by concurrent Host reconciles
    // (the Context watch re-reconciles Hosts) and would defer the mount
    // indefinitely. assessReadiness() below remains the authoritative phase.
    if (this.getStatus(sfs).phase !== 'Ready') {
      this.patchStatus(sfs, { phase: 'Provisioning' })
    }

    try {
      const pvc = await this.ensurePvc(sfs)
      this.patchStatus(sfs, {
        pvcName: pvc,
        storageClassName: sfs.spec.storageClassName,
      })

      if (this.getStatus(sfs).phase !== 'Ready') {
        this.patchStatus(sfs, { phase: 'Initializing' })
      }
      // Seeding now runs in the controller's initContainer (same pod/node as
      // the RWO mount). Reap any obsolete standalone init Jobs — best-effort.
      await this.cleanupLegacyInitJobs(sfs)

      const svc = await this.ensureService(sfs)
      this.patchStatus(sfs, { serviceName: svc })

      await this.ensureDeployment(sfs)
      await this.ensureNetworkPolicies(sfs)

      const mountedBy = this.listContextRefs(sfs.name)
        .slice()
        .sort((a, b) =>
          a.namespace === b.namespace
            ? a.name.localeCompare(b.name)
            : a.namespace.localeCompare(b.namespace)
        )
      this.patchStatus(sfs, { mountedByContexts: mountedBy })

      // Truthful status (#592): never assume Ready after the create calls return.
      // Assess the real PVC bind + wfc pod state and report Ready / Initializing
      // / Degraded. The periodic SFS resync re-runs reconcile so a transient
      // Initializing/Degraded auto-recovers to Ready once the PVC binds and the
      // wfc pod serves.
      const assessment = await this.assessReadiness(sfs)
      this.patchStatus(sfs, assessment)
    } catch (err) {
      const phase: SharedFileSystemPhase = 'Failed'
      this.patchStatus(sfs, {
        phase,
        conditions: [
          this.stampCondition(sfs, {
            type: 'Reconciled',
            status: 'False',
            reason: 'ReconcileError',
            // #592 CWE-209: the raw error can carry K8s/client internals (resource
            // names, API-server error bodies, namespace/topology) and this status
            // is read by the end-user-facing external API. Surface only a generic,
            // bounded message; the full error goes to the controller log below.
            message: 'Reconcile failed; see host-context-controller logs for details.',
          }),
        ],
      })
      console.error(`${LOG} Reconcile failed for "${k}":`, err)
      throw err
    } finally {
      await this.writeStatusToCluster(sfs)
    }
  }

  /**
   * Tear down the per-SharedFileSystem resources. Respects retainOnDelete
   * (default true): when true, the PVC stays. When false, deletion runs in
   * reverse-create order (NetworkPolicies → Service → Deployment → PVC last).
   */
  async reconcileDelete(
    name: string,
    namespace: string,
    spec?: { retainOnDelete?: boolean }
  ): Promise<void> {
    const sfs: SharedFileSystemCRD = {
      name,
      namespace,
      spec: { ...spec },
    }
    const ns = this.factoryConfig.hostNamespace
    const retain = spec?.retainOnDelete !== false // default true

    // NetworkPolicies first (no dependents).
    for (const policyName of [wfcIngressPolicyName(sfs), wfcEgressPolicyName(sfs)]) {
      try {
        await this.networkingApi.deleteNamespacedNetworkPolicy({
          name: policyName,
          namespace: ns,
        })
      } catch (err) {
        if (getErrorCode(err) !== 404) {
          console.error(`${LOG} Failed to delete NetworkPolicy "${policyName}":`, err)
        }
      }
    }

    // Service.
    try {
      await this.coreApi.deleteNamespacedService({ name: wfcServiceName(sfs), namespace: ns })
    } catch (err) {
      if (getErrorCode(err) !== 404) {
        console.error(`${LOG} Failed to delete Service "${wfcServiceName(sfs)}":`, err)
      }
    }

    // Deployment.
    try {
      await this.appsApi.deleteNamespacedDeployment({
        name: wfcDeploymentName(sfs),
        namespace: ns,
      })
    } catch (err) {
      if (getErrorCode(err) !== 404) {
        console.error(`${LOG} Failed to delete Deployment "${wfcDeploymentName(sfs)}":`, err)
      }
    }

    // Reap any leftover legacy init Jobs BEFORE the PVC delete: a still-running
    // legacy init pod holding the RWO PVC would otherwise block reclaim (the
    // pvc-protection finalizer leaves the PVC Terminating). Best-effort.
    await this.cleanupLegacyInitJobs(sfs)

    // PVC last — only if !retainOnDelete.
    if (!retain) {
      try {
        await this.coreApi.deleteNamespacedPersistentVolumeClaim({
          name: pvcName(sfs),
          namespace: ns,
        })
        console.log(`${LOG} Deleted PVC "${pvcName(sfs)}" (retainOnDelete=false)`)
      } catch (err) {
        if (getErrorCode(err) !== 404) {
          console.error(`${LOG} Failed to delete PVC "${pvcName(sfs)}":`, err)
        }
      }
    } else {
      console.log(`${LOG} Retained PVC "${pvcName(sfs)}" (retainOnDelete=true)`)
    }

    this.statusMap.delete(key(sfs))
    this.lastWrittenStatus.delete(key(sfs))
    this.mountableMap.delete(key(sfs))
  }

  /**
   * Reconcile every desired SFS from the informer relist. This does not sweep
   * orphaned wfc resources for SFS objects that were deleted while HCC was down;
   * those are cleaned up only by reconcileDelete or manual label-based cleanup.
   */
  async fullReconcile(desired: SharedFileSystemCRD[]): Promise<void> {
    for (const sfs of desired) {
      try {
        await this.reconcile(sfs)
      } catch (err) {
        // Already logged in reconcile; keep going so a single bad SFS doesn't
        // block the whole sweep.
        console.error(`${LOG} fullReconcile: skipping "${key(sfs)}" after reconcile error:`, err)
      }
    }
  }
}
