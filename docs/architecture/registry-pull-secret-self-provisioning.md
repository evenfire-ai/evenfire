# Self-provisioning the `evenfire-registry-pull` image-pull Secret

**Status:** Draft / proposed
**Date:** 2026-08-03
**Area:** control-api registry integration · image pull · self-hosted / open-core
**Supersedes (in effect):** the "MCC mints + creates the secret" role in the registry
bridge design `evenfire-registry/docs/superpowers/specs/2026-06-30-registry-phase2-4-grant-pull-credential-bridge-design.md` §4.2, for **self-hosted** deployments.
**Related:** `docs/concepts/open-core-and-hosted.md`, `docs/how-to/connect-to-registry.md`,
`evenfire-registry/docs/superpowers/specs/2026-06-30-registry-phase2-4-delivery-design.md`

---

## 1. Summary

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

### 6.2 The registry change (ships in the same release)

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
arbitrary namespace is the RBAC check in step 2 (a `403` read aborts before minting),
plus constraining plugin installs to control-api's covered namespaces (§8). If the
gateway is absent (dev/no-cluster), it no-ops.

Algorithm:

1. **Gate — no-op (`'skipped'`) unless all hold:**
   - `registryConnectionMode === 'self-hosted'` (`config.ts:~76`);
   - `isRegistryAuthActive()` true (`registryConnectionDb.ts:231-234`);
   - `config.registryUrl` non-empty and allowlisted;
   - `resolvePublishScope().orgName` is **non-null** (`registryClient.ts:650-662` —
     it is nullable for curator/unresolved `/whoami`; `isRegistryAuthActive()` checks
     credential presence, *not* org mapping). A null org means the connect flow has
     not populated `org_name` yet — skip with a clear install-time error rather than
     minting against `/org/null/keys`.

   This mirrors the attach predicate, so the Secret is provisioned exactly when a
   private evenfire-hosted image is in play, and managed clusters stay inert.
2. **Read.** `getSecret('evenfire-registry-pull', ns)`. **`getSecret` is NOT
   404-aware — it re-throws the underlying K8s error including 404**
   (`secretService.ts:25-31`, docstring explicit). So:
   - `statusCode === 404` → treat as **absent** → go to step 3.
   - Any other error (esp. **`403`** — namespace outside control-api's secrets RBAC)
     → **abort** without minting (surface it; do not waste a key-cap slot).
   - Present, **non-empty** `.dockerconfigjson`, **not** labeled
     `clerum.io/managed-by=control-api` → **`'exists-foreign'`**: an external operator
     owns it → return, never touch (coexistence guarantee, §7.4).
   - Present, labeled `managed-by=control-api`, **non-empty** `.dockerconfigjson` →
     **`'exists-ours'`**: reuse (rotation handled separately, §7.6).
   - Present but `.dockerconfigjson` **missing/empty** (placeholder, truncated write,
     wrong-typed same-named Secret), regardless of label → **`'repaired'`**: mint and
     `updateSecret` (replace) — do **not** `createSecret` (it would 409). This closes
     the gap where a create-409 is silently "treated as success" over a broken Secret.
3. **Mint (only reached when the Secret is absent or broken).** Call the registry's
   pull-only mint for `resolvePublishScope().orgName`
   (`POST /org/:org/registry-pull-credential`, §6.1/§6.2). It is **rotate-on-call**
   (revokes the org's prior pull key and inserts a fresh one under a lock,
   `orgApiKeyService.ts:122-142`), so no explicit revoke-prior bookkeeping is needed —
   but this is exactly why **step 2's read-before-mint is mandatory**: a blind re-mint
   would orphan a working on-cluster key. **Build the `dockerconfigjson` locally**,
   keyed on `registryHostFromUrl(config.registryUrl)` (the image host, per the attach
   invariant) — *not* the registry's `registryTokenIssuer`-keyed response (§7.9-2) —
   via `{auths:{[host]:{username:'_',password:key,auth:base64('_:'+key)}}}`
   (`orgApiKeyService.ts:147-151`).
4. **Write.** `createSecret` (absent) or `updateSecret` (repair) with
   `type:'kubernetes.io/dockerconfigjson'`,
   `data:{'.dockerconfigjson': <base64>}`,
   `labels:{'clerum.io/managed-by':'control-api'}`, and an annotation carrying the
   key id. On a create `409` (concurrent create) → re-read; if the winner is
   `exists-ours`, treat as success (and revoke the key this call just minted to avoid
   a leak); otherwise classify per step 2.

**Failure contract (§7.3 wires this).** If the gate passes but mint or write throws,
the caller **fails the install/upgrade loudly** with a `5xx`
`registry_pull_secret_provision_failed` and does **not** attach an unresolvable
`imagePullSecrets` ref — mirroring the existing fail-loud Secret write at
`registry.ts:1226-1240`. A silent proceed-and-attach would reproduce the very
`ImagePullBackOff` this spec removes. `authedFetch` does not itself time out, so the
mint call should carry a bounded timeout.

### 7.2 The Secret contract (frozen — must match MCC byte-for-byte)

| Field | Value | Source of truth |
| --- | --- | --- |
| `metadata.name` | `evenfire-registry-pull` | `EVENFIRE_REGISTRY_PULL_SECRET_NAME` (`registryImagePullSecret.ts:15`) |
| `metadata.namespace` | **`targetNs`** = the McpServer's own namespace (`body.namespace \|\| config.mcpServersNamespace`) — must co-locate with the pod, since `imagePullSecrets` are namespace-local (§7.1) | `registry.ts:1011`, `reconciler.ts:946-948` |
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
> **Concurrency.** With multiple control-api replicas or concurrent install/upgrade
> ops, the read→mint→write sequence can race. The create-`409` re-read (step 4)
> collapses the Secret-write race, and an in-process mutex keyed on the Secret name
> serializes provisioning within a replica. The mint itself is safe under races:
> `mintPullKey` is rotate-on-call under a per-org advisory lock, so concurrent mints
> converge on a single active pull key rather than accumulating — though a replica
> that minted just before a peer's rotate must still re-read (a stale in-hand key is
> discarded in favor of the on-cluster Secret).

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

**Optional: boot-time reconcile.** A non-fatal pass in `main.ts` alongside
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

### 7.5 What stays unchanged

- The attach/upgrade logic and `shouldAttachEvenfirePullSecret` (correct today).
- HCC's reference propagation (`reconciler.ts:994-1002`) — no HCC change required
  for delivery.
- The infra `clerum` pull secret and its minikube empty-string override
  (`deploy/overlays/minikube/patches/dynamic-images.yaml:29-34,61-64`).
- The `registry-voucher` / voucher-kid substrate (§7.8).

### 7.6 Rotation & lifecycle

- **Rotation & liveness.** `'exists-ours'` reuse (§7.1 step 2) serves the embedded
  key indefinitely, so the key must not silently die. The pull key carries no
  expiry (`mintPullKey` sets none), so reuse is safe by construction. Treat an
  observed `401`/`ImagePullBackOff` (or an admin "re-provision" action) as the
  reactive rotation trigger — which re-mints (the endpoint rotates the org's pull
  key) and **replaces** the `'exists-ours'` Secret in place (never a foreign one). A
  scheduled proactive rotation may be deferred, but the *reactive* trigger is
  **required**, else a revoked-out-of-band key strands the cluster with no self-heal.
  Posture in one line: *control-api owns rotation for Secrets it owns and never
  touches a foreign Secret.*
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

**Adjacent — catalog, decide explicitly (likely follow-up):** these mention MCC or
managed-mode topology but are *not* the pull secret. The "repo should know nothing
about MCC" goal argues for scrubbing the literal word "MCC" (replace with "the
managed operator" / "managed mode"), but the *behavior* they branch on is legitimate
(control-api genuinely differs by `registryConnectionMode`):

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

**Generality note:** the auto-attach only fires for registry-built `McpServer`s,
which land in `mcp-server[-slug]`. A *non-transport* recipe workload pulling a
private evenfire image would resolve its imagePullSecrets to `sandbox-recipes[-slug]`
(`control-api/src/routes/admin/recipes.ts:66-80`) — not covered here. For now,
private-image plugins are transport workloads; broadening to `sandbox-recipes` is
future scope.

---

## 9. Rollout & migration

1. **Deploy the registry gate change (§6.2) first or together** — control-api's mint
   `403`s until the relaxed endpoint is live, so the `evenfire-registry` deploy must
   land before (or with) the control-api rollout. Both are part of this release.
2. **Ship control-api self-provisioning** gated on `self-hosted`, with the comment/doc
   scrub (§7.8). Managed clusters are inert (the managed operator keeps owning the
   Secret) — the mode gate guarantees no double-writer, so no cross-repo coordination
   with the managed operator is needed.
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
| R3 | Pull Secret in the wrong namespace → ref silently unresolved (`imagePullSecrets` are namespace-local). | Provision into `targetNs` (co-located with the McpServer + credentials Secret), not a fixed namespace; a namespace outside control-api's secrets-RBAC set fails the read `403` and aborts (§7.1/§8). |
| R4 | Self-hosted registry identity / org mapping not yet established (no claimed client, `orgName` null). | Gate on `isRegistryAuthActive()` **and** non-null `resolvePublishScope().orgName`; skip with a clear install-time error, never mint against `/org/null/…` (§7.1). Presupposes a working self-hosted connect flow. |
| R5 | Registry unreachable, or the §6.2 endpoint change not yet deployed → mint 403/error. | control-api→registry egress already covered in base; the registry change ships in the same release and must be live before control-api mints (§14 ordering); fail-loud install surfaces it (§7.1). |
| R6 | `targetNs` outside control-api's secrets RBAC (`{mcp-server, mcp-host, control-plane, sandbox-recipes, sandbox-ui}`) via a `body.namespace` override. | Default `targetNs` is `config.mcpServersNamespace` (`mcp-server`, covered + pre-created); a non-404 read error (e.g. `403`) aborts before minting (§7.1); operators exposing the override constrain it to the covered set (§8). |
| R7 | Shared pull Secret wrongly torn down by a per-plugin rollback. | `ensureRegistryPullSecret` sits outside the Step-4 `secretCreated`/`deleteSecret` rollback scope; a CRD-create failure never deletes the namespace-shared pull Secret (§7.3). |
| R8 | `.dockerconfigjson` keyed on the wrong host → present Secret still yields `ImagePullBackOff`. | Build the blob locally keyed on `registryHostFromUrl(config.registryUrl)` (= image host), not the registry's `registryTokenIssuer` (§7.9-2). |
| R9 | Credential-less private-image plugin (`credRequired=false`) gets no pull Secret. | Hook is outside the `if (credRequired)` block, gated only on `shouldAttachEvenfirePullSecret` (§7.9-1). |

---

## 11. Test plan

- **Unit** — `shouldAttachEvenfirePullSecret` unchanged; new
  `ensureRegistryPullSecret` state machine: absent→created; ours→reuse;
  foreign(unlabeled)→untouched; 409→success; gate off in managed/auth-off/empty-URL.
- **Secret shape** — asserts type `kubernetes.io/dockerconfigjson`, single
  `.dockerconfigjson` key, base64 not double-encoded, `managed-by=control-api` label,
  namespace = `config.mcpServersNamespace`.
- **Registry client** — machine `POST /org/:org/registry-pull-credential` mint returns
  a pull-only `key`; org resolved from `resolvePublishScope`; dockerconfigjson built
  locally, keyed on the `registryUrl` host.
- **Registry (Workstream A)** — an org-bound `manage-keys` machine mints its own org's
  pull key (`201`); a foreign org `403`s; `*`-admin still works.
- **Integration / e2e (minikube, self-hosted)** — install a private evenfire-hosted
  local plugin; assert the Secret is created and the plugin pod pulls (no
  `ImagePullBackOff`); re-install is idempotent; a pre-seeded foreign Secret is
  preserved.
- **Coexistence** — with a pre-existing unlabeled Secret, ensure returns
  `'exists-foreign'` and does not mint.
- **Existing tests to revise (not just add).** `control-api/test/routes.registryInstall.test.ts`
  asserts `createSecret` call counts that this change alters: `:864`
  `toHaveBeenCalledTimes(1)` (now 2 for an evenfire-hosted plugin), and `:1148`/`:1204`
  `not.toHaveBeenCalled()` (now called if the plugin is evenfire-hosted). These, and the
  `evenfire imagePullSecrets attach` describe block (`:1424`), must be updated to
  account for the pull-Secret create and to assert its shape/namespace.
- **Host-keying** — the minted Secret's `.auths` key equals the image host
  (`registryUrl` host), not `registryTokenIssuer`, verified against a config where the
  two differ (§7.9-2).
- **credRequired=false** — a private evenfire-hosted plugin with no credentials still
  gets the pull Secret (hook outside the `credRequired` block, §7.9-1).

---

## 12. Open questions / decisions for review

1. **MCC-word scrub breadth (§7.8)** — scrub only pull-secret comments, or all
   managed-mode "MCC" mentions? *(Recommendation: scrub wording, keep behavior.)*
2. **Trigger (§7.3)** — lazy-at-attach only, or add the boot reconcile? *(Recommendation: lazy; boot optional.)*
3. **Rotation policy (§7.6)** — reactive-only now, or add scheduled proactive rotation? *(Recommendation: reactive now, defer scheduled.)*
4. **HCC presence-validation (§7.7)** — in this release or a follow-up? *(Recommendation: follow-up.)*
5. **Managed-operator step retirement (§9.3)** — coordinate managed self-provisioning, or leave managed on the operator indefinitely behind the mode gate?

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

### Workstream A — registry pull-credential gate (`evenfire-registry`)

- **A1 — Relax the gate** (`src/routes/org.ts`). In `POST /:org/registry-pull-credential`,
  replace the `*`-admin gate (`:376`) with
  `authorizeMachineForOrg(auth, orgName, 'registry:manage-keys')` (§6.2) so an org-bound
  machine mints a pull-only key for its **own** org. `mintPullKey` (rotate-on-call,
  `kind:'pull'`) and `buildDockerconfigjson` unchanged — only the auth gate moves.
  *Accept:* an org-bound `manage-keys` machine gets `201`; a foreign org still `403`s;
  `*`-admin still works (managed operator unaffected); audit log preserved.

### Workstream B — control-api self-provisioner (`evenfire`)

Ordered so each task is independently reviewable; **B1–B3** are the functional core,
**B4–B7** are decoupling/quality.

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
