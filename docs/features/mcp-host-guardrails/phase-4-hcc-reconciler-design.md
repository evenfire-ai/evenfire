# Phase 4 — host-context-controller `LlmHook` reconciler — Implementation Design

|  |  |
|---|---|
| **Type** | implementation design (component-scoped; implementable) |
| **Status** | draft for review — no code authorized yet |
| **Scope** | `host-context-controller` only. Consumes the `LlmHook` CRD (§8.2) and `Host.spec.guardrails` (§5), both already landed (bucket B slice A). |
| **Parent** | [`mcp-host-guardrails-spec.md`](./mcp-host-guardrails-spec.md) §8.2, §8.5, §12.1 |
| **Depends on** | slice A (CRD) ✅. Independent of slice D (control-api install saga) and the external registry schema — this reconciler acts on `LlmHook` CRs regardless of who wrote them. |

---

## 0 · Executive summary

host-context-controller (HCC) already reconciles several `clerum.io` CRDs into workloads with a hand-rolled
`@kubernetes/client-node` watch model — each CRD kind has its own reconciler class, watch loop, and status
write-back (`McpServerReconciler`, `HostReconciler`, `NetworkPolicyReconciler`, … constructed in
`McpServerWatcher`, `src/k8sClient.ts:622-701`). This design adds an `LlmHookReconciler` that turns an
`image`-target `LlmHook` into a `Deployment + Service + NetworkPolicy` in the `llm-hooks` namespace, and
writes `LlmHook.status`. `service` and `remote` targets deploy **nothing** (status-only).

**The one hard divergence from every existing reconciler: digest-dedup makes this N-CRs → 1-workload.**
Multiple `image` hooks that share a **pod key** (image digest + port + envSecret + egressBindings + security)
are **co-located on a single pod** and addressed by distinct `spec.path`. Every existing reconciler is
1-CR → 1-workload, GC'd by a single controlling `ownerReference`. That model **cannot** express a shared pod
(K8s allows one controlling owner; deleting that CR would cascade-delete a pod other hooks still use). So the
three mechanisms below replace the owner-ref pattern: **reference-counted, label-owned workloads**,
**per-pod-key serialization**, and a **Host→LlmHook reverse index** for the NetworkPolicy ingress set.

Mirror, don't reinvent: reuse `McpServerReconciler`'s hardened pod securityContext
(`hardenedContainerSecurityContext`, `src/reconciler.ts:934`), `@clerum/image-policy`,
`@clerum/workflow-recipe-capability-policy`, the create-then-409-`replaceWithConflictRetry` apply helpers
(`src/utils.ts`), the ownership-verifying delete helpers, and the status-subresource JSON-Patch writer
(`patchNamespacedCustomObjectStatus`, `src/reconciler.ts:1750`). The `NetworkPolicyReconciler` L0–L3 layering
(`src/networkPolicyReconciler.ts`) is the template for the hook pod's default-deny + infra + ingress + egress.

---

## 1 · The pod-key model (digest-dedup)

### 1.1 · Definition

The **pod key** is a stable hash over the *pod-level* fields of an `image` target — the fields that must be
identical for two hooks to safely share a pod:

```
podKey = sha256short(canonicalJSON({
  imageRef:        spec.target.image.ref,          // digest-pinned (§8.5)
  port:            spec.target.image.port,
  envSecret:       spec.target.image.envSecret ?? '',
  egressBindings:  normalize(spec.target.image.egressBindings ?? []),  // sorted, canonicalized
  addCapabilities: sort(spec.target.image.security?.addCapabilities ?? []),
}))
```

`spec.path`, `spec.lifecyclePoints`, `spec.order`, `spec.capabilities`, `spec.failMode`, `spec.config`,
`spec.onUnavailable`, and `spec.timeoutMs` are **NOT** in the pod key — they are per-hook routing/policy that
mcp-host applies, not pod-shaping. Two hooks with the same pod key but different paths co-locate; the same
image with a *different* envSecret or egressBindings gets its **own** pod key → its own pod (a different
trust/egress boundary, §12.1 — egress is never unioned across unrelated hooks).

Workload resources are named from the pod key, not the CR: `llmhook-<podKey>` for the Deployment/Service, so
the name is stable across the set of co-located hooks. Labels:
`clerum.io/managed-by=host-context-controller`, `clerum.io/hook-pod-key=<podKey>`, `app=llmhook-<podKey>`.

### 1.2 · Path uniqueness within a pod key

Co-located hooks are routed by `spec.path`; a duplicate `path` across two hooks sharing a pod key is a
**config error** the apiserver cannot catch (CEL can't validate cross-object). At reconcile, before applying
the workload, the reconciler collects all `LlmHook`s with the same pod key and checks path uniqueness. On a
collision it sets the offending CR(s) to a `Ready=False, reason=DuplicatePath` condition and does **not**
route the loser (fail-closed for that hook), while still serving the others. No existing reconciler does
cross-object validation — this is new.

---

## 2 · Reconcile flow (per `LlmHook` CR)

`reconcile(hook)` — entry point, serialized (see §4). Mirrors `McpServerReconciler.performReconcile`
(`src/reconciler.ts:1807`):

1. **Classify target.** `service` / `remote` → **status-only**: write `Ready=True, reason=NoWorkload`
   (nothing to deploy; mcp-host dials the Service/remote directly). Return. (Contrast McpServer `remote`,
   which deploys an nginx proxy — hooks do **not**.)
2. **image target** → compute `podKey`. Load the full co-located set (all `LlmHook`s in `llm-hooks` with the
   same pod key) from the in-memory cache.
3. **Validate:** path uniqueness (§1.2); `security.addCapabilities ⊆` the workflow-recipe capability
   allowlist; `envSecret` (if set) exists in `llm-hooks` (mirror `validateSecret`, `src/reconciler.ts:436`,
   which also yields the credentials-revision digest that forces rolling restarts on secret rotation).
4. **Ensure workload for the pod key** (idempotent; see §3 for who "owns" it):
   - `buildDeployment(podKey, set)` — mirror `buildDeployment` (`:812`): hardened securityContext,
     `automountServiceAccountToken:false`, image `ref`, container port, `envSecret` mount, the
     credentials-revision annotation on the pod template. One container (the shared image); routing across
     co-tenant paths is mcp-host's concern, not the pod's.
   - `buildService(podKey)` — ClusterIP, mirror `buildService` (`:1161`).
   - `buildNetworkPolicy(podKey)` — see §5.
   - Apply via the existing create-then-409 `replaceWithConflictRetry` helpers (`ensureDeployment`/
     `ensureService`, `:1209`/`:1253`) with the preserve-assigned-fields merges.
5. **Readiness + status.** Poll rollout (`readDeploymentRollout`/`pollReadiness`, `:255`/`:310`), extract
   `observedDigest` (§6), then write each member CR's status (§6): `Ready`, `readyReplicas`,
   `observedDigest`, `lastReconciled`.

`reconcileDelete(name)` — mirror `reconcileDelete` (`:2080`) but drive the **reference-counted** GC (§3): the
workload is torn down only when the *last* hook for its pod key is gone.

---

## 3 · Reference-counted, label-owned GC (replaces owner-ref cascade)

**Problem.** A single controlling `ownerReference` from one `LlmHook` to a shared Deployment is wrong: K8s
permits one controller owner, and deleting that CR would garbage-collect a pod the other co-tenant hooks
still need.

**Design.** HCC owns the shared workload itself and reference-counts by pod key:

- **No controlling owner-ref.** The Deployment/Service/NetworkPolicy carry the `clerum.io/hook-pod-key` label
  and `clerum.io/managed-by=host-context-controller`, but **no** `ownerReferences` (or at most
  non-controlling refs to every member for observability — non-controlling refs do not cascade-delete).
  Ownership for delete decisions is established by the labels, re-read and verified before any delete (mirror
  `deleteDeploymentIfHccOwned`, `:1291-1416`).
- **Reference count = live members.** On every reconcile (add/update/delete) the reconciler derives the
  current member set for the pod key from the cache: `members(podKey) = { LlmHooks with that pod key }`.
  - `members.length > 0` → ensure the workload exists and its NetworkPolicy ingress reflects the current
    referencing Hosts (§5).
  - `members.length === 0` → delete the Deployment+Service+NetworkPolicy for that pod key (verify HCC
    ownership by label first).
- **Trigger on delete.** When an `LlmHook` is deleted, compute its (former) pod key from the cached object
  before eviction, drop it from the cache, then run the pod-key reconcile which now sees a smaller (possibly
  empty) member set. This is the same "recompute from cache after the event" shape the McpServer watch
  callback already uses (`getMcpServerWatchCallback`, `src/k8sClient.ts:2284`).
- **Startup sweep / orphan GC.** On `fullReconcile` (and a periodic resync timer), list all `llmhook-*`
  Deployments by label and delete any whose `hook-pod-key` has zero live members — covers pods orphaned by a
  missed delete event or a crash between CR-delete and workload-delete. (Existing reconcilers rely on
  owner-ref cascade for this; we cannot, so the sweep is mandatory, not optional.)

**Finalizer (decision — §9 #1):** default to **no CR finalizer**, using the recompute-and-sweep model above,
because a finalizer on a shared resource complicates the "last one out" logic and can wedge deletes if HCC is
down. The startup sweep is the backstop. Revisit if we observe orphan pods surviving a delete storm.

---

## 4 · Concurrency — serialize by pod key, not CR name

`McpServerReconciler.reconcile` (`:1793`) serializes by **CR name** via an `inFlight: Map<name, Promise>`
tail-chain. That is unsafe here: two different `LlmHook`s mutating the **same pod key** race on the same
Deployment/Service/NetworkPolicy (409/replace storms, lost path routes, ingress flapping).

**Design.** Key the in-flight serialization by **pod key** for image targets (`inFlight: Map<podKey, Promise>`),
so all work touching one shared workload runs strictly sequentially, while different pod keys run
concurrently. `service`/`remote` targets have no workload and can serialize by CR name (or skip). A single
`LlmHook` update that *changes* its pod key (e.g. image bump) must chain on **both** the old and new pod keys
(tear-down of the old, ensure of the new) to avoid interleaving.

---

## 5 · NetworkPolicy — Host reverse-index ingress + per-hook egress

Reuse the `NetworkPolicyReconciler` layering (`src/networkPolicyReconciler.ts:5-14`):

- **L0/L1 baseline for `llm-hooks`.** `ensureDefaultPolicies` (`:194`) currently runs per known runtime
  namespace; add `llm-hooks` so hook pods get default-deny ingress+egress + infra egress (DNS, K8s API, HCC
  API). Without this, hook pods get no DNS/egress baseline. (§7 config plumbing.)
- **Ingress (the reverse index).** The shared pod's ingress must admit **exactly** the mcp-hosts whose `Host`
  CR references any co-located hook — i.e. `∪ over members m of { Hosts H : H.spec.guardrails.hooks[*][*].id
  == m.name }`. This mirrors the L2 "ingress admits exactly the referencing namespaces/pods" builder
  (`reconcileContext`, `:435`, `namespaceSelector`+`podSelector` at `:485-533`), but the referencing set
  comes from `Host.spec.guardrails.hooks` instead of `Context.spec.mcpServers`.
  - Requires a **Host→LlmHook reverse index**: on every `Host` change, recompute which hook pod keys the Host
    references and re-reconcile those pods' NetworkPolicies. Add a fan-out from the Host watch into the hook
    reconciler, analogous to how CC counts fan into `HostReconciler` (`src/k8sClient.ts:667`). `Host` is
    already watched (`HostReconciler`); extend its callback to also trigger hook-NP reconciles.
- **Egress.** Per the hook's own `egressBindings` (L3, `reconcileExternalEgress`, `:732`, with the SSRF
  blocklist `PUBLIC_EGRESS_EXCEPT_CIDRS`, `:51`). Because egress is part of the pod key, all co-tenants share
  one egress boundary by construction — egress is never unioned across unrelated hooks (§12.1). **Caveat**
  carried from slice A: `LlmHook.egressBindings` is currently looser than `McpServer.egressBindings` (no
  private-range CEL); the reconciler must apply the same SSRF/private-range validation the NP reconciler
  already enforces for McpServer egress, and set `Ready=False, reason=InvalidEgress` on a rejected binding.

---

## 6 · `observedDigest` extraction + status write-back

- **Status shape (slice A decision):** K8s `conditions[]` (like McpServer/Host) **plus** flat
  `observedDigest`, `readyReplicas`, `lastReconciled`. Write via the status subresource JSON-Patch helper
  (`writeStatusCondition`/`updateStatusConditions`/`patchNamespacedCustomObjectStatus`, `:1642/:1585/:1750`)
  with the `resourceVersion` `test` op + retry-on-409/422. **Every member CR of a shared pod gets its own
  status** (they share a pod but are distinct CRs).
- **`observedDigest` (new capability).** Existing readiness reads only replica counts. To report the digest
  *actually running*, read the pod's container `image` (resolved digest) for the pod-key Deployment — needs
  `pods` get/list RBAC in `llm-hooks` (the McpServer Role does **not** grant pods; the workflow-recipes Role
  does — mirror that). mcp-host binds `Host.spec.guardrails.hooks[].digest == status.observedDigest` at load
  and fails-closed (`may_deny`) / skips-with-alert (advisory) on mismatch (§8.2) — so a wrong/empty
  `observedDigest` is a safety signal, not cosmetic.
- **Condition vocabulary (proposed):** `Ready` (True when rollout complete + path unique + secret resolved),
  with `reason ∈ { NoWorkload, Deploying, Ready, DuplicatePath, SecretNotFound, InvalidEgress,
  DigestMismatch, ReconcileError }`. Keep it a bounded enum (§9 metrics discipline).

---

## 7 · Wiring, config, RBAC, namespace baseline

1. **Types** — `LlmHookCRD`/`LlmHookSpec`/`LlmHookStatus` in `src/types.ts` (analogous to `McpServerCRD`).
2. **Reconciler** — `src/llmHookReconciler.ts` (`LlmHookReconciler`), constructed in `McpServerWatcher`
   (`src/k8sClient.ts:622-701`).
3. **Watch** — add `PLURAL_LLMHOOKS='llmhooks'`, `getLlmHookWatchCallback()` + `startLlmHookWatch()`
   (mirror `:2284`/`:2386`), a `llmHooks: Map` cache + abort handle, start in `start()` next to
   `startMcpServerWatch` (`:1788`), `stop()` cleanup, and a periodic resync timer (feeds the §3 sweep).
   **Watch namespace = `llm-hooks`** (new `config` entry, `src/config.ts`, alongside `namespace`/
   `hostNamespace`/`channelsNamespace`). Extend the `Host` watch callback to fan out hook-NP reconciles (§5).
4. **Constants** — `LLMHOOK_LABEL='clerum.io/llmhook'`, `HOOK_PODKEY_LABEL='clerum.io/hook-pod-key'`
   (`src/constants.ts`).
5. **RBAC** — new `deploy/base/llm-hooks/rbac.yaml` (namespace-scoped `Role`+`RoleBinding` binding the HCC
   ServiceAccount into `llm-hooks`), modeled on `deploy/base/mcp-server/rbac.yaml:75-128`, granting in
   `llm-hooks`: `llmhooks` [get,list,watch,patch], `llmhooks/status` [get,patch], `deployments` (apps),
   `services`/`configmaps`/`secrets`, `networkpolicies` (networking.k8s.io), **and `pods` [get,list]** (for
   `observedDigest`). Wire into the kustomization; add a sibling assertion to `src/rbacManifest.test.ts`
   (which reads `deploy/base/mcp-server/rbac.yaml`).
6. **Namespace baseline** — ensure `ensureDefaultPolicies` covers `llm-hooks` (§5).

---

## 8 · Failure modes / edge cases

| Case | Behavior |
|---|---|
| Duplicate `path` in a pod key | Loser(s) `Ready=False reason=DuplicatePath`, not routed; others served. |
| `envSecret` missing | `Ready=False reason=SecretNotFound`; no rollout (mirror McpServer secret gate). |
| Image bump (pod key changes) | Chain on old+new pod keys (§4): tear down old workload if it now has 0 members; ensure new. |
| Last hook for a pod key deleted | Reference count → 0 → delete workload (label-ownership verified). |
| Missed delete event / crash | Startup + periodic sweep deletes label-orphaned `llmhook-*` workloads with 0 members. |
| Host reference added/removed | Host-watch fan-out re-reconciles the affected pod keys' NetworkPolicy ingress. |
| Invalid egress binding | `Ready=False reason=InvalidEgress`; workload not exposed to that egress. |
| `service`/`remote` target | Status-only `Ready=True reason=NoWorkload`; nothing deployed. |

---

## 9 · Open decisions / risks

1. **Finalizer vs sweep** — proposed **no finalizer**, rely on recompute + startup/periodic sweep (§3).
   Simpler and crash-safe; the risk is a longer orphan window on a missed event (bounded by the resync
   interval). Decide the resync interval (proposed 5 min, matching existing resyncs).
2. **Non-controlling owner-refs to all members?** — optional, for `kubectl`-visible ownership. They don't
   cascade-delete, so they're safe, but they churn on every membership change. Proposed: **labels only**,
   skip owner-refs, to avoid ref churn. Decide.
3. **`observedDigest` source** — read from the Deployment's pod template image (fast, but reflects *intended*
   digest) vs a live pod's container status (reflects *running* digest, needs `pods` RBAC + handles
   mid-rollout). Proposed: **live pod** for true "actually running" semantics (§8.2 binds on it).
4. **Egress hardening** — the reconciler must apply McpServer-grade SSRF/private-range validation to the
   looser `LlmHook.egressBindings` (slice A gap). Confirm we reuse the NP reconciler's existing validators
   rather than trusting the CRD.
5. **Cross-namespace `service` target** — a `service` target names an arbitrary `{namespace}`; mcp-host dials
   it directly. HCC deploys nothing but should it validate the Service exists / is in an allowed namespace?
   Proposed: status-only, no validation in v1 (admin-authored CRs); flag if we want an allowlist.

---

## 10 · Test plan (vitest, mirroring existing reconciler tests)

- **Pod-key hashing** — same pod-level fields → same key; differing envSecret/egress/caps → different key;
  path/order/capabilities do NOT affect the key.
- **Dedup** — two hooks same pod key + distinct paths → one Deployment/Service; distinct pod keys → two.
- **Path collision** — two hooks same pod key + same path → loser `DuplicatePath`, winner served.
- **Reference-counted GC** — delete one of two co-tenants → workload stays; delete the last → workload
  deleted; sweep removes a label-orphan with 0 members.
- **Concurrency** — interleaved reconciles of two CRs sharing a pod key serialize (no double-create); image
  bump chains old+new keys.
- **NetworkPolicy ingress** — reflects exactly the referencing Hosts; Host add/remove re-reconciles;
  invalid egress → `InvalidEgress`, not exposed.
- **Status** — `conditions[]` + `observedDigest`/`readyReplicas`/`lastReconciled` written per member;
  `service`/`remote` → `NoWorkload`.
- **RBAC manifest** — assertion test for the new `llm-hooks` Role (incl. `pods` get/list).
