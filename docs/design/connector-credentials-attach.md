# Attach credentials to an existing keyless connector

Implementation plan and record — Control UI only. Status: implemented in
`fd9b29393`; live manual validation remains pending.
Branch: `feat/ux-improvements-32`. Source-review baseline: `6b68c521f`.

The attach component and shared rollout hook are implemented. The sections
below retain the reviewed design and acceptance criteria. Implementation
verification passed on Node 24: 267 focused tests, 2,832 tests across the full
Control UI suite, typechecking, production build, formatting, and style checks.
The backend conclusion is based on repository code and test coverage, not a
completed live runtime exercise. No backend or cluster changes were made.

## 1. Problem and goal

At the source-review baseline, the connector edit page had no attach action for a connector without
`spec.envSecret`: `UpdateConnectorCredentials` renders “there is nothing to
rotate here.” The Add connector flow can create a Secret and its reference,
and the API can update an existing connector, but the edit UI cannot connect
those operations. Deleting and recreating the connector is therefore a UI
workaround, not a backend requirement.

Let an operator attach a new or existing Secret, declare key → environment
variable mappings, save, and observe the rollout. After the spec is saved,
the connector must be recoverable through the normal set/rotate surface,
even if rollout verification fails or times out.

## 2. Backend conclusion and evidence

**No backend or CRD changes are required for this scope.** The existing
endpoints accept the reference, preserve Secret values on partial updates,
and reconcile it into a Deployment. The frontend must respect the concurrency,
cleanup, and readiness contracts that already exist.

Paths below are relative to the repository root; symbols are the primary
references because line numbers move.

| Need                            | Verified existing mechanism                                                                                                                                                                                       | Source                                                                                                                   |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Create credentials              | `POST /api/v1/admin/mcp-secrets`; returns UID/resourceVersion on success                                                                                                                                          | `control-api/src/routes/admin/secrets.ts:626`; `createMcpSecret` in `control-ui/lib/api.ts`                              |
| Update selected keys            | `PUT /api/v1/admin/mcp-secrets/:name`; server-side merge-patch preserves other keys and returns `affectedConnectors`                                                                                              | `control-api/src/routes/admin/secrets.ts:808`; `updateMcpSecret`                                                         |
| Select an existing Secret       | `GET /api/v1/admin/mcp-secrets` returns name, key names, and identity metadata, never values                                                                                                                      | `control-api/src/routes/admin/secrets.ts:589`; `listMcpSecrets`                                                          |
| Save `envSecret`                | McpServer PUT forwards the supplied spec through `validateMcpServerSpecPreflight` and `gateway.updateResource`                                                                                                    | `control-api/src/routes/admin/resources.ts:883`; `control-api/src/http/validateMcpServerSpec.ts`                         |
| Protect concurrent edits        | `ResourceService.updateResource` already accepts caller UID/resourceVersion, uses the reader's version, and surfaces conflicts without replaying the stale spec                                                   | `control-api/src/services/resourceService.ts:361`; `control-api/src/k8s.ts:258`                                          |
| Store the mapping               | CRD already declares `envSecret.name` and `keys[].{secretKey,envVar}`                                                                                                                                             | `charts/clerum-crds/crds/mcpserver.yaml:402`                                                                             |
| Validate references and restart | `validateSecret` checks existence/keys and hashes Secret data; `buildDeployment` injects `secretKeyRef` env entries and the credentials revision into the pod template; `performReconcile` applies the Deployment | `host-context-controller/src/reconciler.ts:845`, `:1337`, `:1448`, `:2440`                                               |
| Observe the saved spec          | HCC writes `observedGeneration` on conditions; CRD already preserves it                                                                                                                                           | `writeStatusCondition` in `host-context-controller/src/reconciler.ts:2272`; `charts/clerum-crds/crds/mcpserver.yaml:841` |
| Undo an unused create           | DELETE compares UID/resourceVersion and refuses in-use Secrets or unknown reference state                                                                                                                         | `control-api/src/routes/admin/secrets.ts:978`; `deleteMcpSecret`                                                         |
| Display usage                   | Secrets table derives connector usage from `spec.envSecret.name`                                                                                                                                                  | `control-ui/components/SecretsTable.tsx`                                                                                 |

The preflight validator also checks security, plain environment variables,
resources, image policy, and egress/DNS. It does **not** validate `envSecret`
shape or mappings. HCC checks Secret existence and keys, but its plain-env
sanitizer is not a general `envSecret.envVar` validator. Do not describe it as
such a backstop. Keep frontend mapping validation explicit.

The earlier claim that AlreadyExists always becomes a bare 500 is outdated:
`control-api/src/http/errorHandler.ts` forwards recognizable Kubernetes 4xx
statuses, including 409. A generic 500 is not proof of a name collision.

## 3. Surfaces and ownership

### 3.1 Edit-page gating

Keep `resolveCredentialSurface()` unchanged: it chooses set/rotate behavior
from observed Secret state. Attach is a structural action owned by the edit
page, not another resolver value.

Credentials-tab render order:

1. Non-canonical Secret name → existing error banner.
2. Recognized OAuth configuration → existing `OAuthImmutableFields`.
3. Usable `resolveEnvSecret(spec)` result → existing `UpdateConnectorCredentials`
   with its current surface, ownership, and registry props.
4. Any remaining raw `spec.envSecret` or unrecognized/malformed OAuth block →
   explanation requiring correction; do not silently overwrite it as “keyless.”
5. Recipe-owned (`spec.managed === false`) → explanation pointing to the recipe.
6. Disabled (`spec.enabled === false`) → explanation to enable the connector
   before attaching with this restart flow.
7. Otherwise → new `AttachConnectorCredentials`.

`resolveEnvSecret()` returns undefined for malformed references as well as
absent references. Use raw-spec presence checks to distinguish those states.
Recheck eligibility from a fresh server read before any submit writes.
`extractOAuthImmutables()` handles baked, generic, and remote OAuth; a null
result alone does not prove that an invalid OAuth block is absent.

Static remote connectors may use `envSecret` through existing
`remote.authHeaders[].valueTemplate` placeholders. Attaching does not create
header templates or change the upstream authentication method. Explain that
mapping limitation; verify the placeholder path in the manual matrix. Do not
promise that any arbitrary environment-variable name enables authentication.

### 3.2 Component and shared hook

Add `components/AttachConnectorCredentials/{index.tsx,types.ts}` rather than
adding another mode and row editor to `UpdateConnectorCredentials`.

Extract the existing poll effect into
`components/UpdateConnectorCredentials/useRolloutWait.ts`. Keep rotation's
observable behavior unchanged during extraction, including issue #223:

- A fresh `DeploymentReady=True` is required; a successful write is insufficient.
- `WaitingForReplicas` is transitional.
- Preserve `RolloutIncomplete` diagnostics and keep polling: HCC may recover
  after its 120s budget. Declare failure only at the UI's 180s boundary if
  that diagnostic remains unresolved; otherwise report an inconclusive timeout.
- Cancel timers and ignore late reads on unmount, reset, or a new attempt.

Use an explicit hook contract:
`useRolloutWait({ serverName, cutoff, expectedUid?, expectedGeneration? })`
returns `{ phase, phaseMessage, setPhase, setPhaseMessage }`. The hook owns
phase/message state initialized to `idle` / an empty message.
Callers set `saving`, then supply the cutoff/identity and set `rotating` after
their writes succeed. Keep request sequencing outside the hook.

Put reusable budgets/reasons in `app/constants/connectorCredentials.ts` per
Control UI rules. Re-export existing constants from
`UpdateConnectorCredentials/index.tsx` to preserve test imports. Keep exported
hook types in a sibling types file. Correct the existing `RotationPhase`
comment: a fresh False alone does not immediately mean `failed`.

After the pure extraction, add optional identity/generation correlation for
attach. It is a spec mutation, unlike rotation of Secret content alone:
require the expected server UID, the saved spec generation on the resource,
and a fresh condition with the matching `observedGeneration`. Capture the
cutoff immediately **before the spec PUT**, after the Secret step; retain the
existing clock-skew tolerance. Old-generation True conditions, including ones
inside the tolerance window, must never satisfy attach. Missing generation
metadata is inconclusive, not permission to fall back to timestamp-only
success. Abort verification if the connector is replaced or its spec changes
again; ask the operator to refresh.

Add optional `generation` to the frontend `Metadata` type and
`observedGeneration` to `McpServerCondition`; these fields already exist in
backend responses. Preserve timestamp-only behavior for existing rotation
callers that do not supply a generation target.

## 4. Form and validation

Use existing `Field`, `TextInput`, `SelectInput`, `Button`, `FormSection`,
confirmation, and toast primitives. Apply existing token/classes and associate
validation errors with the affected inputs. Disable submission during initial
reads, confirmation, saves, and active verification. Preserve cancellable
loading/error states and provide retry for failed Secret listing.

### 4.1 Create a new Secret (default)

- Secret name: lowercase alphanumeric/hyphen pattern and 253-character cap,
  matching the current MCP Secret endpoint. Trim the name consistently.
- Rows: Secret key, environment variable, password value; add/remove controls.
- Require at least one complete row and a nonempty value for every declared
  key. Preserve submitted credential bytes; do not trim stored values.
- Hoist the current `MCP_SECRET_NAME_PATTERN` from `app/secrets/new/page.tsx`
  into `app/constants/connectorCredentials.ts` and reuse it there and here.
  The connector create form does not currently import that constant; avoid
  claiming this is an existing shared validator.

### 4.2 Use an existing Secret

- Load names/key names with `listMcpSecrets`. Selecting a Secret pre-fills
  its key rows, with environment variable names suggested where valid and
  editable. Permit removing rows or adding keys.
- Blank value = preserve stored value; all blank = **no Secret write**.
- Require a value for a newly declared key absent from the selected Secret.
  Refresh the names/key list before submitting; if the Secret or a blank-valued
  key vanished, stop before the spec PUT. This is a precheck, not an atomic
  guarantee against a later deletion; HCC remains authoritative.
- Nonblank values go through `updateMcpSecret`; 404 means refresh/reselect,
  with no spec write and no automatic create.
- Before writing values, preview other connector references with
  `getMcpServers` and warn that they can restart too. Use the update response's
  `affectedConnectors` for the result notice. Failure of the preview uses a
  generic shared-Secret warning, not a claim that no other connector is affected.

For both modes, validate Secret keys against the endpoint's existing rules
(`control-api/src/services/secretKeys.ts`): `[-._a-zA-Z0-9]+`, maximum 253
characters, not `.` and not beginning with `..`. Require valid environment
variable identifiers (conservative `[A-Za-z_][A-Za-z0-9_]*`), reject duplicate
environment-variable destinations and conflicting values for the same key,
and reject collisions with existing plain env / configured env mappings.
Do not offer dangerous runtime-control names that plain-env editing already
blocks (see `validateMcpServerSpec.ts`).

Build credential and label maps with `Object.create(null)` / own-property
checks so `__proto__`, `constructor`, and `toString` remain safe keys.
Mode/Secret switches and successful Secret writes clear password drafts.
Never place credential values in logs, errors, URLs, or browser persistence.

Registry credential schemas are optional label/suggestion data. Fetch failure
or an empty key list must leave a usable manual form. Do not assume the
registry service guarantees schemas for keyless entries: control-api simply
proxies the request. Avoid overwriting user-edited rows when it resolves.

## 5. Submit, concurrency, and cleanup

### 5.1 Save sequence

1. Validate, confirm the exact target and shared-Secret effects, then read the
   current McpServer and recheck eligibility. Record its UID. No mount-time
   spec snapshot is used as the write source.
2. Complete the Secret operation:
   - Create-new: `createMcpSecret(name, data)`.
   - Existing, with filled values: `updateMcpSecret(name, filled)`.
   - Existing, all blank: skip the Secret write entirely.
3. Re-read the McpServer after the Secret step. Stop if UID, eligibility, or
   spec changed since step 1. Construct the next spec from this fresh read,
   preserving egress and every unrelated field. Require UID/resourceVersion.
4. Capture the cutoff, then call `updateMcpServer` with
   `{ metadata: { uid, resourceVersion }, spec: { ...latest.spec, envSecret: { name, keys } } }`.
   Extend only the frontend helper's payload type to accept those optional
   metadata fields. The backend already supports them. On conflict, refresh
   and report it; never replay the stale spec automatically. Status-only
   writes can cause a safe conflict; HCC also suppresses identical status
   writes, so “resourceVersion changes continuously” is not a reason to drop
   concurrency protection.
5. On confirmed save, clear drafts, retain the saved server UID/generation,
   and start the shared rollout wait with those targets. The spec is attached
   at this point, even while rollout verification remains pending.

**Collision handling:** do not automatically merge-patch after an arbitrary
failed POST. That converts “create new” into replacement of another Secret's
credentials, potentially restarting other connectors. On a recognizable
collision, refresh the list and offer an explicit switch to existing mode,
clear values, and require its confirmation. An ambiguous 500/network failure
is an unknown outcome; reconcile it before further writes. Existing set-mode
fallback is a precedent to understand, not a safe requirement to copy.

### 5.2 Cleanup contract

Only delete a Secret this attempt is proven to have created. After a definite
spec rejection, best-effort `deleteMcpSecret(name, { uid, resourceVersion })`
uses the exact create-response identity. Never delete an existing-mode Secret
and never restore previous credential values (they were never read).

POST can return 503 **after creating the Secret**. Reuse
`getMcpSecretRollbackRepairIdentity` for the exact permit-unavailable repair
response with complete identity, as the connector create form does. If the
response cannot prove identity, show its repair guidance and stop; do not
use a blind update or an unfenced delete. Legacy successful responses without
identity must fail closed for this new attach flow.

A spec PUT timeout/network error does not prove rejection. Read back the same
UID and compare the reference: if it matches the intended attach, treat the
spec as saved and continue verification; if the outcome remains ambiguous,
retain the Secret and report that refresh is required. Avoid immediate deletion
on an unknown write outcome. The backend's reference check also rejects in-use
Secrets, but cleanup must not depend on racing that check against an in-flight
spec write.

If fenced cleanup fails (identity changed, Secret is referenced, reference
lookup unavailable, or transport failure), show both the original failure and
the named Secret cleanup failure. Stop automatic retries. Do not advise deleting
an in-use Secret. A successful existing-Secret patch is not undone when the
later spec save fails; make that partial outcome explicit.

### 5.3 Handoff and recovery

Keep the attach panel mounted while verification runs. Add
`onSpecSaved(server)` so the page disables egress saves and knows attachment
was persisted without immediately unmounting the poll. Add `onFinished()` to
refresh the page after success or when the operator chooses to leave a failed,
timed-out, or cancelled verification. Use the same refresh for a committed
attach discovered by readback. A retry after a saved spec must resume status
checking or open set/rotate; it must not POST the Secret again.

The page needs an active-attach state that retains this panel ahead of the
normal `envSecret` render branch until verification finishes or the operator
leaves it. Updating the page's server snapshot in `onSpecSaved` must not
unmount the running hook. Clear that state when refreshing into set/rotate.

The page's current `load()` is local to an effect. Use a reload counter or a
cancellable refresh callback, preserving its unmount protection. Reloading
must not silently discard unsaved egress edits: block attach while those edits
are dirty, with guidance to save/discard them first, and block egress saves
throughout the attach attempt. Scope any refresh/dirty-state work to this page.

Keep `spec.envSecret` after a failed rollout; do not auto-detach or delete its
Secret. HCC's `SecretResolved` and `DeploymentReady` diagnose the persisted
state. Refresh then exposes normal set/rotate recovery.

## 6. Operator copy

- Title: `Attach credentials`
- Description: `Choose a Secret and map its keys to the connector's environment variables. Stored values are never shown.`
- Modes: `Create a new Secret` / `Use an existing Secret`
- Submit: `Attach and restart`; saving: `Attaching…`
- New-Secret confirmation: `Create Secret "{name}" and restart {server} with these credentials?`
- Existing-Secret confirmation: `Connect {server} to Secret "{name}" and restart it?` Append the shared-Secret warning if values will be written.
- Waiting: `Credentials attached. Waiting for {server} to become ready…`
- Success: `Credentials attached. {server} is ready.` Deployment readiness does
  not prove that an upstream service accepted the credential.
- Rollout failure: `Credentials were attached, but the connector did not become ready: {diagnostic}`
- Timeout: `Credentials were attached, but readiness could not be verified within 180 seconds. Refresh to check status or update credentials.`
- Spec failure after existing-Secret write: `Secret values were updated, but the connector could not be attached: {error}`

Use distinct copy for Secret failure, rejected spec save, unknown outcome, and
rollout failure. Do not suggest attaching again once the reference was saved.

## 7. Files to change

All paths below are relative to `control-ui/`.

| File                                                                      | Planned change                                                                                                  |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `app/constants/connectorCredentials.ts`                                   | Shared validation pattern and rollout budgets/reasons                                                           |
| `components/UpdateConnectorCredentials/useRolloutWait.ts` + sibling types | Extract polling, then add optional attach identity/generation checks                                            |
| `components/UpdateConnectorCredentials/index.tsx`, `types.ts`             | Consume hook, preserve existing behavior/constant imports, fix phase comment                                    |
| `components/AttachConnectorCredentials/index.tsx`, `types.ts`             | Form, submit/cleanup, persisted-state recovery, callbacks                                                       |
| `app/mcp-servers/[name]/edit/page.tsx`                                    | Gating, readback/refresh handoff, coordination with egress edits                                                |
| `lib/api.ts`                                                              | Optional UID/RV on `updateMcpServer` payload, generation/observedGeneration response types; no endpoint changes |
| `app/secrets/new/page.tsx`                                                | Import hoisted name pattern; preserve behavior                                                                  |
| Credential component/page test suites                                     | Acceptance cases below                                                                                          |

`SecretsTable.tsx`, backend services, CRDs, and manifests need no changes.

## 8. Acceptance tests

Keep the existing rotation suite green during extraction, then cover these
eight attach groups. Use actual API-helper mocks where appropriate; current
component/page suites use Toast/Confirm providers and fake timers, not a
mandatory QueryClient wrapper.

1. **Validation and gating:** name/key/env rules, zero/incomplete rows,
   duplicate destinations, env collisions, missing existing key without value;
   recipe, disabled, malformed-reference, and all OAuth exclusions. Invalid
   submissions make no writes. Include safe prototype-overlapping keys.
2. **Loading and switching:** names/keys only; list error/retry; key prefill;
   empty/failing schema; no late overwrite of edits; clear sensitive drafts.
3. **Create success and correlation:** reads → Secret POST → latest server
   read → fenced spec PUT → polls. Preserve full latest spec and assert values
   occur only in the Secret request. Reject stale/wrong-generation True even
   inside clock-skew slack; saved-generation fresh True succeeds once.
4. **Create collisions and partial creation:** 409 offers explicit existing
   mode without a PUT; 500/transport failure never blindly merge-patches;
   complete 503 repair identity permits fenced cleanup; incomplete repair
   metadata permits no delete. Missing successful-create identity fails closed.
5. **Spec errors and cleanup:** definite rejection attempts fenced delete only
   for a proven create; changed identity/in-use/unknown-reference failures
   retain the Secret and show both errors. Ambiguous PUT + matching readback
   continues verification; failed readback retains the Secret. No cleanup
   after confirmed spec save or a later rollout failure.
6. **Existing mode:** all blank means zero Secret writes; added missing key
   requires value; nonblank merges only supplied keys and warns about shared
   restarts; 404/key disappearance prevents spec write. A later spec rejection
   reports that the Secret patch already happened, with no delete/undo.
7. **Concurrency and handoff:** fresh spec preservation, UID replacement,
   rejected stale RV, missing identity, changed eligibility, unsaved egress
   protection, and one completion callback. Failed/timed-out saved attachment
   refreshes into set/rotate; retry never creates again.
8. **Rollout semantics:** stale/no condition never succeeds; transient read
   failures keep polling; RolloutIncomplete → later True succeeds;
   RolloutIncomplete at expiry preserves diagnosis; no diagnosis times out;
   reset/unmount/new attempt ignores late reads and clears timers. Rotation
   retains existing #223 assertions without attach generation targets.

Run the existing `components/__tests__/UpdateConnectorCredentials.test.tsx`,
`EditMcpServerPageCredentials.test.tsx`, `EditMcpServerPage.test.tsx`, and
resolver suites alongside the new attach suite. Update the real-page tests,
not only isolated component props.

Current package scripts provide `test` and `build`; there is no `lint` or
`typecheck` script. From `control-ui/`, use `npm test -- <focused files>`,
`npx tsc --noEmit`, then the normal `npm test` / `npm run build` checks required
for the implementation. The initial document review could not start focused
tests because its shell had no `node`/`npm` on PATH. The implementation later
used Node 24.13.0 and passed the checks recorded above; the final full-suite
command was `UV_USE_IO_URING=0 npm test -- --maxWorkers=4`. Live manual
validation remains pending.

## 9. Manual matrix and implementation order

Manual checks after implementation:

- Open an enabled, managed, keyless non-OAuth connector: attach is visible.
- Create a fresh Secret: confirm names both resources; observe rollout, then
  rotate form; Secrets tab reports the new connector reference.
- Attach a second connector using that Secret and blank values: no Secret
  write; usage shows both connectors.
- Write an existing Secret value: confirmation warns about all references;
  other consumers may restart; only this connector's readiness is verified.
- Collide with an existing name in create mode: no silent credential overwrite.
- Fail the spec save, lose a response, and fail cleanup: inspect each recovery
  message and verify unrelated references/values survive.
- Exercise a slow/failed rollout: the saved reference remains recoverable;
  refresh opens set/rotate and never repeats create.
- Check static remote placeholder behavior, all OAuth families, recipe-owned,
  disabled, malformed-reference, and unsaved-egress exclusions.

Implementation order:

1. Extract the rollout hook without changing rotation behavior; run its suite.
2. Add constants/types and attach-specific generation correlation tests.
3. Build modes, validation, eligibility, and shared-Secret confirmation.
4. Add ordered/fenced writes, partial-create cleanup, and ambiguous-outcome readback.
5. Wire page coordination, handoff, and persisted-state recovery.
6. Complete acceptance suites and frontend checks.
7. Validate against the verified branch-owned profile. Resolve it through
   `scripts/minikube-profiles/branch.mk`, preserve recorded ports, and follow
   repository ownership/health rules. If deploying only Control UI, use
   `MINIKUBE_PROFILE=<verified-profile> make minikube-deploy-service SVC=control-ui NS=control-plane DEPLOYMENT=control-ui`.
   Prove readiness and user-facing health with the owned context/ports; store
   private evidence under ignored `.local-notes/infra/runs/`. This is targeted
   validation, not full T2 certification. This document does not authorize a
   repeat of a completed certification.

## 10. Non-goals

- Secret-side attach shortcuts, detach, or editing mappings on an already
  credentialed connector.
- Repairing malformed references, enabling disabled connectors, or changing
  recipe/OAuth ownership or static remote header templates.
- Atomic transactions across Secret and McpServer writes; existing-Secret
  value changes may persist when attachment fails.
- Server-side `envSecret` validation or a backend logging/security migration.
  Such hardening is separate from the existing API support verified here.
- Proving that credentials authenticate to an upstream service from
  `DeploymentReady` alone.
