# Self-provisioning the `evenfire-registry-pull` image-pull Secret

**Status:** Implemented — shipped in PR #243 (`control-api`), together with the recipe-workload
extension in [`registry-pull-secret-recipe-workloads.md`](registry-pull-secret-recipe-workloads.md).
The registry-side gate this depends on (§6.2 / §14-A1) is `evenfire-registry` PR #64,
**merged and deployed to production 2026-08-04** — including the scope backfill for
admin-approved deployments (evenfire-registry#65 / migration 021, §9-1). Reactive rotation
(§7.6) remains open.
**Date:** 2026-08-03 (design) · 2026-08-04 (as-built)
**Area:** control-api registry integration · image pull · self-hosted / open-core
**Supersedes (in effect):** the "MCC mints + creates the secret" role in the registry
bridge design `evenfire-registry/docs/superpowers/specs/2026-06-30-registry-phase2-4-grant-pull-credential-bridge-design.md` §4.2, for **self-hosted** deployments.
**Related:** `docs/concepts/open-core-and-hosted.md`, `docs/how-to/connect-to-registry.md`,
`evenfire-registry/docs/superpowers/specs/2026-06-30-registry-phase2-4-delivery-design.md`

---

## 1. Summary

> **Reading note (as-built).** This document is written in the design's future tense
> ("this spec makes…", "ships in the same release"). It shipped as specified; read those
> as descriptions of the delivered behavior, except where a section is explicitly marked
> **not shipped**. §11 already distinguishes shipped from deliberately-skipped tests.

On a **managed** cluster, the hosted operator ("MCC", out of this repo) creates the
`evenfire-registry-pull` dockerconfigjson Secret in the plugin namespace, and
control-api merely *references* it by name on the `McpServer` CRD. On a
**self-hosted** cluster there is no MCC, nobody creates the Secret, and every
private-image plugin fails with `ImagePullBackOff: unauthorized`. This silently
breaks the open-core promise that self-hosting is "a first-class path, not a
trial" (`docs/concepts/open-core-and-hosted.md`).

This spec makes **control-api self-provision** the Secret when it runs in
self-hosted mode, using credentials and Kubernetes RBAC it *already holds*, and
removes the in-repo assumption that MCC provisions it. It coexists safely where an
external operator already created the Secret, needs **no new Kubernetes RBAC**, and
ships as **one coordinated release** across two repos: a single `evenfire-registry`
gate change plus the control-api self-provisioner, using a least-privilege pull-only
credential from day one (§14).

The key enabling facts, all verified in code:

- control-api's self-hosted registry client is provisioned with `registry:manage-keys`
  *specifically* "so a headless deployment can mint its own org efrk_ key (the
  docker credential)" — `evenfire-registry/src/routes/deployments.ts:237-247`.
- A one-line registry gate change lets that `manage-keys` machine mint a **pull-only**
  key for its own org via `POST /org/:org/registry-pull-credential` (today `*`-admin
  only, `org.ts:376`; `mintPullKey`/`buildDockerconfigjson` unchanged). The same scope
  *also* already reaches the publish-scoped machine branch of `POST /org/:org/keys`
  (`org.ts:245,276,293-295`) — the proven fallback, §6.3.
- control-api already creates dockerconfigjson-shaped Secrets in the plugin
  namespace (`config.mcpServersNamespace`) with existing RBAC — `SecretService`
  (`control-api/src/services/secretService.ts:33-53`), Role grants
  `create/update/patch` on secrets in `mcp-server`
  (`deploy/base/mcp-server/rbac.yaml:29-31`).
- The managed/self-hosted split is already an **explicit** config discriminator
  (`registryConnectionMode`, `control-api/src/config.ts:60-77,302-304`) — so
  gating self-provisioning to `self-hosted` is exactly how we coexist with MCC
  *without naming it*.

---

## 2. Problem

### 2.1 The functional bug

`control-api` attaches `imagePullSecrets: [{name: 'evenfire-registry-pull'}]` to a
local-mode `McpServer` spec whenever the plugin image host equals the configured
registry host (`shouldAttachEvenfirePullSecret`,
`control-api/src/routes/admin/registryImagePullSecret.ts:51-61`; applied at
`registry.ts:1117-1124` on install and `registry.ts:1808-1818` on upgrade). HCC then
copies that reference verbatim onto the generated Deployment
(`host-context-controller/src/reconciler.ts:994-1002`).

Nothing in this repo ever **creates** the referenced Secret. HCC's own contract is
explicit: "Creating the secrets an McpServer references is not the
host-context-controller's responsibility" (`host-context-controller/README.md:57`).
The Secret's existence is an unstated precondition satisfied **only by MCC**
(`control-api/src/routes/admin/registryImagePullSecret.ts:6-8`: "provisioned onto
the tenant cluster by MCC (out of this repo); control-api only references it by
name"). No MCC → no Secret → `ImagePullBackOff`.

### 2.2 The architectural coupling

Even once the functional gap is closed, the repo carries **named knowledge of
MCC** that violates the open-core boundary (the OSS platform must run standalone):

- `registryImagePullSecret.ts:6,12-13` — "provisioned … by MCC", "Must stay in
  sync with the MCC install step".
- `registry.ts:1116` — "provisioned by MCC in the plugin namespace".
- `config.ts:62` — "Delivered by MCC in the registry-voucher Secret" (adjacent
  subsystem; see §7.8).

A proposed direction: *this repo should not know anything about MCC*, and the
pull-secret responsibility should sit with the controllers that already inject
auth-related secrets (WRC / HCC). §5 assesses that proposal; the conclusion is that
**control-api** is the correct owner, and gating on the existing
`registryConnectionMode` discriminator is what actually removes the MCC coupling.

---

## 3. Goals / Non-goals

### Goals

- **G1.** A self-hosted cluster pulls private evenfire-registry plugin images with
  no external operator — the Secret is created in-cluster by control-api.
- **G2.** No named dependency on MCC in the control-api pull-secret code path;
  the managed/self-hosted branch is expressed via `registryConnectionMode`, not MCC.
- **G3.** Idempotent coexistence: where an external operator (including MCC) already
  provisioned the Secret, control-api never clobbers, rotates, or orphans it.
- **G4.** No new Kubernetes RBAC; a single small `evenfire-registry` gate change (§6.2), shipped in the same release.
- **G5.** The self-provisioned Secret is byte-compatible with MCC's — same name,
  namespace source, type, and data key — so either satisfies the same `McpServer`
  reference.

### Non-goals

- Changing MCC's managed-cluster behavior (that is a separate, sequenced retirement
  of MCC's `install_registry_pull_secret` step — §9).
- Self-provisioning the **infra** pull secret (`clerum`, HCC host/WFC default,
  `host-context-controller/src/config.ts:480,527`). That is a distinct, out-of-band
  concern (GCP node SA in prod, disabled in minikube) and is out of scope.
- Multi-org-per-cluster placement. Self-hosted is single-tenant by design
  (`docs/concepts/open-core-and-hosted.md:38`); see the §8 guardrail.
- The voucher-identity substrate (`registry-voucher` Secret / voucher kid). This
  spec **presupposes** a working self-hosted registry identity; it only adds the
  pull-secret write on top (§7.8, §10-R5).

---

## 4. How it works today (grounded)

### 4.1 The reference (already correct — keep it)

| Concern | Where |
| --- | --- |
| Secret name constant | `EVENFIRE_REGISTRY_PULL_SECRET_NAME = 'evenfire-registry-pull'` — `registryImagePullSecret.ts:15` |
| Attach predicate | `shouldAttachEvenfirePullSecret({isLocal,image,registryUrl})` — `registryImagePullSecret.ts:51-61` |
| Attach on install | `registry.ts:1117-1124` |
| Recompute/delete on upgrade | `registry.ts:1808-1818` (deletes the ref on evenfire→other host change) |
| Identity fail-fast | imageRef repo path must equal scoped `@org/name` else 422 — `registryImageRefIdentity.ts:39-52`, consumed `registry.ts:1066-1077` |
| HCC propagation | copies `spec.imagePullSecrets` verbatim to the Deployment — `reconciler.ts:994-1002` |

The reference logic is correct and stays. **This spec only adds the create side.**

### 4.2 The two credential planes (why the machine token can't docker-pull)

The registry has a **separate OCI auth plane**: the docker token realm recognizes
only `efrk_` org API keys and user tokens — a machine OAuth read-API token can
never `docker pull`. So the pull Secret must be built from an `efrk_` key
(`evenfire-registry/src/services/orgApiKeyService.ts:147` `buildDockerconfigjson`;
plane split documented at `evenfire-managed-cluster-control/docs/registry-auth.md:44-57`).

### 4.3 What MCC does today (being replaced / coexisted-with)

- Mints a **pull-only** key via `POST /org/:org/registry-pull-credential`, which is
  **`*`-admin-machine-only** (`org.ts:371-388`, gate at `:376`) and **rotates on
  every call** (`orgApiKeyService.ts:122-142` `mintPullKey` revoke-then-insert).
- Writes `{type:'kubernetes.io/dockerconfigjson', data:{'.dockerconfigjson': <base64>}}`
  named `evenfire-registry-pull` into the tenant's `mcp-server[-slug]` namespace —
  shared path SSA `fieldManager: mcc-rung35`
  (`evenfire-managed-cluster-control/.../tenant-install-shared.ts:476-496`), dedicated
  path plain create/replace (`.../evenfire-install.ts:356-378`,
  `install/secrets.ts:110-121,181-212`). **No labels** on the Secret either way.
- Because the mint rotates, MCC is **read-before-mint** (skip if the on-cluster
  Secret already carries `.dockerconfigjson`).

Two facts fall out that shape our design: MCC's Secret is **unlabeled**, and its
credential source (`*`-admin endpoint) is **unavailable to control-api**.

### 4.4 The existing secrets-injection sequence (what we hook into)

control-api already writes Secrets into the plugin namespace during install/upgrade,
and self-provisioning must slot into that ordered flow — not bypass it. The **install
handler** (`registry.ts`) runs:

1. Build `mcpServerSpec`; set the in-memory `imagePullSecrets` **reference** (~1124)
   — no K8s write yet.
2. Preflight validation (422 on failure).
3. Ownership metadata: `{ 'clerum.io/managed-by':'control-api',
   'clerum.io/server-mode':… }` (labels) + catalog annotations.
4. **Step 3 — create the per-plugin credentials Secret** (`<name>-credentials`,
   `Opaque`, `stringData`) into `targetNs`, **fail-loud**
   (`extractK8sError → res.status().json(); return`), set `secretCreated=true`
   (`registry.ts:~1200-1250`).
5. **Step 4 — create the McpServer CRD**; on failure, **rollback**: delete the
   credentials Secret iff `secretCreated` (`registry.ts:1255-1272`).
6. Step 5 — Context allowlist (rolls back too).

The **upgrade handler** mirrors this and already uses the exact idempotent shape this
spec proposes: read the existing Secret (`getSecret`, tolerating `404` via
`k8sErr.status !== 404`) → `updateSecret` if present, else `createSecret`, labelled
`managed-by:control-api` (`registry.ts:~1830-1875`).

Three properties of this flow directly justify the design and are load-bearing for
where we hook in:

- **Label precedent** — the credentials Secret is *already* stamped
  `clerum.io/managed-by:control-api`, so the pull Secret's ownership label (§7.2) is
  the same marker the flow already uses, not a new convention.
- **Fail-loud precedent** — Step 3 is the pattern §7.1/§7.3 mirror.
- **Namespace + rollback** — the credentials Secret and CRD both land in `targetNs`,
  and the credentials Secret is per-plugin (rolled back on CRD failure). The pull
  Secret must therefore also target `targetNs` (co-location, §7.1) but sit **outside**
  the per-plugin rollback (it is namespace-shared, §7.3).

---

## 5. Ownership: why control-api, not HCC/WRC

The proposal to route provisioning to WRC/HCC rests on "they already inject
auth-related secrets." The review shows that premise is **only half true**, and the
factoring it implies is the higher-cost path:

- WRC/HCC mint only **self-issued** Opaque JWT/random secrets (coordinator tokens,
  per-Host runtime tokens, `generateKeys`) — `workflow-recipes/src/workflow/secretFactory.ts`,
  `host-context-controller/src/secretFactory.ts`. **None is a
  `kubernetes.io/dockerconfigjson`.** For image-pull they only *reference* a Secret
  by name; they never mint one. Minting a pull credential requires a **registry
  round-trip with registry identity**, which neither controller has.
- Making **HCC** the minter would require: (1) new RBAC — HCC has only
  `get,list,watch` on secrets in `mcp-server` (`deploy/base/mcp-server/rbac.yaml:112-114`),
  not create; (2) new config — HCC holds no registry credentials at all; (3) a new
  namespace-singleton reconcile loop (the `McpServer` per-CRD grain is wrong for one
  namespace-wide credential); (4) breaking the `README:57` "validates but does not
  create referenced secrets" contract.
- **control-api already has every piece**: create/update/patch RBAC on secrets in
  the plugin namespace (`rbac.yaml:29-31`), the registry identity
  (`registry:manage-keys`), the attach decision, and the managed/self-hosted
  discriminator. It already writes credential Secrets into that exact namespace on
  install (`registry.ts:1215-1248`).

**Decision:** control-api self-provisions. HCC stays a pass-through of the reference
(with an optional presence-validation enhancement, §7.7). This honors the real
goal — *the repo stops depending on MCC* — better than relocating the mint, because
the dependency is removed by the `registryConnectionMode` gate, not by moving code
into a controller that would need registry credentials plumbed into it.

---

## 6. Credential source

The feature ships as **one coordinated release across two repos** (`evenfire-registry`
+ `evenfire`), not a sequence — see the parallel workstreams in §14. Because the
registry change lands with control-api, the design uses a **least-privilege pull-only
credential from day one**; there is no interim push-capable step.

### 6.1 The credential — an org-scoped pull-only key

control-api's self-hosted client holds `registry:manage-keys`
(`deployments.ts:242-247`; also the standing `TENANT_DEFAULT_SCOPES`,
`evenfire-registry/src/routes/clients.ts:44-50`), and has a **machine Bearer** fetch
(`registryClient.authedFetch` / `orgRegistryFetch`,
`control-api/src/services/registryClient.ts:191-207,551-582`). It mints a pull-only
key for its own org via the registry's `POST /org/:org/registry-pull-credential`
(relaxed to accept an org-bound `manage-keys` machine — §6.2), which calls
`mintPullKey` (`orgApiKeyService.ts:122-142`, `kind:'pull'`). Org name comes from
`resolvePublishScope().orgName` (`registryClient.ts:650-662`, from the registry
`/whoami` mapping). control-api **builds the `dockerconfigjson` locally**, keyed on
`registryHostFromUrl(config.registryUrl)` (§7.9-2), from the returned key.

Properties of the pull-only key that simplify the design vs a publish key:

- **Least privilege** — pull-only (`kind:'pull'`) grants pull on the org's
  own/granted/public repos, never push. A leaked Secret cannot push.
- **Rotate-on-call, ≤1 per org** — `mintPullKey` revoke-then-inserts under an advisory
  lock, so there is at most one active pull key per org. **No accumulation** toward
  `MAX_ACTIVE_KEYS_PER_ORG` and **no explicit revoke-prior bookkeeping** needed. The
  cost is that a blind re-mint *orphans* the on-cluster key, so **read-before-mint is
  mandatory** (§7.1) — mint only when the Secret is absent/broken.
- **Invisible to operators** — pull keys are excluded from the owner self-service key
  list (`orgApiKeyService.ts:99,110`), so the auto-minted key does not clutter
  `/admin/registry/keys` and cannot be confused with a user/CI key.

**Implementation reality:** control-api has **no** existing method that mints against
this endpoint. The only key-mint wrapper today is `orgApiKeyClient.createKey`, which
uses a per-admin **user** token (`userAuthedFetch`, `orgApiKeyClient.ts:115-164`) — a
different path. The generic machine-Bearer helpers `authedFetch` / `orgRegistryFetch`
exist but are **module-private** and only wrap `/grants`, `/entries`, `/granted-to-me`
(`registryClient.ts:551-626`). So a **new exported `registryClient` method** is
required — e.g. `mintOrgPullCredential(orgName): Promise<{ key, keyId }>` — built on
`orgRegistryFetch`, mirroring the existing `createOrgGrant` pattern
(`registryClient.ts:584`). Listed in §13.

### 6.2 The registry change — SHIPPED (`evenfire-registry` PR #64, deployed 2026-08-04)

Relax `POST /org/:org/registry-pull-credential` so an **org-bound machine holding
`registry:manage-keys`** can mint a pull-only key for its **own** org. Today the gate
requires an `*`-admin machine (`org.ts:376`); the change replaces that with
`authorizeMachineForOrg(auth, orgName, 'registry:manage-keys')`, reusing `mintPullKey`
and `buildDockerconfigjson` unchanged (only the auth gate moves). `*`-admin callers
(the managed operator) keep working; a foreign org still `403`s. This is the single
`evenfire-registry` change and it is **in scope** for this work.

### 6.3 Alternative considered — the publish-scoped machine `/org/:org/keys` path

The machine branch of `POST /org/:org/keys` (`org.ts:245,276,293-295`) is reachable by
the same `manage-keys` machine **with no registry change** and returns a
`dockerconfigjson`, but the key is **publish-scoped (push-capable)** and additive (no
rotate, accumulates toward the 100-cap, visible in the operator key list). It proves
the feasibility and is a viable **fallback** if the §6.2 registry change ever has to be
decoupled — but because we ship both repos together, the pull-only credential (§6.1) is
the design and this path is not used.

## 7. Design

### 7.1 New unit: `ensureRegistryPullSecret`

A control-api service (e.g. `services/registryPullSecretService.ts`) exposing:

```
ensureRegistryPullSecret(targetNs: string): Promise<'created' | 'repaired' | 'exists-ours' | 'exists-foreign' | 'skipped'>
```

It takes the injected `K8sGateway` (for `getSecret`/`createSecret`/`updateSecret`,
`k8s.ts:389-394`) and the new registry mint function (§6.1) as dependencies. It is
called with the **same `targetNs` the McpServer + credentials Secret use**
(`targetNs = body.namespace || config.mcpServersNamespace`, `registry.ts:1011`),
because `imagePullSecrets` are **namespace-local**: the pull Secret must live in the
same namespace as the plugin pod (`server.namespace = targetNs`,
`host-context-controller/src/reconciler.ts:946-948`) or the ref silently fails to
resolve. It does **not** invent its own namespace — co-location with the McpServer is
a correctness requirement, not a policy choice. The guardrail against writing into an
*arbitrary* namespace is an explicit equality check against `config.mcpServersNamespace`
(step 2) — not RBAC, which is broader than this rule allows (control-api holds
`secrets:create` in six namespaces, `channels` among them). A `403` on the read is a
second line of defence that aborts before any mint. If the gateway is absent
(dev/no-cluster), the install routes are not registered at all, so nothing is attached
either.

Two invariants drive the whole algorithm:

- **I1 — never write a Secret we do not own.** Ownership is decided *before* the payload
  is examined, so a foreign Secret is left alone even when it looks broken. Adopting one
  would seize an external operator's credential; repairing it in place would rotate the
  org key out from under them.
- **I2 — mint only when already committed to a write that can succeed.** The mint is
  rotate-on-call (it revokes the org's previous key), so a mint followed by a failed
  write strands *every other namespace's* Secret on a revoked credential.

Algorithm:

1. **Legitimate no-ops (`'skipped'`)** — and *only* these two:
   - `registryConnectionMode !== 'self-hosted'` → the managed operator owns the Secret;
     never contend with it. This is the first statement, before any network or DB call.
   - `registryHostFromUrl(config.registryUrl)` is null → no registry configured (the
     attach predicate is false too, so this is unreachable in practice).
2. **Hard preconditions — these THROW `PullSecretProvisionError`**, because from here on
   the caller is about to attach a reference and a silent skip would recreate the exact
   `ImagePullBackOff` this spec removes:
   - `targetNs !== config.mcpServersNamespace` → `unsupported_namespace` (400). Confines
     a registry credential to the namespace this deployment actually serves so a
     caller-supplied `body.namespace` cannot plant it elsewhere (§8).
   - `isRegistryAuthActive()` false → `registry_not_connected` (409).
   - `resolvePublishScope().orgName` null → retry once with `{force:true}` (the cache is
     module-level and a cold start can pin a null org, `registryClient.ts`), then
     `org_unresolved` (409). The two sibling self-service routes already do this forced
     refresh; this one must match.
3. **Read + classify.** `getSecret` re-throws 404 (`secretService.ts:25-31`), so:
   - `404` → **absent** → go to step 4.
   - any other status (esp. **403**) → **abort before minting**.
   - present and **not** labeled `managed-by=control-api` → **`'exists-foreign'`**,
     returned unconditionally (I1). We never write it, usable or not.

     A foreign copy is not merely "skip this namespace", because the pull key is per-**org**
     and the mint is rotate-on-call: minting for the namespaces we *do* own revokes the key
     inside the foreign Secret as well, and I1 forbids us from repairing it afterwards. So a
     **usable** foreign copy (right `type`, blob keyed on the current host) blocks the mint
     for the whole pass — the org's credential is externally managed and this service must
     not rotate it. Owned namespaces that needed that mint are recorded as blocked and
     surfaced to callers that require them as `foreign_secret_would_be_revoked` (409); a
     caller whose own namespaces are already current is unaffected.

     An **unusable** foreign copy (wrong `type`, or a blob keyed on another host) does *not*
     block the mint: the kubelet never selects it, so it cannot be serving pulls and
     rotating breaks nothing. It still fails any caller that requires *its* namespace, with
     `foreign_secret_unusable` (409). Both conditions are recorded during the pass rather
     than thrown from it, because one pass is shared across callers with different required
     sets — see the `blocked`/`unusable` maps in `registryPullSecretService.ts`.
   - present, ours, `type` correct, and the decoded blob's `auths` contains the current
     host → **`'exists-ours'`**. Presence alone is not enough: a blob keyed on a previous
     `CLERUM_REGISTRY_URL` can never be selected by the kubelet.
   - present, ours, otherwise → **`'repaired'`**. When `type` is wrong the Secret is
     **deleted and recreated** (`Secret.type` is immutable; an update would 422), and the
     delete happens *before* the mint so a failed delete cannot strand a fresh key (I2).
4. **Mint + create (absent).** Call the pull-only mint for the resolved org, then
   `createSecret`. **Build the `dockerconfigjson` locally**, keyed on
   `registryHostFromUrl(config.registryUrl)` — *not* the registry's
   `registryTokenIssuer`-keyed response (§7.9-2).
   On a create **`409`** (lost race): **re-read and adopt the winner** — do *not* mint
   again, since a second mint would revoke the key the winner just stored.

**Failure contract (§7.3 wires this).** Any throw from steps 2-4 fails the
install/upgrade and does **not** persist an McpServer, so no unresolvable
`imagePullSecrets` ref is ever written. Statuses are mapped by class, not collapsed:
`PullSecretProvisionError` keeps its own status + `reason`; a registry rejection becomes
**502** with the upstream status (a generic K8s mapping cannot read
`RegistryProxyError.status` and would report every mint failure as a bare 500); anything
else is 500. The mint carries a bounded timeout — `authedFetch` only bounds GETs.

### 7.2 The Secret contract (frozen — must match MCC byte-for-byte)

| Field | Value | Source of truth |
| --- | --- | --- |
| `metadata.name` | `evenfire-registry-pull` | `EVENFIRE_REGISTRY_PULL_SECRET_NAME` (`registryImagePullSecret.ts:15`) |
| `metadata.namespace` | **`targetNs`** = the McpServer's own namespace — must co-locate with the pod, since `imagePullSecrets` are namespace-local. Provisioning **refuses** any `targetNs` other than `config.mcpServersNamespace` (§7.1 step 2), so a `body.namespace` override cannot redirect the credential | `registry.ts:1011`, `reconciler.ts:946-948` |
| `metadata.labels` | `clerum.io/managed-by: control-api` (provenance label — the ownership marker) | precedent `registry.ts:1206-1209`, `workflow-recipes secretFactory` |
| `type` | `kubernetes.io/dockerconfigjson` | kubelet contract |
| `data['.dockerconfigjson']` | base64 payload **verbatim** (do not double-encode; use `data`, not `stringData`) | `secretService.ts:44`; `secrets.ts:110-121` |

`.dockerconfigjson` passes control-api's key validator unchanged
(`SECRET_DATA_KEY_RE`, `secretKeys.ts:11,38-48`).

> **Label note.** MCC stamps **no** labels on the pull Secret on either path
> (`evenfire-managed-cluster-control/.../install/secrets.ts:110-121`; the shared path
> SSA-applies that same unlabeled manifest), so "present + missing our
> `managed-by=control-api` label ⇒ foreign" is a reliable discriminator *now*. This
> is an **unenforced cross-repo invariant**: it holds because our check is
> *positive-only* (any label other than ours still reads foreign), but to keep it
> honest MCC should carry a regression assertion that its pull Secret does not stamp
> `clerum.io/managed-by=control-api`. We deliberately choose the provenance label
> `clerum.io/managed-by` (values `control-api`/`wrc` already exist) and **not** the
> recipe access labels `clerum.io/owner-recipe` / `clerum.io/shared` — those are the
> #637 recipe↔Secret access model (`packages/workflow-runtime-core/src/secret-ownership.ts`)
> and carry the wrong semantics for a namespace-wide shared credential.
>
> **Concurrency.** Within a replica, concurrent ensures for the same
> `(namespace, secret)` share a single in-flight promise (a dedupe map, not a mutex —
> the second caller receives the first caller's result rather than re-running the state
> machine), so two simultaneous installs cannot both mint. Across replicas, the
> create-`409` path **re-reads and adopts the winner instead of minting again**; that is
> what keeps the stored key and the registry's active key in agreement, since a second
> mint would revoke the key the winner just stored. `mintPullKey` is itself rotate-on-call
> under a per-org advisory lock, so keys never accumulate.

### 7.3 Trigger point

**Primary: lazy, co-located with the existing Secret write.** The install handler
already has a dedicated Secret-write phase — *"Step 3: Create K8s Secret if
credentials provided"* (`registry.ts:~1200-1250`) — that runs **before** *"Step 4:
Create McpServer CRD"* (`registry.ts:~1255`). Call `ensureRegistryPullSecret(targetNs)`
in that same Step-3 window (when `shouldAttachEvenfirePullSecret` is true), so the
pull Secret exists before the CRD that references it is created. The upgrade handler
has the symmetric phase (*"Step 4: Update credentials"* before the CRD update,
`registry.ts:~1830-1875`). Both already hold the router's `K8sGateway`
(`createAdminRegistryRouter(gateway?)`, `registry.ts:732`). This:

- provisions exactly when a private evenfire-hosted plugin is installed/upgraded,
- targets the correct namespace (`targetNs`) automatically, co-located with the pod,
- is idempotent via read-before-mint.

**Rollback scoping (important).** Step 4's CRD-create failure path **rolls back the
per-plugin credentials Secret** (`registry.ts:1265-1272`, `deleteSecret` guarded by
`secretCreated`). The pull Secret is **namespace-shared** across every plugin in
`targetNs` — it MUST NOT be added to that rollback (deleting it would break other
installed plugins and defeats idempotent reuse). So `ensureRegistryPullSecret` sits
*outside* the per-plugin `secretCreated`/rollback bookkeeping; a later CRD failure
leaves the pull Secret in place (correct — it is reused, not owned by this one
install).

**Fail-loud.** On mint/write error, return the `5xx`
`registry_pull_secret_provision_failed` and do not attach an unresolvable ref (§7.1
failure contract) — mirroring the existing fail-loud credentials write at
`registry.ts:1226-1240`. When `gateway` is absent (dev/no-cluster), provisioning
no-ops and the attach behaves as today.

**Boot + periodic reconcile — now REQUIRED, not optional (see the recipe spec §13.1).**
For `McpServer` installs the lazy hook alone is sufficient, since that CRD is only ever
created here. It is *not* sufficient once WRC injects the same reference into
`WorkflowRecipe` workloads, because those CRDs can be created without control-api. A
non-fatal pass in `main.ts` alongside
`reconcileAllowedModelsConfigMapOnBoot` (`main.ts:~61`) can pre-create the Secret so
it exists before any pod schedules. Deferred unless install-time latency is a
concern; the lazy path suffices because HCC re-pulls once the Secret appears.

### 7.4 Coexistence & idempotency

Two independent guarantees, both required:

1. **Mode gate.** `registryConnectionMode === 'self-hosted'` means the path never
   runs on a managed (MCC-owned) cluster. This is how we coexist with MCC *without
   the repo naming it* (G2).
2. **Ownership read.** Within self-hosted, an external/operator-provisioned Secret
   (unlabeled, or lacking `managed-by=control-api`) is left **untouched**
   (`'exists-foreign'`). control-api only ever writes a Secret it owns.

Because the pull-only mint is **rotate-on-call**, a blind re-mint would orphan the
working on-cluster key — so read-before-mint (§7.1 step 2) is the load-bearing
idempotency guarantee: control-api mints only when the Secret is absent or broken, and
never for an `'exists-ours'`/`'exists-foreign'` hit.

Leaving a foreign Secret unwritten is **not** on its own sufficient, because the key is
per-org: a mint for any *other* namespace revokes the foreign copy's credential too, with
no way to detect it (foreign copies are excluded from the fingerprint comparison) and no
way to repair it (I1). A **usable** foreign copy therefore blocks the mint entirely for
that pass — see §7.1 step 3. This is the same one-writer-per-org rule the registry
enforces between operator and tenant, applied within a single cluster.

### 7.5 What stays unchanged

- The attach/upgrade logic and `shouldAttachEvenfirePullSecret` (correct today).
- HCC's reference propagation (`reconciler.ts:994-1002`) — no HCC change required
  for delivery.
- The infra `clerum` pull secret and its minikube empty-string override
  (`deploy/overlays/minikube/patches/dynamic-images.yaml:29-34,61-64`).
- The `registry-voucher` / voucher-kid substrate (§7.8).

### 7.6 Rotation & lifecycle

- **Rotation & liveness.** The pull key carries no expiry (`mintPullKey` sets none), so
  reuse is safe by construction. `'exists-ours'` is **not** a presence-only check: the
  stored blob is decoded and its `auths` map must contain the currently-configured
  registry host, so a Secret minted before `CLERUM_REGISTRY_URL` changed is detected as
  broken and repaired on the next install. A wrong-`type` Secret is likewise detected and
  recreated (`Secret.type` is immutable, so an in-place update would 422).
  Posture in one line: *control-api owns rotation for Secrets it owns and never touches a
  foreign Secret.*

  **Not shipped (accepted gap):** there is no reactive trigger on an observed
  `401`/`ImagePullBackOff`, and no admin "re-provision" action. A key revoked
  **out-of-band** is therefore not self-healed — the stored blob still decodes and still
  matches the host, so it reads as healthy. Today's remedy is to delete the Secret and
  re-install, which re-provisions. A re-provision endpoint is the natural follow-up; it is
  deliberately out of scope here rather than documented as if it exists.
- **GC.** Plugin uninstall deletes the per-plugin `<name>-credentials` Secret by name
  and does **not** touch the shared pull Secret (§7.9) — correct, since other plugins
  may still need it. The Secret is therefore a standing namespace credential for the
  cluster's lifetime; no ownerReference/finalizer is added (consistent with the
  absence of ownerReferences anywhere in control-api today). Because the pull key is
  rotate-on-call (≤1 per org), it does **not** accumulate — but nothing revokes the
  final key on teardown, so it remains a standing registry credential. Revoking it on
  the last-plugin uninstall (and on `registryUrl`/host change) is out of scope but
  noted as a lifecycle follow-up.

### 7.7 Optional HCC enhancement — presence validation

Today HCC validates `envSecret` existence but **not** `imagePullSecrets`
(`reconciler.ts:436-453` vs `:994-1002`), so a missing pull Secret surfaces only as
`ImagePullBackOff`. HCC could read-validate the referenced pull Secret and emit a
clean `SecretResolved`-style condition. This is a small, contract-preserving
addition (HCC already has `get` on secrets in `mcp-server`) that turns a silent
failure into an actionable status. **Optional; not required for delivery.**

### 7.8 Removing MCC knowledge from this repo (G2)

**In scope — the pull-secret path:** rewrite the comments to describe
self-provisioning, keeping the constant and predicate (they are the local contract):

- `registryImagePullSecret.ts:6,12-13` — drop "provisioned … by MCC" / "stay in sync
  with the MCC install step"; state control-api self-provisions in self-hosted mode
  and may coexist with an externally pre-provisioned Secret.
- `registry.ts:1114-1116` — rewrite the whole two-line comment ("… pull secret
  (provisioned by / MCC in the plugin namespace). Attach the reference; HCC
  propagates it.") so no dangling "provisioned by" remains.
- `control-api/test/registryImagePullSecret.test.ts:10` — the test named
  *"is the exact secret name MCC provisions"* must be reworded (e.g. "is the frozen
  pull-secret name"); the scrub is computed over `control-api/test` as well as
  `control-api/src`, or G2 does not hold.

**Adjacent — DONE in this pass.** These mention managed-mode topology but are *not* the
pull secret. The literal word "MCC" has been replaced with "the managed operator" /
"managed" in each; the *behavior* they branch on is legitimate and unchanged
(control-api genuinely differs by `registryConnectionMode`). `grep -rn '\bMCC\b'
control-api/src control-api/test` now returns nothing:

- `config.ts:62` — voucher-kid "Delivered by MCC in the registry-voucher Secret"
  (voucher-identity substrate; self-hosted reads kid from the `registry_connection`
  DB row — a real, separate subsystem).
- `k8s.ts:497`, `config.ts:750`, `adminProvisioning.ts:95`, `auth.ts:156,589` —
  managed-mode install/topology notes.

Recommendation: scrub the wording in this pass; keep the `registryConnectionMode`
behavior. Do not conflate the voucher substrate with the pull secret.

**Docs:** `docs/how-to/connect-to-registry.md:59,70` currently overstates that
connecting alone yields working image pull. Update it to describe self-provisioning
(the Secret is created by control-api on first private-image install in self-hosted
mode).

**Egress (two distinct planes — do not conflate):**

- **control-api → registry (mint).** A pod-network egress concern, and it is
  **already covered** in base by control-api's external-egress NetworkPolicy (the
  same path the existing registry read-API/voucher calls use). No new policy needed.
- **kubelet → registry (image pull).** Image pulls happen at the **node** level,
  outside the pod network namespace, so Kubernetes `NetworkPolicy` does **not** gate
  them — the `deny-all` egress on `mcp-server`
  (`deploy/base/mcp-server/networkpolicies.yaml`) neither blocks pulls nor is a place
  to "allow" them. The real requirement is **node/GKE firewall egress** to the
  registry host, which is a cluster-infrastructure concern, not a manifest in this
  repo. (Minikube sidesteps it entirely by loading images locally.)

Net: no in-repo NetworkPolicy change is required for either plane; document the
node-level firewall expectation for self-hosted operators pulling from a remote
registry.

### 7.9 Verified side effects & interactions

Traced against the current install/upgrade/uninstall code. **Cleared (safe today):**

- **Uninstall never sweeps the pull Secret.** The uninstall handler deletes
  `${resourceName}-credentials` **by name** (`registry.ts:1610`) and the McpServer by
  name — never by label selector. `clerum.io/managed-by=control-api` is **not** used
  as a list/delete selector anywhere in control-api (only `clerum.io/recipe` and pod
  selectors are). So the namespace-shared pull Secret survives every per-plugin
  uninstall.
- **The #637 recipe↔Secret access gate does not apply.** That gate
  (`parseSecretOwnership` / `isSecretAccessibleByRecipe`) only governs secrets a
  recipe **projects into its pod**. An `imagePullSecrets` entry is consumed by the
  kubelet, never projected — so the pull Secret's absence of `owner-recipe`/`shared`
  labels is irrelevant and cannot trip recipe validation.

**Must-handle (these will bite if missed):**

1. **Hook placement is independent of `credRequired`.** The existing Step-3 Secret
   write is gated on `if (credRequired)` (`registry.ts:1217`). A private evenfire-hosted
   plugin with **no** required credentials (`credRequired === false`) creates *no*
   credentials Secret — but still needs the pull Secret. `ensureRegistryPullSecret`
   MUST therefore be called **outside** the `credRequired` block, gated only on
   `shouldAttachEvenfirePullSecret`. Placing it inside would silently reintroduce
   `ImagePullBackOff` for credential-less private-image plugins.
2. **Build the dockerconfigjson locally, keyed on the image host.** The kubelet selects
   the pull credential by matching the image's registry host against the
   `.auths` keys. The registry's server-built blob is keyed on *its* `registryTokenIssuer`
   (`org.ts:295` → `buildDockerconfigjson(config.registryTokenIssuer, key)`,
   default `registry.evenfire.ai`), which is **independent config** from control-api's
   `config.registryUrl`. control-api has no `registryTokenIssuer` field. So
   `ensureRegistryPullSecret` MUST build the blob itself with
   `registryHostFromUrl(config.registryUrl)` as the `.auths` host — which the
   `shouldAttachEvenfirePullSecret` invariant guarantees equals the image host — rather
   than trust the registry's `registryTokenIssuer`-keyed response. Same pure formula
   (`{auths:{[host]:{username:'_',password:key,auth:base64('_:'+key)}}}`), local host.
3. **No collision with operator `efrk_` keys.** control-api also exposes
   `/admin/registry/keys` (`registry.ts:2221-2247`), where operators mint/list/revoke
   `efrk_` keys. Using the **pull-only** credential keeps these cleanly separate: pull
   keys (`kind:'pull'`) are excluded from that operator list (`orgApiKeyService.ts:99,110`),
   are rotate-on-call (≤1 per org, so negligible against `MAX_ACTIVE_KEYS_PER_ORG=100`),
   and are managed entirely by the mint endpoint — so no description-marker, no
   revoke-prior bookkeeping, and no risk of the provisioner revoking a user/CI key.
   (This is a concrete reason the pull-only credential, §6.1, is preferable to the
   publish-scoped fallback, §6.3, which *would* re-introduce all three concerns.)

---

## 8. Multi-tenancy guardrail (carried forward from the registry bridge design §7)

The self-hosted / OSS platform is **single-tenant — one organization per
deployment** (`docs/concepts/open-core-and-hosted.md:38`, `docs/faq.md:21`). So
exactly one plugin namespace holds exactly one org's plugins, and a single
cluster-scoped `evenfire-registry-pull` Secret carrying that org's identity is
correct and safe.

> **Guardrail.** The pull Secret is written into **`targetNs`** — the same namespace
> as the McpServer + credentials Secret — because `imagePullSecrets` are
> namespace-local and must co-locate with the pod (§7.1). It MUST NOT clobber an
> externally-provisioned Secret (§7.4 ownership read). The safety property against a
> caller directing the write into an *arbitrary* namespace is: the read/write goes
> through the same `K8sGateway` under control-api's RBAC, so a namespace outside
> control-api's secrets-RBAC set (`mcp-server`, `mcp-host`, `control-plane`,
> `sandbox-recipes`, `sandbox-ui`) fails the read with `403` and **aborts before
> minting** (§7.1 step 2, R7). Because self-hosted is single-tenant, in practice
> `targetNs` is `config.mcpServersNamespace` (default `mcp-server`); an operator that
> exposes the `body.namespace` override should constrain it to that covered set. If a
> deployment ever hosts more than one org/namespace, the pull Secret is already
> naturally per-namespace (it follows `targetNs`), but the *single-org-per-namespace*
> assumption must be re-verified before any multi-org self-hosted mode ships — as the
> managed operator already does with `mcp-server-<slug>`.

Note the resolved contradiction between the two registry specs: "one org per
cluster" is the **self-hosted/dedicated** truth; the managed operator's own model is
shared multi-tenant with per-`mcp-server-<slug>` isolation. This spec targets the
self-hosted single-tenant slice and does not regress the managed per-namespace model.

> **CLOSED — recipe plugins were not covered by this spec as first written.**
>
> *Historical, kept because it explains the shape of the extension.* The auto-attach fired
> only for registry-built `McpServer`s, which land in `mcp-server[-slug]`. A
> `WorkflowRecipe` workload pulling a private evenfire image resolves to
> `sandbox-recipes[-slug]` or `sandbox-ui[-slug]`
> (`control-api/src/routes/admin/recipes.ts:66-80`), where this spec provisioned nothing —
> and `install-recipe` had no pull-secret hook. Worse, a *mixed* recipe (transport
> + non-transport) that declares the Secret by name gets it **silently stripped**: the
> Issue-#637 gate classifies our `managed-by`-only Secret as unlabeled → `denied`, and
> `combineSecretAccess` makes a denial in one namespace denial everywhere.
>
> This was a design gap, not a configuration one — nothing in the platform could create a
> usable pull Secret for a recipe namespace. (One half of that is still true:
> `POST /admin/recipes/secrets` still hardcodes `type: 'Opaque'`, which the kubelet ignores
> for image pulls — the third-party BYO-registry path, still open.)
>
> **Closed in the same PR** by
> [`registry-pull-secret-recipe-workloads.md`](registry-pull-secret-recipe-workloads.md):
> `ensureRegistryPullSecrets` fans out from a **single** mint to all three platform workload
> namespaces, and WRC **injects** the reference after the #637 filter so the recipe never
> names it. Note that WRC's injection is **not** mode-gated (that spec §9.1) — on a managed
> cluster the external operator must provision the Secret in all three namespaces. **Do
> not** close any of this by labelling the Secret `clerum.io/shared=true` — the #637
> predicate is shared between `envSecret` and `imagePullSecrets`, so that would let any
> recipe read the credential out of its own environment (see that spec, §5.1).

---

## 9. Rollout & migration

1. **Deploy the registry gate change (§6.2) first or together** — control-api's mint
   `403`s until the relaxed endpoint is live, so the `evenfire-registry` deploy must
   land before (or with) the control-api rollout. **Done:** PR #64 is merged and deployed to
   production (2026-08-04), ahead of the control-api rollout.

   > **Precondition the gate alone does not satisfy — RESOLVED in the same PR.** The relaxed
   > endpoint authorizes on `registry:manage-keys`, and originally only the registry's
   > **auto-approve** path granted that scope. A deployment approved through the **admin
   > approve** route (`POST /deployments/:id/approve`) fell back to `approveDeployment`'s
   > default scope set, which omitted it; migration 015's backfill was scoped
   > `WHERE created_by = 'mcc-admin'` while that path writes `created_by =
   > 'deployment-approval'`, so it was not covered either. Because
   > `CLERUM_REGISTRY_OPEN_REGISTRATION` is absent from every overlay, auto-approve is
   > unreachable in prod — so this was *every* self-hosted deployment, not a subset.
   >
   > Registry PR #64 fixed it (tracked as evenfire-registry#65) rather than leaving it as a
   > follow-up: the optional `scopes` parameter was **removed** from `approveDeployment` in
   > favour of one exported `SELF_HOSTED_DEPLOYMENT_SCOPES`, so both approve paths grant the
   > identical set and `tsc` now rejects any divergent call site. **Migration 021** repairs
   > existing rows, keyed on `registry_deployments.kind = 'self-hosted'` — deliberately *not*
   > on `created_by`, which is precisely the blind spot that made 015 miss this population —
   > and scoped to `client_id = d.id::text` so operator-bound extra clients bound to the same
   > org are not silently widened. Verified in production after the deploy: all seven approved
   > self-hosted deployment clients hold `registry:manage-keys`; the eight managed deployments
   > have no matching client row and were untouched.
2. **Ship control-api self-provisioning** gated on `self-hosted`, with the comment/doc
   scrub (§7.8). **Done in PR #243.** Managed clusters take no *write* (the managed operator
   keeps owning the Secret) — the mode gate guarantees no double-writer, so no cross-repo
   coordination is needed for provisioning. It **is** needed for the recipe extension that
   shipped alongside: WRC's injection is not mode-gated, so the managed operator must widen
   its provisioning to all three platform workload namespaces
   (`registry-pull-secret-recipe-workloads.md` §9.1).
3. **Retire the managed operator's `install_registry_pull_secret`** (shared + dedicated)
   — a separate change in that repo, sequenced *after* managed clusters also
   self-provision (a future extension of the mode gate) **or** left as-is if managed
   stays on the operator. Do not remove it until managed provisioning is guaranteed by
   another actor; until then managed and self-hosted are cleanly partitioned by mode.

No migration is required for existing managed tenants: their MCC-written Secret
(unlabeled, `fieldManager mcc-rung35` on shared) is untouched by the self-hosted
path and reads as `'exists-foreign'` if the mode ever flips.

---

## 10. Risks & mitigations

| # | Risk | Mitigation |
| --- | --- | --- |
| R1 | Rotate-on-call mint orphans a working on-cluster key (blind re-mint). | Read-before-mint is mandatory — mint only when the Secret is absent/broken (§7.1); in-process serialization on the Secret name. |
| R2 | Clobbering an operator/MCC Secret. | Mode gate + `managed-by` ownership read; foreign Secrets are never written (§7.4); unlabeled-⇒-foreign invariant noted (§7.2). |
| R3 | Pull Secret in the wrong namespace → ref silently unresolved (`imagePullSecrets` are namespace-local). | Provision into `targetNs` so it co-locates with the pod, and **refuse** any `targetNs` other than `config.mcpServersNamespace` (§7.1 step 2); a `403` read aborts before minting as a second line of defence. |
| R4 | Self-hosted registry identity / org mapping not yet established (no claimed client, `orgName` null). | **Throws** `registry_not_connected` / `org_unresolved` (409) rather than skipping, so the install fails instead of attaching an unresolvable ref; a cached null org is retried once with `{force:true}` before failing (§7.1 step 2). |
| R5 | Registry unreachable, or the §6.2 endpoint change not yet deployed → mint 403/error. | control-api→registry egress already covered in base; the registry change ships in the same release and must be live before control-api mints (§14 ordering); fail-loud install surfaces it (§7.1). |
| R6 | A caller-supplied `body.namespace` redirects an org registry credential into another namespace (control-api holds `secrets:create` in six, incl. `channels`). | Provisioning **refuses** any namespace other than `config.mcpServersNamespace` with `unsupported_namespace` (400) before minting — RBAC alone is broader than this rule allows (§7.1 step 2, §8). |
| R7 | Shared pull Secret wrongly torn down by a per-plugin rollback. | `ensureRegistryPullSecret` sits outside the Step-4 `secretCreated`/`deleteSecret` rollback scope; a CRD-create failure never deletes the namespace-shared pull Secret (§7.3). |
| R8 | `.dockerconfigjson` keyed on the wrong host → present Secret still yields `ImagePullBackOff`. | Build the blob locally keyed on `registryHostFromUrl(config.registryUrl)` (= image host), not the registry's `registryTokenIssuer` (§7.9-2). |
| R9 | Credential-less private-image plugin (`credRequired=false`) gets no pull Secret. | Hook is outside the `if (credRequired)` block, gated only on `shouldAttachEvenfirePullSecret` (§7.9-1). |

---

## 11. Test plan

**Shipped — `control-api/test/registryPullSecretService.test.ts` (state machine, 16 cases)**

- No-ops: managed mode; no registry host configured.
- Throws (not skips): inactive connection; org unresolved after a forced refresh;
  `targetNs` outside the configured plugin namespace; a non-404 read (403); a mint
  failure — each asserting **nothing was minted or written**.
- Forced refresh: a cached null org is retried with `{force:true}` and then succeeds.
- Provisioning: absent → created, with `type`, `managed-by` label, and an `.auths` map
  keyed on the **image host** (the assertion that would catch a `registryTokenIssuer`
  regression); ours+valid → reused without minting; ours+stale host → repaired;
  ours+empty → repaired; ours+wrong `type` → **deleted and recreated**, with the delete
  asserted to precede the mint.
- Ownership: a foreign Secret **with** data and a foreign **empty** Secret are both left
  byte-for-byte untouched and never relabelled.
- Race: a create-`409` adopts the winner with **exactly one** mint.

**Shipped — `control-api/test/routes.registryInstall.pullSecret.test.ts` (wiring, 4 cases)**

Runs in `self-hosted` mode, which the pre-existing route suites never do (they default to
`managed`, where the hook short-circuits — which is why the wiring previously had no real
coverage). Asserts: a **credential-less** private plugin still gets the Secret (the hook
is outside `credRequired`); a mint failure fails the install and persists **no**
McpServer; an unresolved org returns `409 org_unresolved`; a non-evenfire image provisions
nothing. Mutation-verified: gating the hook on `credRequired` fails 3 of these 4.

**Shipped since — `tests/e2e/integration/registry-pull-secret-runtime.test.ts`**

- **Integration / e2e (minikube, self-hosted)** — install a private plugin end-to-end and
  assert the pod actually pulls. This was blocked on the Workstream-A registry change
  reaching a live registry; `evenfire-registry` #64 is merged and deployed, so it now
  exists. It covers this spec's `McpServer` path — control-api → `McpServer` CRD → HCC →
  Deployment → Pod Ready → a real authenticated pull, with the image evicted from the
  node's docker cache first so `imagePullPolicy: IfNotPresent` cannot serve it from cache
  and leave the credential unexercised — alongside the recipe-workload extension. See
  [`registry-pull-secret-recipe-workloads.md`](registry-pull-secret-recipe-workloads.md)
  §11 and §13.5.

**Not shipped (deliberate)**

- **A `mintOrgPullCredential` transport test** (endpoint path, POST, timeout, key
  validation). It is mocked in both suites above; its behavior is still asserted only
  indirectly at the unit level — though the e2e above now exercises the real transport end
  to end, since a pull that succeeds proves the minted key reached the registry intact.

---

## 12. Open questions / decisions for review

**Resolved**

- ~~MCC-word scrub breadth (§7.8)~~ — **done**: scrubbed repo-wide in comments, behavior
  unchanged. `grep -rn '\bMCC\b' control-api/src control-api/test` returns nothing.
- ~~Trigger (§7.3)~~ — **REVERSED.** Originally resolved as lazy-only (no boot reconcile,
  to avoid provisioning on clusters that never install a private plugin). That reasoning
  holds for `McpServer` installs, which only ever originate here — but not for
  `WorkflowRecipe`, which can be created by `kubectl apply` or the WRC `deploy_recipe`
  tool without control-api being involved, while WRC injects the pull-secret reference
  regardless. Provisioning therefore has to be a standing invariant. See
  [`registry-pull-secret-recipe-workloads.md`](registry-pull-secret-recipe-workloads.md)
  §13.1.

**Still open**

1. **Rotation (§7.6)** — no reactive trigger shipped. A stale *host* is now self-healed
   (content is validated), but a key revoked *out-of-band* is not. Add a re-provision
   endpoint, or accept "delete the Secret and re-install" as the remedy?
2. **HCC presence-validation (§7.7)** — follow-up PR, or never? It would turn a missing
   Secret into a clean condition instead of `ImagePullBackOff`.
3. **`enforceNamespace` on the install route** — this PR guards only the *credential*
   write (§7.1 step 2). Applying the repo's existing `enforceNamespace` middleware to
   `POST /admin/registry/install` would also constrain where the McpServer itself lands,
   consistent with every other admin secret route — but that changes pre-existing install
   semantics and was deliberately left out of scope here.
4. **Managed-operator step retirement (§9-3)** — coordinate managed self-provisioning, or
   leave managed on the operator indefinitely behind the mode gate?

---

## 13. Appendix — touchpoint index

**evenfire (this repo)**
- `control-api/src/routes/admin/registryImagePullSecret.ts` — name/predicate; comments to rewrite (`:6,12-13`).
- `control-api/test/registryImagePullSecret.test.ts:10` — test description to reword (G2 scrub).
- `control-api/src/routes/admin/registry.ts` — attach sites `:~1117-1124`,`:~1808-1818`; comment `:1114-1116`; existing fail-loud plugin-ns Secret write via gateway `:1226-1240`; router gateway param `:732`.
- `control-api/src/services/registryPullSecretService.ts` — **new** (`ensureRegistryPullSecret`; takes `K8sGateway` + mint fn).
- `control-api/src/services/registryClient.ts` — **new** exported `mintOrgPullCredential(orgName)` built on the private `orgRegistryFetch` (`:551`, machine Bearer, prefixes `/api/v1`), mirroring `createOrgGrant` (`:584`); `authedFetch` `:191`; `resolvePublishScope` `:650-662` (orgName nullable).
- `control-api/src/services/orgApiKeyClient.ts:115-164` — existing **user-token** key mint (the path that 403s in ownerless orgs; *not* reused).
- `control-api/src/k8s.ts:389-394` — `K8sGateway.getSecret/createSecret/updateSecret` (the write surface actually used at the attach sites).
- `control-api/src/services/secretService.ts:25-53` — `getSecret` **re-throws 404** (not 404-aware); `createSecret` passes `type` through.
- `control-api/src/config.ts:~76,285,302-304,460` — `registryConnectionMode`, `mcpServersNamespace`.
- `deploy/base/mcp-server/rbac.yaml:29-31` — control-api secrets RBAC (sufficient; broader set incl. `sandbox-ui`).
- `host-context-controller/src/reconciler.ts:994-1002` — reference propagation (unchanged); `:436-453` — envSecret validation (model for §7.7).
- `docs/how-to/connect-to-registry.md:59,70` — doc fix.

**evenfire-registry (in scope; Workstream A)**
- `src/routes/deployments.ts:237-247` — self-hosted client gets `registry:manage-keys` (the enabler).
- `src/routes/org.ts:371-388` — `*`-gated pull-only endpoint (`:376` gate is the A1 relaxation target); `:245,276,293-295` — publish-scoped machine branch (the §6.3 fallback).
- `src/services/orgApiKeyService.ts:122-151` — `mintPullKey` (rotate-on-call, `kind:'pull'`) / `buildDockerconfigjson`; `:99,110` — pull keys excluded from the owner key list; `:23` — `MAX_ACTIVE_KEYS_PER_ORG`.

**evenfire-managed-cluster-control (out of repo; sequenced retirement)**
- `packages/backend/src/operations/handlers/tenant-install-shared.ts:476-496`, `evenfire-install.ts:356-378`, `install/secrets.ts:110-121,181-212`, `install/registry.ts:48-95` — the `install_registry_pull_secret` behavior being superseded.

---

## 14. Implementation plan

**One release, two parallel workstreams** — Workstream A (`evenfire-registry`, one
endpoint gate change) and Workstream B (`evenfire`/control-api, the self-provisioner).
They can be built concurrently; the only ordering constraint is at **deploy** time (A
must be live before B mints — §9-1). control-api uses the least-privilege pull-only
credential from the first commit; there is no interim publish-scoped step.

### Workstream A — registry pull-credential gate (`evenfire-registry`) — **shipped (PR #64)**

- **A1 — Relax the gate** (`src/routes/org.ts`). **Shipped and deployed to production
  2026-08-04.** In `POST /:org/registry-pull-credential`,
  replace the `*`-admin gate (`:376`) with
  `authorizeMachineForOrg(auth, orgName, 'registry:manage-keys')` (§6.2) so an org-bound
  machine mints a pull-only key for its **own** org. `mintPullKey` (rotate-on-call,
  `kind:'pull'`) and `buildDockerconfigjson` unchanged — only the auth gate moves.
  *Accept:* an org-bound `manage-keys` machine gets `201`; a foreign org still `403`s;
  `*`-admin still works (managed operator unaffected); audit log preserved.

### Workstream B — control-api self-provisioner (`evenfire`) — **shipped (PR #243)**

Ordered so each task is independently reviewable; **B1–B3** are the functional core,
**B4–B7** are decoupling/quality. B1–B6 shipped; **B7 (HCC presence-validation) was not
taken** and remains the follow-up in §12-3.

- **B1 — `registryClient.mintOrgPullCredential(orgName)`** (`control-api/src/services/registryClient.ts`).
  New exported fn on the private `orgRegistryFetch` (machine Bearer, prefixes `/api/v1`),
  mirroring `createOrgGrant`; `POST /org/${orgName}/registry-pull-credential`; returns
  `{ key, keyId }`. Do **not** consume the response's `dockerconfigjson` (wrong host,
  §7.9-2). *Accept:* unit test against a mocked registry asserts machine-Bearer + endpoint.
- **B2 — `registryPullSecretService.ensureRegistryPullSecret(targetNs)`**
  (`control-api/src/services/registryPullSecretService.ts`, **new**). The §7.1 state
  machine: gate (mode/auth/url/non-null `orgName`) → read (404→absent, 403→abort,
  classify ours/foreign/repair) → mint (B1, only when absent/broken) → **build
  dockerconfigjson locally** keyed on `registryHostFromUrl(config.registryUrl)` →
  `createSecret`/`updateSecret` with `managed-by:control-api`. In-process mutex on the
  Secret name. Deps injected: `K8sGateway`, the B1 mint fn, `config`.
  *Accept:* the §11 unit matrix (absent/ours/foreign/repair/409/gate-off) green.
- **B3 — Wire into install + upgrade** (`control-api/src/routes/admin/registry.ts`).
  Call `ensureRegistryPullSecret(targetNs)` when `shouldAttachEvenfirePullSecret` is true,
  **outside the `if (credRequired)` block** (§7.9-1), in the Step-3 window **before** the
  Step-4 CRD create, and **outside** the per-plugin `secretCreated`/rollback bookkeeping
  (§7.3). Fail-loud (`registry_pull_secret_provision_failed`, `5xx`) — do not attach an
  unresolvable ref. Same in the upgrade handler's credentials phase.
  *Accept:* e2e (minikube, self-hosted) — a private plugin pulls; a credential-less
  private plugin pulls; re-install idempotent; a pre-seeded foreign Secret is preserved.
- **B4 — Revise existing tests** (`control-api/test/routes.registryInstall.test.ts`).
  Update the `createSecret` call-count assertions (`:864`, `:1148`, `:1204`) and extend the
  `evenfire imagePullSecrets attach` block (`:1424`) to assert the pull-Secret create,
  shape, namespace (`targetNs`), and host-keying.
- **B5 — Remove MCC knowledge** (§7.8). Rewrite comments at
  `registryImagePullSecret.ts:6,12-13` and `registry.ts:1114-1116`; reword the test name at
  `registryImagePullSecret.test.ts:10`; scrub the adjacent managed-mode "MCC" wording
  (keep the `registryConnectionMode` behavior). *Gate:* `grep -rn '\bMCC\b' control-api/src
  control-api/test` returns only intentional, neutral phrasings.
- **B6 — Docs** — fix `docs/how-to/connect-to-registry.md:59,70` to describe
  self-provisioning; add the node-level registry-egress note for remote-registry
  self-hosters (§7.8).
- **B7 — (optional) HCC presence-validation** (§7.7) — separate PR; read-validate the
  pull Secret and emit a `SecretResolved`-style condition instead of silent
  `ImagePullBackOff`.

### Release & sequencing (see §9)

A and B are built in parallel and **released together**. The only hard ordering is at
deploy: **A must be live before B mints** (else B `403`s — surfaced fail-loud, R5). An
integration test exercises B against the A-updated registry before cutover. Retiring the
managed operator's `install_registry_pull_secret` step (§9-3) is a separate, later change
in that repo — **not** part of this release, and only once managed-mode provisioning is
guaranteed by another actor; until then the `registryConnectionMode` gate keeps managed
and self-hosted cleanly partitioned.
