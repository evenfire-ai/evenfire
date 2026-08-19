/**
 * Stateless Host lifecycle execution (Stages 2–6), extracted from
 * HostReconciler: reconcile-time assessment + durable status writes, the
 * heartbeat-driven suspend/drain/cancel-drain executors backing the
 * tracker's StatelessLifecycleReconcilerPort, the wake fast-path, and the
 * per-host reconcile serialization chain. The tracker DECIDES; this class
 * EXECUTES. HostReconciler holds one instance and delegates.
 */
import * as k8s from '@kubernetes/client-node'
import { config } from './config'
import { isHeartbeatManagedLifecycleReason } from './constants'
import type { ResolvedSfsMount } from './hostReconciler'
import { SFS_LABEL, SFS_NAMESPACE_LABEL, WFC_APP_LABEL } from './k8s/sharedFileSystemFactory'
import {
  STATELESS_PULL_POLICY_REJECTED_CONDITION_TYPE,
  pullPolicyNotApplicableCondition,
  statelessPullPolicyCondition,
} from './statelessDeployment'
import {
  EffectiveHostLifecycle,
  HostLifecycleAssessment,
  SuspendFromHeartbeatOutcome,
} from './statelessLifecycle.types'
import { HostCRD, HostCondition, HostCrdStatus, HostLifecycleStatus } from './types'
import { getErrorCode } from './utils'

// ─── Stateless lifecycle (Stage 2) ─────────────────────────────────────────
const GROUP = 'clerum.io'
const VERSION = 'v1alpha1'
const PLURAL_HOSTS = 'hosts'
const STATELESS_REJECTED_CONDITION_TYPE = 'StatelessEnableRejected'
const COMMUNICATION_CHANNEL_CACHE_UNSYNCED_REASON = 'CommunicationChannelCacheUnsynced'
const COMMUNICATION_CHANNEL_CACHE_UNSYNCED_MESSAGE =
  'CommunicationChannel cache is not synchronized; stateless lifecycle is held active'
const ACTIVE_COMMUNICATION_CHANNELS_REASON = 'ActiveCommunicationChannels'
/**
 * Host CR annotation carrying the monotonic wake generation (Stage 4.3).
 * control-api bumps a Postgres-backed generation on every wake request —
 * for suspended AND draining Hosts (a bump while draining means "cancel the
 * drain") — and projects it here. HCC compares it against
 * status.lifecycle.wakeHandledGeneration to detect pending wakes.
 */
const WAKE_REQUESTED_ANNOTATION = 'clerum.io/wake-requested'

/**
 * H2: reflect a committed lifecycle outcome onto the CURRENT canonical cache
 * entry for `name` — but only if that entry still has the admitted `uid`.
 * The receiver (McpServerWatcher) owns the lookup and the uid guard; the
 * executor never touches the cache directly. A same-name recreation with a
 * different uid MUST be skipped silently (the mutation already committed
 * server-side under the old uid; corrupting the new object would be worse
 * than staleness, which the watch/resync repairs).
 */
export type ReflectHostOutcomeFn = (
  name: string,
  uid: string | undefined,
  apply: (target: HostCRD) => void
) => void

/** Constructor-injected seams from HostReconciler (late-bound where needed). */
export interface StatelessLifecycleExecutorDeps {
  appsApi: k8s.AppsV1Api
  coreApi: k8s.CoreV1Api
  /**
   * Lazily resolves the CustomObjects client: HostReconciler constructs it
   * on first use (existing tests construct the reconciler with a bare
   * KubeConfig stub that cannot makeApiClient), so the executor must never
   * capture it eagerly.
   */
  getCustomApi: () => k8s.CustomObjectsApi
  /** Injectable clock so tests get deterministic condition lastTransitionTime. */
  now: () => Date
  /**
   * Count CommunicationChannels referencing this Host. Late-bound through
   * the reconciler (McpServerWatcher wires the counter after construction).
   */
  countCommunicationChannels: (hostName: string) => number
  /**
   * True only after the CommunicationChannel initial list has completed.
   * An unsynchronized cache cannot safely prove that a Host has no channels.
   */
  isCommunicationChannelCacheSynced: () => boolean
  /**
   * HostReconciler.reconcileCore — the UN-serialized reconcile body.
   * Callers inside this executor already run inside the host's
   * serialization slot, so re-entering the per-host chain would
   * self-deadlock.
   */
  reconcileCore: (host: HostCRD, revalidate?: () => HostCRD) => Promise<void>
  /**
   * Capture Host inventory authority at heartbeat dispatch time and return an
   * admission closure that revalidates that authority and resolves the current
   * same-identity Host inside this executor's per-Host serializer. The two-step
   * shape is intentional: capturing only after the queue drains cannot detect
   * an authority generation change that happened while the work was waiting.
   */
  prepareHostMutationAdmission?: (action: string, host: HostCRD) => () => HostCRD
  reflectHostOutcome?: ReflectHostOutcomeFn
  onLifecycleStatusCommitted?: (host: HostCRD, lifecycle: HostLifecycleStatus) => void
}

export class StatelessLifecycleExecutor {
  private readonly appsApi: k8s.AppsV1Api
  private readonly coreApi: k8s.CoreV1Api
  private readonly getCustomApiFn: () => k8s.CustomObjectsApi
  private readonly now: () => Date
  private readonly countCommunicationChannels: (hostName: string) => number
  private readonly isCommunicationChannelCacheSynced: () => boolean
  private readonly reconcileCore: (host: HostCRD, revalidate?: () => HostCRD) => Promise<void>
  private readonly prepareHostMutationAdmission: (action: string, host: HostCRD) => () => HostCRD
  private readonly reflectHostOutcome: ReflectHostOutcomeFn
  private readonly onLifecycleStatusCommitted: (
    host: HostCRD,
    lifecycle: HostLifecycleStatus
  ) => void
  /**
   * Serialized lifecycle status last written to the Host /status subresource,
   * keyed by host name. Mirrors sharedFileSystemReconciler's dirty check: a
   * no-op /status patch bumps resourceVersion → MODIFIED watch event →
   * re-reconcile → write again, so steady-state writes must be skipped.
   */
  private readonly lastWrittenLifecycleStatus: Map<string, string> = new Map()
  /**
   * Last malformed clerum.io/wake-requested annotation value logged per host.
   * A broken writer must stay operator-visible, but the periodic resync
   * would otherwise repeat the identical log line forever — log loudly once
   * per distinct value instead.
   */
  private readonly malformedWakeAnnotationLogged: Map<string, string> = new Map()
  /**
   * In-memory scale-transition counter per host (Stage 6 metric). Resets on
   * HCC restart — acceptable: the wake-budget script correlates transitions
   * within a single HCC run.
   */
  private readonly scaleTransitionsByHost: Map<string, number> = new Map()
  private readonly suspendedAppliedLoggedByHost: Set<string> = new Set()
  private readonly suspendedScaleMetricRecordedByHost: Set<string> = new Set()
  /**
   * L2: per-host serializing promise chain. @kubernetes/client-node's Watch
   * does NOT await the prior callback, and the tracker (heartbeat poller)
   * drives suspend/drain reconciles on a separate timer. So a MODIFIED-wake
   * reconcile and a tracker-driven suspend for the SAME host could otherwise
   * interleave and clobber each other's status/replicas writes. Every public
   * mutation entry point for a host funnels through serializeByHost(), which
   * chains that host's work onto its previous promise — reconciles for the
   * same host run strictly one-at-a-time, while different hosts still run
   * concurrently. Internal self-calls (e.g. suspendHostFromHeartbeat →
   * reconcileCore) deliberately bypass the chain to avoid self-deadlock, since
   * they already run inside the caller's held slot.
   */
  private readonly reconcileChainByHost: Map<string, Promise<void>> = new Map()

  constructor(deps: StatelessLifecycleExecutorDeps) {
    this.appsApi = deps.appsApi
    this.coreApi = deps.coreApi
    this.getCustomApiFn = deps.getCustomApi
    this.now = deps.now
    this.countCommunicationChannels = deps.countCommunicationChannels
    this.isCommunicationChannelCacheSynced = deps.isCommunicationChannelCacheSynced
    this.reconcileCore = deps.reconcileCore
    this.prepareHostMutationAdmission =
      deps.prepareHostMutationAdmission ?? ((_action, host) => () => host)
    this.reflectHostOutcome = deps.reflectHostOutcome ?? (() => {})
    this.onLifecycleStatusCommitted = deps.onLifecycleStatusCommitted ?? (() => {})
    StatelessLifecycleExecutor.warnSingleReplicaInvariantOnce()
  }

  /**
   * SINGLE-REPLICA INVARIANT (undocumented until now, load-bearing): the
   * stateless lifecycle status writers are made safe by TWO mechanisms working
   * together — the per-host serializeByHost chain (orders writers WITHIN one
   * process) and the D3 resourceVersion precondition + 409-retry (closes the
   * cross-writer window serialization cannot). Neither provides leader
   * election. If HCC ever runs with replicas > 1, two independent
   * reconcile loops drive suspend/drain/wake for the same Host with no
   * cross-process ordering; the resourceVersion precondition then degrades
   * from "correct" to "one writer wins each round, the loser retries" — which
   * is safe against corruption but can livelock two racing controllers. HCC is
   * therefore deployed replicas:1 without leader election. This warn makes the
   * assumption operator-visible once per process instead of silent.
   */
  private static singleReplicaInvariantWarned = false
  private static warnSingleReplicaInvariantOnce(): void {
    if (StatelessLifecycleExecutor.singleReplicaInvariantWarned) {
      return
    }
    StatelessLifecycleExecutor.singleReplicaInvariantWarned = true
    console.warn(
      '[HostReconciler] Stateless lifecycle status writes assume HCC runs replicas:1 WITHOUT leader election. serializeByHost orders writers within this process; the resourceVersion precondition + 409-retry closes the cross-writer window — but neither elects a leader. Running >1 replica risks two controllers racing (safe against corruption, but can livelock).'
    )
  }

  /** CustomObjects API client for Host /status writes (lazily constructed). */
  private get customApi(): k8s.CustomObjectsApi {
    return this.getCustomApiFn()
  }

  /**
   * Drop this host's lifecycle bookkeeping (called from
   * HostReconciler.clearStatus on Host deletion).
   */
  clearHost(name: string): void {
    this.lastWrittenLifecycleStatus.delete(name)
    this.malformedWakeAnnotationLogged.delete(name)
  }

  // ─── Stateless lifecycle (Stage 2) ──────────────────────────────────

  /**
   * Synchronous effective-lifecycle derivation for direct buildDeployment
   * callers. reconcile() passes the full async assessment (which also runs
   * the SharedFileSystem co-location check); this fallback covers the
   * synchronously checkable rejections so a direct build never suspends a
   * Host that has a desktop or CommunicationChannels.
   */
  effectiveLifecycleFromCache(host: HostCRD): EffectiveHostLifecycle {
    if (host.spec.lifecycle?.stateless !== true) {
      return { stateless: false, state: 'active' }
    }
    const hasCommunicationChannels = this.countCommunicationChannels(host.name) > 0
    if (
      !this.isCommunicationChannelCacheSynced() ||
      host.spec.desktop !== undefined ||
      hasCommunicationChannels
    ) {
      return { stateless: false, state: 'active' }
    }
    return { stateless: true, state: host.status?.lifecycle?.state ?? 'active' }
  }

  private communicationChannelPolicyRejection(hostName: string): {
    reasons: string[]
    messages: string[]
  } {
    const reasons: string[] = []
    const messages: string[] = []
    if (!this.isCommunicationChannelCacheSynced()) {
      reasons.push(COMMUNICATION_CHANNEL_CACHE_UNSYNCED_REASON)
      messages.push(COMMUNICATION_CHANNEL_CACHE_UNSYNCED_MESSAGE)
    }
    const ccCount = this.countCommunicationChannels(hostName)
    if (ccCount > 0) {
      // Addendum 6 (operator visibility): the rejection message names both the
      // associated channel count AND the recovery action, because control-ui
      // renders `condition.message` verbatim in the stateless-rejection banner.
      // The rejection is state-derived, so disassociating the channels
      // re-enables the requested stateless lifecycle on the next reconcile.
      reasons.push(ACTIVE_COMMUNICATION_CHANNELS_REASON)
      messages.push(
        `${ccCount} CommunicationChannel(s) reference this Host; disassociate them to enable the requested stateless lifecycle`
      )
    }
    return { reasons, messages }
  }

  /**
   * Assess whether the Host may run the stateless lifecycle and compute the
   * durable status to persist. Rejections (each also acts as an automatic
   * kill-switch when it appears AFTER enable):
   *   - active CommunicationChannels referencing the Host
   *   - spec.desktop present
   *   - provably unsatisfiable SharedFileSystem co-location (2+ SFS whose
   *     wfc pods are pinned to different nodes)
   * A rejected or disabled Host is forced to state=active (replicas 1) so it
   * never sits unsuspendable without an operator-visible signal.
   */
  async assessLifecycle(
    host: HostCRD,
    mounts: ResolvedSfsMount[]
  ): Promise<HostLifecycleAssessment> {
    const wakeHandledGeneration = host.status?.lifecycle?.wakeHandledGeneration ?? 0

    if (host.spec.lifecycle?.stateless !== true) {
      // Kill-switch: stateless disabled or the field was removed — back to
      // active + replicas 1 on this reconcile.
      return {
        effective: { stateless: false, state: 'active' },
        lifecycle: { state: 'active', wakeHandledGeneration },
        condition: {
          type: STATELESS_REJECTED_CONDITION_TYPE,
          status: 'False',
          reason: 'StatelessDisabled',
          message: 'spec.lifecycle.stateless is not enabled',
        },
        pullPolicyCondition: pullPolicyNotApplicableCondition(),
      }
    }

    const reasons: string[] = []
    const messages: string[] = []

    const channelRejection = this.communicationChannelPolicyRejection(host.name)
    reasons.push(...channelRejection.reasons)
    messages.push(...channelRejection.messages)
    if (host.spec.desktop !== undefined) {
      reasons.push('DesktopEnabled')
      messages.push('spec.desktop is present')
    }
    if (mounts.length >= 2) {
      const conflictingNodes = await this.findSfsColocationConflict(host, mounts)
      if (conflictingNodes) {
        reasons.push('SfsColocationUnsatisfiable')
        messages.push(
          `SharedFileSystem co-location is unsatisfiable: wfc pods are pinned to different nodes (${conflictingNodes.join(', ')})`
        )
      }
    }

    if (reasons.length > 0) {
      const message = messages.join('; ')
      return {
        effective: { stateless: false, state: 'active' },
        lifecycle: { state: 'active', wakeHandledGeneration, reason: message },
        condition: {
          type: STATELESS_REJECTED_CONDITION_TYPE,
          status: 'True',
          reason: reasons.join(','),
          message,
        },
        pullPolicyCondition: pullPolicyNotApplicableCondition(),
      }
    }

    // Accepted: preserve the durable state from the CRD status — a suspended
    // Host must survive HCC restarts and periodic resyncs.
    const state = host.status?.lifecycle?.state ?? 'active'
    // Preserve heartbeat-tracker-owned reasons ('idle' suspension, D8
    // suspend-blocked): the accepted path otherwise clears `reason`, which
    // would erase the tracker's status one watch event after every publish.
    const observedReason = host.status?.lifecycle?.reason
    const preservedReason = isHeartbeatManagedLifecycleReason(observedReason)
      ? observedReason
      : undefined
    return {
      effective: { stateless: true, state },
      lifecycle: {
        state,
        wakeHandledGeneration,
        ...(preservedReason !== undefined ? { reason: preservedReason } : {}),
      },
      condition: {
        type: STATELESS_REJECTED_CONDITION_TYPE,
        status: 'False',
        reason: 'StatelessEnabled',
        message: 'stateless lifecycle is enabled',
      },
      // Stateless is never desktop (spec.desktop rejects above), so the pod
      // image is always config.hostImage here — same input buildDeployment
      // resolves against.
      pullPolicyCondition: statelessPullPolicyCondition(config.hostImage),
    }
  }

  /**
   * Close the interval between the initial lifecycle assessment and the
   * Deployment write. Reconciliation performs several Kubernetes operations
   * in between; if the CommunicationChannel watch ends or a channel starts
   * referencing this Host during that interval, an assessment that was safe
   * when computed must not still scale the Host to zero or leave it on the
   * stateless runtime template.
   *
   * This synchronous cache check adds no Kubernetes API calls to steady state.
   */
  enforceCommunicationChannelPolicyBeforeDeployment(
    hostName: string,
    assessment: HostLifecycleAssessment
  ): HostLifecycleAssessment {
    if (!assessment.effective.stateless) {
      return assessment
    }

    const { reasons, messages } = this.communicationChannelPolicyRejection(hostName)
    if (reasons.length === 0) {
      return assessment
    }
    const message = messages.join('; ')

    return {
      effective: { stateless: false, state: 'active' },
      lifecycle: {
        state: 'active',
        wakeHandledGeneration: assessment.lifecycle.wakeHandledGeneration,
        reason: message,
      },
      condition: {
        type: STATELESS_REJECTED_CONDITION_TYPE,
        status: 'True',
        reason: reasons.join(','),
        message,
      },
      pullPolicyCondition: pullPolicyNotApplicableCondition(),
    }
  }

  /**
   * Returns the sorted distinct node names hosting the wfc pods of the given
   * SFS mounts when they PROVABLY conflict (2+ distinct nodes), else null.
   *
   * Every SFS PVC is RWO and its wfc pod is the RW writer, so a Host mounting
   * 2+ SFS is schedulable only when all wfc pods share one node. When node
   * placement cannot be resolved (list error, pods not scheduled yet) this
   * returns null: only the provably-unsatisfiable case rejects — a transient
   * lookup failure must not flap the lifecycle.
   */
  private async findSfsColocationConflict(
    host: HostCRD,
    mounts: ResolvedSfsMount[]
  ): Promise<string[] | null> {
    const nodes = new Set<string>()
    for (const m of mounts) {
      try {
        const pods = await this.coreApi.listNamespacedPod({
          namespace: m.namespace,
          labelSelector: `app=${WFC_APP_LABEL},${SFS_LABEL}=${m.name},${SFS_NAMESPACE_LABEL}=${m.namespace}`,
        })
        for (const pod of pods.items ?? []) {
          if (pod.spec?.nodeName) {
            nodes.add(pod.spec.nodeName)
          }
        }
      } catch (err) {
        console.warn(
          `[HostReconciler] Could not resolve wfc node placement for SFS "${m.namespace}/${m.name}" (host "${host.name}"); skipping the co-location rejection check:`,
          err
        )
        return null
      }
    }
    if (nodes.size <= 1) {
      return null
    }
    return [...nodes].sort()
  }

  /**
   * Write status.lifecycle + the StatelessEnableRejected condition to the
   * Host /status subresource. Follows the sharedFileSystemReconciler status
   * pattern: idempotent-by-comparison (skip when nothing changed, preserve
   * lastTransitionTime across unchanged conditions) and best-effort (errors
   * are logged, not thrown — status writes must not block reconciliation).
   *
   * Hosts that never opted into the lifecycle (no spec.lifecycle AND no
   * previously-written status.lifecycle) are skipped entirely so legacy
   * Hosts keep an untouched status.
   */
  async writeLifecycleStatusToCluster(
    host: HostCRD,
    assessment: HostLifecycleAssessment
  ): Promise<boolean> {
    if (host.spec.lifecycle === undefined && host.status?.lifecycle === undefined) {
      return false
    }

    const desired = JSON.stringify({
      lifecycle: assessment.lifecycle,
      condition: assessment.condition,
      pullPolicyCondition: assessment.pullPolicyCondition,
    })
    if (this.lastWrittenLifecycleStatus.get(host.name) === desired) {
      return false
    }

    const observedLifecycle = host.status?.lifecycle
    const observedCondition = host.status?.conditions?.find(
      c => c.type === STATELESS_REJECTED_CONDITION_TYPE
    )
    const observedPullPolicyCondition = host.status?.conditions?.find(
      c => c.type === STATELESS_PULL_POLICY_REJECTED_CONDITION_TYPE
    )
    const observedMatches =
      observedLifecycle !== undefined &&
      observedLifecycle.state === assessment.lifecycle.state &&
      observedLifecycle.wakeHandledGeneration === assessment.lifecycle.wakeHandledGeneration &&
      observedLifecycle.reason === assessment.lifecycle.reason &&
      observedCondition !== undefined &&
      observedCondition.status === assessment.condition.status &&
      observedCondition.reason === assessment.condition.reason &&
      observedCondition.message === assessment.condition.message &&
      observedPullPolicyCondition !== undefined &&
      observedPullPolicyCondition.status === assessment.pullPolicyCondition.status &&
      observedPullPolicyCondition.reason === assessment.pullPolicyCondition.reason &&
      observedPullPolicyCondition.message === assessment.pullPolicyCondition.message
    if (observedMatches) {
      this.lastWrittenLifecycleStatus.set(host.name, desired)
      return false
    }

    // Kubernetes convention: lastTransitionTime tracks a STATUS change, not
    // every re-assessment — keeping it stable also keeps a converged status
    // byte-identical for the dirty checks above.
    const stampCondition = (
      observed: HostCondition | undefined,
      desiredCondition: Omit<HostCondition, 'lastTransitionTime'>
    ): HostCondition => {
      const priorTransitionTime =
        observed !== undefined &&
        observed.status === desiredCondition.status &&
        observed.reason === desiredCondition.reason
          ? observed.lastTransitionTime
          : undefined
      return {
        ...desiredCondition,
        lastTransitionTime: priorTransitionTime ?? this.now().toISOString(),
      }
    }
    try {
      // D2/AP-1: TARGETED sub-object patch under the D3 resourceVersion
      // precondition. The previous implementation spread the CACHED
      // `host.status` into a whole-`/status` write, which could clobber a
      // fresher conditions[]/reason/wakeHandledGeneration that a heartbeat
      // core wrote between the cache snapshot and this write (this is the
      // highest-traffic lifecycle writer). Instead we compute the two owned
      // sub-objects against a FRESH read inside the build callback and emit
      // ONLY `/status/lifecycle` + `/status/conditions` ops, so fields this
      // method did not compute are never overwritten. The build callback
      // stamps conditions off the FRESH observed values so lastTransitionTime
      // stays stable, and it re-runs on a 409 so a racing writer's newer
      // resourceVersion wins the round and this write retries against it.
      //
      // AP-1 (the 8th costume): the D3 precondition proves nothing changed
      // AFTER the fresh read, but `assessment.lifecycle` was derived by
      // assessLifecycle from the CACHED `host` snapshot captured BEFORE the
      // fresh read. A heartbeat suspend that landed between the snapshot and
      // this fresh read passes the precondition trivially (the serialized
      // per-host chain means the fresh GET always matches the current
      // resourceVersion) yet would be silently overwritten if we wrote
      // `assessment.lifecycle` verbatim — resurrecting a `suspended` Host to
      // replicas:1 with NO wake, and/or regressing wakeHandledGeneration.
      // So we re-source the ECHOED `state` from FRESH inside the callback
      // (mirroring the heartbeat cores, which recompute both the guard AND the
      // written value from the fresh object) while preserving the assessment's
      // INTENDED state overrides.
      //
      // The clean override-vs-echo discriminator is whether the assessment's
      // `state` DIFFERS from the cached snapshot's state (`host.status`):
      //   - EQUAL → the assessment did not intend to change state; the value
      //     is a pass-through ECHO of the snapshot (assessLifecycle accepted
      //     path echoes `host.status.lifecycle.state`; a steady kill-switch on
      //     an already-active Host also echoes). Prefer FRESH so a heartbeat
      //     suspend/wake that landed under this write is preserved (never move
      //     suspended→active without a wake).
      //   - DIFFERS → the assessment INTENDED a transition and that override
      //     MUST win: kill-switch/rejection forcing active over a suspended
      //     snapshot, OR the resolveWakeBeforeScaleDown wake transition
      //     (stateless + active, derived from its OWN fresh wake read). Using
      //     `effective.stateless` alone would misclassify that wake transition
      //     as an echo and regress it back to suspended.
      // `reason` follows `state`: on the echo branch we re-source the
      // heartbeat-managed reason from fresh (mirroring the accepted-path
      // preservedReason logic); on the override branch the assessment's reason
      // (rejection message, or cleared) wins with its intended state.
      // `wakeHandledGeneration` is an ECHO in EVERY branch, never an intended
      // override, so it is kept monotonic against fresh and never regressed.
      let committedLifecycle: HostLifecycleStatus | undefined
      const result = await this.patchStatusWithPrecondition(host, fresh => {
        const freshStatus = fresh.status ?? {}
        const freshRejected = freshStatus.conditions?.find(
          c => c.type === STATELESS_REJECTED_CONDITION_TYPE
        )
        const freshPullPolicy = freshStatus.conditions?.find(
          c => c.type === STATELESS_PULL_POLICY_REJECTED_CONDITION_TYPE
        )
        const stamped = stampCondition(freshRejected, assessment.condition)
        const stampedPullPolicy = stampCondition(freshPullPolicy, assessment.pullPolicyCondition)
        const otherConditions = (freshStatus.conditions ?? []).filter(
          c =>
            c.type !== STATELESS_REJECTED_CONDITION_TYPE &&
            c.type !== STATELESS_PULL_POLICY_REJECTED_CONDITION_TYPE
        )
        const conditions = [...otherConditions, stamped, stampedPullPolicy]
        // Re-source the echoed lifecycle from fresh (see AP-1 note above).
        const freshLifecycle = freshStatus.lifecycle
        const wakeHandledGeneration = Math.max(
          assessment.lifecycle.wakeHandledGeneration,
          freshLifecycle?.wakeHandledGeneration ?? 0
        )
        const cachedState = host.status?.lifecycle?.state ?? 'active'
        // A rejection is an INTENDED reason override even when it does not
        // change state. The reject/kill-switch path sets
        // assessment.lifecycle = { state:'active', reason:<rejection message> }
        // with condition.status='True' (StatelessEnableRejected). When the
        // Host is ALREADY active a first-ever/steady rejection has
        // assessment.state ('active') === cachedState ('active'), so the plain
        // state-diff discriminator would route it to the ECHO branch, which
        // re-sources reason via isHeartbeatManagedLifecycleReason and DROPS the
        // rejection message (not heartbeat-managed) — silently losing the
        // rejection explanation the CRD documents. Detect it via the condition
        // transitioning to Rejected:True so the rejection reason is stamped on
        // the fresh state instead of folded into the heartbeat-managed-only
        // echo. (StatelessDisabled kill-switch carries status:'False' and no
        // lifecycle reason, so it never trips this branch.)
        const assessmentIsRejection = assessment.condition.status === 'True'
        const assessmentIntendsStateOverride = assessment.lifecycle.state !== cachedState
        let lifecycle: HostLifecycleStatus
        if (assessmentIntendsStateOverride) {
          // The assessment DIFFERS from the cached snapshot's state: it
          // INTENDED a transition (kill-switch/rejection forcing active over a
          // suspended snapshot, or a resolveWakeBeforeScaleDown wake
          // transition). That override wins; only wakeHandledGeneration stays
          // monotonic against fresh.
          lifecycle = { ...assessment.lifecycle, wakeHandledGeneration }
        } else if (assessmentIsRejection) {
          // Reject-while-active: state does not change, but the assessment's
          // rejection reason is an INTENDED override. Keep state from FRESH
          // (never reintroduce the 8th costume — a heartbeat suspend/wake that
          // landed since the snapshot must still be preserved) and stamp the
          // rejection reason onto it instead of dropping it into the
          // heartbeat-managed-only echo.
          lifecycle = {
            state: freshLifecycle?.state ?? 'active',
            wakeHandledGeneration,
            ...(assessment.lifecycle.reason !== undefined
              ? { reason: assessment.lifecycle.reason }
              : {}),
          }
        } else {
          // The assessment's state was a pass-through ECHO of the cached
          // snapshot — prefer the FRESH durable state and the heartbeat-managed
          // reason so a suspend/wake that landed since the snapshot is
          // preserved (never move suspended→active without a wake).
          const freshReason = isHeartbeatManagedLifecycleReason(freshLifecycle?.reason)
            ? freshLifecycle.reason
            : undefined
          lifecycle = {
            state: freshLifecycle?.state ?? 'active',
            wakeHandledGeneration,
            ...(freshReason !== undefined ? { reason: freshReason } : {}),
          }
        }
        if (freshStatus.lifecycle === undefined && freshStatus.conditions === undefined) {
          // A fresh Host has no /status yet: `add /status/lifecycle` would
          // fail on a missing parent, so seed the whole subresource once. All
          // subsequent writes take the targeted-op path below.
          committedLifecycle = lifecycle
          return this.fullStatusOps({ ...freshStatus, lifecycle, conditions })
        }
        // Targeted ops: never touch /status members this method did not
        // compute. The lifecycle written here is re-sourced from fresh for the
        // echoed fields (AP-1), so a heartbeat suspend/wake that landed under a
        // conditions-transition write is preserved instead of clobbered.
        committedLifecycle = lifecycle
        return [
          { op: 'add', path: '/status/lifecycle', value: lifecycle },
          { op: 'add', path: '/status/conditions', value: conditions },
        ]
      })
      if (!('skipped' in result)) {
        this.lastWrittenLifecycleStatus.set(host.name, desired)
        this.onLifecycleStatusCommitted(host, committedLifecycle ?? assessment.lifecycle)
        return true
      }
      return false
    } catch (err) {
      // Best-effort: a status-write failure (including 409-retry exhaustion)
      // is logged, not thrown — status writes must not block reconciliation.
      console.error(
        `[HostReconciler] Failed to write lifecycle status for "${host.name}" (${getErrorCode(err) ?? 'no code'}):`,
        err
      )
      return false
    }
  }

  // ─── Stateless heartbeat execution (Stage 3) ────────────────────────
  //
  // The StatelessLifecycleTracker DECIDES (drain verdicts, D8 idle gate,
  // podUid ordering); these methods EXECUTE. HostReconciler implements the
  // tracker's `StatelessLifecycleReconcilerPort` structurally.

  /** Public view of the synchronous effective-lifecycle derivation. */
  getEffectiveLifecycle(host: HostCRD): EffectiveHostLifecycle {
    return this.effectiveLifecycleFromCache(host)
  }

  /** Public view of the clerum.io/wake-requested generation parser. */
  getWakeRequestedGeneration(host: HostCRD): number {
    return this.wakeRequestedGeneration(host)
  }

  /**
   * FRESH GET (not the watch cache) of a Host, mirroring the
   * drained-pre-scale guard's read inside reconcileCore. The watch callback
   * builds a NEW HostCRD instance per ADDED/MODIFIED event, so two
   * independently-triggered heartbeat-path callers can hold DIFFERENT
   * instances for the same host and the in-memory `host.status` reflection
   * never propagates cross-instance. Heartbeat-path status writers therefore
   * guard against the CURRENT server-side lifecycle, never the snapshot they
   * were handed. Throws on GET failure — each caller logs loudly and the
   * next polled heartbeat retries.
   */
  async readFreshHost(host: HostCRD): Promise<HostCRD> {
    const response = await this.customApi.getNamespacedCustomObject({
      group: GROUP,
      version: VERSION,
      namespace: host.namespace,
      plural: PLURAL_HOSTS,
      name: host.name,
    })
    const obj = response as {
      metadata: {
        name: string
        namespace?: string
        uid?: string
        generation?: number
        resourceVersion?: string
        annotations?: Record<string, string>
      }
      spec: HostCRD['spec']
      status?: HostCRD['status']
    }
    const fresh: HostCRD = {
      name: obj.metadata.name,
      namespace: obj.metadata.namespace ?? host.namespace,
      uid: obj.metadata.uid,
      generation: obj.metadata.generation,
      // Preserve resourceVersion so heartbeat-path status writers can pass it
      // back as an optimistic-concurrency precondition (D3). Dropping it here
      // would force every write to be an unconditioned last-write-wins patch.
      resourceVersion: obj.metadata.resourceVersion,
      annotations: obj.metadata.annotations,
      spec: obj.spec,
      status: obj.status,
    }
    this.requireSameHostIdentity(host, fresh)
    return fresh
  }

  /**
   * Suspend a stateless Host after the drained report (or drain-grace
   * expiry): durable status flip FIRST (same crash-safety precedent as the
   * wake fast-path), then a full reconcile so replicas derive to 0. The core
   * re-reads the Host FRESH from the API and proceeds only when the CURRENT
   * server-side state is `draining` — a stale watch-cache snapshot can never
   * suspend a Host whose drain decision was overturned. The fresh read and
   * the status write THROW on failure — the tracker logs and the next
   * drained heartbeat retries. The wake fast-path + drained-pre-scale guard
   * inside reconcile() remain the last line of defense against a racing wake.
   *
   * `entryWakeHandledGeneration` (AP-1 generation epoch): the
   * `wakeHandledGeneration` the tracker observed on its Host snapshot when
   * it DECIDED this suspend. Fresh `draining` alone cannot prove the drain
   * decision is still current — an aged drain:true verdict can re-persist
   * `draining` (heartbeat poller) after a wake already cancelled the drain
   * and was handled, and that handled wake leaves requested==handled so
   * NOTHING would revive the suspended Host. The commit no-ops when the
   * fresh generation advanced past the epoch, or when a wake is pending in
   * fresh (see the guards in the build callback).
   */
  async suspendHostFromHeartbeat(
    host: HostCRD,
    reason: string,
    entryWakeHandledGeneration: number
  ): Promise<SuspendFromHeartbeatOutcome> {
    return this.serializeHeartbeatMutation(
      'heartbeat suspension',
      host,
      (admittedHost, revalidate) =>
        this.suspendHostFromHeartbeatCore(
          admittedHost,
          reason,
          entryWakeHandledGeneration,
          revalidate
        )
    )
  }

  private async suspendHostFromHeartbeatCore(
    host: HostCRD,
    reason: string,
    entryWakeHandledGeneration: number,
    revalidate?: () => HostCRD
  ): Promise<SuspendFromHeartbeatOutcome> {
    // FRESH GET (see readFreshHost): guard against the CURRENT server-side
    // lifecycle, not the caller's watch-cache snapshot. The guard is re-run
    // inside the D3 precondition helper's build callback so a 409-retry
    // re-reads and re-checks it against the newest server state.
    const initialFresh = await this.readFreshHost(host)
    let writtenStatus: HostCrdStatus | undefined
    // Outcome carried out of the build callback: every skip is 'skipped_stale'
    // (evidence aged/overturned — the tracker answers drain:false) except the
    // idempotent already-suspended retry. Re-evaluated on each 409 re-build.
    let skipOutcome: SuspendFromHeartbeatOutcome = 'skipped_stale'
    const result = await this.patchStatusWithPrecondition(
      host,
      fresh => {
        // UID proves object identity, not decision freshness. A same-identity
        // Host may have advanced from stateless to stateful while the watch
        // cache trails the API. Re-evaluate the complete effective stateless
        // policy from every fresh read/retry before honoring old heartbeat
        // evidence.
        if (
          !this.sameHostSpecRevision(host, fresh) ||
          !this.effectiveLifecycleFromCache(fresh).stateless
        ) {
          return { skip: true }
        }
        const freshLifecycle = fresh.status?.lifecycle
        if (freshLifecycle?.state !== 'draining') {
          // Every legitimate suspend follows a durable `draining` write (the
          // poller persists drain:true before the emitter can fence/flush, and
          // drain-grace is armed by the same verdict). A fresh CR that is NOT
          // draining means the drain decision has been overturned (a
          // cancel-drain or wake landed in between) — suspending would clobber
          // newer evidence. A fresh `suspended` returns as a SILENT idempotent
          // no-op: the drained-report retry path relies on exactly that.
          if (freshLifecycle?.state !== 'suspended') {
            console.log(
              `[HostReconciler] Suspend of stateless Host "${host.name}" skipped — fresh state "${freshLifecycle?.state ?? 'active'}" is not draining (drain decision overturned)`
            )
          }
          skipOutcome =
            freshLifecycle?.state === 'suspended' ? 'already_suspended' : 'skipped_stale'
          return { skip: true }
        }
        // AP-1 generation-epoch guard (aged drained evidence): a wake handled
        // AFTER the suspend decision bumps wakeHandledGeneration (wake
        // fast-path) — the pod was un-fenced and may have served turns, and
        // with requested==handled nothing would ever revive the Host after a
        // scale-down. A fresh handled generation past the caller's entry
        // epoch therefore no-ops the suspend; the emitter's next drained
        // report retries on current evidence. Do NOT key this on "fresh
        // state is active": every normal suspension commits over `draining`,
        // and an aged drain:true verdict can legitimately re-persist
        // `draining` after the wake — the generation is the only safe
        // discriminator. This applies to max-uptime drains too: skipping
        // strands nothing (the over-age pod is recycled on its next idle
        // drain cycle), while suspending would strand a just-demanded Host
        // with no reviver.
        const freshHandled = freshLifecycle.wakeHandledGeneration ?? 0
        if (freshHandled > entryWakeHandledGeneration) {
          console.log(
            `[StatelessSuspend] host=${host.name} phase=drained_report_stale reason=wake_handled_since entryGeneration=${entryWakeHandledGeneration} freshGeneration=${freshHandled} ts=${this.now().getTime()}`
          )
          return { skip: true }
        }
        // Pending-wake mirror (the wake-annotation-not-yet-processed flavor
        // of the same race): a fresh requested generation above handled is a
        // wake in flight right now — resolveWakeBeforeScaleDown would abort
        // the scale-down later, but skipping here avoids committing a
        // suspended state that must immediately be overturned.
        const freshRequested = this.wakeRequestedGeneration(fresh)
        if (freshRequested > freshHandled) {
          console.log(
            `[StatelessSuspend] host=${host.name} phase=drained_report_stale reason=wake_pending requestedGeneration=${freshRequested} handledGeneration=${freshHandled} ts=${this.now().getTime()}`
          )
          return { skip: true }
        }
        // Both the write base and the wake generation come from the FRESH
        // object, so a stale snapshot can never regress wakeHandledGeneration.
        const lifecycle: HostLifecycleStatus = {
          state: 'suspended',
          wakeHandledGeneration: freshLifecycle.wakeHandledGeneration ?? 0,
          reason,
        }
        writtenStatus = { ...(fresh.status ?? {}), lifecycle }
        return this.fullStatusOps(writtenStatus)
      },
      initialFresh,
      revalidate
    )
    if ('skipped' in result || writtenStatus === undefined) {
      return skipOutcome
    }
    // Revalidate authority/UID immediately before follow-on effects, then read
    // once more from the API. The successful PATCH attempt's fresh object is
    // the exact spec on which the status write committed, but a wake/spec
    // update can land immediately AFTER that commit and BEFORE runtime
    // reconciliation. A linearizable follow-on GET observes both our durable
    // suspended write and any such newer same-UID update; the watch cache can
    // legitimately trail either one.
    const currentAtFollowOn = revalidate?.()
    if (currentAtFollowOn) this.requireSameHostIdentity(host, currentAtFollowOn)
    this.reflectOutcome(host, target => {
      target.status = writtenStatus
    })
    const reconcileHost = await this.readFreshHost(result.fresh)
    if (!this.sameHostSpecRevision(host, reconcileHost)) {
      const error = new Error(
        `Host spec generation changed before heartbeat suspension follow-on for "${host.name}"`
      )
      error.name = 'HostMutationSpecRevisionChangedError'
      throw error
    }
    const currentAfterFollowOnRead = revalidate?.()
    if (currentAfterFollowOnRead) {
      this.requireSameHostIdentity(host, currentAfterFollowOnRead)
    }
    this.lastWrittenLifecycleStatus.delete(host.name)
    this.logSuspendedApplied(host.name)
    console.log(
      `[HostReconciler] Suspending stateless Host "${host.name}" (reason: ${reason}) — reconciling to replicas=0`
    )
    // L2: call reconcileCore (not the serialized reconcile) — this method
    // already runs inside this host's serialization slot, so re-entering the
    // per-host chain here would self-deadlock.
    await this.reconcileCore(reconcileHost, revalidate)
    // Preserve the historical caller-visible reflection contract even when
    // follow-on work correctly used a fresher API object. The tracker may hold
    // the originally admitted instance until the watch delivers the next
    // MODIFIED event; reflect the final authoritative outcome immediately so
    // it cannot make a second decision from the pre-follow-on status.
    this.reflectOutcome(host, target => {
      target.uid = reconcileHost.uid
      target.generation = reconcileHost.generation
      target.resourceVersion = reconcileHost.resourceVersion
      target.annotations = reconcileHost.annotations
      target.spec = reconcileHost.spec
      target.status = reconcileHost.status
    })
    // The wake fast-path / drained-pre-scale guard inside reconcile() may
    // have flipped the host back to active (a wake raced the suspension) —
    // in that case no scale-down happened, so no phase/metric is emitted.
    const wakePending =
      this.wakeRequestedGeneration(reconcileHost) >
      (reconcileHost.status?.lifecycle?.wakeHandledGeneration ?? 0)
    if (reconcileHost.status?.lifecycle?.state !== 'suspended' || wakePending) {
      // The durable suspended write DID commit (a racing wake revived the
      // host afterwards), so the drained evidence was honored: 'suspended'.
      return 'suspended'
    }
    this.recordSuspendedApplied(reconcileHost.name)
    return 'suspended'
  }

  /**
   * Publish the D8 condition blocking suspension into
   * status.lifecycle.reason. Change-only: an unchanged reason is a no-op
   * (heartbeats arrive every ~30s; steady state must not churn the CRD).
   * Throws on API failure — the tracker logs it loudly.
   */
  async publishSuspendBlockedReason(host: HostCRD, reason: string): Promise<void> {
    return this.serializeHeartbeatMutation(
      'heartbeat suspend-blocked reason publication',
      host,
      (admittedHost, revalidate) =>
        this.publishSuspendBlockedReasonCore(admittedHost, reason, revalidate)
    )
  }

  private async publishSuspendBlockedReasonCore(
    host: HostCRD,
    reason: string,
    revalidate?: () => HostCRD
  ): Promise<void> {
    // FRESH GET (see readFreshHost): this is a suspend-BLOCKED reason
    // ANNOTATOR, not a state writer — it must NEVER change state, only stamp
    // the reason on top of the CURRENT server-side state. AP-1 (the 9th
    // costume): the earlier implementation read state from the CACHED
    // `host.status` snapshot and spread the whole `/status` with NO
    // resourceVersion precondition. The tracker's `!idleEligible` branch calls
    // cancelDrainOnEvidence(hostRef, host) then publishSuspendBlockedReason(host)
    // against the SAME host ref; if a suspend landed on the serializeByHost
    // chain first, cancelDrainOnEvidence's fresh guard skips (fresh is no
    // longer draining) leaving host.status stale `draining`, and this writer
    // would then re-source that stale `draining` and write state back —
    // resurrecting a just-suspended Host (replicas derive from state) with no
    // wake and no precondition to catch it. So we re-source state +
    // wakeHandledGeneration from FRESH inside the D3 precondition callback,
    // GUARD against fresh states where a suspend-blocked reason is no longer
    // meaningful (fresh `suspended`/`draining` — the Host is no longer being
    // kept active/blocked), and emit ONLY a targeted /status/lifecycle op.
    const initialFresh = await this.readFreshHost(host)
    let writtenLifecycle: HostLifecycleStatus | undefined
    const result = await this.patchStatusWithPrecondition(
      host,
      fresh => {
        if (
          !this.sameHostSpecRevision(host, fresh) ||
          !this.effectiveLifecycleFromCache(fresh).stateless
        ) {
          return { skip: true }
        }
        const freshLifecycle = fresh.status?.lifecycle
        const freshState = freshLifecycle?.state ?? 'active'
        if (freshState !== 'active') {
          // A suspend-blocked reason only annotates a Host being KEPT active.
          // Fresh `suspended`/`draining` means the state changed underneath
          // (a suspend/drain landed first) — writing the reason would either
          // resurrect a suspended Host or misannotate a draining one. No-op.
          return { skip: true }
        }
        // Re-evaluate the change-only idempotency short-circuit against fresh:
        // an unchanged reason on the fresh active state is a no-op (heartbeats
        // arrive ~30s; steady state must not churn the CRD).
        if (freshLifecycle?.reason === reason) {
          return { skip: true }
        }
        const lifecycle: HostLifecycleStatus = {
          state: freshState,
          wakeHandledGeneration: freshLifecycle?.wakeHandledGeneration ?? 0,
          reason,
        }
        writtenLifecycle = lifecycle
        return [{ op: 'add', path: '/status/lifecycle', value: lifecycle }]
      },
      initialFresh,
      revalidate
    )
    if ('skipped' in result || writtenLifecycle === undefined) {
      return
    }
    const reflectedStatus = { ...(host.status ?? {}), lifecycle: writtenLifecycle }
    this.reflectOutcome(host, target => {
      target.status = reflectedStatus
    })
    this.lastWrittenLifecycleStatus.delete(host.name)
  }

  /**
   * Persist the tracker's drain decision durably. With heartbeats ingested
   * by control-api (which answers the emitter's `{drain}` verdict from
   * `status.lifecycle.state`), this status write is the ONLY channel through
   * which a drain decision reaches the pod. Idempotent by state: only an
   * `active` Host flips to `draining` — an already-draining Host is a no-op
   * and a `suspended` Host (drained-report suspension in the same poll pass)
   * is never clobbered back. The state guard runs against a FRESH API read
   * of the Host, never the caller's watch-cache snapshot (a stale `active`
   * snapshot over an actually-suspended CR must not write a running state
   * over it). Fresh `active` alone is NOT sufficient (AP-1): `active` is
   * exactly the state a just-handled wake produces, so an AGED drain verdict
   * queued behind that wake would re-fence the woken pod — and its consumed
   * wake (requested==handled) revives nothing. The commit therefore also
   * carries the tracker's `entryWakeHandledGeneration` epoch from VERDICT
   * time and no-ops when the fresh handled generation advanced past it, or
   * when a wake is pending in fresh. The stale suspend-blocked reason is dropped on
   * the flip (the Host is draining, not blocked). Throws on API failure —
   * the poller logs it loudly and the next polled beat retries. Cancel-drain
   * (`draining` → `active`) is executed by the tracker via
   * markHostActiveFromHeartbeat on activity/pending-wake evidence; the wake
   * fast-path also flips it back and remains the only reviver of a
   * `suspended` Host.
   */
  async markHostDrainingFromHeartbeat(
    host: HostCRD,
    entryWakeHandledGeneration: number
  ): Promise<void> {
    return this.serializeHeartbeatMutation(
      'heartbeat draining transition',
      host,
      (admittedHost, revalidate) =>
        this.markHostDrainingFromHeartbeatCore(admittedHost, entryWakeHandledGeneration, revalidate)
    )
  }

  private async markHostDrainingFromHeartbeatCore(
    host: HostCRD,
    entryWakeHandledGeneration: number,
    revalidate?: () => HostCRD
  ): Promise<void> {
    // FRESH GET (see readFreshHost): a stale `active` snapshot over an
    // actually-`suspended` CR would write `draining` (a running state) and
    // the next reconcile would resurrect the pod with NO wake. Proceed only
    // when the CURRENT server-side state is active. The guard runs inside the
    // D3 precondition helper's build callback so a 409-retry re-checks it.
    const initialFresh = await this.readFreshHost(host)
    let writtenStatus: HostCrdStatus | undefined
    const result = await this.patchStatusWithPrecondition(
      host,
      fresh => {
        if (
          !this.sameHostSpecRevision(host, fresh) ||
          !this.effectiveLifecycleFromCache(fresh).stateless
        ) {
          return { skip: true }
        }
        const freshLifecycle = fresh.status?.lifecycle
        if ((freshLifecycle?.state ?? 'active') !== 'active') {
          return { skip: true }
        }
        // AP-1 generation-epoch guard (aged drain verdict): a wake handled
        // AFTER this verdict was decided bumps wakeHandledGeneration and
        // leaves the CR `active` — the exact state this writer commits over.
        // Re-writing `draining` from the aged verdict would re-fence the
        // just-woken pod with requested==handled (nothing revives it). A
        // fresh handled generation past the verdict's entry epoch therefore
        // no-ops the write; the next polled beat re-decides on fresh
        // evidence.
        const freshHandled = freshLifecycle?.wakeHandledGeneration ?? 0
        if (freshHandled > entryWakeHandledGeneration) {
          console.log(
            `[StatelessSuspend] host=${host.name} phase=draining_write_stale reason=wake_handled_since entryGeneration=${entryWakeHandledGeneration} freshGeneration=${freshHandled} ts=${this.now().getTime()}`
          )
          return { skip: true }
        }
        // Pending-wake mirror: a wake in flight right now cancels the drain
        // by definition ("pending wake wins") — never fence over it.
        const freshRequested = this.wakeRequestedGeneration(fresh)
        if (freshRequested > freshHandled) {
          console.log(
            `[StatelessSuspend] host=${host.name} phase=draining_write_stale reason=wake_pending requestedGeneration=${freshRequested} handledGeneration=${freshHandled} ts=${this.now().getTime()}`
          )
          return { skip: true }
        }
        const lifecycle: HostLifecycleStatus = {
          state: 'draining',
          wakeHandledGeneration: freshHandled,
        }
        writtenStatus = { ...(fresh.status ?? {}), lifecycle }
        return this.fullStatusOps(writtenStatus)
      },
      initialFresh,
      revalidate
    )
    if ('skipped' in result || writtenStatus === undefined) {
      return
    }
    this.reflectOutcome(host, target => {
      target.status = writtenStatus
    })
    this.lastWrittenLifecycleStatus.delete(host.name)
    console.log(
      `[HostReconciler] Marked stateless Host "${host.name}" draining — control-api now answers {drain:true} from Host.status`
    )
  }

  /**
   * Tracker-side cancel-drain: revert an in-flight drain when the tracker
   * sees HOST evidence (activity or a pending wake) on a polled heartbeat
   * while the CR still says `draining`. Without this write the emitter is
   * wedged behind the fence whenever the rpc-proxy wake call never lands —
   * control-api keeps answering {drain:true} from Host.status while the
   * tracker keeps deciding drain:false. Guarded by state against a FRESH
   * API read of the Host (never the caller's watch-cache snapshot): ONLY a
   * currently-`draining` Host reverts — `active` is a no-op and `suspended`
   * is NEVER touched
   * (reviving a suspended Host is exclusively the wake fast-path's job).
   * Throws on API failure — the tracker logs it loudly and the next polled
   * heartbeat retries.
   */
  async markHostActiveFromHeartbeat(host: HostCRD): Promise<void> {
    return this.serializeHeartbeatMutation(
      'heartbeat cancel-drain transition',
      host,
      (admittedHost, revalidate) => this.markHostActiveFromHeartbeatCore(admittedHost, revalidate)
    )
  }

  private async markHostActiveFromHeartbeatCore(
    host: HostCRD,
    revalidate?: () => HostCRD
  ): Promise<void> {
    // FRESH GET (see readFreshHost): a stale `draining` snapshot over an
    // actually-`suspended` CR must never resurrect it (and would regress
    // wakeHandledGeneration). Proceed only when the CURRENT server-side
    // state is draining; the wake generation comes from the fresh lifecycle.
    // The guard runs inside the D3 precondition helper's build callback so a
    // 409-retry re-checks it against the newest server state.
    const initialFresh = await this.readFreshHost(host)
    let skippedNotDraining: string | undefined
    let writtenStatus: HostCrdStatus | undefined
    const result = await this.patchStatusWithPrecondition(
      host,
      fresh => {
        if (
          !this.sameHostSpecRevision(host, fresh) ||
          !this.effectiveLifecycleFromCache(fresh).stateless
        ) {
          return { skip: true }
        }
        const freshLifecycle = fresh.status?.lifecycle
        if (freshLifecycle?.state !== 'draining') {
          skippedNotDraining = freshLifecycle?.state ?? 'active'
          return { skip: true }
        }
        const lifecycle: HostLifecycleStatus = {
          state: 'active',
          wakeHandledGeneration: freshLifecycle.wakeHandledGeneration ?? 0,
        }
        writtenStatus = { ...(fresh.status ?? {}), lifecycle }
        return this.fullStatusOps(writtenStatus)
      },
      initialFresh,
      revalidate
    )
    if ('skipped' in result || writtenStatus === undefined) {
      console.log(
        `[StatelessLifecycle] host=${host.name} cancel-drain skipped — fresh state "${skippedNotDraining ?? 'active'}" is not draining`
      )
      return
    }
    this.reflectOutcome(host, target => {
      target.status = writtenStatus
    })
    this.lastWrittenLifecycleStatus.delete(host.name)
    console.log(
      `[StatelessLifecycle] host=${host.name} cancel-drain: activity evidence while draining — reverting status to active`
    )
  }

  /**
   * Resolve a Host pod's creationTimestamp by pod UID (max-uptime ceiling).
   * The mcp-host Deployment selector is `app=<host.name>` (see
   * buildDeployment). Returns null when no pod with that UID is visible.
   */
  async findPodCreationTimestamp(host: HostCRD, podUid: string): Promise<Date | null> {
    const pods = await this.coreApi.listNamespacedPod({
      namespace: host.namespace,
      labelSelector: `app=${host.name}`,
    })
    for (const pod of pods.items ?? []) {
      if (pod.metadata?.uid === podUid) {
        return pod.metadata.creationTimestamp ? new Date(pod.metadata.creationTimestamp) : null
      }
    }
    return null
  }

  // ─── Wake fast-path (Stage 4.3) ─────────────────────────────────────

  /**
   * Parse the clerum.io/wake-requested annotation into a monotonic wake
   * generation. Absent means no wake intent (0). A malformed (non-integer)
   * value is also treated as no wake intent and logged loudly once per
   * distinct value, so a broken writer is operator-visible without flooding
   * the periodic-resync log. Never throws.
   */
  private wakeRequestedGeneration(host: HostCRD): number {
    const raw = host.annotations?.[WAKE_REQUESTED_ANNOTATION]
    if (raw === undefined) {
      return 0
    }
    const parsed = Number.parseInt(raw, 10)
    if (Number.isNaN(parsed)) {
      if (this.malformedWakeAnnotationLogged.get(host.name) !== raw) {
        this.malformedWakeAnnotationLogged.set(host.name, raw)
        console.error(
          `[HostReconciler] Malformed ${WAKE_REQUESTED_ANNOTATION} annotation on Host "${host.name}": ${JSON.stringify(
            raw
          )} is not an integer; treating it as no wake intent`
        )
      }
      return 0
    }
    this.malformedWakeAnnotationLogged.delete(host.name)
    return parsed
  }

  /**
   * Wake fast-path: runs at the very start of reconcile() for stateless
   * Hosts — the watch-event callback AND the periodic resync both funnel
   * through reconcile(), so a wake event dropped on a watch disconnect is
   * recovered at the next resync. A wake generation above
   * status.lifecycle.wakeHandledGeneration is a pending wake, executed by
   * CURRENT durable state:
   *   - suspended → flip to active + minimal replicas=1 scale patch on the
   *     existing Deployment (a missing Deployment falls through to the full
   *     reconcile, which builds it with replicas=1)
   *   - draining  → cancel-drain: flip to active; replicas were never
   *     dropped, so no scale call is issued
   *   - active    → record wakeHandledGeneration only (no-op wake; keeps
   *     the comparison monotonic)
   * Repeated events carrying an already-handled generation are no-ops. The
   * fast-path NEVER awaits pod readiness: the watch callback is serial for
   * the whole fleet, so it is bounded to one fresh GET + one status write +
   * one scale patch (wakes are user-triggered and rare). AP-1: the pending
   * wake and the transition are re-decided from a FRESH read at the commit
   * point and written as a TARGETED /status/lifecycle op under the D3
   * resourceVersion precondition — see the notes inside.
   */
  async handleWakeFastPath(host: HostCRD): Promise<boolean> {
    if (host.spec.lifecycle?.stateless !== true) {
      return false
    }
    const wakeRequested = this.wakeRequestedGeneration(host)
    const wakeHandled = host.status?.lifecycle?.wakeHandledGeneration ?? 0
    if (wakeRequested <= wakeHandled) {
      return false
    }

    // AP-1 (the 10th costume): the cached gate above only DISCOVERS a
    // potentially-pending wake — the commit is re-decided from a FRESH read
    // below. The previous implementation decided requested/handled from the
    // CACHED snapshot and spread the whole cached `/status` with no
    // resourceVersion precondition, so a snapshot captured before a hardened
    // sibling's write on the same serialized chain silently resurrected that
    // sibling's fresher conditions/reason. A fresh-read failure is logged
    // and returns without a write — the wake is NOT lost: the annotation is
    // durable, the drained-pre-scale guard re-checks it before any
    // replicas:0 apply, and the periodic resync re-enters this fast-path.
    let initialFresh: HostCRD
    try {
      initialFresh = await this.readFreshHost(host)
    } catch (err) {
      console.error(
        `[HostReconciler] Wake fast-path fresh Host read failed for "${host.name}" (${getErrorCode(err) ?? 'no code'}):`,
        err
      )
      return false
    }
    const freshWakeRequested = this.wakeRequestedGeneration(initialFresh)
    const freshWakeHandled = initialFresh.status?.lifecycle?.wakeHandledGeneration ?? 0
    if (freshWakeRequested <= freshWakeHandled) {
      // A sibling writer (or a prior fast-path pass over another snapshot)
      // already handled this wake: no write, and the wake phases are NOT
      // logged a second time (they were emitted by whoever handled it).
      // Reflect the fresh truth on the in-memory object so the heavy
      // reconcile body derives replicas from the current durable state
      // instead of the stale event payload.
      this.reflectOutcome(host, target => {
        target.annotations = initialFresh.annotations
        target.status = initialFresh.status
      })
      return false
    }

    const currentState = initialFresh.status?.lifecycle?.state ?? 'active'
    console.log(
      `[HostReconciler] Wake fast-path for "${host.name}": generation ${freshWakeRequested} > handled ${freshWakeHandled} while ${currentState}`
    )
    // Stage 6 (W2): machine-parseable wake-phase timestamps for the
    // wake-budget script. One line per phase, correlated by generation.
    console.log(
      `[StatelessWake] host=${host.name} generation=${freshWakeRequested} phase=wake_observed ts=${this.now().getTime()}`
    )

    // Durable flip FIRST: the woken state must survive an HCC crash between
    // this write and the scale patch (the resync re-derives replicas from
    // the CRD status, not from HCC memory). The write goes through the D3
    // precondition helper: the build callback re-decides requested/handled
    // from FRESH (a 409-retry re-reads and respects a racing sibling's newer
    // write, returning skip) and emits ONLY a targeted /status/lifecycle op,
    // so fresh conditions and a fresher heartbeat-managed reason are never
    // spread over. Every wake transition lands on active; the stale cached
    // reason is dropped, mirroring markHostActiveFromHeartbeatCore and
    // resolveWakeBeforeScaleDown (the change-only suspend-blocked publisher
    // re-stamps a still-valid reason on the next heartbeat).
    let latestFresh = initialFresh
    let writtenLifecycle: HostLifecycleStatus | undefined
    let commitState = currentState
    try {
      const result = await this.patchStatusWithPrecondition(
        host,
        fresh => {
          latestFresh = fresh
          const freshLifecycle = fresh.status?.lifecycle
          const buildRequested = this.wakeRequestedGeneration(fresh)
          const buildHandled = freshLifecycle?.wakeHandledGeneration ?? 0
          if (buildRequested <= buildHandled) {
            // A racing writer handled the wake between the fresh read and
            // this (re)build — skip: no write, no duplicate wake phases.
            return { skip: true }
          }
          commitState = freshLifecycle?.state ?? 'active'
          const lifecycle: HostLifecycleStatus = {
            state: 'active',
            wakeHandledGeneration: buildRequested,
          }
          writtenLifecycle = lifecycle
          if (fresh.status?.lifecycle === undefined && fresh.status?.conditions === undefined) {
            // A fresh Host has no /status yet: `add /status/lifecycle` would
            // fail on a missing parent, so seed the whole subresource once
            // (there are no fresher conditions to spread over when /status
            // does not exist) — same seed as writeLifecycleStatusToCluster.
            return this.fullStatusOps({ ...(fresh.status ?? {}), lifecycle })
          }
          return [{ op: 'add', path: '/status/lifecycle', value: lifecycle }]
        },
        initialFresh
      )
      if ('skipped' in result || writtenLifecycle === undefined) {
        this.reflectOutcome(host, target => {
          target.annotations = latestFresh.annotations
          target.status = latestFresh.status
        })
        return false
      }
    } catch (err) {
      // Same precedent as writeLifecycleStatusToCluster: a status-write
      // failure is logged and retried on the next pass. The wake is NOT
      // lost — the annotation is durable and the drained-pre-scale guard in
      // reconcile() re-checks it before any replicas:0 apply, so a pending
      // wake can never be raced away by the suspension.
      console.error(
        `[HostReconciler] Wake fast-path status write failed for "${host.name}" (${getErrorCode(err) ?? 'no code'}):`,
        err
      )
      return false
    }
    // Reflect the flip on the in-memory object so the heavy reconcile body
    // (assessLifecycle reads host.status) derives replicas from the woken
    // state instead of re-suspending from the stale event payload. The base
    // is the FRESH status the write committed over, never the cached spread.
    const reflectedStatus = { ...(latestFresh.status ?? {}), lifecycle: writtenLifecycle }
    this.reflectOutcome(host, target => {
      target.annotations = latestFresh.annotations
      target.status = reflectedStatus
    })
    console.log(
      `[StatelessWake] host=${host.name} generation=${writtenLifecycle.wakeHandledGeneration} phase=status_flipped ts=${this.now().getTime()}`
    )

    if (commitState !== 'suspended') {
      // draining (cancel-drain) or active (record-only): replicas were
      // never dropped — no scale call.
      return false
    }

    // Minimal scale patch — NOT the full buildDeployment replace. It also
    // starts the pod even when the heavy body aborts early (e.g. on a
    // transient Secret read failure).
    try {
      await this.appsApi.patchNamespacedDeployment(
        { name: host.name, namespace: host.namespace, body: { spec: { replicas: 1 } } },
        {
          middleware: [
            k8s.setHeaderMiddleware('Content-Type', 'application/strategic-merge-patch+json'),
          ],
        }
      )
      console.log(`[HostReconciler] Wake fast-path scaled Deployment "${host.name}" to replicas=1`)
      console.log(
        `[StatelessWake] host=${host.name} generation=${writtenLifecycle.wakeHandledGeneration} phase=replicas_patched ts=${this.now().getTime()}`
      )
      this.markHostNotSuspended(host.name)
      this.recordScaleTransition(host.name, 'up')
      return true
    } catch (err) {
      if (getErrorCode(err) === 404) {
        // Deployment missing (e.g. deleted while suspended): fall through —
        // the full reconcile below builds it with replicas=1.
        console.log(
          `[HostReconciler] Wake fast-path: Deployment "${host.name}" not found; the full reconcile will create it`
        )
        return true
      }
      if (getErrorCode(err) === 403) {
        // Compatibility with deployed RBAC that grants update but not patch on
        // mcp-host Deployments. Keep the fast-path bounded to replicas only by
        // reusing the current object and preserving its resourceVersion.
        try {
          const deployment = await this.appsApi.readNamespacedDeployment({
            name: host.name,
            namespace: host.namespace,
          })
          if (!deployment.spec) {
            throw new Error('deployment has no spec')
          }
          deployment.spec.replicas = 1
          await this.appsApi.replaceNamespacedDeployment({
            name: host.name,
            namespace: host.namespace,
            body: deployment,
          })
          console.warn(
            `[HostReconciler] Wake fast-path scale patch forbidden for "${host.name}"; used deployment update fallback`
          )
          console.log(
            `[HostReconciler] Wake fast-path scaled Deployment "${host.name}" to replicas=1`
          )
          console.log(
            `[StatelessWake] host=${host.name} generation=${writtenLifecycle.wakeHandledGeneration} phase=replicas_patched ts=${this.now().getTime()}`
          )
          this.markHostNotSuspended(host.name)
          this.recordScaleTransition(host.name, 'up')
          return true
        } catch (fallbackErr) {
          console.error(
            `[HostReconciler] Wake fast-path deployment update fallback failed for "${host.name}":`,
            fallbackErr
          )
          return true
        }
      }
      // Surfaced loudly; ensureDeployment in this same reconcile pass
      // replaces the Deployment with replicas=1, so nothing is masked.
      console.error(`[HostReconciler] Wake fast-path scale patch failed for "${host.name}":`, err)
      return true
    }
  }

  /**
   * Stage 6 scale-transition metric: one counter line per replicas 0→1 (up)
   * or 1→0 (down) transition driven by the wake fast-path or the heartbeat
   * suspension. Totals live in HCC memory only and reset on restart —
   * acceptable: the wake-budget script correlates within one HCC run.
   */
  private recordScaleTransition(hostName: string, direction: 'up' | 'down'): void {
    const total = (this.scaleTransitionsByHost.get(hostName) ?? 0) + 1
    this.scaleTransitionsByHost.set(hostName, total)
    console.log(
      `[StatelessMetric] scale_transition host=${hostName} direction=${direction} total=${total}`
    )
  }

  recordSuspendedApplied(hostName: string): void {
    this.logSuspendedApplied(hostName)
    if (this.suspendedScaleMetricRecordedByHost.has(hostName)) {
      return
    }
    this.suspendedScaleMetricRecordedByHost.add(hostName)
    this.recordScaleTransition(hostName, 'down')
  }

  private logSuspendedApplied(hostName: string): void {
    if (this.suspendedAppliedLoggedByHost.has(hostName)) {
      return
    }
    this.suspendedAppliedLoggedByHost.add(hostName)
    console.log(
      `[StatelessSuspend] host=${hostName} phase=suspended_applied ts=${this.now().getTime()}`
    )
  }

  markHostNotSuspended(hostName: string): void {
    this.suspendedAppliedLoggedByHost.delete(hostName)
    this.suspendedScaleMetricRecordedByHost.delete(hostName)
  }

  /**
   * RFC 6902 JSON Patch op. `add` replaces an existing member and creates a
   * missing one; `test` is used only for structural preconditions we do not
   * currently need (resourceVersion is enforced via an `add` op on
   * /metadata/resourceVersion, honored by the apiserver as an
   * optimistic-concurrency precondition).
   */
  private prependResourceVersionOp(
    resourceVersion: string | undefined,
    ops: Array<{ op: 'add'; path: string; value: unknown }>
  ): Array<{ op: 'add'; path: string; value: unknown }> {
    if (resourceVersion === undefined) {
      // A watch-cache snapshot with no resourceVersion falls back to an
      // unconditioned write — but every heartbeat-path caller reads fresh
      // first, so that fallback never fires in practice.
      return ops
    }
    // metadata.resourceVersion carried on the object being written is honored
    // by the apiserver as an optimistic-concurrency precondition: the patch is
    // rejected with 409 if the CR changed since the read that produced this
    // resourceVersion (Kubernetes API concepts, "Updates to existing
    // resources").
    return [{ op: 'add', path: '/metadata/resourceVersion', value: resourceVersion }, ...ops]
  }

  /**
   * D3: write a Host /status subresource under an optimistic-concurrency
   * precondition with a bounded 409-retry, mirroring control-api's
   * patchAnnotationMonotonic. `build` runs against a FRESH read of the Host
   * and returns either the JSON Patch ops to apply or `{ skip: true }` when the
   * guard no longer holds (e.g. the drain decision was overturned between the
   * caller's read and this write). On a 409 the loop re-reads fresh, re-runs
   * `build` (so the guard is re-checked against the newest server state) and
   * re-patches; exhausting the attempts throws loudly so the caller logs it
   * and the next heartbeat retries. `initialFresh` is the fresh read the
   * caller already performed on attempt 1 (avoids a redundant GET); pass
   * undefined to have the helper read fresh itself. The helper prepends the
   * resourceVersion precondition op from the fresh read to whatever ops
   * `build` returns.
   *
   * SINGLE-REPLICA COUPLING: this precondition defends against concurrent
   * writers, but HCC's safety model still assumes replicas:1 without leader
   * election (see warnSingleReplicaInvariantOnce) — the serializeByHost chain
   * only orders writers WITHIN one process. The 409-retry closes the residual
   * cross-writer window that serialization alone cannot.
   */
  private async patchStatusWithPrecondition(
    host: HostCRD,
    build: (fresh: HostCRD) => Array<{ op: 'add'; path: string; value: unknown }> | { skip: true },
    initialFresh?: HostCRD,
    revalidate?: () => HostCRD
  ): Promise<{ fresh: HostCRD } | { skipped: true }> {
    const maxAttempts = 5
    let fresh = initialFresh
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const currentAtAttempt = revalidate?.()
      if (currentAtAttempt) this.requireSameHostIdentity(host, currentAtAttempt)
      if (fresh === undefined) {
        fresh = await this.readFreshHost(host)
      }
      if (host.uid !== undefined && fresh.resourceVersion === undefined) {
        const error = new Error(
          `Host status mutation for "${host.name}" has no fresh resourceVersion; refusing an unconditioned write`
        )
        error.name = 'HostMutationPreconditionUnavailableError'
        throw error
      }
      const built = build(fresh)
      if ('skip' in built) {
        return { skipped: true }
      }
      try {
        const currentBeforePatch = revalidate?.()
        if (currentBeforePatch) this.requireSameHostIdentity(host, currentBeforePatch)
        await this.customApi.patchNamespacedCustomObjectStatus({
          group: GROUP,
          version: VERSION,
          namespace: host.namespace,
          plural: PLURAL_HOSTS,
          name: host.name,
          body: this.prependResourceVersionOp(fresh.resourceVersion, built),
        })
        return { fresh }
      } catch (err) {
        if (getErrorCode(err) === 409) {
          if (attempt < maxAttempts) {
            // The CR changed under us (a concurrent lifecycle writer or an
            // unrelated metadata write). Re-read fresh and re-evaluate the
            // guard so a decision the racing writer just made is respected.
            console.warn(
              `[HostReconciler] Status write for "${host.name}" hit 409 (stale resourceVersion); re-reading fresh and retrying (attempt ${attempt}/${maxAttempts})`
            )
            fresh = undefined
            continue
          }
          // Bounded retries exhausted on a persistent conflict: fail LOUD with
          // a descriptive message (never swallow, never last-write-wins).
          throw new Error(
            `[HostReconciler] Status write for "${host.name}" failed after ${maxAttempts} attempts (persistent 409 conflict)`
          )
        }
        throw err
      }
    }
    // Unreachable: the loop either returns, retries, or throws above.
    throw new Error(
      `[HostReconciler] Status write for "${host.name}" exited its retry loop unexpectedly`
    )
  }

  /** Full-status `/status` write ops (used by the heartbeat-path cores). */
  private fullStatusOps(status: HostCrdStatus): Array<{ op: 'add'; path: string; value: unknown }> {
    // `add` (not `replace`): add replaces an existing member and creates a
    // missing one, and a fresh Host has no /status yet.
    return [{ op: 'add', path: '/status', value: status }]
  }

  /**
   * L2: serialize `work` for a single host onto that host's promise chain so
   * concurrent callers (watch MODIFIED events, periodic resync, SFS/CC/Context
   * fan-out, and the heartbeat tracker) never interleave writes for the same
   * host. Work for DIFFERENT hosts runs concurrently. Errors propagate to the
   * caller; a rejected slot must NOT poison the chain, so the stored tail is
   * the settled (caught) promise while the caller still sees the real result.
   */
  serializeByHost<T>(hostName: string, work: () => Promise<T>): Promise<T> {
    const prior = this.reconcileChainByHost.get(hostName) ?? Promise.resolve()
    const result = prior.then(work)
    // Tail swallows rejection so the next queued call still runs; drop the
    // entry once it is the current tail to avoid unbounded map growth.
    const tail = result.then(
      () => undefined,
      () => undefined
    )
    this.reconcileChainByHost.set(hostName, tail)
    void tail.then(() => {
      if (this.reconcileChainByHost.get(hostName) === tail) {
        this.reconcileChainByHost.delete(hostName)
      }
    })
    return result
  }

  /**
   * Capture admission before enqueueing, then resolve the current Host only
   * after this mutation reaches the front of its own serializer. Keeping the
   * check here avoids wrapping a lifecycle call in HostReconciler's serializer,
   * which would recursively acquire the same Host chain and deadlock.
   */
  private serializeHeartbeatMutation<T>(
    action: string,
    host: HostCRD,
    work: (admittedHost: HostCRD, revalidate: () => HostCRD) => Promise<T>
  ): Promise<T> {
    const revalidate = this.prepareHostMutationAdmission(action, host)
    return this.serializeByHost(host.name, () => work(revalidate(), revalidate))
  }

  /**
   * A resourceVersion conflict can be caused by ordinary writes or by a
   * delete/recreate. Every fresh read, including every bounded 409 retry, must
   * remain on the Kubernetes UID that was admitted. Name equality is not an
   * identity fence. Production watch snapshots always carry UID; if only one
   * side carries it, fail closed rather than guessing.
   */
  /**
   * H2: apply a committed outcome to BOTH visible surfaces:
   *  1. the local working object (`host`) — with a resolver wired this is the
   *     admitted CLONE (serializeHeartbeatMutation), so this keeps same-pass
   *     logic (assessLifecycle, drained-pre-scale guard, follow-on reconcile)
   *     reading the outcome exactly as before; standalone callers (no resolver)
   *     get the legacy caller-visible reflection unchanged;
   *  2. the CURRENT cache entry, via the uid-guarded reflector (no-op unless
   *     McpServerWatcher wired it).
   * `host.uid` is the admitted identity (admission proved requested.uid ===
   * current.uid; readFreshHost re-proves it), so passing it after mutate() ran
   * is equivalent to passing it before.
   *
   * `mutate` closures MUST only ASSIGN precomputed values — never derive from
   * `target` — so both surfaces receive the identical outcome.
   */
  private reflectOutcome(host: HostCRD, mutate: (target: HostCRD) => void): void {
    mutate(host)
    this.reflectHostOutcome(host.name, host.uid, mutate)
  }

  private requireSameHostIdentity(expected: HostCRD, current: HostCRD): void {
    if (expected.uid === undefined && current.uid === undefined) return
    if (expected.uid === undefined || current.uid === undefined || expected.uid !== current.uid) {
      const error = new Error(
        `Host identity changed while mutating "${expected.name}"; refusing to cross a same-name recreation`
      )
      error.name = 'HostMutationIdentityChangedError'
      throw error
    }
  }

  /**
   * Heartbeat evidence belongs to one Host spec epoch. UID equality allows
   * status-only updates and retries, but a generation change can replace the
   * runtime inputs (context, Secret, image, lifecycle policy, etc.) while
   * remaining stateless. Never apply an older runtime's heartbeat decision to
   * that new spec. UID-less standalone fixtures retain their legacy behavior;
   * production objects (which carry UID) fail closed on a missing generation.
   */
  private sameHostSpecRevision(expected: HostCRD, current: HostCRD): boolean {
    if (expected.generation === undefined && current.generation === undefined) {
      return expected.uid === undefined && current.uid === undefined
    }
    return (
      expected.generation !== undefined &&
      current.generation !== undefined &&
      expected.generation === current.generation
    )
  }

  /**
   * Drained-pre-scale guard (Stage 4.3): a pending wake must abort the
   * suspension IMMEDIATELY before replicas:0 derives from the assessment.
   * Normally the wake fast-path already flipped the state, but when its
   * status write failed the assessment still observes suspended — run the
   * wake transition here instead of scaling down over it.
   *
   * M2: `host` came from the informer/watch CACHE. A wake PATCH that landed
   * AFTER this cache entry but BEFORE its MODIFIED event is processed is
   * invisible to the cached annotations, so the cached guard could pass and
   * strand the wake behind replicas:0 until the next resync. Before
   * committing the scale-down we therefore re-check the guard against a
   * FRESH GET (not the cache) of the Host metadata+status. If the fresh
   * read sees a pending wake, the scale-down is aborted and the wake
   * transition runs instead (the returned assessment derives replicas=1).
   * A GET failure returns null — fail loud and skip the scale this pass
   * (the periodic resync retries) rather than scaling on stale data.
   *
   * AP-1/AP-5 (FIX 1): the wake check alone is NOT enough. assessLifecycle
   * echoes the reconcile payload's CACHED `host.status`, and ensureDeployment
   * derives replicas from that assessment — so a stale cached lifecycle
   * STATE (not just a missed wake) could commit the wrong replicas:
   *   - cached `suspended` over a fresh `active` (wake fully handled,
   *     requested==handled) → replicas:0 would KILL the live serving pod
   *     with nothing left to revive it until resync;
   *   - cached `active` over a fresh `suspended` → replicas:1 would
   *     resurrect a suspended Host with NO wake.
   * So this guard runs for EVERY stateless assessment and re-derives the
   * scale-relevant state from the SAME fresh read: when fresh disagrees with
   * the cached assessment across the suspended/not-suspended boundary, the
   * assessment is rebuilt from FRESH (mirroring how the wake fast-path's
   * epoch guard reflects fresh onto the in-memory host). The replicas value
   * handed to buildDeployment is therefore always a function of FRESH state
   * whenever fresh and cache disagree. Draining↔active disagreements are
   * left to the status writers — both derive replicas=1, so they are not
   * scale-relevant and rebuilding would only churn the heartbeat writers.
   */
  async resolveWakeBeforeScaleDown(
    host: HostCRD,
    assessment: HostLifecycleAssessment
  ): Promise<HostLifecycleAssessment | null> {
    if (!assessment.effective.stateless) {
      // Kill-switch/rejection assessments INTEND active+replicas:1 regardless
      // of the durable state — never second-guess them from fresh.
      return assessment
    }
    const cachedState = assessment.effective.state
    let fresh: HostCRD
    try {
      fresh = await this.readFreshHost(host)
    } catch (err) {
      if (cachedState === 'suspended') {
        // Fail loud and skip the scale-down this pass: a suspend derived from
        // a possibly-stale cache must NOT strand a racing wake at replicas:0.
        // The periodic resync re-runs this reconcile with a fresh cache.
        console.error(
          `[HostReconciler] Drained-pre-scale guard for "${host.name}": fresh Host read failed; skipping replicas=0 this pass (resync will retry):`,
          err
        )
      } else {
        // Same posture in the mirror direction: never commit replicas from a
        // possibly-stale cached state when the fresh read is unavailable.
        console.error(
          `[HostReconciler] Stateless replicas guard for "${host.name}": fresh Host read failed; skipping the Deployment scale this pass (resync will retry):`,
          err
        )
      }
      return null
    }
    const freshWakeRequested = this.wakeRequestedGeneration(fresh)
    const freshWakeHandled = fresh.status?.lifecycle?.wakeHandledGeneration ?? 0
    const freshState = fresh.status?.lifecycle?.state ?? 'active'
    if (freshWakeRequested > freshWakeHandled) {
      if (cachedState === 'suspended') {
        console.log(
          `[HostReconciler] Drained-pre-scale guard for "${host.name}": aborting replicas=0 — fresh wake generation ${freshWakeRequested} > handled ${freshWakeHandled}`
        )
        // A wake is pending in the fresh read — run the wake transition
        // instead of the scale-down. Reflect the fresh wake generation on the
        // in-memory object so downstream writes preserve it.
        this.reflectOutcome(host, target => {
          target.annotations = fresh.annotations
          target.status = fresh.status
        })
        return {
          effective: { stateless: true, state: 'active' },
          lifecycle: { state: 'active', wakeHandledGeneration: freshWakeRequested },
          condition: assessment.condition,
          pullPolicyCondition: assessment.pullPolicyCondition,
        }
      }
      // Cached active/draining with a wake pending in fresh: replicas already
      // derive to 1, which is what the pending wake wants — keep the
      // assessment (the wake fast-path/resync records the generation).
      return assessment
    }
    // FIX 1: no pending wake — re-derive the scale-relevant state from the
    // SAME fresh read. Only the suspended/not-suspended boundary changes
    // replicas, so only that disagreement rebuilds the assessment.
    const freshSuspended = freshState === 'suspended'
    if ((cachedState === 'suspended') === freshSuspended) {
      return assessment
    }
    console.log(
      `[HostReconciler] Stateless replicas guard for "${host.name}": cached lifecycle state "${cachedState}" disagrees with fresh "${freshState}" — deriving replicas from FRESH state`
    )
    // Reflect fresh onto the in-memory host (mirroring the wake fast-path's
    // epoch guard) so every downstream write derives from the current
    // server-side truth instead of the stale event payload.
    this.reflectOutcome(host, target => {
      target.annotations = fresh.annotations
      target.status = fresh.status
    })
    const freshReason = fresh.status?.lifecycle?.reason
    const preservedReason = isHeartbeatManagedLifecycleReason(freshReason) ? freshReason : undefined
    return {
      effective: { stateless: true, state: freshState },
      lifecycle: {
        state: freshState,
        wakeHandledGeneration: freshWakeHandled,
        ...(preservedReason !== undefined ? { reason: preservedReason } : {}),
      },
      condition: assessment.condition,
      pullPolicyCondition: assessment.pullPolicyCondition,
    }
  }
}
