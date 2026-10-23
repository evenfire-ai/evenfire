# Desktop updates compatible with the selected backend

Status: implementation in progress. The first implementation slice is in this
branch; actual coverage and remaining platform proof are recorded in sections 2.6,
8, and the companion roadmap.
Investigated on October 23, 2026. Audience: Desktop, API, release engineering,
and QA contributors. This is an engineering reference, not an operational guide
or a claim that signed native update journeys have shipped or been verified on
every target.

Companion: [gap inventory and roadmap](desktop-backend-compatible-updates-roadmap.md).

## 1. Outcome and scope

Evenfire Desktop must check the selected backend deployment's compatibility
policy and offer the newest Desktop release that deployment supports. A client
that is too old receives an upgrade alert; a client that is too new receives
an alert offering a supported older release. Different deployments can select
different releases. Compatibility checking is advisory and must never introduce
an intentional restriction on app or backend usage.

Compatibility is many-to-many: one backend can support several Desktop builds,
and one Desktop build can support several backend releases. The target is the
newest build in the selected deployment's certified compatible set.

There are two update flows:

- **Startup validation:** always attempt a fresh backend compatibility check
  when a selected environment is available. An already compatible app remains
  usable even when a newer compatible build exists; startup does not force that
  update. For a confirmed mismatch, show a dismissible alert with **Update and
  restart** (or **Install compatible version and restart** for a downgrade).
  Choosing that action downloads with progress, verifies, installs, and restarts
  immediately. Dismissing it leaves the app usable.
- **Manual Check for updates:** the native menu or Settings action requests
  the newest compatible build. If it differs, show the update alert and download
  progress. After download/verification, offer **Restart now** and **Restart
  later**, including when a manual check found incompatibility. Deferring restart
  never disables features or backend calls. A current target reports up to date
  without downloading again.

Downloads are visible and user-initiated inside Desktop. The startup action
authorizes the complete immediate download/install/restart sequence; it does
not need a second restart decision. The manual check is an explicit request to
check and download an available compatible update, rather than just inspect
metadata. No launch-time silent prefetch is authorized. OS permission prompts
may still be necessary. Users should not need to find, unpack, or run another
installer for the normal supported flow.

Check failures must not intentionally block usage either. Report the failed
verification without calling the app compatible or up to date, leave the user
free to do what still works, and attempt verification again on the next launch.
Manual retry is also available. An ignored mismatch can result in operations
failing naturally; the updater must not intercept or disable those operations.
Existing authentication/authorization and installation-integrity protections
remain applicable; this feature adds no compatibility-based access gate.

These owner-confirmed decisions replace the earlier hard-blocking proposal.
Section 11 records all three answered product questions; none remains pending.

Scope includes macOS, Windows, and Linux; x64 and arm64; backend policy;
release assets and automation; native menus; Settings; failure recovery; and
upgrade/downgrade data safety. Versioned invitation/landing downloads are recorded
as separate **post-release work**, not a prerequisite to this release (section
10).

## 2. Evidence and current behavior

### 2.1 Pinned sources and verification limits

| Source                                               | Investigated revision                                                                                                                                   |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Latest fetched `origin/dev`                          | [`cbc8441feff89dc6a727e83efc07024e7455aaaf`](https://github.com/evenfire-ai/evenfire/tree/cbc8441feff89dc6a727e83efc07024e7455aaaf)                     |
| Latest fetched `origin/main`, also release `v0.11.0` | [`cfa72530fc1544bcce47b9bd549a287ab92bfc15`](https://github.com/evenfire-ai/evenfire/tree/cfa72530fc1544bcce47b9bd549a287ab92bfc15)                     |
| Landing `feat/download-page`                         | [`b2db3922763c6a49203bbcf623711f17d548515b`](https://github.com/keyper-labs/evenfire-landing/tree/b2db3922763c6a49203bbcf623711f17d548515b)             |
| Member-registration latest fetched `main`            | [`a9bef8fc245cdf46a74bd254399a0cb7b9c511b6`](https://github.com/keyper-labs/evenfire-member-registration/tree/a9bef8fc245cdf46a74bd254399a0cb7b9c511b6) |

The work account `josue-palmera` could read the private landing branch. The
investigation used source, Git history, and live GitHub release metadata.
Every listed release tag was verified as an ancestor of fetched `main`.
Release dates below are GitHub `published_at` converted to America/Guatemala
(UTC−06:00); they are not commit or asset-upload dates.

No running customer/backend instance was probed. No installer archives were
downloaded, unpacked, executed, or signature-verified. Package versions in the
history table come from tagged source; their equality with the version inside
published binaries has not been established. No Electron tests, native update
tests, Minikube gates, or cross-version product journeys were run. Consequently,
this investigation distinguishes declared policy from functional compatibility.

### 2.2 What existed before this implementation

| Capability                | Verified current implementation and consequence                                                                                                                                                                                                                                                                  |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deployment-local policy   | External REST API, not Control API, serves authenticated `GET /api/v1/desktop/release`. Values are compiled into `external-rest-api/src/releaseManifest.ts`. Separate API deployments can already advertise separate targets.                                                                                    |
| Version declarations      | On `dev`: Desktop target `0.11.0`, minimum `0.1.252`, release ID `v0.11.0`, External REST counter `0.1.136`, RPC counter `0.1.127`. On `main`, the API/RPC counters are `0.1.100`/`0.1.126`; target and minimum are the same. Service counters are not Desktop compatibility versions.                           |
| Required update detection | `AppService.getDesktopReleaseStatus()` evaluates only `installed < minimumDesktopVersion`. A larger version is always accepted by that check. There is no maximum, supported set, or required downgrade.                                                                                                         |
| Check lifecycle           | Authenticated session loading starts a release check asynchronously. It does not wait before loading workspace data. The auth controller catches release-check errors and returns `null`; it does not explain the failure globally. No recurring update poll was found.                                          |
| Update alert              | `DesktopUpdateRequiredDialog` appears only while authenticated and below the floor. Its text says "latest", although the server supplies a particular target. Its action opens the returned release page through `shell.openExternal()`.                                                                         |
| Settings                  | Settings → Information fetches and displays versions, target, minimum, release URL, health, and last-check time. It reports fetch errors locally. There is no explicit "Check for updates" control or install/progress flow. Its diagnostic result is separate from the controller's global update-dialog state. |
| Native menu               | No application-menu update command or native updater registration was found in Desktop main-process code.                                                                                                                                                                                                        |
| Release URL               | The current route builds `.../releases/tag/v<desktopVersion>`, not `/releases/latest`. The `dev` target `v0.11.0` exists. The current Desktop route is already version-specific.                                                                                                                                 |
| Installation              | There is no `autoUpdater`, update download, byte-progress bridge, verified staging, install, or restart implementation. Updating is a browser handoff.                                                                                                                                                           |
| Local data compatibility  | Chat storage keeps a v2 index, paged history, bounded 100-message legacy snapshots, and reconciliation of writes made by older builds. Future unsupported index versions fail closed. This is useful local recovery behavior, not an installer or backend support matrix.                                        |
| Release preparation       | `prepare-release.mjs` assigns the Desktop release version and updates release coordinates. The minimum moves only with an explicit `--minimum-desktop-version`. Ordinary pre-commit service-counter synchronization uses `--defer-desktop-release`; it deliberately does not publish a new Desktop target.       |
| Build automation          | The checked-in CI builds/tests Desktop but has no workflow that runs Forge packaging and publishes Desktop installers. `release-images.yml` promotes container images, not the Electron application. Releases do have Desktop assets, so their production/upload mechanism is outside the reviewed pipeline.     |

Primary implementation evidence:

- [Policy route](https://github.com/evenfire-ai/evenfire/blob/cbc8441feff89dc6a727e83efc07024e7455aaaf/external-rest-api/src/routes/desktop.ts),
  [compiled manifest](https://github.com/evenfire-ai/evenfire/blob/cbc8441feff89dc6a727e83efc07024e7455aaaf/external-rest-api/src/releaseManifest.ts), and
  [API client](https://github.com/evenfire-ai/evenfire/blob/cbc8441feff89dc6a727e83efc07024e7455aaaf/desktop-app/src/authClient.ts).
- [Main-process comparison and browser handoff](https://github.com/evenfire-ai/evenfire/blob/cbc8441feff89dc6a727e83efc07024e7455aaaf/desktop-app/src/appService.ts),
  [session loading](https://github.com/evenfire-ai/evenfire/blob/cbc8441feff89dc6a727e83efc07024e7455aaaf/desktop-app/ui/src/hooks/useAppController.ts), and
  [check error handling](https://github.com/evenfire-ai/evenfire/blob/cbc8441feff89dc6a727e83efc07024e7455aaaf/desktop-app/ui/src/hooks/domain/useAuthController.ts).
- [Dialog](https://github.com/evenfire-ai/evenfire/blob/cbc8441feff89dc6a727e83efc07024e7455aaaf/desktop-app/ui/src/App.tsx),
  [Settings](https://github.com/evenfire-ai/evenfire/blob/cbc8441feff89dc6a727e83efc07024e7455aaaf/desktop-app/ui/src/pages/SettingsPage.tsx), and
  [native startup](https://github.com/evenfire-ai/evenfire/blob/cbc8441feff89dc6a727e83efc07024e7455aaaf/desktop-app/src/main.ts).
- [Release writer](https://github.com/evenfire-ai/evenfire/blob/cbc8441feff89dc6a727e83efc07024e7455aaaf/scripts/release/prepare-release.mjs),
  [manifest writer](https://github.com/evenfire-ai/evenfire/blob/cbc8441feff89dc6a727e83efc07024e7455aaaf/scripts/release/update-desktop-release-manifest.mjs), and
  [service-counter synchronization](https://github.com/evenfire-ai/evenfire/blob/cbc8441feff89dc6a727e83efc07024e7455aaaf/scripts/precommit/bump-staged-package-versions.mjs).

### 2.3 Reproduced decision gaps

The actual comparison function was extracted from the pinned `dev` source and
evaluated in isolation against the manifest. These are source-level results,
not a packaged-app test:

| Installed version                    | Current minimum | Advertised target | `updateRequired` |
| ------------------------------------ | --------------- | ----------------- | ---------------- |
| `0.1.251`                            | `0.1.252`       | `0.11.0`          | `true`           |
| `0.1.252`                            | `0.1.252`       | `0.11.0`          | `false`          |
| `0.10.0`                             | `0.1.252`       | `0.11.0`          | `false`          |
| `0.11.0`                             | `0.1.252`       | `0.11.0`          | `false`          |
| `0.12.0` (hypothetical newer client) | `0.1.252`       | `0.11.0`          | `false`          |

The absence of an update alert on `0.10.0` follows the existing minimum-only
contract; advertising `0.11.0` does not require it. That does not establish
whether `0.10.0` actually works with all current backend capabilities.
The comparison also treats `0.11.0-beta.1` as equal to `0.11.0`; a future policy
must use complete SemVer and explicit release-channel rules.

### 2.4 Landing reference and artifact limitations

The landing branch's [`lib/release-info.mjs`](https://github.com/keyper-labs/evenfire-landing/blob/b2db3922763c6a49203bbcf623711f17d548515b/lib/release-info.mjs)
fetches GitHub `/releases/latest`, caches it for five minutes, and selects
`evenfire-desktop-v<version>-<mac|windows|linux>-<x64|arm64>.zip` assets.
[`download.js`](https://github.com/keyper-labs/evenfire-landing/blob/b2db3922763c6a49203bbcf623711f17d548515b/download.js)
detects OS, guesses architecture, refines Chromium hints when available, and
builds direct first-party download links. Without reliable architecture hints,
its Mac default is arm64, so it can choose the wrong build for an Intel Mac.
[`api/download-latest.js`](https://github.com/keyper-labs/evenfire-landing/blob/b2db3922763c6a49203bbcf623711f17d548515b/api/download-latest.js)
falls back to the global latest GitHub page on failure. None of these paths
accepts a backend compatibility policy. Reuse the platform/asset vocabulary and
direct-download experience; do not reuse global-latest resolution or fallback.

The live [`v0.11.0` release](https://github.com/evenfire-ai/evenfire/releases/tag/v0.11.0)
publishes six outer Desktop ZIP archives and a container-image JSON manifest.
No standalone updater feed, Windows `RELEASES`/`.nupkg`, Linux managed-update
artifact, or Desktop-specific signed compatibility catalog is exposed in its
top-level asset list. The ZIP contents and binary signatures remain unverified;
an outer ZIP is not evidence that an updater can consume its contents.

[`forge.config.js`](https://github.com/evenfire-ai/evenfire/blob/cbc8441feff89dc6a727e83efc07024e7455aaaf/desktop-app/forge.config.js)
can produce ZIP/DMG, Squirrel.Windows, and DEB/RPM packages. macOS signing and
notarization are opt-in; Windows signing is not configured. Configuration
capability is distinct from the assets actually published and installed.

### 2.5 Invitation download handoff

The owner confirms that closed-source `evenfire-member-registration` is optional
per deployment and currently used in production and development. Its latest
fetched `main` was inspected read-only; no live deployment was probed.

In that source, [`sendInvitationEmail`](https://github.com/keyper-labs/evenfire-member-registration/blob/a9bef8fc245cdf46a74bd254399a0cb7b9c511b6/src/services/emailService.ts)
renders [`member-invitation.html`](https://github.com/keyper-labs/evenfire-member-registration/blob/a9bef8fc245cdf46a74bd254399a0cb7b9c511b6/src/email-templates/member-invitation.html)
with an **Accept invitation** URL. The
[`invitation flow`](https://github.com/keyper-labs/evenfire-member-registration/blob/a9bef8fc245cdf46a74bd254399a0cb7b9c511b6/src/services/invitationsFlowService.ts)
builds a Profile UI invitation URL, optionally through its redirect service.
The inspected email templates have no separate Desktop version/download value.
Thus the current download handoff is indirect through Profile UI, rather than
a versioned Desktop download button in the inspected email template.

On pinned `dev`, Profile UI's
[`getEvenfireDownloadUrl()`](https://github.com/evenfire-ai/evenfire/blob/cbc8441feff89dc6a727e83efc07024e7455aaaf/profile-ui/lib/api.ts)
returns [`EVENFIRE_RELEASES_URL`](https://github.com/evenfire-ai/evenfire/blob/cbc8441feff89dc6a727e83efc07024e7455aaaf/profile-ui/app/constants/api.ts),
the GitHub releases listing. The
[`accepted-invitation page`](https://github.com/evenfire-ai/evenfire/blob/cbc8441feff89dc6a727e83efc07024e7455aaaf/profile-ui/app/invitations/%5Btoken%5D/InvitationClient.tsx)
uses that URL for its download action. No Desktop version is passed through it.
The member-registration flow config carries environment URLs and app name,
but no Desktop release selection.

The owner confirms that the landing download change is not deployed yet.
The reviewed branch supports global latest and explicit platform selection,
but no requested-version contract. Post-release work must cover the email/
invitation contract, Profile UI's existing download action, and landing's
version-aware resolver. No email was sent and neither external repo was edited.

### 2.6 Current implementation in this branch

This branch adds the first end-to-end updater path. Signed native update
journeys still require release credentials and platform validation:

- External REST API desktop release metadata is public because it contains
  only version and release information. It returns the backend's recommended
  Desktop version, an explicit compatible-version set, and a feed URL for
  that exact release tag. The selected API deployment remains the authority;
  the client does not resolve global latest.
- The release writer validates a non-empty, unique compatible-version set
  containing the target. A Desktop version bump defaults the set to the new
  version; repeated compatible-version flags retain other certified builds.
  The historical minimum version is frozen and is not used by this client.
- Desktop checks the selected backend at startup, including while signed out.
  A compatible build stays usable and receives no startup prompt. A mismatch
  shows a dismissible, non-modal notice. Check failures do not block the app.
  Settings and the native menu start the manual check/download flow; download
  progress is shown in-app and the user can restart now or later.
- The main process uses electron-updater and rechecks the backend target before
  downloading and installing. Its feed is constrained to the exact HTTPS tag
  path. macOS has an Evenfire menu command; Windows/Linux use Help.
- electron-builder is configured for signed macOS DMG/ZIP, signed Windows
  NSIS/ZIP, and Linux AppImage/DEB/RPM builds on x64 and arm64. The release
  workflow builds and attaches assets to the same version tag. It requires
  macOS signing/notarization and Windows signing secrets; those credentials
  were not available or exercised in this task.
- This first policy uses a compiled manifest, not a dynamic admin catalog. It
  has no policy revision/expiry or per-platform eligibility, and no catalog
  gate proves every asset exists before deployment. Release ordering and
  native platform proofs remain explicit follow-up validation; see the roadmap.

## 3. Release history and backward compatibility assessment

### 3.1 Main release inventory

The two version columns must not be conflated: early release tags did not match
`desktop-app/package.json`. All tagged source package versions below meet
today's `0.1.252` floor, including the source under tag `v0.1.0`.

| Main release                                                            | Published, Guatemala time | Age on Oct 23 | Desktop source version | Policy target / floor | Desktop ZIP assets | Existing policy link |
| ----------------------------------------------------------------------- | ------------------------- | ------------- | ---------------------- | --------------------- | ------------------ | -------------------- |
| [v0.1.0](https://github.com/evenfire-ai/evenfire/releases/tag/v0.1.0)   | 2026-07-12 00:10          | 103 days      | `0.1.253`              | `0.1.252` / `0.1.252` | 0                  | Broken legacy tag    |
| [v0.2.0](https://github.com/evenfire-ai/evenfire/releases/tag/v0.2.0)   | 2026-07-12 23:43          | 103 days      | `0.1.253`              | `0.1.252` / `0.1.252` | 0                  | Broken legacy tag    |
| [v0.3.0](https://github.com/evenfire-ai/evenfire/releases/tag/v0.3.0)   | 2026-07-17 04:21          | 98 days       | `0.1.263`              | `0.1.252` / `0.1.252` | 0                  | Broken legacy tag    |
| [v0.4.0](https://github.com/evenfire-ai/evenfire/releases/tag/v0.4.0)   | 2026-07-19 22:05          | 96 days       | `0.1.299`              | `0.1.252` / `0.1.252` | 6                  | Broken legacy tag    |
| [v0.5.0](https://github.com/evenfire-ai/evenfire/releases/tag/v0.5.0)   | 2026-07-24 09:22          | 91 days       | `0.1.316`              | `0.1.252` / `0.1.252` | 6                  | Broken legacy tag    |
| [v0.6.0](https://github.com/evenfire-ai/evenfire/releases/tag/v0.6.0)   | 2026-08-07 00:32          | 77 days       | `0.6.0`                | `0.6.0` / `0.1.252`   | 6                  | Correct `v0.6.0`     |
| [v0.7.0](https://github.com/evenfire-ai/evenfire/releases/tag/v0.7.0)   | 2026-08-13 08:24          | 71 days       | `0.7.0`                | `0.7.0` / `0.1.252`   | 6                  | Correct `v0.7.0`     |
| [v0.8.0](https://github.com/evenfire-ai/evenfire/releases/tag/v0.8.0)   | 2026-09-14 01:55          | 39 days       | `0.8.0`                | `0.8.0` / `0.1.252`   | 6                  | Correct `v0.8.0`     |
| [v0.8.1](https://github.com/evenfire-ai/evenfire/releases/tag/v0.8.1)   | 2026-09-16 00:30          | 37 days       | `0.8.1`                | `0.8.1` / `0.1.252`   | 6                  | Correct `v0.8.1`     |
| [v0.9.0](https://github.com/evenfire-ai/evenfire/releases/tag/v0.9.0)   | 2026-09-21 23:17          | 32 days       | `0.9.0`                | `0.9.0` / `0.1.252`   | 6                  | Correct `v0.9.0`     |
| [v0.10.0](https://github.com/evenfire-ai/evenfire/releases/tag/v0.10.0) | 2026-09-28 07:26          | 25 days       | `0.10.0`               | `0.10.0` / `0.1.252`  | 6                  | Correct `v0.10.0`    |
| [v0.11.0](https://github.com/evenfire-ai/evenfire/releases/tag/v0.11.0) | 2026-10-12 05:55          | 11 days       | `0.11.0`               | `0.11.0` / `0.1.252`  | 6                  | Correct `v0.11.0`    |

GitHub reports `v0.1.0` and `v0.2.0` against the same source commit and with
publication times before that commit's recorded timestamp. These are reported
release dates, not proof of distinct historical binaries. Earlier unpublished,
private, deleted, or locally distributed builds were not inventoried.

### 3.2 What can actually be called incompatible

1. **Current declared version policy:** an installed version below `0.1.252`
   is rejected by the current Desktop check. No published tag's source package
   version in the inventory falls below it. There is no discovered published
   release/date that proves the real lower compatibility boundary. The floor
   was already present in the initial imported history.
2. **Broken update metadata:** backend releases through `v0.5.0` generate
   `desktop-app-0.1.252`, with the old default repository placeholder as well.
   The [fix](https://github.com/evenfire-ai/evenfire/commit/aa9ff2142aa4ec429b60213cf8bdc034ebdc7a38)
   first shipped in `v0.6.0`. This is a proven update-routing defect, not proof
   that ordinary login/chat between those releases is incompatible.
3. **Future updater protocol:** every currently published release, including
   the 11-day-old `v0.11.0`, lacks the new updater and a bounded supported-version
   policy. None can transparently gain the new in-app experience without being
   replaced. The first new protocol version has not been released.
4. **Product/API/data compatibility:** no cross-version capability matrix or
   exact-head cross-release journeys were found for this feature. Neither a
   successful minimum comparison nor a newer release date proves compatibility
   with older authentication, RPC, GFS, or local-data behavior.

### 3.3 Existing local downgrade safeguards

The [chat-history downgrade change](https://github.com/evenfire-ai/evenfire/commit/36a7c7004014d5319f5fa90f6654360009cce482)
first shipped in `v0.6.0`, following pre-paging releases through `v0.5.0`.
Current [chat storage](https://github.com/evenfire-ai/evenfire/blob/cbc8441feff89dc6a727e83efc07024e7455aaaf/desktop-app/src/chatStore.ts)
and [binding](https://github.com/evenfire-ai/evenfire/blob/cbc8441feff89dc6a727e83efc07024e7455aaaf/desktop-app/src/chatStoreBinding.ts)
retain compatibility snapshots, downgrade-written message import, and
unsupported-index protection. Older pre-paging readers get a bounded recent
window, not the full paged cache. These safeguards do not cover every persisted
store, token/keychain format, pending upload, or deletion semantic. Removing
them is outside this task and is not justified by retiring old release links.

## 4. Confirmed legacy exclusion and recent-build baseline

Owner decision on October 23, 2026: all currently used builds are from the last
30 days. Older legacy releases do not need additional compatibility handling.
This usage statement is supplied by the owner, not inferred from GitHub dates.

For this investigation the 30-day window begins September 23, 2026. The published
`main` releases within it are `v0.10.0` (September 28) and `v0.11.0` (October 12).
`v0.9.0` was published September 21 in Guatemala and falls outside that window.
Both in-window releases already have the corrected `v<desktopVersion>` link and
the same existing minimum-only contract. The broken `desktop-app-*` metadata is
older than the supported discovery baseline and requires no compatibility shim.

The implementation and future PR descriptions must explicitly state:

> Legacy builds outside the confirmed recent-build baseline are out of scope.
> No broken-tag adapter, legacy update-policy projection, old-backend backport,
> or historical maintenance build is added solely for those releases. Recent
> builds and the new updater contract are validated directly. Future certified
> backend/Desktop combinations support both upgrade and downgrade.

Do not add a v1 bridge just because older releases lack the new updater protocol.
Preserve response fields only where current supported product consumers need
them, not as an assumed legacy-support obligation. The release history is an
audit record, not an instruction to support all those versions. Verify the
recent actual package versions and test the affected contracts; the minimum
comparison alone still does not prove functional compatibility.

Existing `v0.10.0`/`v0.11.0` binaries cannot gain an installer updater remotely.
Their first updater-capable installation is an ordinary one-time bootstrap,
not a new legacy adapter/backport project. Document that distribution step.
Subsequent updates follow the new in-app flows. Retain current local-data
safeguards; removing old release-link support does not authorize removing
chat recovery or dropping recent user data.

The 30-day statement fixes the initial discovery baseline. It does not impose
a rolling 30-day expiry on future certified deployments or their Desktop
artifacts: independent deployments may intentionally retain compatible versions.

## 5. Backend and release contract

### 5.1 Ownership and discovery

The selected External REST API deployment is the compatibility authority. The
implemented contract extends the existing desktop release route and makes its
non-secret version/release metadata available before sign-in. No new route or
legacy projection is added; no backport is required for releases outside
section 4's baseline.

An API image or deployment policy revision declares its supported Desktop
versions and approved target. Control API may administer that declaration, but
Desktop must not infer support from a Control UI version, service counter,
landing page, GitHub "latest", or another environment's cached policy.

Policies must allow several Desktop versions for one backend and the same
Desktop version in several backend policies. Do not force a one-to-one version
mapping or treat every backend release as requiring a unique Desktop build.

Use an explicit finite set of supported Desktop versions. The implementation
stores that set and its recommended target in each deployment's compiled
manifest. The release-cut writer defaults the set to the bumped Desktop
version; maintainers can explicitly retain multiple compatible builds. The
writer checks that the target is in the set, but release publication and
backend deployment remain separate operations. Do not advertise a new target
until its updater metadata and required platform assets are published.

### 5.2 Minimum policy and catalog information

| Information                                                              | Required meaning                                                                                                                                                           |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Supported Desktop versions and target                                    | Implemented as compatibleDesktopVersions and desktopVersion. The client checks exact membership; the target must belong to the set.                                        |
| Exact Desktop version and release tag                                    | Implemented as desktopVersion and v<desktopVersion>. The feed URL points at this exact tag, never global latest.                                                           |
| Platform artifacts                                                       | Electron-updater metadata selects platform/architecture assets from the exact tag. The backend response does not yet expose a per-platform catalog, minimum OS, or digest. |
| Schema, deployment identity, revision, expiry, channel, and availability | Not represented in this first implementation. A future policy service/catalog must define these before dynamic administration or staged revocation.                        |
| Downgrade/data constraints                                               | The updater can select an older backend target; whole-store source/target safety remains unverified and is tracked in the roadmap.                                         |

The policy route is public and fetched from the selected backend over HTTPS.
The main process accepts only a same-origin HTTPS feed URL at the exact tag
path; renderer callers cannot choose a feed URL or executable path.
electron-updater consumes the platform release metadata and package hashes.
macOS/Windows signing is required by the release workflow. Linux package
signature and permission behavior remains a native validation item. No GitHub
work-account credential is embedded in the application.

### 5.3 Decision rules

| Installed client and current policy                  | Result and permitted action                                                                                                                                                                        |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Installed equals target and is supported             | Compatible, up to date for this backend.                                                                                                                                                           |
| Installed is supported and below target              | Startup leaves the compatible client usable without forcing an update. Manual checking downloads the newest compatible target and offers restart now/later.                                        |
| Installed is below all supported versions            | Incompatible; show a dismissible upgrade alert. The startup update action downloads the approved target and installs/restarts immediately; ignoring it does not disable usage.                     |
| Installed is newer than target and not supported     | Incompatible; show a dismissible wrong-version alert offering the older target. User-selected startup installation restarts immediately; usage remains available if ignored.                       |
| Installed lies in a disallowed gap or is revoked     | Incompatible regardless of numeric ordering; warn and offer the approved target without adding a usage restriction. Do not install revoked artifacts.                                              |
| Policy, target, or matching asset is invalid/missing | Visible actionable failure; no guessed version or global-latest fallback. Normal usage remains available; an unverifiable installation does not proceed.                                           |
| Endpoint/policy is offline or expired                | Compatibility unknown; show the failed check and offer retry while preserving usage. Do not report "up to date" or begin unverified installation. Always attempt a fresh check on the next launch. |

Illustrative only: deployment A supports `0.12.0` and `0.12.1`, with target
`0.12.1`; deployment B supports `0.13.0`. A `0.13.0` client connecting to A
must offer a downgrade to `0.12.1`, even if GitHub's latest is `0.13.0`. The
user may dismiss the mismatch alert and continue without an updater-imposed gate.
These example versions are not claims of published releases.

## 6. Desktop experience and lifecycle

### 6.1 Entry points and checks

- Attempt a fresh backend check on every packaged-app startup after an environment
  is selected, on connecting/switching environments, and after restart. Do not
  substitute cached approval for that attempt or make successful validation a
  prerequisite for workspace use. Revalidate on reconnect with bounded timeouts/
  retries; no extra periodic background-update schedule is required by this scope.
- Add **Evenfire → Check for updates…** on macOS and **Help → Check for updates…**
  on Windows/Linux. Open/focus a window if needed. Preserve normal platform menu
  roles. The command and Settings invoke the same main-process state machine.
- Add **Check for updates** in Settings with installed version, selected backend,
  newest compatible version, outcome, and last check. Make the same recovery
  surface available while signed out and from the incompatibility dialog.
- A manual menu/Settings check requests the latest compatible download if one
  differs from the installed version; after verification it offers **Restart
  now** / **Restart later**, even after a mismatch. Choosing the startup update
  action instead authorizes immediate restart after verification; that alert
  itself can be dismissed without restricting use.
- With no selected backend, explain that an environment is needed for checking.
  Pending, failed, unavailable, or incompatible results never disable navigation,
  authentication, environment selection, or workspace/API/RPC operations. Show
  honest status and allow the user to ignore warnings. Backend/service errors
  remain ordinary errors rather than updater-enforced denial.
- Coalesce concurrent checks/downloads. Scope each result and pending operation
  to the environment, policy revision, target, and artifact. Switching environments
  invalidates stale results and previous authorization; do not install A's
  pending release while B is selected without a new decision and consent.

### 6.2 Alert, progress, installation, and restart

| Stage            | Startup check and mismatch alert                                                                                                                                        | Manual Check for updates                                                                                                                                                                         |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Check            | Attempt fresh validation, including before sign-in when possible; pending/failure does not prevent use. Compatible non-target builds are not forced to update.          | Resolve the newest compatible build for the active backend. Failed resolution leaves usage available.                                                                                            |
| Alert/action     | Explain installed/target versions and mismatch. The alert is dismissible. **Update and restart** explicitly authorizes the download/install/immediate-restart sequence. | The menu/Settings action explicitly requests checking and downloading. Show which compatible version will download, its backend, platform, size, and release notes before/with visible progress. |
| Download         | Visible progress after the user chooses the update action; do not impose a workspace lock.                                                                              | Visible progress for the latest compatible artifact without locking usage. If already current, report up to date without downloading.                                                            |
| Verified package | The chosen startup action proceeds to installation without a second restart decision. An ignored warning never reaches this stage automatically.                        | Ask **Restart now** or **Restart later** after verification, including for a mismatch.                                                                                                           |
| Restart          | Save/flush local state, install, and restart immediately as authorized by the startup action.                                                                           | **Restart now** saves/flushes work and installs/restarts. **Restart later** keeps the verified package staged and leaves normal usage available regardless of compatibility.                     |

Both flows must satisfy these rules:

1. Metadata validation alone never prefetches application bytes. The startup
   update action or explicit manual check authorizes a visible transfer. Show
   accessible bytes/percentage when the total is known; otherwise show an
   indeterminate progress bar. Reopen/focus restores the current progress.
2. Cancellation, ignored alerts, failed checks, and failed downloads never impose
   a usage restriction. Offer retry without requiring quit or an environment
   switch to continue. Use bounded retries and private staging/disk-space checks.
3. Verify digest, size, publisher/signature, version, architecture, install format,
   and data-transition eligibility. Separate download completion, verification,
   and preparation; none means "installed". Revalidate policy and active backend
   immediately before applying a staged update, including after restart-later.
4. Persist enough trusted state to finish a manual deferred install on the next
   normal launch after revalidation; the user already chose to install on a later
   restart. Never apply a revoked/stale package or re-prompt in a startup loop.
5. Save/flush local work before replacement. A startup alert can arrive while
   work is already usable; disclose immediate restart and active-work handling
   in the update action. Preserve drafts/pending local work. Backend work may
   stop naturally when the user-authorized installer exits/restarts the app;
   updater compatibility status itself must not suspend it.
6. Use the selected recoverable platform installer. Show preparation progress
   while Desktop runs; the app cannot render its own progress after process exit.
   On relaunch, verify installed version and compatibility and show completion or
   recovery. An install failure must preserve user data and a working application.

### 6.3 Platform and installation coverage

The implementation uses electron-builder with electron-updater. Its configured
targets cover:

| Platform | Configured update formats | Architectures | Release gate                                                                            |
| -------- | ------------------------- | ------------- | --------------------------------------------------------------------------------------- |
| macOS    | DMG and ZIP               | x64 and arm64 | Signed and notarized; verify real install replacement and relaunch.                     |
| Windows  | NSIS and ZIP              | x64 and arm64 | Signed; verify first-run installation, UAC behavior, downgrade, and relaunch.           |
| Linux    | AppImage, DEB, and RPM    | x64 and arm64 | Verify user permissions, package-manager prompts, replacement, downgrade, and relaunch. |

The electron-builder documentation lists macOS DMG, Windows NSIS, and Linux
AppImage/DEB/Pacman/RPM as auto-update targets and requires macOS signing:
[official updater target documentation](https://www.electron.build/v26/docs/features/auto-update/).
The release workflow requires macOS signing/notarization and Windows signing
secrets. No real signed package or installed update was produced in this branch,
so configured targets are not evidence of successful native installation.

The updater resolves the asset for the running platform and architecture from
the backend's exact-tag feed metadata. It does not rely on a browser user-agent
or global-latest endpoint. Unsupported package formats, missing metadata,
permission prompts, emulated architectures, and failure recovery require
packaged tests before the platform can be declared qualified.

## 7. Release and deployment automation

The implementation adds a versioned compatibility set to each compiled
External REST API release manifest. During release preparation, the writer
advances the Desktop target and defaults the set to that version. Repeated
compatible-version flags retain additional builds certified for that backend.
The historical minimum is frozen and remains in the response only for existing
clients that still use the old comparison. Service counters remain unrelated.

The release workflow runs after a GitHub release is published, validates that
the tag matches the Desktop package version and manifest, builds the configured
platform/architecture targets, and uploads update metadata and packages to that
same release tag. It requires Windows signing and macOS signing/notarization
secrets. It has not yet produced release evidence.

The code does not verify asset completeness before an API deployment advertises
the target, and the release workflow is triggered only after release
publication. Release operators must ensure the exact-tag metadata and required
assets are available before deploying a manifest that recommends the target.
Moving to artifact-first publication/promotion is a remaining release-ordering
task.

Each backend deployment owns its own compiled target and compatible-version
set, so one environment can retain older builds while another advances. The
current change does not add dynamic policy storage, a policy revision/expiry,
replica-level atomic promotion, artifact revocation, or automated two-backend
release tests. Never substitute GitHub's global latest or another backend's
policy. Do not add compatibility adapters for releases outside the
owner-confirmed recent baseline in section 4.

## 8. Acceptance conditions

These conditions define full feature acceptance. This branch implements
the flows and release wiring, but code coverage is not native end-to-end
proof. The coverage summary after the table records the current state.

| ID    | Acceptance condition                                                                                                                                                                                                                                                        | Required evidence                                                                                                                                              |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AC-01 | Every startup attempts fresh backend compatibility verification when an environment is selected. Pending/failed checks and ignored mismatch alerts never intentionally disable usage. An accepted startup update installs/restarts immediately and rechecks.                | Startup/API/auth journeys for success, timeout, failure, and ignored warnings, with normal controls/calls still available.                                     |
| AC-02 | Deployment A and B can select different targets; each can support multiple builds, and a build can belong to both support sets. Publishing an unrelated release changes neither incorrectly.                                                                                | Many-to-many, two-deployment policy/catalog integration test.                                                                                                  |
| AC-03 | A compatible installed build is not forced to update at startup. Manual checking on a current target reports up to date; otherwise it downloads the newest compatible build and offers restart now/later after verification.                                                | Compatible-old startup, version boundary, manual download, and deferred-restart journeys.                                                                      |
| AC-04 | An unsupported older client receives a dismissible upgrade alert. Choosing the startup update action downloads the approved target and installs/restarts immediately; dismissing it or cancelling a transfer leaves usage available.                                        | Packaged startup upgrade, ignored-alert, and cancellation journeys.                                                                                            |
| AC-05 | An unsupported newer client receives a dismissible wrong-version alert offering the approved older target. Unsupported gaps/revocations are reported accurately without a usage gate; revoked/unverified packages are never installed.                                      | Packaged startup downgrade, ignored-alert, and policy-revocation journeys.                                                                                     |
| AC-06 | Full SemVer and channel rules distinguish prereleases, build metadata, malformed inputs, equality, and boundary versions.                                                                                                                                                   | Contract tests; no numeric/lexical shortcuts.                                                                                                                  |
| AC-07 | Native macOS/Windows/Linux menu commands and Settings call the same check flow and show checking, compatible, optional, mismatch, and failure states.                                                                                                                       | Menu/IPC tests plus native menu screenshots and Settings journeys.                                                                                             |
| AC-08 | Metadata checks transfer no application bytes. The startup update action or manual menu/Settings check initiates the visible download. Ignoring/cancelling does not disable navigation, login, workspace actions, or backend requests.                                      | Startup/reconnect/menu/Settings network assertions, continued-use checks, and duplicate-click checks.                                                          |
| AC-09 | Correct immutable version, OS, architecture, minimum OS, and install-format artifacts are selected without manual GitHub asset selection.                                                                                                                                   | All six platform/architecture cases, including emulation, missing, ambiguous, and wrong-format assets.                                                         |
| AC-10 | The in-app accessible progress bar reflects transfer; cancellation/retry and indeterminate totals work; verification and ready-to-install states are distinct.                                                                                                              | Main-process event tests and real-package UX evidence.                                                                                                         |
| AC-11 | Failed integrity, publisher, size, identity, or policy revalidation prevents installation. Tenant credentials are not forwarded to asset hosts.                                                                                                                             | Tamper, redirect, IPC trust, revoked-package, and stale-policy tests.                                                                                          |
| AC-12 | User-accepted startup updates install/restart immediately after verification. Manual downloads offer restart now/later, including mismatches; later never imposes a usage restriction. Deferred installs revalidate before application, preserve work, and verify relaunch. | Immediate/deferred upgrade and downgrade evidence on each supported package format, including normal actions after deferral.                                   |
| AC-13 | Cancellation, offline checks, interrupted transfer/install, insufficient disk, permissions, proxy/TLS errors, and provider rate limits produce actionable states and preserve recovery.                                                                                     | Fault-injection native journeys; no false success or global-latest fallback.                                                                                   |
| AC-14 | Backend switching cancels/invalidates stale work and requires fresh authorization for a different target. No cross-tenant state or credential leakage occurs.                                                                                                               | Delayed-response, environment-switch, and staged-download races.                                                                                               |
| AC-15 | Tested downgrade/upgrade round trips preserve chats, offline messages, drafts, settings, credentials, environment bindings, uploads, and deletion semantics. Unsafe schema transitions prevent package installation while leaving the current app usable.                   | Per-store fixtures and real-package round trips against retained release pairs.                                                                                |
| AC-16 | Release automation verifies complete native artifacts, embedded versions, trust, and updater metadata before a deployment advertises a target.                                                                                                                              | Publication/promotion tests, including partial uploads and failed builds.                                                                                      |
| AC-17 | New compatible releases advance only eligible deployments' targets; old supported releases remain downloadable and rollback/revocation is controlled.                                                                                                                       | Catalog/policy promotion and retention tests across two backend versions.                                                                                      |
| AC-18 | Missing backend, old endpoint, invalid/unavailable metadata, unsupported platform, and dev/unpackaged mode give honest status without adding a usage gate. Retry or closing/reopening makes a fresh check; no failure is reported as compatible/up to date.                 | Recovery and continued-use UI/API tests; no unverified source-build self-replacement.                                                                          |
| AC-19 | The owner-confirmed recent-build baseline is explicit in docs and implementation PRs. No compatibility shim/backport is added for excluded legacy releases; recent builds and the one-time updater installation are validated directly.                                     | Recent package/version and bootstrap checks; review of PR scope statement.                                                                                     |
| AC-20 | macOS, Windows, and Linux each pass end-to-end user-selected upgrade/downgrade acceptance on x64 and arm64, including continued use after ignored mismatch alerts or deferred restart.                                                                                      | Named OS/package versions, source/target releases, signatures/digests, progress evidence, and post-restart results. A single OS or unit suite is insufficient. |

### Current implementation coverage

| State                                           | Acceptance conditions                                                              | Meaning                                                                                                                                                                                                                                       |
| ----------------------------------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Implemented in code; basic focused checks exist | AC-01, AC-03, AC-05, AC-07                                                         | Startup/manual flows, compatible-build continuity, advisory mismatch/failure, native entry points, and the legacy boundary are wired. This is not packaged end-to-end evidence.                                                               |
| Partially implemented; qualification remains    | AC-02, AC-06, AC-08, AC-09, AC-10, AC-11, AC-12, AC-14, AC-16, AC-17, AC-18, AC-19 | The manifest, target checks, updater formats, progress events, policy rechecks, signing requirements, and release writer exist, but missing multi-deployment, package-integrity, native install, asset-promotion, and fault evidence remains. |
| Not complete                                    | AC-13, AC-15, AC-20                                                                | Fault injection, environment-switch races, full data round trips, and all-six-target upgrade/downgrade journeys are still open.                                                                                                               |

The compatible set permits multiple versions, but the current committed manifest
is a single-version baseline. Release preparation can retain multiple versions
when maintainers certify them. No acceptance row is considered fully complete
until its evidence column has been satisfied.

## 9. Validation recorded for this branch

The following source-level checks pass:

- Desktop main and renderer production builds with Node 24.22.1.
- Electron runtime verification with Node 24.22.1.
- Desktop main and UI TypeScript checks.
- Focused Desktop status, settings, workspace-startup, and updater-manager tests.
- External REST API desktop release route tests: 4 tests pass.
- Release coordinate contract: 36 assertions pass, including the frozen
  historical minimum and compatible-set validation.

These checks do not exercise a signed package, actual platform updater, package
permissions, native menu screenshots, or upgrade/downgrade installation.
Minikube, full E2E, and all-six-target native certification are separate lanes.
Signing credentials were unavailable; no native release result is claimed.

The original discovery history, policy evidence, and release-date assessment
remain in sections 2–4. The companion roadmap tracks the outstanding work.

## 10. Post-release: versioned invitation and landing downloads

This work is explicitly **not required to release the Desktop updater**.
Member-registration remains optional for deployments. The owner confirms that
an existing invitation can continue to download an app. If that updater-capable
build is incompatible, startup warns and offers the compatible replacement.
The owner-confirmed advisory policy permits ignoring that alert; this flow
does not guarantee that incompatible operations can never be attempted. The
downloaded build must contain the new startup check/update capability; historical
binaries cannot acquire it remotely. The landing rollout must not distribute a
pre-updater binary and claim it has the new compatibility notification behavior.

The follow-up spans member-registration, Profile UI, and landing:

1. Obtain the inviting deployment's newest compatible Desktop version from the
   same backend-owned policy. Carry an explicit release version through the
   email/template or invitation download handoff. Preserve the invitation accept
   link and onboarding token flow; a Desktop download link does not replace it.
2. Use a first-party landing download URL with an explicit requested version,
   such as `/download?version=0.12.1` on the configured landing origin. This is an
   illustrative contract, not an implemented route. Do not send users to a
   GitHub release page. OS/architecture detection happens when the recipient
   opens the link, because the sender cannot know their device.
3. Add exact-version resolution to landing's server endpoint, browser page,
   no-JavaScript path, rewrites, and cache keys. A versioned request must not
   be overwritten by `/releases/latest` or a cached different version. Download
   the selected version/platform asset directly; GitHub can remain the upstream
   byte host behind the first-party resolver/proxy.
4. Give browser users an explicit OS/architecture override when native detection
   is uncertain. Missing/invalid/unpublished versions or unavailable platform
   assets need a visible recovery state rather than a silent global-latest swap.
   Final presentation can be designed when this post-release work starts.
5. Do not put invitation/setup tokens, email addresses, tenant credentials, or
   arbitrary download destinations in landing URLs. Preserve safe version-only
   links and HTML escaping. Recheck backend compatibility when the installed
   app starts: a pinned email can outlive the backend policy that generated it.

| Post-release ID | Acceptance condition                                                                                                                                                                                                                        |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PW-01           | New invitation download links carry the inviting deployment's explicit compatible Desktop version, and the Profile UI download action preserves it. Optional deployments without member-registration still work.                            |
| PW-02           | Opening the first-party link selects that exact version and the recipient's OS/architecture and starts a direct asset download without a GitHub page. User override works when detection is uncertain.                                      |
| PW-03           | Server/browser/no-JavaScript/cache/rewrite paths preserve version selection; malformed or missing artifacts do not silently select another release.                                                                                         |
| PW-04           | Invitation acceptance, password/setup flows, safe URL handling, and token privacy remain intact. An email opened after a backend change still receives startup checking and mismatch notification without a usage gate.                     |
| PW-05           | Invitation and landing deployment order is independent of the core updater release. Before versioned emails are enabled, the first-party resolver is deployed and the default downloaded build has the new startup check/update capability. |

## 11. Confirmed product decisions

All three questions were answered by the owner on October 23, 2026. No product
question remains open. The implementation uses electron-updater and
electron-builder. Signing-secret availability, release ordering, and native
verification remain open engineering gates, not product questions.

| ID   | Question answered                                 | Confirmed decision                                                                                                                                                            |
| ---- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q-01 | Must an already compatible app update at startup? | No. Keep it usable. Manual checking may download a newer compatible build and offer restart now/later.                                                                        |
| Q-02 | What if fresh startup verification fails?         | Always attempt verification, but never intentionally restrict usage on failure. Show honest status, let users do what works, and check again when they retry or close/reopen. |
| Q-03 | Can a manually discovered mismatch defer restart? | Yes. Offer restart now/later and impose no usage restriction. Users may ignore the alert and attempt operations; incompatibility may cause natural failures.                  |

The owner's instruction to never intentionally block usage applies to startup
mismatch notifications as well. Earlier hard-blocking startup/workspace designs
are superseded. A user-selected startup update still authorizes immediate
installation/restart; dismissing its alert does not. Compatibility warnings do
not weaken existing authentication, authorization, or verified-installation rules.
