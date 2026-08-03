# Platform image-pull credentials for recipe workloads

**Status:** Implemented (see PR #243)
**Date:** 2026-08-04
**Area:** control-api · workflow-recipes (WRC) · workflow-runtime-core · image pull · self-hosted
**Follows:** [`registry-pull-secret-self-provisioning.md`](registry-pull-secret-self-provisioning.md)
(the MCP-server slice, PR #243) — read that first; this spec extends its model to
`WorkflowRecipe` workloads and deliberately reuses its decisions rather than inventing a
parallel mechanism.

---

## 1. Summary

PR #243 made control-api self-provision the `evenfire-registry-pull` dockerconfigjson
Secret so **MCP-server** plugins on a self-hosted cluster can pull private images. That
slice stops at the `mcp-server` namespace.

**Recipe plugins are not covered, and cannot be made to work by configuration.** A
`WorkflowRecipe` whose workload runs a private evenfire-registry image fails today, in one
of two ways depending on the recipe's shape — and the platform has no supported path to
fix it, because *nothing in the repo creates a usable pull Secret for recipe namespaces*.

This spec closes that with the same shape as #243: **control-api owns the credential, the
platform injects the reference, the recipe never names it.** The two changes of substance
are (a) provisioning fans out to every platform workload namespace from a **single** mint,
and (b) WRC injects the reference itself instead of trusting a recipe-declared name.

---

## 2. What exists today

### 2.1 WRC projects and gates pull secrets — it never creates them

The CRD supports declaration: `workloads[].imagePullSecrets: string[]`
(`charts/clerum-crds/crds/workflowrecipe.yaml:1100`, `workflow-recipes/src/types.ts:129`
— *"Docker registry secrets for private images"*). WRC consumes it at two enforcement
points, both **fail-closed** under Issue #637:

- `workflow-recipes/src/reconciler/resourceBuilder.ts:872-882` — builds the pod's
  `imagePullSecrets`, dropping `denied`/`error` names.
- `workflow-recipes/src/reconciler/mcpDelegation.ts:231` — filters to
  `projectableImagePullSecrets` **before** writing the `McpServer` CRD, because HCC
  materializes that spec verbatim and re-checks nothing
  (`host-context-controller/src/reconciler.ts:994-1002`).

The access states (`workflow-recipes/src/reconciler/secretOwnership.ts:54-102`):

| State | Meaning | Outcome |
| --- | --- | --- |
| `accessible` | `clerum.io/owner-recipe` matches, or `clerum.io/shared=true` | projected |
| `denied` | exists but **unlabeled**, or owned by another recipe | **stripped** |
| `error` | ownership unverifiable | stripped, requeue |
| `missing` | 404 | projected anyway → `ImagePullBackOff` |

`combineSecretAccess` is cross-namespace and fail-closed: **a name `denied` in ANY
classified namespace is denied everywhere.**

This is live, not latent: the access map is threaded through the reconciler
(`workflowRecipeReconciler.ts:2006-2032`) and denied workloads are actively torn down
(`:2082`).

### 2.2 Nothing provisions a recipe pull Secret

The only `kubernetes.io/dockerconfigjson` writer in the repo is
`control-api/src/services/registryPullSecretService.ts` (from #243), and it targets
`config.mcpServersNamespace` only.

The endpoint that *does* create recipe-owned Secrets — `POST /admin/recipes/secrets` —
**hardcodes `type: 'Opaque'`** (`control-api/src/routes/admin/recipes.ts:1654`). The
kubelet honors only `kubernetes.io/dockerconfigjson` / `kubernetes.io/dockercfg` for image
pulls, so that endpoint **structurally cannot** produce a working pull Secret. An operator
who follows the documented recipe-secret flow to create one gets a silently unusable
object — no error, just `ImagePullBackOff` later.

So the only path that works today is entirely out-of-band:

```bash
kubectl create secret docker-registry my-pull -n sandbox-recipes ...
kubectl label secret my-pull -n sandbox-recipes clerum.io/owner-recipe=<recipe>
```

### 2.3 Recipe workloads do not run in `mcp-server`

`resolveWorkloadSecretNamespace` (`control-api/src/routes/admin/recipes.ts:66-80`,
mirrored in WRC) splits three ways:

| Workload | Namespace |
| --- | --- |
| has `transport` | `config.mcpServersNamespace` (`mcp-server`) |
| is `spec.ui.workloadRef` | `config.sandboxUiNamespace` (`sandbox-ui`) |
| everything else | `config.sandboxNamespace` (`sandbox-recipes`) |

---

## 3. The failure, precisely

For a recipe workload running `registry.evenfire.ai/<org>/<img>`:

1. **`install-recipe` provisions nothing** — the pull-secret hook exists only on the
   MCP-server install/upgrade paths (`registry.ts:1278`, `:1904`).
2. **No Secret exists** in `sandbox-recipes` / `sandbox-ui`. #243's service actively
   *refuses* to write outside `mcpServersNamespace` (its namespace guard), so it cannot
   even be pointed there.
3. **If the recipe declares the name anyway**, #637 classifies it. In a recipe with only
   non-transport workloads it is `missing` → projected → `ImagePullBackOff`. In a **mixed**
   recipe it is also classified in `mcp-server`, where #243's Secret exists carrying only
   `clerum.io/managed-by=control-api` — *unlabeled* to the #637 model → **`denied`** →
   denied in every namespace → the reference is **silently stripped**.

The second case is the nastier one: the credential is present and correct, and the
platform removes the reference to it.

---

## 4. Goals / Non-goals

### Goals

- **G1.** A recipe plugin whose workload image lives on the configured evenfire registry
  pulls successfully on a self-hosted cluster, with no operator action.
- **G2.** One credential per org, materialized consistently across every platform workload
  namespace — never one mint per namespace (§6.3).
- **G3.** The platform credential is **never** reachable by recipe-authored `envSecret`
  references. Closing G1 must not open an exfiltration path.
- **G4.** No second source of truth. The "is this image ours?" predicate and the Secret
  name are defined **once** and consumed by both services (§6.2).
- **G5.** Recipes stay portable: a recipe manifest carries no evenfire-specific pull-secret
  plumbing, so the same manifest works on managed and self-hosted.

### Non-goals

- **Third-party private registries.** A recipe pulling from a non-evenfire registry keeps
  using recipe-declared `imagePullSecrets` + the #637 owner-recipe model. That separation
  is deliberate: *platform credential for the platform registry, recipe-owned credential
  for everything else* (§8.3).
- Changing the #637 ownership model, or exempting names from it (§6.1, rejected).
- Managed-cluster behavior. As in #243, everything here is gated to `self-hosted`; the
  managed operator keeps owning provisioning on its clusters.
- Reactive rotation of an out-of-band-revoked key (still open from #243 §12-2), though
  §6.3's fingerprint makes cross-namespace divergence detectable.

---

## 5. Why not the obvious approaches

Recording these because each looks reasonable and two are actively unsafe.

### 5.1 Label the Secret `clerum.io/shared=true` — **rejected, unsafe**

The natural way to satisfy #637. But `isSecretAccessibleByRecipe`
(`packages/workflow-runtime-core/src/secret-ownership.ts:36-44`) is the **same predicate**
for `envSecret` and `imagePullSecrets`. `shared=true` would let any third-party recipe on
the cluster declare:

```yaml
envSecret: { name: evenfire-registry-pull, keys: [{ secretKey: .dockerconfigjson, envVar: X }] }
```

and read the org's registry credential out of its own environment. This converts a
pull-only credential into a cluster-wide exfiltration primitive. **Never label it shared.**

### 5.2 control-api writes `imagePullSecrets` into the recipe CRD at install — **rejected, does not work**

Appealing because it needs no WRC change. But a name in the CRD *is* a recipe-declared
reference, so #637 classifies it — and our Secret is unlabeled to that model → `denied` →
stripped. It fails for exactly the reason in §3.3.

It is also brittle long-term: the reference would be frozen into every stored CRD, so a
later `CLERUM_REGISTRY_URL` change leaves stale references behind. Injection at reconcile
time self-corrects (same reasoning as validating the Secret's `auths` host in #243 §7.6).

### 5.3 Exempt the reserved name inside the #637 pull-secret filter — **rejected, erodes the gate**

Workable (exempt only in the `imagePullSecrets` filter, never `envSecret`), and it would
let §5.2 proceed. Rejected because it puts a name-based exemption inside a security gate
whose entire value is that it is uniform and fail-closed — precisely the kind of
special-case that rots. It also still requires WRC to know the reserved name, so it saves
nothing over injection.

---

## 6. Design

### 6.1 The platform injects; recipes never name it

WRC attaches the platform pull secret **after** the #637 ownership filter, to any workload
whose image host equals the configured registry host — mirroring what control-api already
does for `McpServer` (`shouldAttachEvenfirePullSecret`).

Because the recipe never *references* the Secret, it is **never classified**, so:

- no ownership label is needed → no `shared` → **no `envSecret` exfiltration path** (G3)
- a recipe cannot opt in, opt out, or rename the credential
- recipe manifests stay portable across managed/self-hosted (G5)

Both enforcement points get the injection, since both produce runnable specs:

| Point | File | Effect |
| --- | --- | --- |
| Pod template | `resourceBuilder.ts` (after the `allowedPullSecrets` filter) | recipe workloads in any namespace |
| McpServer delegation | `mcpDelegation.ts` (after `projectableImagePullSecrets`) | transport workloads → `McpServer` → HCC |

**Reserved-name handling.** If a recipe explicitly declares the platform name, injection
makes it redundant; the declared copy would be `denied` and stripped, and we would inject
it anyway. To avoid that confusing silent no-op, recipe validation should **reject** the
reserved name with a message saying it is platform-managed. Fail loudly rather than
appear to honor a declaration we ignore.

### 6.2 One source of truth, in `@clerum/workflow-runtime-core`

Issue #637 was *caused* by the same rule living in two services and drifting; the fix put
the predicate in the shared package "precisely so the rule cannot drift between the two
enforcement points" (`secret-ownership.ts:9-12`). Both control-api and workflow-recipes
already depend on `@clerum/workflow-runtime-core`.

Move there, and have both services import:

```ts
export const EVENFIRE_REGISTRY_PULL_SECRET_NAME = 'evenfire-registry-pull'
export function registryHostFromUrl(registryUrl: string): string | null
export function imageRefHost(image: string): string | null
/** True when `image` is hosted on the configured evenfire registry. */
export function isPlatformRegistryImage(image: unknown, registryUrl: string): boolean
```

control-api's `shouldAttachEvenfirePullSecret` becomes
`isLocal && isPlatformRegistryImage(...)`, preserving its current semantics exactly. WRC
calls `isPlatformRegistryImage` directly (recipe workloads have no `isLocal` notion).

**New WRC config: reuse `CLERUM_REGISTRY_URL` verbatim** (WRC has no registry config
today). Deliberately the *same* variable name control-api reads, not a WRC-prefixed alias:
the two values must agree, and a shared name makes a mismatch a deployment error rather
than a silent divergence. If they ever drift, recipe pods get no credential while MCP
servers do — the hardest failure in this design to diagnose (R3), so the config is kept
impossible to set inconsistently by accident.

### 6.3 One mint, fanned out — the core correctness rule

The credential is per-**org**; the Secret is per-**namespace**. The registry's
`mintPullKey` is **rotate-on-call** with ≤1 active pull key per org, so minting per
namespace would have each mint **revoke the previous namespace's key** — leaving the first
namespaces holding dead credentials while the last one works. This is the single easiest
way to get this feature badly wrong.

Generalize #243's service:

```ts
ensureRegistryPullSecrets(gateway, namespaces: string[]): Promise<Map<string, EnsurePullSecretResult>>
```

1. **Read all** target namespaces.
2. **Classify each** with #243's existing rules (ours-and-valid / foreign / absent-or-broken).
   Foreign namespaces are dropped from the write set and never touched.
3. **Mint at most once**, and only if ≥1 non-foreign target is absent or broken.
4. **Write the new blob to every non-foreign target** — *including ones that were valid*,
   because the mint just revoked their key.

Post-condition (the invariant worth testing): *after a successful ensure, every
non-foreign target namespace holds the same, current credential.*

**Fingerprint annotation.** Write `clerum.io/pull-key-fingerprint: <sha256(key)[0:12]>`
alongside the payload. This makes cross-namespace divergence **detectable**: if targets
disagree, a partial write happened (mint succeeded, one write failed) and the stale ones
must be repaired. #243 dropped the "key id" annotation because the registry returns no id
— a fingerprint of the key we wrote needs no registry support and is strictly more useful.

**Namespace allowlist.** #243 restricts writes to `config.mcpServersNamespace`. Widen to
the three **platform** workload namespaces (`mcpServersNamespace`, `sandboxNamespace`,
`sandboxUiNamespace`) — still a fixed allowlist derived from config, never from
`body.namespace`. control-api already holds `secrets:create` in all three.

### 6.4 Provisioning trigger — eager across all platform namespaces

**Decision: provision into all three platform workload namespaces** whenever provisioning
runs, rather than computing per-recipe which namespaces a manifest touches. Triggered from
both `install` and `install-recipe`, and only when the entry actually references a
platform-registry image (same lazy principle as #243).

The alternatives, and why they lose:

| Option | Verdict |
| --- | --- |
| **Eager — all three** | **Chosen.** One fan-out, one global invariant. |
| Per-recipe — namespaces computed from the manifest | Rejected — see below. |
| Hybrid — `mcp-server` always, sandboxes once recipes exist | Rejected: saves two Secret copies, adds deployment-state tracking. |
| Reconcile-driven — WRC requests the credential when it needs one | Rejected: WRC holds no registry credentials (the same argument that ruled out HCC in #243 §5); adds a control-plane callback. |

**Rotate-on-call is what actually decides this.** Because every mint revokes the org's
previous key, provisioning a *new* namespace later forces a re-mint — which invalidates
the namespaces already provisioned, so all of them must be rewritten anyway (§6.3 step 4).
Per-recipe provisioning therefore does **not** reduce mints; it multiplies cluster-wide
credential churn, once per recipe that introduces a workload class the cluster has not seen.

It is also fragile across the control-api/WRC seam: control-api provisions at **install**,
WRC reconciles **continuously**. A recipe later edited to add a `spec.ui.workloadRef` needs
`sandbox-ui`, which was never provisioned and which nothing re-triggers — a silent
`ImagePullBackOff` with no failing request to attribute it to. Eager provisioning removes
that class of gap entirely.

Cost: two extra copies of a pull-only, org-scoped credential in namespaces the operator
already controls. **No extra mint, no extra registry calls** (§8.2).

### 6.5 Fix the silent `Opaque` failure

`POST /admin/recipes/secrets` hardcodes `type: 'Opaque'` (`recipes.ts:1654`). The kubelet
honors only `kubernetes.io/dockerconfigjson` / `dockercfg` for image pulls, so a request
that intends to create a pull Secret is accepted, written, returns `201` — and is then
**silently ignored at pull time**. The user sees `ImagePullBackOff` with nothing pointing
at the cause.

**The silent failure is the bug**, and it must not survive regardless of how much of the
third-party story we choose to support.

Two cases must stay separate:

- **Platform-registry images** — fully automatic, zero user input. That is this entire
  spec; the recipe-secrets endpoint is not involved at all.
- **Third-party registries** (ghcr.io, private Docker Hub, …) — the platform cannot invent
  these credentials; someone must supply them once.

For the third-party case, **do not ask anyone to paste a base64 `dockerconfigjson`.**
Nobody will, and it is not a credential format humans should handle. Instead accept
**structured input** and let the server assemble it:

```
POST /admin/recipes/secrets   { kind: 'imagePull', registry, username, password, ownership }
  → type: kubernetes.io/dockerconfigjson
  → data['.dockerconfigjson'] = buildDockerconfigjson(registry, username, password)
  → labels: clerum.io/owner-recipe=<recipe>   (so #637 admits it for THAT recipe only)
```

This reuses the same blob builder the platform path already has
(`registryPullSecretService.buildDockerconfigjson`), generalized from the fixed
`username: '_'` form to an arbitrary username. The user supplies a registry, a username and
a token — never base64.

**Minimum bar if the structured endpoint is deferred:** reject a request that is evidently
trying to create a pull Secret (a `.dockerconfigjson` key, or a docker-config-shaped
payload) with an error naming the supported path. Accepting it and writing an object the
kubelet ignores is the one outcome that must not remain.

---

## 7. Implementation

> **As-built note.** Shipped in PR #243 alongside the MCP-server slice. Two deviations
> from the plan below, both deliberate:
> - **`buildSecretReq` carries a key fingerprint annotation**
>   (`clerum.io/pull-key-fingerprint`), and a copy *without* one is treated as broken. This
>   is what makes cross-namespace divergence detectable — and it means Secrets written by
>   the pre-fan-out code are re-minted once on upgrade, converging the cluster onto the
>   annotated form.
> - **Wrong-typed Secrets are deleted BEFORE the single mint**, not during the per-namespace
>   write. A delete that fails must not leave us holding a freshly-minted key that has
>   already revoked the credential the cluster was using.
>
> WRC reads the registry URL via `loadConfig().registryUrl` at the point of use, matching
> the existing pattern in `restEndpoints.ts` rather than threading a new parameter through
> every builder call site.

**`packages/workflow-runtime-core`**
- Add `registry-image.ts`: the name constant + `registryHostFromUrl` / `imageRefHost` /
  `isPlatformRegistryImage`, moved (not copied) from
  `control-api/src/routes/admin/registryImagePullSecret.ts`. Re-export from the package
  index.

**`control-api`**
- `registryImagePullSecret.ts` re-exports from the shared package (keeps existing imports
  working); `shouldAttachEvenfirePullSecret` delegates to `isPlatformRegistryImage`.
- `registryPullSecretService.ts`: `ensureRegistryPullSecrets(namespaces[])` per §6.3 —
  single mint, fan-out write, fingerprint annotation, three-namespace allowlist.
- `registry.ts`: install + upgrade pass the platform namespace set; **`install-recipe`
  gains the same hook**, gated on the entry carrying a platform-registry image.
- `recipes.ts:1654`: §6.5.

**`workflow-recipes` (WRC)**
- New config: registry URL (+ document that it must match control-api's).
- `resourceBuilder.ts`: after `allowedPullSecrets`, append the platform pull secret when
  `isPlatformRegistryImage(workload.image, config.registryUrl)`.
- `mcpDelegation.ts`: same, after `projectableImagePullSecrets`.
- Recipe validation: reject a recipe declaring the reserved name (§6.1).

**Docs**
- `docs/how-to/publish-plugin-to-registry.md` — private-image recipes need no pull-secret
  declaration; the platform handles it.
- Update #243's spec §8/§12 to point here.

---

## 8. Security analysis

**8.1 The credential is not reachable by recipes.** It stays labeled `managed-by=control-api`
only — *unlabeled* to the #637 model — so any recipe-authored `envSecret` **or**
`imagePullSecrets` reference to it is `denied` and stripped. Injection happens after that
filter and is not recipe-authored. Workload pods run on the `default` ServiceAccount with
no `secrets` RBAC, so a pod cannot read it from the API either.

**8.2 Blast radius of two extra copies.** The same org-scoped, pull-only credential now
sits in `sandbox-recipes` and `sandbox-ui` as well as `mcp-server`. It grants pull on the
org's own/granted/public repos and **never push** (`kind='pull'`, empty scopes). Anyone
who could read it in the new namespaces could already read it in `mcp-server` given the
same RBAC class, so this widens exposure by namespace count, not by capability.

**8.3 Third-party registries are unaffected.** Recipe-declared `imagePullSecrets` keep
their existing owner-recipe/shared semantics. Injection only ever *appends* the platform
name for platform-registry images; it never removes or rewrites a recipe's own entries.

**8.4 Host confusion.** Injection keys on the image host matching the configured registry
host — the same invariant as #243 §7.9-2, and the reason the Secret's `auths` map is built
locally rather than trusting the registry's `registryTokenIssuer`-keyed blob.

---

## 9. Rollout

1. Ship `workflow-runtime-core` first (additive; no behavior change).
2. control-api: fan-out provisioning + the `install-recipe` hook. Safe alone — it only
   creates Secrets nothing references yet.
3. WRC: config + injection. This is the step that changes pod specs; a WRC rollout with a
   *missing* registry URL simply injects nothing (degrades to today's behavior).
4. `recipes.ts` `Opaque` fix — independent, can land any time.

Managed clusters are inert throughout (the `self-hosted` gate from #243 is unchanged).
Existing recipes that already declare their own third-party pull secrets are unaffected.

---

## 10. Risks

| # | Risk | Mitigation |
| --- | --- | --- |
| R1 | Per-namespace minting revokes other namespaces' keys → partial cluster-wide `ImagePullBackOff`. | Single mint + fan-out write (§6.3); post-condition asserted in tests. |
| R2 | Partial write (mint OK, one namespace fails) leaves a stale, undetectable key. | Fingerprint annotation makes divergence detectable and repairable (§6.3). |
| R3 | WRC/control-api registry URL drift → recipe pods get no credential while MCP servers do. | Shared predicate (§6.2) + documented config pairing; consider surfacing both values on a status/health endpoint. |
| R4 | Someone "fixes" #637 denial by labelling the Secret `shared`. | §5.1 recorded as an explicit, permanent non-goal; add a test asserting the Secret is NOT `shared`/`owner-recipe` labeled. |
| R5 | A recipe declares the reserved name and expects it honored. | Validation rejects it with an explanatory message (§6.1). |
| R6 | Two extra copies of the credential. | Pull-only, org-scoped, no push; §8.2. |

---

## 11. Test plan

- **Shared predicate** — `isPlatformRegistryImage` table: platform host, other registry,
  no host, empty `registryUrl`; control-api's `shouldAttachEvenfirePullSecret` keeps its
  exact current truth table after delegating.
- **Fan-out** — absent in one of three namespaces → **exactly one** mint, three writes, all
  three carrying the same fingerprint; a foreign Secret in one namespace → untouched, other
  two still provisioned; all-valid-and-same-fingerprint → **no** mint.
- **WRC injection** — platform-registry image gets the reference appended; non-platform
  image does not; a recipe's own third-party pull secrets are preserved alongside;
  injection survives the #637 filter (i.e. is not classified).
- **Anti-exfiltration** — a recipe declaring the platform Secret as `envSecret` is `denied`
  (regression guard for §5.1); a test asserts the Secret carries neither `shared` nor
  `owner-recipe`.
- **e2e (minikube, self-hosted)** — install a recipe plugin with a private image; assert the
  pod pulls; assert a mixed recipe (transport + non-transport) works in both namespaces.

---

## 12. Open questions

**Resolved**

- ~~WRC config plumbing~~ — **reuse `CLERUM_REGISTRY_URL` verbatim** (§6.2).
- ~~Eager vs per-recipe namespaces~~ — **eager, all three** (§6.4). Rotate-on-call means
  per-recipe provisioning increases credential churn rather than reducing it.
- ~~How much of the third-party story to support~~ — **structured input, server builds the
  blob** (§6.5). Never ask a human for base64. Silent acceptance of an unusable Secret is
  the bug being fixed, independent of scope.

**Still open**

1. **Scope of the third-party path (§6.5)** — ship the structured `kind: 'imagePull'`
   endpoint in this slice, or ship only the hard rejection now and the endpoint when a
   real BYO-registry recipe appears?
2. **Reserved-name declaration (§6.1)** — hard-reject at validation, or accept-and-ignore
   with a warning for backwards compatibility?
3. Should HCC gain the presence-validation from #243 §7.7 now that more namespaces
   reference the same Secret name?
