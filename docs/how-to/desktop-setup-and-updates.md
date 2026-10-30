# How to: set up Desktop App environments and updates

The Desktop App is **one packaged build** that any number of people point at any
number of evenfire instances — your production tenant, a staging tenant, or a
local `make`-forwarded cluster. This guide covers adding and switching
**environments**, the three setup paths, and how the app handles **updates**.
For packaging and shipping the build itself, see
[Ship it to your users](../surfaces/desktop-app.md#ship-it-to-your-users).

## When you need this

- You run more than one instance (say, staging and production) and want to
  switch between them in one app.
- You are onboarding through an **invitation** rather than a shared login.
- You distribute a **packaged** build and want users to know when a new release
  requires them to update.

### Self-hosted first administrator

The first Control Admin created by the self-hosted `/admin/auth/setup` bootstrap
is a separate setup path from invitation onboarding. The Desktop identity
provisioned for that admin is linked directly for GFS operator access when the
self-hosted deployment enables the operator-link setting. Control UI displays
the exact pair and provides **Revoke/disable Desktop GFS operator access**;
revoking it removes only GFS authority and preserves the admin account,
passwords, identities, and unrelated permissions. The same surface provides an
explicit **Reactivate Desktop GFS operator access** action that creates a new
generation from retained history; it never restores a revoked row in place.
Retiring the linked Control Admin revokes the active generation before the
admin is disabled. Invitations and ordinary member provisioning do not create,
repair, or reassign this link.

## The environment model

You save only the **External REST API URL** for an instance. The app then asks
that API for the display name and RPC proxy URL when the environment is saved
or selected. Startup also retries discovery for a saved profile without an RPC
URL. Discovery can happen before sign-in; there is no second URL to type or
include in a Profile UI link.

If discovery fails before sign-in, authentication can still succeed. A later
health check can discover and use RPC for the live session without changing its
saved environment, credential slot, chat binding, or GFS scope. Settings shows
the saved RPC URL and display name, so it may still show an empty RPC URL while
RPC health is healthy. The discovered URL and name are saved at the next safe
signed-out boundary. If that optional save fails, authentication still ends and
a later health check retries discovery and persistence. A failed team switch
that clears the session also clears its live RPC override.

## Setup paths

Three ways to add an environment; all of them end with the same saved
environment.

### 1. Manual, from the sign-in screen

Click the **+** beside **Environment**, give it a **name** and the **External
REST API URL**, and save. Both fields are required. The app discovers the RPC
proxy before sign-in, then you can sign in with the configured REST and RPC
endpoints.

For a local minikube cluster, follow the
[Quickstart](../get-started/quickstart.md) port-forwards and point the
environment at the forwarded External REST API.

### 2. From Profile UI, by deep link

When Profile-to-Desktop handoff is enabled, a member can open the environment
from **Profile UI → Settings → Setup desktop app**. Desktop selects a single
saved environment with the matching REST endpoint, including its API path and
query. URL matching ignores fragments and trailing path slashes and normalizes a
terminal DNS root dot. A different path on an already-saved origin is rejected
for manual resolution. If the current session uses another REST URL, Desktop
asks before switching. Cancel keeps the current session signed in; confirming
signs out and then selects the matching saved environment. If no exact match is
saved, Desktop asks before adding the environment; after confirmation, the
External REST API supplies the RPC proxy URL before sign-in. Duplicate saved
matches are rejected unless the already-active environment itself matches the
requested REST endpoint; that exact active environment is retained.

The handoff is disabled by default. A release operator can enable it by setting
the `PROFILE_DESKTOP_HANDOFF_ENABLED` repository variable to `true` when
building Profile UI, after releasing the updated Desktop client and retiring
older supported clients. Changing the repository variable alone does not build
a new image: the normal build runs only when Profile UI source paths change, or
the **Build & Publish** workflow can be dispatched with `build_all=true` to
rebuild every image. Production promotion reuses the digest built from dev, so
rebuild Profile UI before promotion when the variable was the only change.
Before enabling the handoff, verify that `EXTERNAL_REST_API_PUBLIC_BASE_URL`
and `CONTROL_API_DESKTOP_EXTERNAL_REST_API_BASE_URL` point to the same REST
endpoint, including the API path. Matching only the hostname is not sufficient.
While the handoff is disabled, copy the REST API URL from Profile UI Settings
and add it from Desktop's sign-in screen. Fleets can also be pre-seeded with a
`CLERUM_DESKTOP_CONFIG_PATH` config file (see
[Ship it to your users](../surfaces/desktop-app.md#ship-it-to-your-users)).

### 3. Through an invitation

When the app starts with **no selected environment**, it runs invitation
detection. Completing the [Profile UI](../surfaces/profile-ui.md) invitation
flow hands the app a setup token (an `evenfire://desktop-setup` deep link); the
app then saves the tenant environment by name and discovers its RPC proxy.

> **Gap:** the invitation email and the Profile UI signup flow above can now
> run with nothing extra to deploy, via control-api's **hosted mode** — see
> [Member invitations on self-hosted](member-invitations-self-hosted.md).
> Completing the handoff into the Desktop App itself still depends on
> `member-registration-service`, which is not in this repo. See the
> [member-registration gap](../surfaces/desktop-app.md#the-member-registration-service-gap)
> for what still works without it.

## Localhost

**Localhost** always sits at the bottom of the environment list. In a packaged
build it stays **unselected** until you pick it, so invitation detection can run
on first launch; running through local dev commands selects it by default.

## Updates

When an environment is selected, Desktop checks its External REST API release
policy at startup, including before sign-in. Each backend deployment chooses a
recommended Desktop version and the exact set of Desktop versions it supports.
The app uses that selected backend's policy; it does not use GitHub's global
latest release.

If the installed version is in the compatible set, the app remains usable and
does not prompt at startup, even if the backend recommends a newer build. If it
is outside the set, a dismissible notice offers the backend's recommended
update. Windows and Linux download, install, and restart after the user's
consent. On macOS, Desktop downloads and verifies the published DMG, then asks
the user to open it and manually replace Evenfire in Applications. Dismissing
the notice does not block app use or persist an opt-out: an incompatible build
is checked again on the next launch.

Choose **Evenfire → Check for Updates** on macOS, **Help → Check for Updates**
on Windows/Linux, or **Settings → Information → Check for updates** to check
manually. If a different compatible build is available, Desktop downloads the
exact release ZIP for the backend-selected version and current OS/architecture,
and checks its size and SHA-256 digest against GitHub release metadata. On
macOS, it extracts the original DMG, verifies the application version,
architecture, signature, developer team, and macOS trust assessment, then saves
`Evenfire-v<VERSION>.dmg` in Downloads. Open installer and drag Evenfire into
Applications to replace the existing app, then reopen it. Opening the DMG does
not install the update. On Windows and Linux, Desktop installs after consent and
offers the existing restart timing controls. The minimum supported target is
v0.8.0.

If the compatibility check fails, Desktop reports that it could not verify the
build and leaves the app available. Try again from Settings or close and reopen
the app. An update uses only the verified asset chosen by the app; users do not
select another build on GitHub during the normal flow. The existing Forge
release process remains unchanged.

Existing releases without the integrated updater cannot acquire it remotely.
The first updater-capable version must be installed through the normal
distribution process. The versioned invite-email/Profile UI/landing download
follow-up is separate and is not required for these update checks. See
[Ship it to your users](../surfaces/desktop-app.md#ship-it-to-your-users) for
release and signing details.

## Troubleshooting

- **Wrong instance after switching** — each environment caches its own RPC
  proxy; re-open the **Environment** screen and confirm which instance is
  selected.
- **Stale RPC proxy** — re-running the Profile UI **Setup desktop app** for an
  already-saved External REST API updates the name and clears the cached RPC
  proxy so it is re-discovered.
- **Signed in to the wrong tenant** — authentication is per environment; sign
  out, reselect the environment, and sign in again.

## Related

- [Desktop App surface](../surfaces/desktop-app.md) — screens, packaging, env vars
- [Profile UI](../surfaces/profile-ui.md) — the invited-member entry point
- [Quickstart](../get-started/quickstart.md) — local minikube bring-up
