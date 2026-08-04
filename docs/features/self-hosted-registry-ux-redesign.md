# Self-hosted Registry UX Redesign — Implementation Map

> **Status:** Phase 1 planned in detail and ready to execute. Phases 2–5 mapped to
> files/functions here but not yet broken down into tickets.
>
> **Source design spec:** _Self-hosted Registry UX Redesign — Design Spec_ (7-page PDF).
> This document is the engineering change-map for that spec: every file and
> function that changes, grouped by the spec's five phases.
>
> **Scope boundary:** control-ui only. Confirmed **zero new backend endpoints**
> are required for phases 1–5 (see [Backend: no new endpoints](#backend-no-new-endpoints)).

---

## 0. Orientation — facts every phase depends on

### 0.1 Routing model (filesystem vs. public URL)

The App Router tree uses `app/registry/**` and `app/publisher/**`, but the
**public URLs are `/marketplace/*` and `/publisher/*`** via Next rewrites/redirects.

- `control-ui/next.config.js:34-36` — rewrites `/marketplace/connectors`, `/marketplace/plugins`, `/marketplace/:path*` → `/registry/:path*`. **So `app/registry/**` _is_ the Marketplace.**
- `control-ui/next.config.js:89-93` — permanent redirects `/registry` → `/marketplace/connectors`, `/registry/:path*` → `/marketplace/:path*`, `/marketplace` → `/marketplace/connectors`.
- `control-ui/app/constants/routes.ts:70-82` — `CONTROL_ROUTES.marketplace.*` (root, connectors, plugins, install, publish, keys, connect, entry, editEntry).
- `control-ui/app/constants/routes.ts:100-105` — `CONTROL_ROUTES.publisher.*` (root, entries, sharedWithMe, credentials) — **the routes folded away in Phase 2**.
- `control-ui/app/constants/routes.ts:89-99` — `CONTROL_ROUTES.plugins.*` — the "Plugins" sidebar item points here, **not** to the Marketplace.

### 0.2 Capability signals already in the browser

The redesign's core rule — _render controls from capability, not role guesses_
(§5.1) — is satisfiable with two calls that already exist and are already
fetched. **No new signal, no new endpoint.**

| Signal | Client fn (`lib/api.ts`) | Endpoint | Fields |
| --- | --- | --- | --- |
| Who am I / do I administer the catalog | `getPublishScope()` `:2835` | `GET /admin/registry/publish-scope` | `scope: string\|null`, `curator: boolean`, `orgName: string\|null`, `publisherUiEnabled?: boolean` (type `PublishScope` `:2826`) |
| Self-hosted vs managed / connection state / auth on | `getRegistryConnection()` `:3426` | `GET /admin/registry/connect` | `state`, `authEnabled`, `org`/`requestedOrgName`, `recoveryError?` (type `RegistryConnectionStatus` `:3417`); `not_self_hosted` (409) ⇒ managed |

Derived rules (enforced identically server-side, so a client guess only costs a typed 409/400):
- **Cross-org sharing available** ⇔ `authEnabled && !curator && orgName != null`. Server guards: `resolveSelfServiceOrg` (`control-api/src/routes/admin/registry.ts:2274`) → 400 `registry_self_service_unavailable`; grants 403 → client `unavailable` (`lib/hooks/useInboundGrants.ts`).
- **Key/publish management available** ⇔ same predicate; server guard `prepareKeysRequest` (`registry.ts:2165`) → 409 `no_org` / `registry_auth_disabled` / `registry_url_not_configured`.
- **Curator (administers shared catalog)** keeps existing catalog management controls — for a curator "the catalog _is_ the administration surface" (§5.4).

Existing consumers of these signals: `usePublishScope()` (`lib/hooks/usePublishScope.ts:18`) + gate `isPublisherEnabled(scope)` (`:50`); `Sidebar/index.tsx:17`, `PublisherView/index.tsx:20`, `PublishToRegistryForm.tsx:130`, `RegistryCatalog.tsx:86`, `RegistryApiKeysPanel.tsx:88`, `RegistryConnectPanel.tsx:55`.

### 0.3 The §5.1 rule to encode once

> **structurally absent** (a capability this deployment can never have) → state the fact once, **remove the control**.
> **transient** (a call that could succeed on retry) → keep the control, **offer Retry**.

Today these are collapsed — e.g. `RegistryApiKeysPanel` shows a `not-owner`/`auth-disabled`
banner where a Retry-style affordance sits next to a permission error that can
never change. **Recommended shared primitive:** a small `useRegistryCapability()`
hook (new, `control-ui/lib/hooks/useRegistryCapability.ts`) that composes
`getPublishScope()` + `getRegistryConnection()` into a typed capability object
(`{ canManageOrg, canShare, isCurator, isSelfHosted, authEnabled, orgName }`),
consumed everywhere a control is conditionally rendered. This is the backbone of
Phases 1 and 3.

### 0.4 Backend: no new endpoints

Verified against `control-api/src/routes/admin/registry.ts`,
`registryConnect.ts`, and the registry services. The two failure causes the spec
defers are genuinely undetectable client-side today and **stay deferred**:

1. **Missing publish/push permission** — no introspection endpoint; the registry's 403 only surfaces reactively (`handleKeysError` `registry.ts:2208`, `handleRegistryProxyError` `:2325`).
2. **Quota exceeded** — no per-org image quota field/endpoint exists anywhere.

Both get "one honest sentence" in the UI (§5.5), not proactive rendering.

**Disconnect endpoint disposition:** `DELETE /admin/registry/connect`
(`registryConnect.ts:715` → `deleteConnection()` `registryConnectionDb.ts:173`)
**stays** — it is intentionally reachable even without a configured registry URL
(`requireSelfHostedAdmin(..., { requireRegistryUrl: false })`) and is the only
self-service reset for a wedged connection. Phase 1 removes the **UI control**,
not the endpoint (§5.6).

---

## Phase 1 — Ownership moves; discovery stops offering failing actions; sharing stated; Disconnect removed

**Delivers (from spec §7):** ownership actions move off discovery surfaces into
the Publisher; discovery surfaces stop offering actions that fail; sharing limits
are _stated_ not _offered_; Disconnect is removed. **No route moves yet** (that's
Phase 2), so this phase is purely control-visibility + copy.

### 1.1 Remove management actions from the catalog (discovery surface)

File: `control-ui/components/RegistryCatalog.tsx`

| Location | Current | Change |
| --- | --- | --- |
| `:459-486` per-row `RowActionsMenu` (Edit → `editEntry`, **Remove from Marketplace** danger) | offered on every row | Remove Edit/Remove from the catalog rows. Owned entries get a non-actioning **"You own this"** badge that links to the ownership area (Publisher today; org tab in Phase 2). Keep Edit/Remove _only_ when `isCurator` (curator administers the catalog, §5.4). |
| `:38-46 REGISTRY_COLUMNS` `actions` column | edit/remove column | Drop the management `actions` column for non-curators; badge lives in the name cell. |
| `:119-138 handleConfirmRemove` + `:544-589` remove-confirm modal | delete from catalog | Move to ownership area (`OwnedEntries`), remove from catalog for non-curators. |
| `:264-274` header "Manage API keys" (`RowActionsMenu` → `marketplace.keys`) | always shown | Gate behind `canManageOrg`; otherwise omit (structurally absent). |
| `:316-325` "+ Publish to Marketplace" | always shown | Gate behind `canManageOrg`. |
| `:306-315` "Connect" toolbar button + `:211` connect banner (`:86 loadConnectionMode`) | shown unless `managed` | Keep for now (claim-at-first-use is Phase 3); ensure it's hidden when `authEnabled` (already connected) so it can't present a no-op. |

Detail page mirrors the same removal:
- `control-ui/app/registry/entries/[name]/[version]/page.tsx:28 RegistryEntryActionsMenu` (Edit/Remove/Source repo) and `:206 handleRemove` → gate Edit/Remove behind ownership/curator; keep the source-repo link and install button (`:259-267`).

### 1.2 State sharing limits instead of offering them (§5.4)

Cross-org sharing is impossible for a self-hosted org. Where the UI currently
_offers_ a share control that will 403:

- `control-ui/components/PublisherView/OwnedEntries.tsx:94-104` — "Share access" button on private entries → `GrantAccessModal`. **Change:** when `!canShare` (self-hosted / no grant capability), replace the button with a one-line stated fact ("Cross-org sharing isn't available on this deployment"), per §5.1 _structurally absent_. Keep the button only when `canShare`.
- `control-ui/components/PublisherView/index.tsx:51-54` already hides the "Shared with me" tab when inbound grants are `unavailable` — keep; this is the correct pattern to generalize.

### 1.3 Remove the Disconnect control (§5.6)

File: `control-ui/components/RegistryConnectPanel.tsx`

- **Remove:** `:281 handleDisconnect` and the Disconnect button `:305-314` in the `connected` view (its confirm dialog wrongly implied reversibility).
- **Keep:** the broken-connection recovery paths that also call `disconnectRegistryConnection()` — `:240 handleStartOver` (from `rejected`) and `:259 handleStartOverFromConnecting` (confirm-gated, from `connecting`). Per spec: _"Recovery paths survive only where the connection is already broken and there is nothing left to preserve."_
- `control-ui/lib/api.ts:3451 disconnectRegistryConnection()` — **keep** (still used by the two recovery paths; backend endpoint unchanged).
- Copy: the `connected` view should state the claim is permanent (no undo button).

### 1.4 Encode the capability rule once (§5.1)

- **New:** `control-ui/lib/hooks/useRegistryCapability.ts` (see §0.3).
- **Refactor consumers** to distinguish structurally-absent (remove control + state fact) from transient (keep control + Retry):
  - `control-ui/components/RegistryApiKeysPanel.tsx:23-30` view states — `not-owner`/`no-org`/`auth-disabled`/`url-not-configured` are structurally absent → no Retry; only `error` (transient) keeps Retry (`:146-153`).
  - `control-ui/components/PublisherView/DockerCredentials.tsx:24-31` — same treatment.
  - `control-ui/components/PublisherView/RetryBanner.tsx` — reserve strictly for transient failures.

### 1.5 Phase 1 file summary

| Action | Files |
| --- | --- |
| **Modify** | `components/RegistryCatalog.tsx`, `app/registry/entries/[name]/[version]/page.tsx`, `components/PublisherView/OwnedEntries.tsx`, `components/PublisherView/index.tsx`, `components/RegistryConnectPanel.tsx`, `components/RegistryApiKeysPanel.tsx`, `components/PublisherView/DockerCredentials.tsx`, `components/PublisherView/RetryBanner.tsx` |
| **Create** | `lib/hooks/useRegistryCapability.ts` (+ test) |
| **Delete** | none (controls hidden, not files removed) |
| **Untouched** | all install-flow files (§Phase 3 note), backend |

---

## Phase 2 — Org-named tab, folded Publisher, route redirects, docs

**Delivers:** fold the standalone Publisher console into the Marketplace as a
**third tab labelled with the org name** (`@acme`; reads `Your org` before a claim,
pressing it starts the claim — Phase 3). Add route redirects and update operator
docs. **Named cost (spec §7):** moving these surfaces changes published URLs;
redirects keep old paths working and operator guides that reference them must be
updated in the same change.

### 2.1 Add the tabs to the Marketplace

Target IA (spec §4): `Marketplace › Connectors | @acme`, where the org tab holds
plugins, images, mcp servers, credentials, connection.

- `control-ui/components/RegistryCatalog.tsx:48-54` — today derives `connectors|plugins` tabs from pathname. **Add** a third destination `@<orgName>` (label from `getPublishScope().orgName`, or `Your org` when null). New route segment `app/registry/org/**` (public `/marketplace/<org>` or `/marketplace/org`).
- **New:** `control-ui/app/registry/org/page.tsx` (org area shell) rendering the folded Publisher content (below).

### 2.2 Fold the Publisher console into the org tab

Relocate — not rewrite — `components/PublisherView/**` under the org tab.

| Folded from | Into |
| --- | --- |
| `app/publisher/page.tsx` (redirect `/publisher` → `/publisher/entries`) | redirect → `/marketplace/<org>` |
| `app/publisher/entries/page.tsx` (`PublisherView activeTab="entries"`) | org tab › **Plugins/Entries** sub-view |
| `app/publisher/shared-with-me/page.tsx` (`activeTab="shared"`) | org tab › **Shared with me** (hidden when `!canShare`) |
| `app/publisher/credentials/page.tsx` (`activeTab="credentials"` → `DockerCredentialsPanel`) | org tab › **Credentials** (unified in Phase 5) |
| `app/publisher/api-keys/page.tsx` — **already redirects to `marketplace.keys`** | precedent for the fold; keep redirect |
| `components/PublisherView/index.tsx:60` header `Publisher — ${orgScope}` | reframed as the org tab header (`@org`) |
| `components/Sidebar/constants.tsx:96` `publisher` nav item + `Sidebar/index.tsx:17-25` gating | **remove** the standalone Publisher sidebar entry |

Components carried over as-is (behavior unchanged, parent changes): `OwnedEntries.tsx`, `GrantedToMe.tsx`, `DockerCredentials.tsx`, `DockerCredentialModal.tsx`, `GrantAccessModal/**`, `RetryBanner.tsx`, `dockerCredential.ts`, `types.ts`.

### 2.3 Sidebar relabel

- `control-ui/components/Sidebar/constants.tsx:91-95` — `workflow-recipes` item `label: 'Plugins'` → **`Installed plugins`** (spec §4: three plugin-shaped concepts each need their own verb — running here, browsable in catalog, authored by you).
- `control-ui/components/Sidebar/constants.tsx:86-90` — Marketplace item stays; it now owns the org tab.

### 2.4 Routes + redirects + docs

- `control-ui/app/constants/routes.ts:100-105` — repoint/retire `CONTROL_ROUTES.publisher.*`; add `CONTROL_ROUTES.marketplace.org`.
- `control-ui/next.config.js` — add **permanent redirects** `/publisher`, `/publisher/entries`, `/publisher/shared-with-me`, `/publisher/credentials` → the new `/marketplace/<org>` sub-views (mirror the existing `:89-93` pattern).
- **Docs to update in the same change** (operator guides referencing `/publisher/*`): grep `docs/**` and `control-ui/README.md:32,47` (Publisher/RegistryCatalog descriptions), `control-ui/README.md:31` sidebar table.

### 2.5 Phase 2 file summary

| Action | Files |
| --- | --- |
| **Create** | `app/registry/org/page.tsx` (+ any `org/[tab]` segments) |
| **Modify** | `components/RegistryCatalog.tsx`, `components/PublisherView/index.tsx`, `components/Sidebar/constants.tsx`, `components/Sidebar/index.tsx`, `app/constants/routes.ts`, `next.config.js`, `control-ui/README.md`, `docs/**` operator guides |
| **Convert to redirect** | `app/publisher/page.tsx`, `app/publisher/entries/page.tsx`, `app/publisher/shared-with-me/page.tsx`, `app/publisher/credentials/page.tsx` (keep `api-keys` redirect) |
| **Delete** | standalone Publisher sidebar entry (`Sidebar/constants.tsx:96`) |

---

## Phase 3 — Claim-at-first-use component replacing the connect flow

**Delivers:** a single reusable claim component that swaps into whichever surface
needs identity and hands control back when done. **Never a destination** — no setup
page to find, no ceremony to finish before working (§5.2).

### 3.1 Build the reusable claim component

- **New:** `control-ui/components/RegistryClaimInline/index.tsx` — one field (org name) + submit; on success returns control to the caller. Reuses the existing request/claim/recover machinery but **not** as a page.
- Org name stays a human decision (permanent publish scope + image-path namespace — a generated name would hand someone a public identity they never chose, §5.2).
- Approval wording is **server-driven** (§5.3): render success vs. "an operator must approve" _only_ from the returned `state`, never a hardcoded promise. Source states from `getRegistryConnection()` / `requestRegistryConnection()` responses (`state ∈ pending|connecting|approved|rejected|connected`).

### 3.2 Rewire surfaces to claim inline

Replace "go to the connect page" affordances with an inline claim that triggers
the first time identity is needed (install-private / publish / open org tab):

- `control-ui/components/RegistryCatalog.tsx:306-315` Connect button + `:211` banner → inline claim trigger (`Your org` tab press, spec §4).
- `control-ui/components/RegistryApiKeysPanel.tsx:162-177` "Connect" link (self-hosted `auth-disabled`) → inline claim.
- Org tab `Your org` label (Phase 2) → pressing starts the claim.

### 3.3 Retire the connect page (keep the API)

- `control-ui/app/registry/connect/page.tsx` + `components/RegistryConnectPanel.tsx` — demote from a destination. Keep the request/claim/recover **logic** (extract into the inline component or a shared hook); keep broken-state recovery reachable.
- `control-ui/lib/api.ts:3426-3460` — `getRegistryConnection` / `requestRegistryConnection` / `submitRegistryClaim` / `recoverRegistryConnection` / `disconnectRegistryConnection` all **stay** (now called by the inline component).
- `next.config.js` — redirect `/marketplace/connect` appropriately (into the org tab).

### 3.4 Phase 3 file summary

| Action | Files |
| --- | --- |
| **Create** | `components/RegistryClaimInline/index.tsx` (+ types, test); optionally `lib/hooks/useRegistryClaim.ts` |
| **Modify** | `components/RegistryCatalog.tsx`, `components/RegistryApiKeysPanel.tsx`, the org-tab shell, `next.config.js` |
| **Demote/retire** | `app/registry/connect/page.tsx`, `components/RegistryConnectPanel.tsx` (logic extracted, not deleted wholesale) |
| **Untouched** | connect/claim/recover API fns and all backend routes |

---

## Phase 4 — Images area + generated push commands

**Delivers:** an images area under the org tab that **generates** `docker login` /
`tag` / `push` commands from the entry name + org scope, so the user never composes
a registry path by hand and malformed-path failures become unreachable (§5.5).

**New-build**, but reuse the existing docker builders and reveal modal.

### 4.1 Reuse / extend the existing builders

File: `control-ui/components/PublisherView/dockerCredential.ts` (already present)

- Existing: `DEFAULT_REGISTRY_HOST = 'registry.evenfire.ai'` (`:3`), `buildDockerLoginCommand` (`:5`), `dockerNamespace` (`:15`), `buildPushCoordinate` (`:19`, returns `registry/namespace/<name>:<tag>` template), `deriveDockerconfigjson` (`:23`), `resolveDockerCredential` (`:44`).
- **Add:** `buildDockerTagCommand(localRef, registry, orgScope, name, tag)` and `buildDockerPushCommand(registry, orgScope, name, tag)` — filling `<name>`/`<tag>` from the **entry**, not free text.
- Reuse `components/PublisherView/DockerCredentialModal.tsx` as the reveal/copy presentation pattern (it already renders `docker login` + downloadable `dockerconfigjson` + push coordinate).

### 4.2 Build the images area

- **New:** `control-ui/app/registry/org/images/page.tsx` (or an org-tab sub-view) + `components/RegistryImages/**` — lists the org's image-backed entries and, per entry, shows copy-ready `login`/`tag`/`push` commands generated from `entry.name` + `getPublishScope().scope`.
- Source data from existing catalog/owned-entries: `getOwnedRegistryEntries()` (`lib/api.ts:2917`), `RegistryEntry` image ref fields; push creds from `createRegistryApiKey` (`:3366`, `CreatedRegistryApiKey.dockerconfigjson`/`registry` `:3304-3305`).
- **Two undetectable failures** (missing publish permission, quota exceeded) get **one honest sentence each** — no proactive gating (§0.4, §5.5).

### 4.3 Reconcile host/namespace strings (cleanup)

Flagged inconsistency to resolve while building: builder host is
`registry.evenfire.ai` (`dockerCredential.ts:3`) but publish placeholders still show
`us-central1-docker.pkg.dev/...` (`PublishToRegistryForm.tsx:410-421`,
`CreateMcpServerForm/index.tsx:402`) and org naming mixes `@clerum`/`clerum`. Pick
one source of truth (prefer the server-provided `created.registry`).

### 4.4 Phase 4 file summary

| Action | Files |
| --- | --- |
| **Create** | `app/registry/org/images/page.tsx`, `components/RegistryImages/**` (+ tests) |
| **Modify/extend** | `components/PublisherView/dockerCredential.ts` (add tag/push builders), reuse `DockerCredentialModal.tsx` |
| **Cleanup** | reconcile registry host strings in `PublishToRegistryForm.tsx`, `CreateMcpServerForm/index.tsx` |
| **No new** | backend endpoints (quota/push introspection stay deferred) |

---

## Phase 5 — Credentials unified into one list

**Delivers:** the org tab's registry API keys and docker push credentials become
**one credentials list** (§4 IA: `credentials — one key list for CI and docker push`).

Today there are two surfaces over the **same** `efrk_` keys:
- `control-ui/components/RegistryApiKeysPanel.tsx` (`/marketplace/keys`) — CI/publish keys.
- `control-ui/components/PublisherView/DockerCredentials.tsx` — docker push credentials.

Both call the identical API (`listRegistryApiKeys`/`createRegistryApiKey`/`revokeRegistryApiKey`, `lib/api.ts:3360-3376`); a created key carries docker push fields iff it has `registry:publish` (`CreatedRegistryApiKey.dockerconfigjson` `:3304`).

### 5.1 Merge into one panel

- **New/merged:** `control-ui/components/RegistryCredentials/**` — one table of keys; each row shows its scopes and, when `registry:publish` is present, the docker-push affordance (reveal via `DockerCredentialModal` pattern, commands via `dockerCredential.ts`).
- **Retire/absorb:** `RegistryApiKeysPanel.tsx`, `DockerCredentials.tsx`, `DockerCredentialModal.tsx`, `RevealApiKeyModal.tsx`, `CreateApiKeyModal.tsx` — consolidate create/reveal/revoke into the unified panel.
- Live under the org tab's **Credentials** sub-view (Phase 2 slot).
- `next.config.js` — redirect `/marketplace/keys` into the unified credentials view.

### 5.2 Phase 5 file summary

| Action | Files |
| --- | --- |
| **Create** | `components/RegistryCredentials/**` (+ tests) |
| **Absorb/retire** | `components/RegistryApiKeysPanel.tsx`, `components/CreateApiKeyModal.tsx`, `components/RevealApiKeyModal.tsx`, `components/PublisherView/DockerCredentials.tsx`, `components/PublisherView/DockerCredentialModal.tsx` |
| **Reuse** | `dockerCredential.ts`, `lib/api.ts` key fns (unchanged) |
| **Modify** | org-tab shell, `next.config.js` |

---

## Explicitly out of scope / untouched

- **Plugin install wizard** — `app/registry/install/page.tsx` (incl. `RegistryRecipeInstallPreview` `:116`, `RegistryInstallPageContent` `:392`, `RegistryInstallPage` `:477`), `app/registry/install/loading.tsx`, `components/RegistryInstallForm/**`, `components/registryInstallHelpers.ts`, and install API fns (`installFromRegistry`, `installRecipeFromRegistry`, `getRegistryCredentialSchema`). Spec §6: "its own piece of work, deliberately untouched."
- **Live quota / permission introspection** — needs registry-side endpoints that don't exist (§0.4).
- **All backend routes/services** — no changes required.

### Incidental cleanup (optional, any phase)

- `control-ui/components/RegistryInstallModal.tsx:22 RegistryInstallModal` — dead code (no non-test imports); the live install path is `RegistryInstallForm` + `RegistryRecipeInstallPreview`. Safe to delete.

---

## Decisions carried from the design spec (§6)

| Decision | Rationale | Phase |
| --- | --- | --- |
| Fold Publisher into a Marketplace tab labelled with the org name | one destination for the catalog; ownership + identity stop being separate | 2 |
| Claim identity inline at first use, one reusable component | removes the setup gate; built once, not per-flow | 3 |
| Disconnect removed entirely | irreversible, no benefit, its confirmation was wrong | 1 |
| Approval wording driven by server state | correct across registry configs without knowing any | 3 |
| Publishing-UI toggle narrows to publishing actions only | turning publishing off must not remove push creds or connection status | 1–2 |
| Image visibility & cross-org sharing stated, not offered | neither possible for a self-hosted org | 1 (sharing), 4 (image visibility) |
| Live quota & permission introspection deferred | needs registry-side endpoints that don't exist | — |
| Plugin install wizard unchanged | its own work | — |

---

## Open items before coding

1. **HTML scaffolds not yet obtained.** The spec references two static scaffolds
   (`marketplace-catalog-scaffold.html`, `claim-and-images-scaffold.html`) as
   `attachment:` links; they were not in the PDF and aren't on disk. They pin down
   the exact layout/copy for the catalog tabs (Phase 2), the claim step (Phase 3),
   and the images area (Phase 4). **Needed before finalizing those phases' UI.**
2. **Org-tab URL shape** — decide `/marketplace/<org>` vs. a fixed `/marketplace/org`
   segment (affects redirect table and how `orgName` maps to a route).
3. **Curator experience** — confirm curators keep full catalog management (§5.4);
   the capability hook must branch on `isCurator`.
