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

## The environment model

You save only the **External REST API URL** for an instance. The app then asks
that API for the rest of the environment — the display name and the RPC proxy
URL — and caches it locally. There is no second URL to type: the RPC proxy is
**discovered**, not entered.

## Setup paths

Three ways to add an environment; all of them end with the same saved
environment.

### 1. Manual, from the sign-in screen

Click the **+** beside **Environment**, give it a **name** and the **External
REST API URL**, and save. Both fields are required. The app discovers the RPC
proxy, and you can sign in.

For a local minikube cluster, follow the
[Quickstart](../get-started/quickstart.md) port-forwards and point the
environment at the forwarded External REST API.

### 2. From Profile UI, by deep link

A member can hand the app its environment from the browser: in **Profile UI →
Settings → Setup desktop app**, copy the External REST API and click **Open
desktop app and setup**. That opens an `evenfire://desktop-environment` deep
link the installed app handles — it saves or updates the environment, and if the
External REST API was already saved, it updates the name and re-discovers the
RPC proxy. Fleets can also be pre-seeded with a `CLERUM_DESKTOP_CONFIG_PATH`
config file (see
[Ship it to your users](../surfaces/desktop-app.md#ship-it-to-your-users)).

### 3. Through an invitation

When the app starts with **no selected environment**, it runs invitation
detection. Completing the [Profile UI](../surfaces/profile-ui.md) invitation
flow hands the app a setup token (an `evenfire://desktop-setup` deep link); the
app then saves the tenant environment by name and discovers its RPC proxy.

> **Gap:** invitation signup depends on `member-registration-service`, which is
> not in this repo. See the
> [member-registration gap](../surfaces/desktop-app.md#the-member-registration-service-gap)
> for what still works without it.

## Localhost

**Localhost** always sits at the bottom of the environment list. In a packaged
build it stays **unselected** until you pick it, so invitation detection can run
on first launch; running through local dev commands selects it by default.

## Updates

After you authenticate, the app checks the **currently selected tenant** for its
update policy, so different tenants can be on different versions at the same
time. It asks that tenant's External REST API for its release info, including a
`minimumDesktopVersion`. If the installed version is **below** that minimum, the
app shows an **update-required** screen and opens the release page for the new
build (tag `desktop-app-<version>`) in your browser. (A packaged distribution is
where this matters most — a source checkout can just pull the latest.)

This is update **detection**, not silent auto-install: the app tells the user an
update is required and links the release. Code signing, notarization, and
automatic download/install are not part of this repo — see
[Ship it to your users](../surfaces/desktop-app.md#ship-it-to-your-users).

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
