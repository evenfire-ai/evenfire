# Platform image-pull credentials for recipe workloads

**Status:** Implemented in PR #243. Five blocking review findings were raised against it
(§13); **all five are now closed** — the four P1s in code, including §13.1, which reversed
this document's install-time trigger decision (provisioning is now a standing invariant,
because a `WorkflowRecipe` can be created without control-api while WRC injects the
pull-secret reference regardless); and **§13.5, the runtime acceptance gate, by a live
cluster E2E: `tests/e2e/integration/registry-pull-secret-runtime.test.ts`** (§11, §13.5).
Two earlier carve-outs remain recorded in place: WRC injection is deliberately **not**
mode-gated, so the operator contract changes on managed clusters too (§9); and §6.5 shipped
only **partially** — the *minimum bar* (reject a pull-secret-shaped payload instead of
writing an object the kubelet ignores) is in `recipes.ts` and covered by
`routes.adminRecipes.test.ts`, so the third-party BYO-registry path is **no longer a silent
failure** — it is a 400 naming the supported path. What did **not** ship is the structured
`kind:'imagePull'` endpoint that would let the server build the dockerconfigjson from
`registry`/`username`/`password`; until then BYO users still create that Secret by hand.
**Date:** 2026-08-04
**Area:** control-api · workflow-recipes (WRC) · workflow-runtime-core · image pull · self-hosted
**Follows:** [`registry-pull-secret-self-provisioning.md`](registry-pull-secret-self-provisioning.md)
(the MCP-server slice, PR #243) — read that first; this spec extends its model to
`WorkflowRecipe` workloads and deliberately reuses its decisions rather than inventing a
parallel mechanism.

> **Reading note.** §2 and §3 describe the **pre-#243 baseline** this spec was written
> against — design history, kept because §5-§6 only make sense against it. They are not a
> description of current behavior. §6-§8 describe the shipped design; §7 carries the
> as-built deviations from the plan.

---

## 1. Summary

The MCP-server slice of #243 made control-api self-provision the `evenfire-registry-pull`
dockerconfigjson Secret so **MCP-server** plugins on a self-hosted cluster can pull private
images. As first written, that slice stopped at the `mcp-server` namespace.

**Recipe plugins were not covered, and could not be made to work by configuration.** A
`WorkflowRecipe` whose workload ran a private evenfire-registry image failed in one of two
ways depending on the recipe's shape (§3), with no supported path to fix it, because
*nothing in the repo created a usable pull Secret for recipe namespaces*.

This spec closes that with the same shape as the MCP-server slice: **control-api owns the
credential, the platform injects the reference, the recipe never names it.** The two
changes of substance, both shipped in #243, are (a) provisioning fans out to every platform
workload namespace from a **single** mint, and (b) WRC injects the reference itself instead
of trusting a recipe-declared name.

---

## 2. What existed before this change (pre-#243 baseline)

*Design history. §2.2's "nothing provisions" and §3's failure modes are what #243 removed;
read them as the problem statement, not as current behavior.*

### 2.1 WRC projects and gates pull secrets — it never creates them

*(Still accurate: WRC creates no Secret. What changed is that it now also **injects** the
platform reference after the filter — §6.1.)*

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

*Closed by §6.3: the same service now fans out to all three platform workload namespaces.*

The only `kubernetes.io/dockerconfigjson` writer in the repo is
`control-api/src/services/registryPullSecretService.ts` (from #243), and it targeted
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

## 3. The failure, precisely (pre-#243)

*Design history — §6 removes this on self-hosted clusters. On a **managed** cluster the
platform still creates nothing (control-api's provisioner stays mode-gated), so the
injected reference resolves only where the external operator has provisioned the Secret —
see §9.*

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
- Managed-cluster **provisioning**. control-api's writer keeps #243's `self-hosted` gate;
  the managed operator keeps owning provisioning on its clusters. Note this is a non-goal
  for the *write* side only — WRC's **injection** is not mode-gated and therefore does
  change what the managed operator must provision (§9).
- Reactive rotation of an out-of-band-revoked key (still open — `registry-pull-secret-self-provisioning.md` §12-1), though
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

**Reserved-name handling — SHIPPED in #243** (§12-2, resolved; R5). If a recipe explicitly
declares the platform name, injection makes it redundant, so recipe validation **rejects**
the reserved name with a message saying it is platform-managed — failing loudly rather than
appearing to honor a declaration we ignore. As built:
`isPlatformManagedWorkflowSecretName` (`control-api/src/routes/admin/recipes.ts`) reserves
`EVENFIRE_REGISTRY_PULL_SECRET_NAME` alongside the `wf-` prefix, and `/validate`, POST, PUT
and `POST /admin/recipes/secrets` all reject the declaration at admission with a
`RefReserved` rule.

> An earlier revision of this section recorded the validation as *not shipped* while §12-2
> and R5 recorded it as shipped. That contradiction was flagged in review (P2) and is
> resolved here in favour of the source: the reservation is live.

The #637 gate stays behind that validation as defense-in-depth for anything already
persisted, and its behavior is *louder* than the "silent no-op" the validation was meant to
prevent: the gate classifies the declared name `denied`, which makes the whole **workload**
denied (`workflowRecipeReconciler.ts`, `collectSecretOwnership` counts `imagePullSecrets`
refs alongside `envSecret`), so the workload is **not rendered at all** — it is torn down and
reported `EnvSecretOwnershipDenied`. A recipe must therefore not name the reserved Secret by
either route. The injection sites still normalize the name defensively (§11), because the
builders are re-entered with a denied access map on the StatefulSet revocation re-render
path.

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

**New WRC config: reuse `CLERUM_REGISTRY_URL` verbatim.** Deliberately the *same* variable
name control-api reads, not a WRC-prefixed alias: the two values must agree. If they drift,
recipe pods get no credential while MCP servers do — the hardest failure in this design to
diagnose (R3).

A shared variable *name* is not by itself sufficient, and the original form of this section
claimed more than it delivered on two counts. First, WRC did already have registry config:
`registry/clerumRegistryClient.ts` reads `CLERUM_REGISTRY_URL` for catalog search (live via
`mcp/handlers.ts`), so the variable is dual-purpose — API base URL for that client, image
host for this predicate. Second, the values were not merely *possible* to set
inconsistently, they were inconsistent **by default**: the shipped minikube overlay pinned
WRC to `http://registry-api.registry.svc.cluster.local:8085` while control-api used
`https://registry.evenfire.ai`, so R3 was the out-of-the-box behaviour and recipe installs
reliably produced `ImagePullBackOff`. A shared predicate cannot prevent drift when each
service feeds it a different value.

What actually makes it safe is a single *definition*, not a single name:
`control-api-config.CLERUM_REGISTRY_URL` is the only place the URL is written, and WRC
projects that key via `configMapKeyRef`. That projection lives in the **base** Deployment
(`deploy/base/control-plane/workflow-recipes.yaml`), alongside the two workflow limits
already sourced from the same ConfigMap, so anything built from `deploy/base` inherits the
pairing and no overlay has to remember it. The reference is `optional: true` because base
ships no `CLERUM_REGISTRY_URL` key — only overlays set the value — and a hard reference
would put a plain `deploy/base` install into `CreateContainerConfigError`. The minikube
overlay consequently no longer redeclares the env var; it only supplies the ConfigMap value
(`deploy/overlays/minikube/configmaps/control-api-config.yaml`).

Two caveats remain. Overlays that live outside this repo — the GCP dev/prod overlays in
`evenfire-infra`, and MCC tenant rendering — still set `CLERUM_REGISTRY_URL` for both
services independently; they agree today, but base cannot enforce that from here. And an
overlay is still free to leave the key unset, which leaves WRC's value empty and disables
injection; WRC now logs a startup WARN naming the consequence
(`registryUrlStartupWarning` in `workflow-recipes/src/config.ts`, printed from `main.ts`)
rather than failing silently. The base projection is pinned by
`workflow-recipes/tests/unit/workflow/deployManifest.test.ts` so a later edit cannot quietly
revert it to a literal or drop it.

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

> **SUPERSEDED IN PART by §13.1.** The *namespace* decision below stands (eager across all
> three). The *trigger* decision does not: install-time hooks alone leave the `kubectl
> apply` and `deploy_recipe` creation paths unprovisioned, because WRC injects the
> reference for CRDs control-api never sees. Provisioning becomes a standing invariant
> (boot + periodic + the lazy hooks). Read §13.1 before implementing this section.

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

**Minimum bar if the structured endpoint is deferred — ✅ SHIPPED.** Reject a request that
is evidently trying to create a pull Secret (a `.dockerconfigjson` / `.dockercfg` key) with
an error naming the supported path, rather than writing an object the kubelet ignores.
Implemented at `control-api/src/routes/admin/recipes.ts` (the `stringData` key check ahead
of the `type: 'Opaque'` write) and covered in `routes.adminRecipes.test.ts`. The structured
endpoint above remains deferred (§12-1).

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

1. **Shipped** — `workflow-runtime-core` first (additive; no behavior change).
2. **Shipped** — control-api: fan-out provisioning + the `install-recipe` hook. Safe alone —
   it only creates Secrets nothing references yet.
3. **Shipped** — WRC: config + injection. This is the step that changes pod specs; a WRC
   rollout with a *missing* registry URL simply injects nothing (degrades to the prior
   behavior).
4. **Not shipped** — `recipes.ts` `Opaque` fix (§6.5). Independent of the above and still
   open (§12); `POST /admin/recipes/secrets` continues to write `type: 'Opaque'`, so the
   third-party BYO-registry path is still the silent failure described there.

Existing recipes that already declare their own third-party pull secrets are unaffected
(§8.3).

### 9.1 Managed clusters — only the control-api half is inert

**Do not read this as "managed is unaffected".** Only the *write* side carries the
`self-hosted` gate:

- **control-api never writes on a managed cluster.** `ensureRegistryPullSecrets` returns
  `skipped` for every target when `registryConnectionMode !== 'self-hosted'`
  (`control-api/src/services/registryPullSecretService.ts`), exactly as in #243.
- **WRC injection has no mode gate at all.** It keys solely on
  `isPlatformRegistryImage(workload.image, loadConfig().registryUrl)`
  (`workflow-recipes/src/reconciler/resourceBuilder.ts`, `.../mcpDelegation.ts`), and WRC's
  `registryUrl` is `CLERUM_REGISTRY_URL` (`workflow-recipes/src/config.ts`) — which managed
  clusters **do** set. So on a managed cluster WRC still appends
  `imagePullSecrets: [evenfire-registry-pull]` to every recipe workload pulling a
  platform-registry image, in whichever namespace that workload lands.

This asymmetry is deliberate and must stay. Gating injection on the mode flag would break
managed private recipes *even after* the operator provisions the credential — the whole
point of injection is that the recipe never names the Secret, so there is no other way for
the reference to appear. The correct resolution is on the operator side, not in the gate.

**Consequent operator contract (this is the part that changed).** An external operator on a
managed cluster must provision `evenfire-registry-pull` in **all three** platform workload
namespaces — `mcp-server`, `sandbox-recipes`, `sandbox-ui` (the `resolveWorkloadSecretNamespace`
split, §2.3) — not just the McpServer's own namespace, which was the pre-existing contract.
The credential is per-org and the mint is rotate-on-call, so the operator must fan out from a
**single** mint for the same reason control-api does (§6.3); minting once per namespace
revokes the previous namespace's key.

Until the operator does that, a managed recipe workload on a private platform image behaves
as it did before this change: the injected name is *never classified* (the recipe does not
declare it), so it is projected verbatim and a missing Secret surfaces as
`ImagePullBackOff` — the same symptom as the pre-#243 baseline (§3), not a new failure mode.
Transport workloads delegated into the operator-provisioned `mcp-server` namespace start
working immediately.

---

## 10. Risks

| # | Risk | Mitigation |
| --- | --- | --- |
| R1 | Per-namespace minting revokes other namespaces' keys → partial cluster-wide `ImagePullBackOff`. | Single mint + fan-out write (§6.3); post-condition asserted in unit tests, and on a live cluster by the E2E's one-fingerprint-across-all-copies assertion (§11) — divergent fingerprints are the only symptom this failure has. |
| R2 | Partial write (mint OK, one namespace fails) leaves a stale, undetectable key. | Fingerprint annotation makes divergence detectable and repairable (§6.3). **Observed working live** — an induced divergence was detected and converged on the next ensure pass; timestamps and fingerprints in §11. |
| R3 | WRC/control-api registry URL drift → recipe pods get no credential while MCP servers do. | **Was live, not hypothetical** — the shipped minikube overlay pinned WRC to the in-cluster registry while control-api used the shared one, so every recipe install hit it (found in live testing 2026-08-04). Closed in-repo: the **base** WRC Deployment now projects `control-api-config.CLERUM_REGISTRY_URL` via an `optional: true` `configMapKeyRef`, so every deployment built from `deploy/base` — including OSS self-hosted, the only mode where control-api provisioning actually runs — reads the same definition control-api does, and the minikube overlay no longer redeclares it (§6.2). Pinned by `workflow-recipes/tests/unit/workflow/deployManifest.test.ts`. Shared predicate alone was insufficient. **Residual:** the GCP dev/prod overlays and MCC tenant rendering live outside this repo and still set the value for both services independently (they agree today); and an overlay may still leave the key unset, which disables injection — WRC now emits a startup WARN naming that consequence instead of failing silently. Surfacing both values on a status/health endpoint is still worth doing. |
| R4 | Someone "fixes" #637 denial by labelling the Secret `shared`. | §5.1 recorded as an explicit, permanent non-goal; the live-cluster E2E asserts the Secret carries neither `clerum.io/shared` nor `clerum.io/owner-recipe` in any platform namespace (§11), so a "fix" of this shape fails the acceptance gate. |
| R5 | A recipe declares the reserved name and expects it honored. | **Closed.** Validation rejection (§6.1) shipped: `isPlatformManagedWorkflowSecretName` now reserves `EVENFIRE_REGISTRY_PULL_SECRET_NAME`, so `/validate`, POST, PUT and `POST /admin/recipes/secrets` reject the declaration at admission with a reserved-name rule. The #637 gate stays behind it as defense-in-depth for anything already persisted. |
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
- **e2e (minikube, self-hosted)** — **SHIPPED:**
  `tests/e2e/integration/registry-pull-secret-runtime.test.ts`, the §13.5 acceptance gate.
  Four blocks against a live cluster and the live registry:

  | Block | Asserts | Why a MockGateway cannot |
  | --- | --- | --- |
  | Secret placement | present in all three platform namespaces; `kubernetes.io/dockerconfigjson`; `managed-by=control-api`; `auths` keyed on the configured registry host; **one fingerprint across all copies**; neither `shared` nor `owner-recipe` | namespace + RBAC are real; the fingerprint check is the only cluster-visible symptom of R1 (three mints against a rotate-on-call registry) |
  | Materialization | WRC renders the recipe workload's PodTemplate with `imagePullSecrets: [evenfire-registry-pull]` while the CRD does **not** declare it (proving injection, not declaration); control-api writes the reference onto the `McpServer` CRD and HCC materializes it verbatim onto the Deployment it owns | the WRC and HCC reconcile hops, and the rollout, are outside any route test |
  | Pod readiness + real pull | image evicted from the node's docker cache first (`imagePullPolicy: IfNotPresent` would otherwise serve it from cache and exercise no credential); Pod Ready; the `Pulled` event says `Successfully pulled image … Image size: N bytes` and **not** `already present on machine` | proves the kubelet accepts the blob and the registry honors the minted key — both previously assumed from docs |
  | Pre-persistence failure | a foreign, unusable Secret planted in one namespace makes `install-recipe` return `409 foreign_secret_unusable` **and** leaves no `WorkflowRecipe` behind | the ordering of provision-then-persist only matters against a real API server |

  Guarded to **skip** (not fail) when the cluster, the port-forward, the admin credential,
  self-hosted mode, or the private fixtures are unavailable; everything it creates is
  prefixed `e2e-pullsecret-` and removed in `afterAll`, including an unconditional restore
  of the temporary foreign Secret.

  Two gaps it deliberately does not close. **The periodic reconcile (§13.1)** is not in the
  suite: `REGISTRY_PULL_SECRET_RECONCILE_INTERVAL_MS` defaults to 600 000 ms and shortening
  it needs a redeploy, so a committed E2E cannot wait for a tick. It was verified
  out-of-band on `clerum-test` instead — the `sandbox-ui` copy was deleted at 11:30:18Z and
  restored by the cron at 11:32:33Z with a fresh fingerprint and a
  `registry_pull_secret_reconciled` log line naming all three namespaces. **The
  `kubectl apply` creation path** is covered only indirectly: the suite proves the standing
  invariant is what makes it work (the Secret is present in every namespace before any
  particular install), not the apply itself.

  **R2's divergence repair was observed live during this work**, which is worth recording
  because it is otherwise only argued. A regression rehearsal left `sandbox-ui` holding a
  fingerprint (`dab2bc929d3d`) that disagreed with `mcp-server` / `sandbox-recipes`
  (`f64af065ebe4`). The next install's ensure pass detected it —
  `registry pull secret copies diverged across namespaces; re-minting to converge`
  (2026-08-04T12:37:38Z) — re-minted once and rewrote all three onto `f3170a6e0585`. The
  following run then took the no-mint path (`exists-ours`, fingerprint unchanged),
  confirming both halves of §6.3: converge when diverged, do nothing when already current.

  The suite is not in `DEFAULT_VITEST_SUITES` in `scripts/e2e/run-vitest-e2e.sh`, so it does
  not run in the default gate; invoke it by path. Adding it there is safe — it skips
  cleanly without the fixtures — and is worth doing when the fixtures become part of the
  seeded environment.

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
2. ~~**Reserved-name declaration (§6.1)** — hard-reject at validation, or keep the #637
   gate's ownership-worded denial?~~ **Resolved: hard-reject at validation shipped.**
3. Should HCC gain the presence-validation from #243 §7.7 now that more namespaces
   reference the same Secret name?

---

## 13. Review findings — remediation plan

Five blocking findings from PR review. All five were verified against source before being
accepted; none is dismissed. **§13.1 is the important one** — it invalidates a decision
recorded in §12 and changes the shape of the feature from an install-time side effect into
a standing cluster invariant.

### 13.1 [P1] ✅ SHIPPED — Provisioning is a standing invariant, not an install-time hook

**The mismatch.** As shipped, the two halves of this feature are triggered by different
things:

| Half | Trigger | Covers |
| --- | --- | --- |
| WRC **injects** the reference | every reconcile, for **any** `WorkflowRecipe` CRD | all creation paths |
| control-api **provisions** the Secret | its own install/upgrade routes | one creation path |

A `WorkflowRecipe` does not only come from control-api. `docs/crds/workflowrecipe.md:339`
documents three supported paths:

1. control-api (`POST /admin/registry/install-recipe`) — the only one hooked;
2. **`kubectl apply`** of a CRD;
3. the **WRC MCP `deploy_recipe` tool** (`workflow-recipes/src/mcp/tools.ts:62`,
   `server.ts:128`), callable by an agent and authorized only by a `contextRef` match.

For paths 2 and 3, WRC injects a reference to a Secret nobody created →
`ImagePullBackOff`.

**Why this is worse than the pre-existing gap.** Before this feature those paths produced a
pod with *no* pull secret and the same failure. After it, the pod asserts a credential the
platform never provisioned. Same symptom, but the platform is now making a claim it has
not backed — which is exactly the class of silent precondition §2 exists to eliminate.

**Decision — reverses §12's "lazy only".** control-api ensures the platform pull Secret as
a **standing invariant**:

- **At boot**, non-fatal, alongside the existing boot reconcilers in `main.ts`.
- **Periodically**, on a configurable interval (default ~10 min), so a CRD created by any
  path finds the credential already present.
- **Plus the existing lazy hooks**, retained deliberately — an install must not wait up to
  a full interval, and the lazy path is the only one that can fail the request with an
  actionable error.

**Two different failure semantics — specify both.** This is the part most likely to be got
wrong:

| Context | On a precondition failure (no org, not connected) |
| --- | --- |
| **Install/upgrade (lazy)** | **THROW** → fail the request with `registry_pull_secret_provision_failed` and a reason. The user asked for something we cannot deliver. |
| **Boot / periodic reconcile** | **LOG and retry next tick.** A cluster mid-connect-flow must not crash-loop or emit an error every interval. |

Reusing the install path's fail-loud behavior in the reconcile would turn a normal
pre-connect state into recurring noise; reusing the reconcile's log-and-continue in the
install would restore the silent `ImagePullBackOff`.

**Hard dependency: the periodic loop makes §13.3 mandatory, not optional.** Two replicas
reconciling on a timer, without a cross-process lock, do not merely race occasionally —
they fight *continuously*: each pod's mint revokes the other's key, the fingerprint check
then sees divergence, and both re-mint on the next tick. A lazy-only design races only
during concurrent installs; a periodic design races forever. **§13.3 must land with, or
before, the periodic reconcile.**

**Second-order effect on §13.2.** With a periodic loop, a mint can happen at an arbitrary
time rather than only during an install — so the possibility of revoking an
externally-managed copy's credential (§13.2) stops being install-scoped and becomes
continuous. That raises §13.2's priority from "handle it" to "handle it before enabling
the timer."

**Not chosen: have WRC skip injection when the Secret is absent.** It would avoid asserting
a credential that does not exist, but the pod still cannot pull, so it trades one silent
failure for another. The presence-*surfacing* idea (§12-3 / #243 §7.7 — emit a condition
instead of a bare `ImagePullBackOff`) is complementary and still worth doing.

### 13.2 [P1] ✅ SHIPPED — Minting can revoke a valid foreign copy

The "never touch a foreign Secret" rule protects the **Secret object**; it does not protect
the **credential inside it**. `mintPullKey` revokes `WHERE org_id = $1 AND kind = 'pull'`
(`evenfire-registry/src/services/orgApiKeyService.ts:130-131`) — every prior pull key for
the org, whoever minted it.

So: an operator-managed Secret in one namespace holds a working key; a plugin installs into
another namespace with no Secret; we mint; the operator's key is revoked; we correctly do
not touch their Secret — which now contains a dead credential. Their workloads break, we
report success.

Conditional on the foreign copy having been built from a `kind='pull'` key for the same
org. A user token or publish-scoped `efrk_` key is unaffected.

**Remediation:** treat a foreign copy as a **refusal to mint**, not something to work
around. If any target namespace holds an externally-managed Secret, fail with an
actionable error (`foreign_secret_present`: remove it, or provision every namespace the
same way) rather than silently invalidating it. Reading the credential out of a foreign
Secret and reusing it is explicitly rejected — that is someone else's credential.

### 13.3 [P1] ✅ SHIPPED — Serialization is per-process only

`replicas: 1` in `deploy/base/control-plane/control-api.yaml:15` with no explicit
`strategy` takes the default `RollingUpdate`, so two pods coexist on every deploy. The
`inflight` map is per-process and does not span them.

Interleaving is the problem, not key accumulation (which rotate-on-call already bounds):
pod A mints `k1`; pod B mints `k2` (revoking `k1`); writes interleave; some namespaces end
up holding the revoked key. The fingerprint annotation makes this **detectable and
self-healing on the next pass** — but "the next pass" is the next install, so pulls fail
until then.

**Remediation:** a cross-process lock around read→mint→write, keyed on the org.
control-api already has Postgres, so `pg_advisory_lock` is the natural mechanism and adds
no dependency — mirroring what the registry itself does inside `mintPullKey`. The
in-process map stays as a cheap first-level dedupe.

**The overlap is observed, not argued.** During #243's live testing on `clerum-test`
(2026-08-04) a control-api rollout put two pods in `Running` simultaneously —
ReplicaSets `786f7dcb9` and `7b7746fdf9`, both serving, before the older was killed.
The finding was originally derived from the manifest (`replicas: 1` + default
`RollingUpdate` ⇒ transient two-pod overlap); this is the same shape happening in an
ordinary deploy on the deployed configuration. It is worth recording because the
counter-argument to §13.3 was that a single-replica Deployment makes the in-process
`inflight` map sufficient — which is true only between rollouts, and a rollout is
exactly when a boot-time provisioning pass runs.

### 13.4 [P1] ✅ SHIPPED — `upgrade-recipe` has no provisioning hook

`POST /admin/registry/upgrade-recipe` (`control-api/src/routes/admin/registry.ts:2001`)
never calls `ensureRegistryPullSecret(s)`. The three existing hooks are at `:1206`
(McpServer install), `:1522` (install-recipe) and `:1850` (McpServer upgrade).

Upgrading a recipe from a public image to a private one therefore persists the CRD and then
fails at pull time, with a `200` on the API call.

**Remediation:** add the same hook, gated on `recipeReferencesPlatformImage` of the
**incoming** spec, positioned after validation and before the CRD write — matching the
install-recipe placement. Fix it explicitly even once §13.1 lands: the reconcile is a
safety net, not a substitute for failing the request that introduced the problem.

### 13.5 [Acceptance] ✅ SHIPPED — End-to-end runtime evidence

**The finding.** Coverage was unit- and route-level against `MockGateway`. Nothing
exercised `Secret → WRC → McpServer/HCC → Pod Ready → private image pull`. Mutation
testing sharpened that rather than substituting for it: it proves the tests fail when the
code breaks, but it cannot prove the kubelet accepts the blob, that the type and data key
are what Kubernetes wants, that RBAC permits the write in `sandbox-ui`, or that the
registry honors the minted key at pull time. Those were assumptions verified only against
docs and source.

**Closed by** `tests/e2e/integration/registry-pull-secret-runtime.test.ts` — a live-cluster
suite against `clerum-test` and the live `registry.evenfire.ai`, run in
`REGISTRY_CONNECTION_MODE=self-hosted` against a connected org. Contents and per-block
rationale are in §11; the short version is the four things a mock could not reach:

| Assumption previously unverified | How the suite verifies it |
| --- | --- |
| the kubelet accepts the blob we write | a Pod pulls a private image with only this Secret referenced, after the image is evicted from the node |
| the type and data key are what Kubernetes wants | the Secret is read back as `kubernetes.io/dockerconfigjson` with `.dockerconfigjson`, and a pull actually succeeds through it |
| RBAC permits the write in `sandbox-ui` | the Secret is asserted present in all three platform namespaces, `sandbox-ui` included |
| the registry honors the minted key at pull time | the `Pulled` event must read `Successfully pulled image … Image size: N bytes`, never `already present on machine` |

Two additional properties the suite pins that no unit test can: **one mint fanned out**
(all copies must carry the same `clerum.io/pull-key-fingerprint` — the only cluster-visible
symptom of R1), and **injection rather than declaration** (the rendered PodTemplate carries
the reference while the `WorkflowRecipe` CRD does not).

**Coverage against the remediation as originally written.** (a) MCP-server plugin — covered.
(b) recipe plugin with a non-transport workload — covered. (c) recipe created by
`kubectl apply` — covered only *indirectly*: §13.1 turned provisioning into a standing
invariant, so what makes that path work is the Secret already being present in every
namespace, which the suite asserts directly. The apply itself is not exercised.

**Deliberately still out of the suite:** the periodic reconcile tick (interval is 10 min by
default and shortening it needs a redeploy — verified out-of-band instead; timestamps in
§11) and managed-cluster behaviour (control-api writes nothing there by design, so there is
no runtime outcome to observe — §9.1).

### 13.7 As-built

| # | Status | Where |
| --- | --- | --- |
| 13.1 | ✅ | `services/registryPullSecretReconcileCron.ts` (boot pass + timer, wired in `main.ts`); interval via `REGISTRY_PULL_SECRET_RECONCILE_INTERVAL_MS` (default 10 min) |
| 13.2 | ✅ | `registryPullSecretService.ts` — `foreign_secret_would_be_revoked`, all-or-nothing refusal |
| 13.3 | ✅ | `withPullSecretLock` — `pg_advisory_xact_lock(hashtext('registry-pull-secret:<org>'))` around read→mint→write |
| 13.4 | ✅ | `registry.ts` — hook on `upgrade-recipe`, keyed on the INCOMING spec |
| 13.5 | ✅ | `tests/e2e/integration/registry-pull-secret-runtime.test.ts` — live-cluster acceptance (§11, §13.5) |

Notes worth carrying forward:

- **The reconcile is why 13.3 was not optional.** A periodic loop without the lock does not
  race occasionally, it fights continuously. The lock blocks rather than fails, so the
  second replica waits, re-reads, finds an agreeing credential, and returns `exists-ours`
  without minting — which is the convergence property the whole design wants.
- **Failure semantics are split as specified**: `ensureRegistryPullSecrets` throws, the
  install path surfaces that as a 4xx/5xx, and the cron swallows it into a warning and
  retries. Both directions are mutation-tested (letting the error escape the cron fails 3
  tests; removing the install-path throw fails the route tests).
- **The unit suites now mock `../src/db.js`.** The advisory lock made them reach Postgres
  and hang. The lock itself is still asserted — the mock records the SQL, so a test checks
  the lock is taken, is keyed on the org, and is taken *before* the mint.

### 13.6 Sequencing (as planned)

```
§13.3 lock ──┬──> §13.1 periodic reconcile ──> §13.5 e2e
§13.2 foreign┘
§13.4 upgrade-recipe hook  (independent, land immediately)
```

§13.4 is independent and should land first as the smallest correct fix. §13.3 and §13.2
gate the periodic half of §13.1 — the boot-only half is safe without them, so §13.1 may be
split (boot now, timer after the lock) if that shortens the path to a mergeable state.
