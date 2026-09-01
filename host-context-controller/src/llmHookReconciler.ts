/**
 * LlmHook Reconciler — turns `image`-target LlmHook CRs into a shared
 * Deployment + Service + NetworkPolicy in the llm-hooks namespace, and writes
 * LlmHook.status. `service` and `remote` targets deploy nothing (status-only).
 *
 * The one hard divergence from every other HCC reconciler is digest-dedup:
 * this is N-CRs → 1-workload. Multiple `image` hooks that share a POD KEY
 * (image ref + port + envSecret + egressBindings + addCapabilities) co-locate
 * on a single pod and are addressed by distinct spec.path. Three mechanisms
 * replace the single-owner-ref cascade every other reconciler relies on:
 *   1. reference-counted, label-owned workloads (delete when the last member
 *      for a pod key is gone; startup/periodic sweep for orphans);
 *   2. per-pod-key serialization (not per-CR-name — two CRs mutating the same
 *      pod key would otherwise race on the same Deployment/Service/NP);
 *   3. a Host→LlmHook reverse index for the NetworkPolicy ingress set.
 *
 * Mirrors McpServerReconciler (hardened securityContext, credentials-revision
 * annotation, create-then-409 replaceWithConflictRetry, ownership-verifying
 * deletes, status-subresource JSON-Patch writer) and NetworkPolicyReconciler
 * (default-deny + infra baseline, L2 reverse-index ingress, L3 egress + SSRF
 * validators).
 */
import * as k8s from '@kubernetes/client-node'
import { IntOrString } from '@kubernetes/client-node/dist/types.js'
import { createHash } from 'crypto'
import * as dns from 'node:dns/promises'
import { isIP } from 'node:net'
import { isWorkflowRecipeDefaultAllowedCapability } from '@clerum/workflow-recipe-capability-policy'
import { config } from './config'
import {
  HOOK_PODKEY_LABEL,
  HOST_LABEL,
  LLMHOOK_LABEL,
  MANAGED_BY_LABEL,
  MANAGED_BY_VALUE,
  POLICY_TYPE_LABEL,
} from './constants'
import { isAllowedExternalEgressCidr, isPublicDnsHostname } from './networkPolicyReconciler'
import { HostCRD, LlmHookCRD, LlmHookCondition, LlmHookImageTarget, LlmHookStatus } from './types'
import {
  deploymentMatchesDesired,
  getErrorCode,
  networkPolicyMatchesDesired,
  preserveDeploymentAnnotations,
  preserveObjectAnnotations,
  preserveServiceAssignedFields,
  replaceWithConflictRetry,
  serviceMatchesDesired,
} from './utils'

const GROUP = 'clerum.io'
const VERSION = 'v1alpha1'
const PLURAL_LLMHOOKS = 'llmhooks'
const CREDENTIALS_REVISION_ANNOTATION = 'clerum.io/credentials-revision'
const LOG = '[LlmHook]'

/** Machine-readable Ready condition reasons (bounded enum, §6). */
export type LlmHookReadyReason =
  | 'NoWorkload'
  | 'Deploying'
  | 'Ready'
  | 'DuplicatePath'
  | 'SecretNotFound'
  | 'InvalidEgress'
  | 'ReconcileError'

type LlmHookReconcilerDeps = {
  appsApi?: k8s.AppsV1Api
  coreApi?: k8s.CoreV1Api
  customApi?: k8s.CustomObjectsApi
  networkingApi?: k8s.NetworkingV1Api
}

type SecretValidation = { ok: true; revision: string } | { ok: false; message: string }

type EgressBuild = { rules: k8s.V1NetworkPolicyEgressRule[]; failures: string[] }

type StatusExtras = {
  observedDigest?: string
  readyReplicas?: number
  lastReconciled?: string
}

/**
 * Collect every installed-hook id a Host references across all guardrail
 * lifecycle phases. This is the Host side of the Host→LlmHook reverse index
 * that drives the shared pod's NetworkPolicy ingress set (§5).
 */
export function referencedHookIds(host: HostCRD | undefined): string[] {
  const hooks = host?.spec.guardrails?.hooks
  if (!hooks) return []
  const ids: string[] = []
  for (const phase of Object.values(hooks)) {
    if (!Array.isArray(phase)) continue
    for (const ref of phase) {
      if (ref && typeof ref.id === 'string' && ref.id) ids.push(ref.id)
    }
  }
  return ids
}

/**
 * Stable pod key over the POD-LEVEL fields of an image target (§1.1). Two
 * hooks with the same key safely share a pod; a different envSecret or
 * egressBindings gets its own key → its own pod (a different trust/egress
 * boundary). path/order/capabilities/failMode/config are NOT in the key.
 * Returns null for non-image (service/remote) targets.
 */
export function computePodKey(hook: LlmHookCRD): string | null {
  const img = hook.spec.target?.image
  if (!img) return null
  const canonical = {
    imageRef: img.ref,
    port: img.port,
    envSecret: img.envSecret ?? '',
    egressBindings: normalizeEgressBindings(img.egressBindings),
    addCapabilities: [...(img.security?.addCapabilities ?? [])].sort(),
  }
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0, 16)
}

/** Canonicalize egressBindings into a stable, order-independent form. */
function normalizeEgressBindings(
  bindings: LlmHookImageTarget['egressBindings']
): Array<{ cidr: string | null; toFQDN: string | null; ports: number[] }> {
  return (bindings ?? [])
    .map(b => ({
      cidr: b.cidr ?? null,
      toFQDN: b.toFQDN ?? null,
      ports: [...(b.ports ?? [])].sort((a, z) => a - z),
    }))
    .sort((a, z) => JSON.stringify(a).localeCompare(JSON.stringify(z)))
}

export function podKeyResourceName(podKey: string): string {
  return `llmhook-${podKey}`
}

/** NetworkPolicy name for a service-target hook's per-CR ingress policy (§8.2). */
export function serviceTargetNpName(crName: string): string {
  return `llmhook-svc-${crName}`
}

type TargetKind = 'image' | 'service' | 'remote' | 'invalid'

function classifyTarget(hook: LlmHookCRD): TargetKind {
  const t = hook.spec.target ?? {}
  if (t.image) return 'image'
  if (t.service) return 'service'
  if (t.remote) return 'remote'
  return 'invalid'
}

export class LlmHookReconciler {
  private readonly appsApi: k8s.AppsV1Api
  private readonly coreApi: k8s.CoreV1Api
  private readonly customApi: k8s.CustomObjectsApi
  private readonly networkingApi: k8s.NetworkingV1Api

  /** Cache of LlmHook CRs by name (owned by the watcher). */
  private readonly hooks: Map<string, LlmHookCRD>
  /** Cache of Host CRs by name (owned by the watcher) — reverse-index source. */
  private readonly hosts: Map<string, HostCRD>

  /**
   * Tail promise of the in-flight work per SERIALIZATION KEY. Image targets
   * serialize by pod key so all work touching one shared workload runs strictly
   * sequentially while different pod keys run concurrently (§4); service/remote
   * targets serialize by `name:<crName>`.
   */
  private readonly inFlight: Map<string, Promise<void>> = new Map()

  constructor(
    kc: k8s.KubeConfig,
    hookCache: Map<string, LlmHookCRD>,
    hostCache: Map<string, HostCRD>,
    deps?: LlmHookReconcilerDeps
  ) {
    this.appsApi = deps?.appsApi ?? kc.makeApiClient(k8s.AppsV1Api)
    this.coreApi = deps?.coreApi ?? kc.makeApiClient(k8s.CoreV1Api)
    this.customApi = deps?.customApi ?? kc.makeApiClient(k8s.CustomObjectsApi)
    this.networkingApi = deps?.networkingApi ?? kc.makeApiClient(k8s.NetworkingV1Api)
    this.hooks = hookCache
    this.hosts = hostCache
  }

  // ─── Serialization ──────────────────────────────────────────────────

  private runSerialized(key: string, fn: () => Promise<void>): Promise<void> {
    const prev = this.inFlight.get(key) ?? Promise.resolve()
    const next = prev.catch(() => undefined).then(fn)
    this.inFlight.set(key, next)
    return (async () => {
      try {
        await next
      } finally {
        if (this.inFlight.get(key) === next) this.inFlight.delete(key)
      }
    })()
  }

  // ─── Public API ─────────────────────────────────────────────────────

  /**
   * Reconcile a created or modified LlmHook. `previousPodKey` (the pod key the
   * CR had before this event, computed from the cached object) lets an image
   * bump chain teardown of the old workload on the old key AND ensure the new
   * one on the new key (§4), so neither interleaves with the other.
   */
  async reconcile(hook: LlmHookCRD, previousPodKey?: string | null): Promise<void> {
    const kind = classifyTarget(hook)
    if (kind !== 'image') {
      await this.runSerialized(`name:${hook.name}`, () => this.reconcileNonImage(hook, kind))
      return
    }
    // Clean any stale service-target ingress NP left by a prior service→image flip.
    await this.deleteServiceTargetNetworkPolicy(hook.name)
    const podKey = computePodKey(hook)!
    if (previousPodKey && previousPodKey !== podKey) {
      // The image target changed pod keys: tear down the stale one (if it now
      // has zero members) before/while ensuring the new one.
      await this.runSerialized(previousPodKey, () => this.reconcilePodKey(previousPodKey))
    }
    await this.runSerialized(podKey, () => this.reconcilePodKey(podKey))
  }

  /**
   * Reconcile a deleted LlmHook. The cached object was already evicted by the
   * watcher; `formerPodKey` is its pod key (computed before eviction). Running
   * the pod-key reconcile now sees a smaller (possibly empty) member set and
   * GCs the workload when the last member is gone (§3).
   */
  async reconcileDelete(name: string, formerPodKey?: string | null): Promise<void> {
    if (!formerPodKey) {
      // service/remote (or unknown) — no workload was deployed, but a service
      // target may have left an ingress NP; remove it.
      await this.runSerialized(`name:${name}`, () => this.deleteServiceTargetNetworkPolicy(name))
      return
    }
    await this.runSerialized(formerPodKey, () => this.reconcilePodKey(formerPodKey))
  }

  /**
   * Re-reconcile only the NetworkPolicy ingress for the pod keys referenced by
   * the given hook ids. Called from the Host-watch fan-out so adding/removing a
   * Host reference re-computes which mcp-hosts the shared pod admits (§5).
   */
  async reconcileNetworkPoliciesForHooks(hookNames: string[]): Promise<void> {
    const podKeys = new Set<string>()
    for (const name of hookNames) {
      const hook = this.hooks.get(name)
      if (!hook) continue
      // Service targets: refresh the per-CR ingress NP so the admitted-host set
      // tracks the Host reference change (image targets handled by pod key below).
      if (classifyTarget(hook) === 'service') {
        await this.runSerialized(`name:${name}`, () => this.ensureServiceTargetNetworkPolicy(hook))
        continue
      }
      const key = computePodKey(hook)
      if (key) podKeys.add(key)
    }
    for (const podKey of podKeys) {
      await this.runSerialized(podKey, async () => {
        const members = this.membersForPodKey(podKey)
        if (members.length === 0) return
        const img = members[0].spec.target.image!
        const egress = await this.buildEgressRules(img)
        // A now-invalid egress binding must not silently re-open the pod; the
        // ingress refresh still applies (fail-closed egress on the next full
        // reconcile). Apply ingress with whatever egress currently validates.
        await this.ensureNetworkPolicy(podKey, members, egress.failures.length ? [] : egress.rules)
      })
    }

    // Refresh the per-host scoped EGRESS for every host referencing an affected
    // hook, so a Host reference change (or an image bump that moves a pod key)
    // keeps the host's egress allowlist in sync with what it may reach (N1/N7).
    // The "host dropped its last reference" case is covered by the Host-watch
    // calling reconcileHostEgress(host) directly.
    const affectedHosts = new Map<string, HostCRD>()
    for (const name of hookNames) {
      const hook = this.hooks.get(name)
      if (!hook) continue
      for (const h of this.referencingHosts([hook])) affectedHosts.set(h.name, h)
    }
    for (const host of affectedHosts.values()) {
      await this.reconcileHostEgress(host)
    }
  }

  /**
   * Full reconciliation pass (startup + periodic resync). Reconciles every
   * distinct pod key once, every non-image hook, then sweeps label-orphaned
   * `llmhook-*` workloads whose pod key has zero live members (§3).
   */
  async fullReconcile(hooks: LlmHookCRD[]): Promise<void> {
    console.log(`${LOG} Running full reconciliation for ${hooks.length} LlmHook(s)`)
    const imagePodKeys = new Set<string>()
    for (const hook of hooks) {
      const kind = classifyTarget(hook)
      if (kind === 'image') {
        const key = computePodKey(hook)
        if (key) imagePodKeys.add(key)
      } else {
        await this.reconcile(hook)
      }
    }
    for (const podKey of imagePodKeys) {
      await this.runSerialized(podKey, () => this.reconcilePodKey(podKey))
    }
    // Converge every Host's scoped egress-to-hooks policy (N1/N7) — the periodic
    // backstop for a missed watch event or an image bump that moved a pod key.
    for (const host of this.hosts.values()) {
      await this.reconcileHostEgress(host)
    }
    await this.sweepOrphanedWorkloads()
    console.log(`${LOG} Full reconciliation complete`)
  }

  // ─── Members / reverse index ────────────────────────────────────────

  /** All cached image-target LlmHooks whose pod key equals `podKey`. */
  private membersForPodKey(podKey: string): LlmHookCRD[] {
    return [...this.hooks.values()]
      .filter(h => classifyTarget(h) === 'image' && computePodKey(h) === podKey)
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  /** Hosts whose guardrails reference any of the given member hooks (§5). */
  private referencingHosts(members: LlmHookCRD[]): HostCRD[] {
    const memberNames = new Set(members.map(m => m.name))
    return [...this.hosts.values()]
      .filter(h => referencedHookIds(h).some(id => memberNames.has(id)))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  // ─── Core pod-key reconcile ─────────────────────────────────────────

  private async reconcilePodKey(podKey: string): Promise<void> {
    const members = this.membersForPodKey(podKey)

    // Reference count == live members. Zero → tear the workload down (§3).
    if (members.length === 0) {
      await this.gcPodKey(podKey)
      return
    }

    const rep = members[0]
    const img = rep.spec.target.image!

    // Path uniqueness within the pod key (§1.2): losers fail closed, winners
    // are still served.
    const duplicatePathNames = this.duplicatePathMembers(members)

    // Secret gate (mirror McpServer secret gate).
    const secret = await this.validateSecret(img)
    if (!secret.ok) {
      for (const m of members) {
        await this.writeStatus(m, condition('False', 'SecretNotFound', secret.message))
      }
      return
    }

    // Egress hardening (§5 caveat): apply McpServer-grade SSRF/private-range
    // validation to the looser LlmHook.egressBindings; a rejected binding fails
    // the whole pod key closed (egress is a pod-level boundary).
    const egress = await this.buildEgressRules(img)
    if (egress.failures.length > 0) {
      const message = egress.failures.join('; ')
      for (const m of members) {
        await this.writeStatus(m, condition('False', 'InvalidEgress', message))
      }
      return
    }

    // Ensure the shared workload (idempotent create-then-409 replace).
    try {
      await this.ensureDeployment(podKey, members, secret.revision)
      await this.ensureService(podKey, img.port)
      await this.ensureNetworkPolicy(podKey, members, egress.rules)
    } catch (err) {
      const message = `Resource sync failed: ${errMsg(err)}`
      for (const m of members) {
        await this.writeStatus(m, condition('False', 'ReconcileError', message))
      }
      return
    }

    // Readiness + observedDigest → per-member status (each member is a distinct
    // CR and gets its own status even though they share a pod, §6).
    const name = podKeyResourceName(podKey)
    const rollout = await this.readDeploymentRollout(name)
    const observedDigest = await this.readObservedDigest(podKey)
    const nowIso = new Date().toISOString()
    const extras: StatusExtras = {
      observedDigest,
      readyReplicas: rollout.readyReplicas,
      ...(rollout.ready ? { lastReconciled: nowIso } : {}),
    }

    for (const m of members) {
      if (duplicatePathNames.has(m.name)) {
        await this.writeStatus(
          m,
          condition(
            'False',
            'DuplicatePath',
            `spec.path "${m.spec.path ?? '/'}" collides with another co-located hook sharing this pod`
          ),
          extras
        )
        continue
      }
      await this.writeStatus(
        m,
        rollout.ready
          ? condition('True', 'Ready', 'Hook deployment ready')
          : condition('Unknown', 'Deploying', `Waiting for hook pod: ${rollout.detail}`),
        extras
      )
    }
  }

  private async reconcileNonImage(hook: LlmHookCRD, kind: TargetKind): Promise<void> {
    // service / remote targets deploy nothing: mcp-host dials them directly.
    if (kind === 'invalid') {
      await this.writeStatus(
        hook,
        condition('False', 'ReconcileError', 'target must be exactly one of image, service, remote')
      )
      return
    }
    // A service target gets an ingress NP admitting only referencing hosts; a
    // remote target has no in-cluster pod, so clear any stale NP (e.g. after a
    // service→remote target flip).
    if (kind === 'service') {
      await this.ensureServiceTargetNetworkPolicy(hook)
    } else {
      await this.deleteServiceTargetNetworkPolicy(hook.name)
    }
    await this.writeStatus(
      hook,
      condition('True', 'NoWorkload', 'No workload deployed for service/remote target'),
      { lastReconciled: new Date().toISOString() }
    )
  }

  /**
   * Names of members that lose a path collision. The first member (by sorted
   * name) to claim a path wins; later members claiming the same path are
   * flagged DuplicatePath and not routed.
   */
  private duplicatePathMembers(members: LlmHookCRD[]): Set<string> {
    const seen = new Map<string, string>()
    const losers = new Set<string>()
    for (const m of members) {
      const path = m.spec.path ?? '/'
      if (seen.has(path)) {
        losers.add(m.name)
      } else {
        seen.set(path, m.name)
      }
    }
    return losers
  }

  // ─── Secret validation (mirror validateSecret, credentials revision) ──

  private async validateSecret(img: LlmHookImageTarget): Promise<SecretValidation> {
    if (!img.envSecret) return { ok: true, revision: '' }
    try {
      const secret = await this.coreApi.readNamespacedSecret({
        name: img.envSecret,
        namespace: config.llmHooksNamespace,
      })
      const data = secret.data || {}
      const revision = createHash('sha256')
        .update(
          JSON.stringify(
            Object.keys(data)
              .sort()
              .map(k => [k, data[k]])
          )
        )
        .digest('hex')
      return { ok: true, revision }
    } catch (error) {
      const code = getErrorCode(error)
      if (code === 404) {
        return {
          ok: false,
          message: `Secret "${img.envSecret}" not found in namespace "${config.llmHooksNamespace}"`,
        }
      }
      return {
        ok: false,
        message: `Failed to read Secret "${img.envSecret}": ${errMsg(error)}`,
      }
    }
  }

  // ─── Egress builder (reuse NP reconciler's SSRF/private-range validators) ──

  private async buildEgressRules(img: LlmHookImageTarget): Promise<EgressBuild> {
    const rules: k8s.V1NetworkPolicyEgressRule[] = []
    const failures: string[] = []
    for (const binding of img.egressBindings ?? []) {
      const ports: k8s.V1NetworkPolicyPort[] =
        binding.ports && binding.ports.length > 0
          ? binding.ports.map(p => ({ port: p, protocol: 'TCP' as const }))
          : [
              { port: 443, protocol: 'TCP' },
              { port: 80, protocol: 'TCP' },
            ]

      if (binding.cidr) {
        if (!isAllowedExternalEgressCidr(binding.cidr)) {
          failures.push(
            `CIDR "${binding.cidr}" overlaps private, metadata, link-local, multicast, documentation, or reserved ranges`
          )
          continue
        }
        rules.push({ to: [{ ipBlock: { cidr: binding.cidr } }], ports })
        continue
      }

      if (binding.toFQDN) {
        if (!isPublicDnsHostname(binding.toFQDN)) {
          failures.push(
            `hostname "${binding.toFQDN}" is private, internal, metadata, local, or otherwise disallowed`
          )
          continue
        }
        try {
          const ips = [...new Set(await dns.resolve4(binding.toFQDN))].sort()
          if (ips.length === 0) {
            failures.push(`hostname "${binding.toFQDN}" resolved to no IPv4 addresses`)
            continue
          }
          const cidrs = ips.map(ip => `${ip}/32`)
          const disallowed = cidrs.filter(
            c => isIP(c.split('/')[0]) !== 4 || !isAllowedExternalEgressCidr(c)
          )
          if (disallowed.length > 0) {
            failures.push(
              `hostname "${binding.toFQDN}" resolved disallowed address(es): ${disallowed.join(', ')}`
            )
            continue
          }
          for (const cidr of cidrs) rules.push({ to: [{ ipBlock: { cidr } }], ports })
        } catch (err) {
          failures.push(`failed to resolve hostname "${binding.toFQDN}": ${errMsg(err)}`)
        }
        continue
      }

      failures.push('egress binding must declare toFQDN or cidr')
    }

    // Scoped DNS (N5): a hook that declares outbound egress must resolve its
    // targets at runtime, so grant egress to CoreDNS (kube-system:53) — but ONLY
    // for hooks that opted into egress. A pure /v1 responder (no egressBindings)
    // gets no egress at all, "no implicit DNS".
    if (rules.length > 0) {
      rules.push({
        to: [
          { namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' } } },
        ],
        ports: [
          { port: 53, protocol: 'UDP' },
          { port: 53, protocol: 'TCP' },
        ],
      })
    }
    return { rules, failures }
  }

  // ─── Resource builders ──────────────────────────────────────────────

  private podKeyLabels(podKey: string): Record<string, string> {
    return {
      app: podKeyResourceName(podKey),
      [MANAGED_BY_LABEL]: MANAGED_BY_VALUE,
      [HOOK_PODKEY_LABEL]: podKey,
    }
  }

  private buildDeployment(
    podKey: string,
    members: LlmHookCRD[],
    credentialsRevision: string
  ): k8s.V1Deployment {
    const img = members[0].spec.target.image!
    const name = podKeyResourceName(podKey)
    const labels = this.podKeyLabels(podKey)

    // Defense in depth: the CRD enum already bounds addCapabilities to the
    // workflow-recipe allowlist, but strip anything outside it at reconcile too.
    const addCapabilities = (img.security?.addCapabilities ?? []).filter(cap => {
      if (isWorkflowRecipeDefaultAllowedCapability(cap)) return true
      console.warn(`${LOG} pod key ${podKey}: capability "${cap}" stripped (forbidden)`)
      return false
    })

    const hardenedContainerSecurityContext: k8s.V1SecurityContext = {
      allowPrivilegeEscalation: false,
      runAsNonRoot: true,
      runAsUser: 1000,
      runAsGroup: 1000,
      capabilities: {
        drop: ['ALL'],
        ...(addCapabilities.length ? { add: addCapabilities } : {}),
      },
      seccompProfile: { type: 'RuntimeDefault' },
      // N8: the image filesystem is immutable to the running hook. Scratch space
      // is the ephemeral `/tmp` emptyDir mounted below — never the image layers.
      readOnlyRootFilesystem: true,
    }

    return {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name, namespace: config.llmHooksNamespace, labels },
      spec: {
        replicas: 1,
        selector: { matchLabels: { app: name } },
        template: {
          metadata: {
            labels,
            // Rotating the hook's envSecret changes this digest → pod template
            // → rolling restart (mirror McpServer credentials-revision).
            ...(credentialsRevision && {
              annotations: { [CREDENTIALS_REVISION_ANNOTATION]: credentialsRevision },
            }),
          },
          spec: {
            automountServiceAccountToken: false,
            enableServiceLinks: false,
            securityContext: {
              runAsNonRoot: true,
              runAsUser: 1000,
              runAsGroup: 1000,
              seccompProfile: { type: 'RuntimeDefault' },
            },
            ...(img.imagePullSecrets?.length
              ? { imagePullSecrets: img.imagePullSecrets.map(n => ({ name: n })) }
              : {}),
            containers: [
              {
                name: 'hook',
                image: img.ref,
                imagePullPolicy: config.mcpServerImagePullPolicy,
                ports: [{ name: 'http', containerPort: img.port, protocol: 'TCP' }],
                // envSecret injects the hook's OWN credentials (whole Secret).
                ...(img.envSecret ? { envFrom: [{ secretRef: { name: img.envSecret } }] } : {}),
                securityContext: hardenedContainerSecurityContext,
                // Writable scratch under a read-only root fs (N8).
                volumeMounts: [{ name: 'tmp', mountPath: '/tmp' }],
                livenessProbe: {
                  tcpSocket: { port: 'http' as unknown as IntOrString },
                  initialDelaySeconds: 10,
                  periodSeconds: 15,
                },
                readinessProbe: {
                  tcpSocket: { port: 'http' as unknown as IntOrString },
                  initialDelaySeconds: 5,
                  periodSeconds: 10,
                },
                resources: {
                  requests: { memory: '64Mi', cpu: '50m' },
                  limits: { memory: '256Mi', cpu: '500m' },
                },
              },
            ],
            volumes: [{ name: 'tmp', emptyDir: {} }],
          },
        },
      },
    }
  }

  private buildService(podKey: string, port: number): k8s.V1Service {
    const name = podKeyResourceName(podKey)
    return {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: { name, namespace: config.llmHooksNamespace, labels: this.podKeyLabels(podKey) },
      spec: {
        type: 'ClusterIP',
        ports: [{ port, targetPort: 'http' as IntOrString, protocol: 'TCP', name: 'http' }],
        selector: { app: name },
      },
    }
  }

  private buildNetworkPolicy(
    podKey: string,
    members: LlmHookCRD[],
    egressRules: k8s.V1NetworkPolicyEgressRule[]
  ): k8s.V1NetworkPolicy {
    const name = podKeyResourceName(podKey)
    const port = members[0].spec.target.image!.port
    const hosts = this.referencingHosts(members)

    // Ingress admits EXACTLY the mcp-hosts whose Host CR references any
    // co-located member (Host→LlmHook reverse index, §5). No referencing host
    // ⇒ empty ingress ⇒ deny all (fail-closed until a Host references it).
    const ingress: k8s.V1NetworkPolicyIngressRule[] =
      hosts.length > 0
        ? [
            {
              _from: hosts.map(h => ({
                namespaceSelector: {
                  matchLabels: { 'kubernetes.io/metadata.name': config.hostNamespace },
                },
                podSelector: { matchLabels: { [HOST_LABEL]: h.name } },
              })),
              ports: [{ port, protocol: 'TCP' }],
            },
          ]
        : []

    const policyTypes: Array<'Ingress' | 'Egress'> = ['Ingress']
    if (egressRules.length > 0) policyTypes.push('Egress')

    return {
      apiVersion: 'networking.k8s.io/v1',
      kind: 'NetworkPolicy',
      metadata: {
        name,
        namespace: config.llmHooksNamespace,
        labels: this.podKeyLabels(podKey),
        // Member CR names are recorded as an ANNOTATION, not a label: co-located
        // members are comma-joined, and commas are invalid in a label value (the
        // apiserver 422s), which would break exactly the multi-member digest-dedup
        // case. Annotations allow commas and long values.
        annotations: { 'clerum.io/llmhook-members': members.map(m => m.name).join(',') },
      },
      spec: {
        podSelector: { matchLabels: { [HOOK_PODKEY_LABEL]: podKey } },
        policyTypes,
        ingress,
        ...(egressRules.length > 0 ? { egress: egressRules } : {}),
      },
    }
  }

  // ─── Apply helpers (create-then-409 replaceWithConflictRetry) ─────────

  private async ensureDeployment(
    podKey: string,
    members: LlmHookCRD[],
    credentialsRevision: string
  ): Promise<void> {
    const deployment = this.buildDeployment(podKey, members, credentialsRevision)
    const name = deployment.metadata!.name!
    try {
      await this.appsApi.createNamespacedDeployment({
        namespace: config.llmHooksNamespace,
        body: deployment,
      })
      console.log(`${LOG} Created Deployment "${name}"`)
      return
    } catch (error) {
      if (getErrorCode(error) !== 409) throw error
    }
    await replaceWithConflictRetry({
      description: `Deployment "${name}"`,
      logPrefix: LOG,
      body: deployment,
      mergeExisting: preserveDeploymentAnnotations,
      isUpToDate: deploymentMatchesDesired,
      read: () =>
        this.appsApi.readNamespacedDeployment({ name, namespace: config.llmHooksNamespace }),
      replace: body =>
        this.appsApi.replaceNamespacedDeployment({
          name,
          namespace: config.llmHooksNamespace,
          body,
        }),
    })
  }

  private async ensureService(podKey: string, port: number): Promise<void> {
    const service = this.buildService(podKey, port)
    const name = service.metadata!.name!
    try {
      await this.coreApi.createNamespacedService({
        namespace: config.llmHooksNamespace,
        body: service,
      })
      console.log(`${LOG} Created Service "${name}"`)
      return
    } catch (error) {
      if (getErrorCode(error) !== 409) throw error
    }
    await replaceWithConflictRetry({
      description: `Service "${name}"`,
      logPrefix: LOG,
      body: service,
      mergeExisting: preserveServiceAssignedFields,
      isUpToDate: serviceMatchesDesired,
      read: () => this.coreApi.readNamespacedService({ name, namespace: config.llmHooksNamespace }),
      replace: body =>
        this.coreApi.replaceNamespacedService({ name, namespace: config.llmHooksNamespace, body }),
    })
  }

  private async ensureNetworkPolicy(
    podKey: string,
    members: LlmHookCRD[],
    egressRules: k8s.V1NetworkPolicyEgressRule[]
  ): Promise<void> {
    await this.applyNetworkPolicy(this.buildNetworkPolicy(podKey, members, egressRules))
  }

  /** Idempotent create-then-409-replace of a NetworkPolicy in its own namespace. */
  private async applyNetworkPolicy(policy: k8s.V1NetworkPolicy): Promise<void> {
    const name = policy.metadata!.name!
    const namespace = policy.metadata!.namespace ?? config.llmHooksNamespace
    try {
      await this.networkingApi.createNamespacedNetworkPolicy({ namespace, body: policy })
      console.log(`${LOG} Created NetworkPolicy "${name}" (${namespace})`)
      return
    } catch (error) {
      if (getErrorCode(error) !== 409) throw error
    }
    await replaceWithConflictRetry({
      description: `NetworkPolicy "${name}"`,
      logPrefix: LOG,
      body: policy,
      mergeExisting: preserveObjectAnnotations,
      isUpToDate: networkPolicyMatchesDesired,
      read: () => this.networkingApi.readNamespacedNetworkPolicy({ name, namespace }),
      replace: body => this.networkingApi.replaceNamespacedNetworkPolicy({ name, namespace, body }),
    })
  }

  /**
   * Per-service-target ingress NP (§8.2). A `service` target deploys no workload,
   * so it never gets a per-podKey policy — with the namespace default-deny that
   * leaves its pods fail-closed. This admits EXACTLY the referencing mcp-hosts to
   * the target Service's pods (empty `ingress` ⇒ deny-all), the service-target
   * analog of the image reverse-index (`buildNetworkPolicy`). Scoped to Services
   * in the llm-hooks namespace, where HCC has RBAC + the default-deny baseline; a
   * Service elsewhere is left to that namespace's own policy (warned), and a
   * missing/selector-less Service is left fail-closed under the default-deny.
   */
  private async ensureServiceTargetNetworkPolicy(hook: LlmHookCRD): Promise<void> {
    const svc = hook.spec.target?.service
    if (!svc?.name || !svc.namespace || !svc.port) return
    if (svc.namespace !== config.llmHooksNamespace) {
      console.warn(
        `${LOG} service-target hook "${hook.name}" → Service ${svc.namespace}/${svc.name} outside ${config.llmHooksNamespace}; ingress not enforced by HCC`
      )
      return
    }

    // A missing Service or an empty selector would leave us unable to scope the
    // ingress (an empty podSelector selects ALL pods) — refuse and leave the pods
    // fail-closed under the namespace default-deny instead.
    const selector = await this.readServiceSelector(svc.name, svc.namespace)
    if (!selector) {
      console.warn(
        `${LOG} service-target hook "${hook.name}": Service ${svc.namespace}/${svc.name} missing or selector-less; leaving fail-closed under default-deny`
      )
      return
    }

    const hosts = this.referencingHosts([hook])
    const labels: Record<string, string> = {
      [MANAGED_BY_LABEL]: MANAGED_BY_VALUE,
      [POLICY_TYPE_LABEL]: 'service-hook-ingress',
    }
    // Per-CR traceability label — omit if the CR name is not a valid label value.
    if (hook.name.length <= 63) labels[LLMHOOK_LABEL] = hook.name

    const ingress: k8s.V1NetworkPolicyIngressRule[] =
      hosts.length > 0
        ? [
            {
              _from: hosts.map(h => ({
                namespaceSelector: {
                  matchLabels: { 'kubernetes.io/metadata.name': config.hostNamespace },
                },
                podSelector: { matchLabels: { [HOST_LABEL]: h.name } },
              })),
              ports: [{ port: svc.port, protocol: 'TCP' as const }],
            },
          ]
        : []

    await this.applyNetworkPolicy({
      apiVersion: 'networking.k8s.io/v1',
      kind: 'NetworkPolicy',
      metadata: {
        name: serviceTargetNpName(hook.name),
        namespace: config.llmHooksNamespace,
        labels,
      },
      spec: {
        podSelector: { matchLabels: selector },
        policyTypes: ['Ingress'],
        ingress,
      },
    })
  }

  /** Delete a service-target hook's ingress NP (CR delete / target-kind change). */
  private async deleteServiceTargetNetworkPolicy(crName: string): Promise<void> {
    const name = serviceTargetNpName(crName)
    const ns = config.llmHooksNamespace
    try {
      const np = await this.networkingApi.readNamespacedNetworkPolicy({ name, namespace: ns })
      if (np.metadata?.labels?.[MANAGED_BY_LABEL] === MANAGED_BY_VALUE) {
        await this.networkingApi.deleteNamespacedNetworkPolicy({ name, namespace: ns })
        console.log(`${LOG} Deleted NetworkPolicy "${name}"`)
      } else {
        console.warn(`${LOG} Skipping NetworkPolicy "${name}" delete — not HCC-owned`)
      }
    } catch (error) {
      if (getErrorCode(error) !== 404) throw error
    }
  }

  /** Read a Service's selector; undefined if missing/empty (can't scope pods). */
  private async readServiceSelector(
    name: string,
    namespace: string
  ): Promise<Record<string, string> | undefined> {
    try {
      const svc = await this.coreApi.readNamespacedService({ name, namespace })
      const selector = svc.spec?.selector
      return selector && Object.keys(selector).length > 0 ? selector : undefined
    } catch (error) {
      if (getErrorCode(error) === 404) return undefined
      throw error
    }
  }

  // ─── Per-host egress reverse-index (§8.2) ───────────────────────────

  private hostEgressNpName(hostName: string): string {
    return `mcp-host-${hostName}-egress-llm-hooks`
  }

  /**
   * Scoped egress reverse-index (§8.2) — the SOURCE-side mirror of the hook
   * ingress policies. A host pod may egress ONLY to the specific hook pods its
   * Host CR references (one rule per referenced in-cluster hook), so a host now
   * reaches only its CRD's hooks from BOTH ends rather than the whole llm-hooks
   * namespace. Serialized per host so concurrent Host/LlmHook events don't race.
   */
  async reconcileHostEgress(host: HostCRD): Promise<void> {
    await this.runSerialized(`host-egress:${host.name}`, () =>
      this.ensureHostEgressNetworkPolicy(host)
    )
  }

  private async ensureHostEgressNetworkPolicy(host: HostCRD): Promise<void> {
    const rules = await this.buildHostEgressRules(host)
    if (rules.length === 0) {
      // No referenced in-cluster hooks → the host has no reason to reach
      // llm-hooks; remove the policy (DNS/control-plane egress live elsewhere).
      await this.deleteHostEgressNetworkPolicy(host.name)
      return
    }
    await this.applyNetworkPolicy({
      apiVersion: 'networking.k8s.io/v1',
      kind: 'NetworkPolicy',
      metadata: {
        name: this.hostEgressNpName(host.name),
        namespace: config.hostNamespace,
        labels: {
          [MANAGED_BY_LABEL]: MANAGED_BY_VALUE,
          [HOST_LABEL]: host.name,
          [POLICY_TYPE_LABEL]: 'llm-hooks-egress',
        },
      },
      spec: {
        podSelector: {
          matchLabels: { [HOST_LABEL]: host.name, [MANAGED_BY_LABEL]: MANAGED_BY_VALUE },
        },
        policyTypes: ['Egress'],
        egress: rules,
      },
    })
  }

  /**
   * One egress rule per referenced in-cluster hook (deduped by pod selector +
   * port): image → `hook-pod-key` + `img.port`; service (in llm-hooks) → the
   * target Service's selector + port. Dangling refs, cross-namespace service
   * targets, and `remote` targets add no rule.
   */
  private async buildHostEgressRules(host: HostCRD): Promise<k8s.V1NetworkPolicyEgressRule[]> {
    const llmHooksNs = config.llmHooksNamespace
    const rules: k8s.V1NetworkPolicyEgressRule[] = []
    const seen = new Set<string>()
    for (const id of new Set(referencedHookIds(host))) {
      const hook = this.hooks.get(id)
      if (!hook) continue // dangling reference

      let podSelector: Record<string, string> | undefined
      let port: number | undefined
      const kind = classifyTarget(hook)
      if (kind === 'image') {
        podSelector = { [HOOK_PODKEY_LABEL]: computePodKey(hook)! }
        port = hook.spec.target!.image!.port
      } else if (kind === 'service') {
        const svc = hook.spec.target!.service!
        if (svc.namespace !== llmHooksNs) continue // only llm-hooks is scoped (matches ingress)
        const selector = await this.readServiceSelector(svc.name, svc.namespace)
        if (!selector) continue
        podSelector = selector
        port = svc.port
      } else {
        continue // remote / invalid — not an in-cluster llm-hooks destination
      }

      const dedup = `${JSON.stringify(podSelector)}:${port}`
      if (seen.has(dedup)) continue
      seen.add(dedup)
      rules.push({
        to: [
          {
            namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': llmHooksNs } },
            podSelector: { matchLabels: podSelector },
          },
        ],
        ports: [{ port: port!, protocol: 'TCP' }],
      })
    }
    return rules
  }

  private async deleteHostEgressNetworkPolicy(hostName: string): Promise<void> {
    const name = this.hostEgressNpName(hostName)
    const ns = config.hostNamespace
    try {
      const np = await this.networkingApi.readNamespacedNetworkPolicy({ name, namespace: ns })
      if (np.metadata?.labels?.[MANAGED_BY_LABEL] === MANAGED_BY_VALUE) {
        await this.networkingApi.deleteNamespacedNetworkPolicy({ name, namespace: ns })
        console.log(`${LOG} Deleted NetworkPolicy "${name}" (${ns})`)
      }
    } catch (error) {
      if (getErrorCode(error) !== 404) throw error
    }
  }

  // ─── Reference-counted, label-owned GC (§3) ─────────────────────────

  private isHccOwned(
    resource: { metadata?: { labels?: Record<string, string> } },
    podKey: string
  ): boolean {
    const labels = resource.metadata?.labels ?? {}
    return labels[MANAGED_BY_LABEL] === MANAGED_BY_VALUE && labels[HOOK_PODKEY_LABEL] === podKey
  }

  private async gcPodKey(podKey: string): Promise<void> {
    const name = podKeyResourceName(podKey)
    const ns = config.llmHooksNamespace
    // Deployment
    try {
      const dep = await this.appsApi.readNamespacedDeployment({ name, namespace: ns })
      if (this.isHccOwned(dep, podKey)) {
        await this.appsApi.deleteNamespacedDeployment({ name, namespace: ns })
        console.log(`${LOG} Deleted Deployment "${name}" (0 members)`)
      } else {
        console.warn(`${LOG} Skipping Deployment "${name}" delete — not HCC-owned`)
      }
    } catch (error) {
      if (getErrorCode(error) !== 404) throw error
    }
    // Service
    try {
      const svc = await this.coreApi.readNamespacedService({ name, namespace: ns })
      if (this.isHccOwned(svc, podKey)) {
        await this.coreApi.deleteNamespacedService({ name, namespace: ns })
        console.log(`${LOG} Deleted Service "${name}" (0 members)`)
      } else {
        console.warn(`${LOG} Skipping Service "${name}" delete — not HCC-owned`)
      }
    } catch (error) {
      if (getErrorCode(error) !== 404) throw error
    }
    // NetworkPolicy
    try {
      const np = await this.networkingApi.readNamespacedNetworkPolicy({ name, namespace: ns })
      if (this.isHccOwned(np, podKey)) {
        await this.networkingApi.deleteNamespacedNetworkPolicy({ name, namespace: ns })
        console.log(`${LOG} Deleted NetworkPolicy "${name}" (0 members)`)
      } else {
        console.warn(`${LOG} Skipping NetworkPolicy "${name}" delete — not HCC-owned`)
      }
    } catch (error) {
      if (getErrorCode(error) !== 404) throw error
    }
  }

  /**
   * Startup / periodic orphan GC (§3): list all `llmhook-*` Deployments by
   * label and delete any whose hook-pod-key has zero live members — covers pods
   * orphaned by a missed delete event or a crash between CR-delete and
   * workload-delete. Mandatory (no owner-ref cascade to rely on).
   */
  private async sweepOrphanedWorkloads(): Promise<void> {
    let deployments: k8s.V1Deployment[]
    try {
      const resp = await this.appsApi.listNamespacedDeployment({
        namespace: config.llmHooksNamespace,
        labelSelector: `${MANAGED_BY_LABEL}=${MANAGED_BY_VALUE}`,
      })
      deployments = resp.items ?? []
    } catch (error) {
      console.error(`${LOG} Orphan sweep: failed to list Deployments:`, error)
      return
    }
    for (const dep of deployments) {
      const podKey = dep.metadata?.labels?.[HOOK_PODKEY_LABEL]
      if (!podKey) continue
      if (this.membersForPodKey(podKey).length > 0) continue
      console.log(`${LOG} Orphan sweep: pod key ${podKey} has 0 members — deleting workload`)
      await this.runSerialized(podKey, () => this.gcPodKey(podKey))
    }
  }

  // ─── Readiness + observedDigest ─────────────────────────────────────

  private async readDeploymentRollout(
    name: string
  ): Promise<{ ready: boolean; readyReplicas: number; detail: string }> {
    try {
      const dep = await this.appsApi.readNamespacedDeployment({
        name,
        namespace: config.llmHooksNamespace,
      })
      const desired = dep.spec?.replicas ?? 1
      const readyReplicas = dep.status?.readyReplicas ?? 0
      return {
        ready: readyReplicas >= desired,
        readyReplicas,
        detail: `ready ${readyReplicas}/${desired}`,
      }
    } catch (error) {
      return { ready: false, readyReplicas: 0, detail: `Deployment read failed: ${errMsg(error)}` }
    }
  }

  /**
   * observedDigest from the LIVE pod's container status (§6). Reflects the
   * digest ACTUALLY running (not merely the intended one), which is what
   * mcp-host binds Host.spec.guardrails.hooks[].digest against and fails closed
   * on. Needs `pods` get/list RBAC in llm-hooks. Empty string when unresolved.
   */
  private async readObservedDigest(podKey: string): Promise<string> {
    try {
      const pods = await this.coreApi.listNamespacedPod({
        namespace: config.llmHooksNamespace,
        labelSelector: `${HOOK_PODKEY_LABEL}=${podKey}`,
      })
      for (const pod of pods.items ?? []) {
        for (const cs of pod.status?.containerStatuses ?? []) {
          const digest = extractSha256(cs.imageID) ?? extractSha256(cs.image)
          if (digest) return digest
        }
      }
    } catch (error) {
      console.warn(`${LOG} Failed to read observedDigest for pod key ${podKey}:`, error)
    }
    return ''
  }

  // ─── Status subresource writer (mirror writeStatusCondition) ──────────

  /**
   * Write (merge) the `Ready` condition plus flat observedDigest/readyReplicas/
   * lastReconciled on an LlmHook, fenced by a resourceVersion `test` op with
   * retry-on-409/422 so a concurrent writer never clobbers the other's fields.
   * Short-circuits when nothing changed (prevents a status→watch→reconcile loop).
   */
  private async writeStatus(
    hook: LlmHookCRD,
    condition: Omit<LlmHookCondition, 'lastTransitionTime'>,
    extras: StatusExtras = {}
  ): Promise<void> {
    const MAX_ATTEMPTS = 4
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const now = new Date().toISOString()
      let current: { metadata?: { resourceVersion?: string }; status?: LlmHookStatus }
      try {
        current = (await this.customApi.getNamespacedCustomObjectStatus({
          group: GROUP,
          version: VERSION,
          namespace: hook.namespace,
          plural: PLURAL_LLMHOOKS,
          name: hook.name,
        })) as { metadata?: { resourceVersion?: string }; status?: LlmHookStatus }
      } catch (error) {
        if (getErrorCode(error) === 404) return
        console.warn(`${LOG} Failed to read status for "${hook.name}":`, error)
        return
      }

      const resourceVersion = current.metadata?.resourceVersion
      const hasStatusObject = typeof current.status === 'object' && current.status !== null
      const existing = current.status ?? {}
      const existingConditions = existing.conditions ?? []

      const prior = existingConditions.find(c => c.type === condition.type)
      const lastTransitionTime =
        prior && prior.status === condition.status ? (prior.lastTransitionTime ?? now) : now
      const merged: LlmHookCondition = {
        type: condition.type,
        status: condition.status,
        reason: condition.reason,
        message: condition.message,
        lastTransitionTime,
        ...(hook.generation !== undefined && { observedGeneration: hook.generation }),
      }
      const nextConditions = [...existingConditions.filter(c => c.type !== condition.type), merged]

      const nextStatus: LlmHookStatus = {
        ...existing,
        conditions: nextConditions,
        ...(extras.observedDigest !== undefined && { observedDigest: extras.observedDigest }),
        ...(extras.readyReplicas !== undefined && { readyReplicas: extras.readyReplicas }),
        ...(extras.lastReconciled !== undefined && { lastReconciled: extras.lastReconciled }),
      }

      // No-op gate: skip the patch when nothing meaningful changed, so a status
      // write does not self-trigger an endless reconcile loop.
      const conditionUnchanged =
        prior !== undefined &&
        prior.status === condition.status &&
        prior.reason === condition.reason &&
        prior.message === condition.message
      const digestUnchanged =
        extras.observedDigest === undefined || existing.observedDigest === extras.observedDigest
      const replicasUnchanged =
        extras.readyReplicas === undefined || existing.readyReplicas === extras.readyReplicas
      if (conditionUnchanged && digestUnchanged && replicasUnchanged) return

      const statusPatch = [
        ...(resourceVersion
          ? [{ op: 'test', path: '/metadata/resourceVersion', value: resourceVersion }]
          : []),
        hasStatusObject
          ? { op: 'add', path: '/status/conditions', value: nextConditions }
          : { op: 'add', path: '/status', value: nextStatus },
        ...(hasStatusObject && extras.observedDigest !== undefined
          ? [{ op: 'add', path: '/status/observedDigest', value: extras.observedDigest }]
          : []),
        ...(hasStatusObject && extras.readyReplicas !== undefined
          ? [{ op: 'add', path: '/status/readyReplicas', value: extras.readyReplicas }]
          : []),
        ...(hasStatusObject && extras.lastReconciled !== undefined
          ? [{ op: 'add', path: '/status/lastReconciled', value: extras.lastReconciled }]
          : []),
      ]

      try {
        await this.customApi.patchNamespacedCustomObjectStatus({
          group: GROUP,
          version: VERSION,
          namespace: hook.namespace,
          plural: PLURAL_LLMHOOKS,
          name: hook.name,
          body: statusPatch,
        })
        return
      } catch (error) {
        if (getErrorCode(error) === 404) return
        const code = getErrorCode(error)
        if ((code === 409 || code === 422) && attempt < MAX_ATTEMPTS) continue
        console.warn(`${LOG} Failed to write status on "${hook.name}":`, error)
        return
      }
    }
  }
}

function condition(
  status: 'True' | 'False' | 'Unknown',
  reason: LlmHookReadyReason,
  message: string
): Omit<LlmHookCondition, 'lastTransitionTime'> {
  return { type: 'Ready', status, reason, message }
}

function extractSha256(ref: string | undefined): string | undefined {
  if (!ref) return undefined
  const m = ref.match(/sha256:[a-f0-9]{64}/)
  return m ? m[0] : undefined
}

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
