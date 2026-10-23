# Desktop compatibility updates: gaps and roadmap

Status: proposed roadmap incorporating owner-confirmed scope and update flows;
no implementation authorized or performed.
Discovery date: October 23, 2026, America/Guatemala.
Audience: Desktop, API, release engineering, support, and QA.

The [specification](desktop-backend-compatible-updates-spec.md) contains the
pinned latest-`dev` evidence, complete `main` release/date inventory, proposed
contract, and acceptance conditions. It also records the inspected optional
member-registration/Profile UI invitation handoff. This document maps that
evidence to work; invitation/landing changes are a separate post-release track.
Checkboxes describe future completion; none is completed by documentation alone.

## 1. Gap inventory

| Gap | Existing foundation | Missing work | Milestone / acceptance |
| --- | --- | --- | --- |
| G-01: backend authority | Deployment-local authenticated `/desktop/release` with target/minimum. | Pre-auth recovery, bounded support declaration, policy identity/revision, validated typed schema, and advisory compatibility notifications without access gates. | M1; AC-01–06, AC-18 |
| G-02: target selection | Desktop already receives an exact `v<desktopVersion>` link. | Many-to-many compatibility, newest certified target, offered downgrade on mismatch, full SemVer/channels, and revocation. | M1/M3; AC-02–06, AC-17 |
| G-03: automatic checks | Best-effort check after authenticated session loading. | Fresh verification on every startup, compatible-build continuity, dismissible mismatch/failure alerts, retry, and user-accepted immediate update/restart. | M3/M4; AC-01, AC-04–05, AC-13, AC-18 |
| G-04: platform downloads | Landing matches six OS/architecture ZIP names and builds direct links. | Exact-policy release lookup; native architecture/install-format selection; remove global-latest and user-agent-guess fallbacks from the Desktop path. | M0/M2/M3; AC-09 |
| G-05: update mechanism | Forge ZIP/DMG/Squirrel/DEB/RPM makers; optional macOS signing. | Chosen and proven updater adapters; progress; authenticated staging; install/restart; Linux mechanism; verified downgrade support. | M0/M2/M3; AC-08–13, AC-20 |
| G-06: user controls | Required-update browser-link dialog and Settings diagnostics. | Native menu/Settings checking and download, dismissible alerts/progress, user-accepted immediate startup install/restart, and manual restart-now/later with continued usage even on mismatch. | M4; AC-07–10, AC-12, AC-18 |
| G-07: publication | Release-preparation/version validators; six ZIPs visible on recent releases. | Reproducible owned packaging/signing/publishing pipeline, updater-native assets, embedded-version checks, complete catalog, atomic eligibility and historical retention. | M2; AC-11, AC-16–17 |
| G-08: environment isolation | Existing saved REST endpoints, auth ownership, and environment switching. | Update work bound to environment generation/policy/target; stale-result cancellation; no wrong-environment staged install. | M3/M4; AC-11, AC-14 |
| G-09: downgrade safety | Existing paged-chat legacy snapshots and reconciliation; unknown-index protection. | Whole-store and installer pair matrix; pending-work handling; tested safe rollback and post-restart validation. | M0/M3/M5; AC-05, AC-12–15 |
| G-10: recent baseline | Owner confirms only builds from the last 30 days are in use; published in-window releases are `v0.10.0`/`v0.11.0`, with corrected tags. | Validate recent packages directly and document first updater installation; explicitly exclude legacy adapters/projections/backports in docs and implementation PRs. | M0/M5; AC-18–19 |
| G-11: validation evidence | Existing route/status/UI/chat tests; manifest validation passed in discovery. | Native signed upgrade/downgrade journeys and fault cases across all six combinations; compatibility evidence for each supported backend family. | M5; AC-01–20 |
| G-12: invitation download | Member-registration emails link Profile UI; its download button opens GitHub. Landing's download branch has no version selection and is not deployed, per owner. | Explicit-version first-party links across optional invitation service, Profile UI, and landing; exact-version OS/architecture resolution and safe fallback UX. | Post-release P0 only; PW-01–05 |

## 2. Confirmed decisions and engineering choices

| Decision | Evidence / rule | Status / remaining work |
| --- | --- | --- |
| D-01: legacy exclusion | Owner confirms no in-use builds older than 30 days. No special compatibility code for excluded legacy releases, including broken tags. | Confirmed. State this exclusion in docs and future implementation PRs; do not reopen an old-deployment inventory as a prerequisite. |
| D-02: recent baseline | As of October 23, the window starts September 23. Published releases in it are `v0.10.0` and `v0.11.0`; both already have corrected tags. | Validate actual recent binaries/contracts directly. No v1 projection is required just to preserve out-of-scope clients. The window is an initial baseline, not a rolling future expiry rule. |
| D-03: first updater-capable release | Current binaries cannot remotely gain installer code. Provide the ordinary one-time installation of the new updater-enabled build. | Assign its version/distribution path in M0; no old-backend backport or historical maintenance release is requested. |
| D-04: package/updater strategy | Forge configuration and six outer ZIPs do not prove unattended replacement, progress, or downgrade. Native Electron alone does not cover Linux. | M0 platform feasibility evidence and an architecture decision; do not select a library solely from its API name. |
| D-05: supported install modes | Per-user vs system install, Linux package-manager vs managed bundle, read-only apps, and architecture migration affect permissions/replacement. | M0 engineering choice within the required three OS families and six architecture combinations; document first-install handling. |
| D-06: compatibility representation | A backend may support multiple builds, and a build may support multiple backends. Start with explicit supported sets and the newest certified target. | Many-to-many requirement confirmed; finalize schema, revocation, distribution, and cache consistency in M1. |
| D-07: check/restart timing | Compatible startup builds do not update automatically. A mismatch alert offers an immediate update/restart action and can be ignored. Manual checking downloads the newest compatible build and offers restart now/later. | Confirmed; Q-01–03 are answered. No extra periodic refresh is required and deferred restart never restricts usage. |
| D-08: publisher trust | Existing binaries' signatures and embedded versions were not inspected; current Windows config has no signing. | Identify actual packaging owner, signing identities/credential storage, asset format, and trust verification rules. |
| D-09: legacy local data | Pre-paging snapshots/reconciliation first shipped in `v0.6.0` and remain in current code. Their scope is narrower than whole-app compatibility. | Retain them; test supported source/target pairs. Any removal requires a separately scoped data-compatibility decision. |
| D-10: invitation work | Optional closed-source service is used in prod/dev. Its invitation flow, Profile UI download action, and undeployed landing change need an explicit-version contract. | Confirmed post-release scope; PW-01–05 do not delay the updater release. Updater-capable downloads warn on incompatibility at startup and offer correction; users can ignore the warning. |
| D-11: continued usage | Always attempt fresh startup verification. Failure, pending status, mismatch, ignored alerts, cancelled downloads, and deferred restart must not disable app/backend actions. | Confirmed owner decision. Report failures honestly and recheck on retry/relaunch; no cached-success bypass or compatibility-based usage gate. Installation integrity and existing authorization remain enforced. |

The investigation did not establish a functional "release X became incompatible
on date Y" boundary. The current floor rejects versions below `0.1.252`, yet
every published release's source Desktop version meets it. Early release labels
do not equal their embedded source version: `v0.4.0` has `0.1.299`, and `v0.5.0`
has `0.1.316`. Verify actual archives before relying on a tag for migration
eligibility. Owner-supplied usage now settles the legacy exclusion; the historic
floor still cannot certify recent product compatibility by itself. All three
product questions are answered in [specification section 11](desktop-backend-compatible-updates-spec.md#11-confirmed-product-decisions).

## 3. Ordered implementation milestones

### M0 — Establish support and platform feasibility

Suggested owners: Desktop/release engineering with support and product.

- [ ] Apply the confirmed recent-build baseline and legacy exclusion from D-01–03.
  Apply confirmed Q-01–03/D-07/D-11 and record engineering choices D-04–06/D-08–09
  without adding out-of-scope compatibility work. Name supported backend families
  and install formats; no further product decision is pending.
- [ ] Inspect the actual recent release artifacts: archive contents, embedded
  Desktop version, executable/publisher identity, signatures, and install mode.
- [ ] In an explicitly authorized future implementation spike, prove user-gated
  download, real progress, upgrade, older-version installation, and relaunch
  for each selected macOS, Windows, and Linux adapter on x64/arm64.
- [ ] Prove Linux permission/package ownership behavior and Windows downgrade
  behavior; evaluate whether Forge can remain the packager or needs an adapter/
  packaging change. Test ARM64 and emulated installations explicitly.
- [ ] Inventory persisted stores and define permitted schema/version transitions.
  Preserve existing chat downgrade safeguards and plan interrupted-update recovery.
- [ ] Record the chosen mechanism, tradeoffs, signing requirements, target artifact
  formats, first updater installation, and supported source/target pairs.

Exit: a feasible architecture within the confirmed scope. A failed platform
spike blocks an "all platforms complete" claim; it does not silently remove
Linux, downgrade, or ARM64 from scope. No implementation spike was run here.

### M1 — Define and implement the compatibility policy

Depends on M0. Suggested owners: External REST API and release engineering.

- [ ] Define the versioned schema and pre-auth non-secret discovery endpoint;
  update current supported consumers directly. Do not add a legacy route
  projection, broken-tag adapter, or old-backend backport outside the baseline.
- [ ] Model supported versions, newest certified target, platform catalog,
  deployment/revision/expiry identity, channels, retirement, and revocation;
  allow several Desktop versions per backend and a build shared across backends.
- [ ] Validate target membership, full SemVer, immutable release identity, supported
  installation format, and invalid/empty/unknown policy states.
- [ ] Bind policy revisions to deployment promotion and replica/cache consistency;
  define promotion of a newly certified compatible Desktop release independently
  of an unrelated global release. Keep service counters separate.
- [ ] Test recent/new supported clients, pre-auth failures, many-to-many support
  across two backend deployments, policy changes, target gaps, channels, and
  missing artifacts. Older historical clients are not an acceptance requirement.

Exit: reviewed contract and passing API/catalog integration evidence for
AC-01–06, AC-16–18. Supported clients can identify a valid target without first
completing an incompatible login. M2 can build against the reviewed contract
while M1 implementation finishes.

### M2 — Publish trustworthy updater assets

Depends on M0 and the M1 contract. Suggested owners: release engineering.

- [ ] Establish ownership of the currently external/manual Desktop artifact
  production process; add reproducible packaging/signing publication to the
  appropriate release workflow.
- [ ] Extend the shared release writer and validators for the selected native
  update formats and signed catalog. Preserve the explicit mandatory-floor
  decision and ordinary service-counter behavior.
- [ ] Build all six OS/architecture combinations with the repository's required
  Node 24 toolchain and verified Electron runtime. Verify embedded versions,
  signing identity, digest/size, installation format, and release tag.
- [ ] Publish and verify updater-native assets/feed metadata before activating a
  target; fail on partial uploads, inaccessible assets, missing combinations,
  invalid signatures, and unsupported prereleases.
- [ ] Retain historical compatible releases and test policy rollback/revocation.
  GitHub or a first-party proxy can serve bytes, but must preserve the selected
  immutable artifact and trust checks.

Exit: a real complete candidate release usable by the selected updaters, plus
failed-publication and target-promotion tests for AC-09, AC-11, AC-16–17.
The existing six release ZIP names alone do not satisfy this milestone.

### M3 — Implement the main-process update service

Depends on M1 and test assets from M2. Suggested owner: Desktop main/preload.

- [ ] Implement one state machine for startup validation, manual check/download,
  mismatch/failure warning, user-accepted immediate startup install/restart,
  manual deferred restart, offered upgrade/downgrade, download, verification,
  ready, install, and recovery. Separate metadata from application-byte transfer.
- [ ] Bind operations to canonical selected backend/generation, policy revision,
  target, and platform asset. Invalidate delayed results and revoke previous
  consent on an environment/target change.
- [ ] Detect platform and runtime/native architecture; select exactly one certified
  package. Validate format/OS constraints; do not install unsafe downgrade pairs,
  while leaving the current app's normal usage available.
- [ ] Add user-triggered download, accessible progress events, cancellation/retry,
  private staging, disk checks, integrity/publisher validation, and controlled
  redirect/credential behavior. Keep executable/path choices out of renderer IPC.
- [ ] Revalidate policy before install, including deferred packages; flush/save
  work, handle OS permissions, apply through the chosen adapter, and verify the
  outcome. Startup's update action authorizes immediate restart; manual download
  offers restart now/later after verification. Persist deferred installation state.
- [ ] Always attempt fresh startup/environment verification, plus reconnect
  revalidation and serialized manual requests. Pending/failed checks, ignored
  warnings, cancellations, and restart deferral must not disable normal app,
  login, navigation, or backend/API/RPC activity. Retry/relaunch rechecks.
- [ ] Test every persisted store and supported round trip, including offline work
  and deletion state. Keep a recoverable working application after failure.

Exit: service and trust-boundary tests for AC-01–06, AC-08–15, AC-18; a real
upgrade/downgrade proof on each selected adapter before broad UI rollout.

### M4 — Add menus, Settings, and update UX

Depends on M3 contracts; native adapter behavior must be verified before release.
Suggested owner: Desktop renderer/main.

- [ ] Add macOS Evenfire and Windows/Linux Help menu commands. Focus/open the
  window and show the same update surface used by Settings.
- [ ] Add explicit Settings check, state, backend, installed/compatible versions,
  last-check time, errors, and pre-auth recovery access.
- [ ] Replace "latest" browser-handoff messaging with backend-compatible startup
  upgrade/downgrade warnings and manual-update messaging.
- [ ] Add a dismissible startup mismatch alert with **Update and restart**,
  progress, verification, and immediate restart only after choosing that action.
  Compatible builds are not forced to update; ignored alerts leave usage available.
- [ ] Manual menu/Settings checks download the newest compatible target and ask
  **Restart now** / **Restart later** after verification; add cancellation/retry,
  completion/recovery, and deferred-package revalidation.
- [ ] Verify keyboard/screen-reader behavior, window close/reopen, signed-out
  checks, honest failure warnings, usable controls/calls after ignored alerts or
  restart deferral, and concurrent menu/Settings checks.

Exit: AC-07–10, AC-12–14, AC-18 UX evidence. No normal path requires choosing
assets on GitHub. Compatibility status never imposes a usage restriction. A
startup action explicitly authorizes immediate update/restart; manual download
offers restart now/later even on mismatch, with continued usage available.

### M5 — Certify and migrate supported deployments

Depends on M1–M4 and the confirmed scope. Suggested owners: QA/release/
support, with service owners for backend capability tests.

- [ ] Run AC-01–20 with actual candidate artifacts, not only mocked updater events.
  Record OS/distro, CPU/native/emulated mode, install format, publisher/digest,
  source/target versions, backend policy revision, and post-restart result.
- [ ] Cover macOS/Windows/Linux × x64/arm64 upgrade and offered downgrade,
  retained source/target pairs, supported backend families, and data round trips.
- [ ] Inject interrupted transfers/install, offline/expired policy, revoked release,
  disk/permission/signature failures, proxy/rate limits, first-run locks, duplicate
  clicks, and environment switching with a staged download. Verify that updater
  failures/ignored warnings/deferred restart do not add a usage gate and that
  closing/reopening attempts fresh backend verification.
- [ ] Deploy the new policy and updater-enabled distribution to supported recent
  environments. Publish ordinary one-time installation instructions for current
  binaries without an updater; do not create historical backports or shims.
- [ ] Roll out to a limited opted-in cohort, confirm recovery, then activate the
  certified policy/catalog. Do not deploy an incompatible backend before its
  Desktop target is available.
- [ ] Update Desktop setup/update and packaging documentation with the two flows,
  initial recent-build baseline, legacy exclusion, and future supported-artifact
  retention rules. Include that exclusion explicitly in implementation PRs.

Exit: every acceptance condition has named evidence or an explicit unresolved
blocker. A unit test run, a published ZIP, or one successful macOS update cannot
substitute for this milestone.

## 4. Post-release P0 — Versioned invitation and landing downloads

This track is intentionally outside M0–M5's release gate. The optional invitation
service may continue its existing handoff while the updater ships. Updater-capable
downloads warn about incompatibility at startup and offer a compatible replacement.
Users may ignore the alert and attempt operations; no prevention of incompatible
usage is promised. Old pre-updater ZIPs do not provide the new notification/update
capability.

Suggested owners: member-registration, Profile UI, and landing maintainers.

- [ ] Extend the invitation/download handoff to carry the inviting deployment's
  exact newest compatible Desktop version from the same backend policy.
- [ ] Preserve email invitation acceptance and optional deployment behavior. Add
  a versioned first-party download link where the email/product flow needs it;
  update Profile UI's existing download action so it no longer opens GitHub.
- [ ] Add requested-version handling to landing's browser/server/no-JavaScript
  resolver, routing, and caches. Detect OS/architecture at recipient click time
  with an override when uncertain, and directly download the exact asset.
- [ ] Validate version input and supported assets; avoid global-latest swaps,
  arbitrary redirects, and invitation tokens or credentials in download URLs.
- [ ] Deploy landing's version-aware resolver before enabling new versioned
  invitation links. Test stale emails after backend version/policy changes and
  verify Desktop startup correction on updater-capable distributions.
- [ ] Validate PW-01–05 separately. Post-release failure or non-deployment does
  not change the core updater's completion criteria or delay its release.

Exit: exact-version first-party downloads from the optional invitation flow,
with the correct OS/architecture and no GitHub page. The owner confirms the
landing download branch is not deployed yet; this task did not deploy or edit it.

## 5. Implementation surface map

| Surface | Likely files / responsibilities |
| --- | --- |
| Backend policy | `external-rest-api/src/routes/desktop.ts`, `releaseManifest.ts`, config, middleware, and route tests; deployment-owned policy storage/configuration to be chosen in M1. |
| Client contract | `desktop-app/src/types.ts`, `authClient.ts`, `appService.ts`, `ipc.ts`, `preload.ts`; a focused main-process update service and native menu setup. |
| UI | `desktop-app/ui/src/hooks/domain/useAuthController.ts`, `useAppController.ts`, `App.tsx`, `pages/SettingsPage.tsx`, update components/styles and their tests. |
| Packaging | `desktop-app/forge.config.js`, package scripts/dependencies, native updater integration selected in M0, signing/publishing workflow. |
| Release policy | `scripts/release/prepare-release.mjs`, `release-coordinates.mjs`, `update-desktop-release-manifest.mjs`, validators/tests, publication and deployment promotion workflow. |
| Data recovery | `desktop-app/src/chatStore.ts`, `chatStoreBinding.ts`, config/token/settings/upload stores and source/target fixtures. Existing compatibility behavior is retained until verified otherwise. |
| Post-release invitation flow | `evenfire-member-registration` email service/templates, invitation registration/config contracts, and tests; Evenfire Profile UI's `lib/api.ts`, release/download constant, invitation page/action panel, and backend policy handoff. No invitation email was sent and no external repo files changed. |
| Post-release landing | `lib/release-info.mjs`, `download.js`, `api/latest-release.js`, `api/download-latest.js`, routing/cache configuration, and local-preview equivalents: add exact-version contract plus OS/architecture selection. No landing files changed or deployed here. |
| User docs | Desktop setup/updates, Desktop surface packaging, releases/upgrades, bootstrap/support and troubleshooting documentation after behavior ships. |

## 6. Validation boundaries and task completion

This task produced the specification, historical assessment, and roadmap only.
The initial manifest read-only validator and isolated comparison evaluation
passed; this amendment inspected member-registration's fetched `main` and the
existing Profile UI download handoff without running product tests. The core
gaps and separate post-release tasks remain open. No release, policy, minimum, dependency,
application behavior, deployment, or backwards-compatibility implementation
was changed. No product test or native-installation result is claimed.

Before running future Desktop tests/builds, use the repository's required Node
24 version, install with lifecycle scripts enabled, and pass
`npm run verify:electron`. Native installer validation is additional evidence,
separate from unit/renderer tests, CI, and any T0/T1/T2 or Playwright lane.
