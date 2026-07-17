# How to: set up member invitations on a self-hosted deployment

Self-hosted evenfire can send invitation emails **out of the box** using
evenfire's shared registration hub — no credentials, no SMTP setup, no extra
service. You opt in with one environment variable; the platform enrolls itself.

## The zero-config path (hosted mode)

Set on the **control-api** container (in your overlay's ConfigMap):

| Variable | Value |
|---|---|
| `CONTROL_API_MEMBER_REGISTRATION_MODE` | `hosted` |

Requirements:

- `CONTROL_API_DESKTOP_PROFILE_UI_BASE_URL` and `CONTROL_API_CONTROL_UI_BASE_URL`
  must point at **real, publicly resolvable domains** (e.g.
  `https://profile.acme.com`). Hosted mode refuses `localhost`, IP literals, and
  dotless hostnames — invitation links are emailed to recipients, so they must
  resolve outside your machine.
- Outbound HTTPS from control-api to `registration.evenfire.ai`.

What happens: on boot, control-api registers itself with the hub once per UI
domain, stores the returned credential encrypted in its own Postgres, and
reuses it forever after. Invitation, admin-invitation, email-confirmation, and
admin password-reset emails are then sent **from evenfire's own sending
address**, through evenfire's infrastructure — you configure no SMTP provider
and no email DNS (SPF/DKIM) of your own. Emailed links pass through a short
`registration.evenfire.ai/i/…` interstitial that names your domain before
continuing.

No other configuration is read in hosted mode: the legacy
`CONTROL_API_MEMBER_REGISTRATION_SERVICE_BASE_URL` value in the base ConfigMap
and the deploy-injected `CONTROL_API_MEMBER_REGISTRATION_HMAC_SECRET` are both
ignored by design. If you previously configured a remote identity
(`CONTROL_API_MEMBER_REGISTRATION_HMAC_KID` /
`CONTROL_API_MEMBER_REGISTRATION_TENANT_ID`), remove those two variables —
control-api refuses to start hosted mode while they are set, and the error
names them.

If something goes wrong, control-api keeps running and invitations fail with
a clear error instead — see [when things go wrong](#when-things-go-wrong).

To point at a different hub (e.g. staging), set
`CONTROL_API_MEMBER_REGISTRATION_EXTERNAL_HUB_BASE_URL`.

## How hosted mode works

You don't need any of this to use hosted mode — the section above is the
whole setup. This explains what actually happens, so nothing about it
surprises you or your invitees.

### Enrollment happens once, at boot

When control-api starts in hosted mode, it takes the hostnames of
`CONTROL_API_DESKTOP_PROFILE_UI_BASE_URL` and `CONTROL_API_CONTROL_UI_BASE_URL`
(deduplicated — ports are ignored) and registers each one with the hub in a
single call per domain. The hub answers with a credential — a tenant id like
`ext-…`, a key id, and a signing secret — bound to that domain. There is no
account to create and no key to copy: **the domain itself is the identity.**

Enrollment runs in the background after control-api is already listening, so
a slow or unreachable hub never delays startup.

### Credentials live in your own database

The credential is stored AES-256-GCM-encrypted in control-api's own Postgres
(the `member_registration_credentials` table), under the platform's existing
at-rest encryption key. Every later boot, restart, or redeploy **reuses** the
stored credential — control-api never re-registers a domain it already holds
a credential for, and there is nothing new to back up beyond the database you
already operate.

If you move a UI to a new domain, control-api enrolls the new domain on its
next boot (or next invitation) and the old credential simply stops being
used. To deliberately discard a domain's credential, mark its row revoked
(`UPDATE member_registration_credentials SET revoked_at = NOW(),
secret_encrypted = '' WHERE bound_domain = '<host>';`) — the next invitation
re-enrolls fresh. One honest caveat: local revocation does not invalidate the
old credential on evenfire's side. If you believe a credential has leaked,
report it (see [SECURITY.md](../../SECURITY.md)) so it can be revoked at the
hub as well.

### One credential per destination host

The hub binds each credential to exactly one domain and refuses to send an
invitation whose link points anywhere else. Member invitations link to your
Profile UI; admin invitations, email confirmations, and admin password resets
link to your Control UI — so when those are different hostnames, control-api
holds one credential for each and signs every request with the credential
matching that request's destination. This is also *why* both base URLs must
be real, publicly resolvable domains: the domain is what the credential is
bound to, and it is where your invitees will be sent.

### What your invitees see

The email arrives from **evenfire's sending address** (at the time of
writing, `info@joinevenfire.com`) rather than from your domain — that is what
makes the no-SPF/DKIM-setup promise possible.

The link inside is not a direct link to your Profile UI. It goes to
`https://registration.evenfire.ai/i/<token>` — a small page that says the
invitation was sent through Evenfire on behalf of **your** domain, and asks
for one click to continue. Only then does the browser land on
`https://<your-profile-ui>/invitations/<token>`. Tell your users to expect
that hop; it is deliberate:

- it stops evenfire's domain from acting as an open redirect (the page names
  the destination before navigating anywhere), and
- it gives evenfire a kill switch against abuse: if a credential is revoked
  or a destination domain is blocked, already-delivered links stop working at
  click time instead of living forever in inboxes.

### When things go wrong

Hosted mode never takes control-api down. Every failure degrades to a clear
error on the invitation endpoints while the rest of the platform keeps
running:

| Symptom | Cause | What to do |
|---|---|---|
| Invitations return `503 member_registration_unavailable` | The hub is unreachable, or enrollment hasn't succeeded yet | Check egress to `registration.evenfire.ai`. Nothing to restart — control-api retries on the next invitation. |
| Invitations return `503 member_registration_misconfigured`; the boot log says "requires a real, publicly resolvable domain" | A UI base URL points at `localhost`, an IP literal, or a single-word hostname | Set the two UI base URLs to real domains. |
| control-api refuses to start, naming `CONTROL_API_MEMBER_REGISTRATION_HMAC_KID` / `…_TENANT_ID` | Leftover remote-mode identity from a previous setup | Remove those two variables — hosted mode manages its own identity. |
| Boot log warns `CONTROL_API_MEMBER_REGISTRATION_HMAC_SECRET is set but IGNORED` | The standard deploy injects this legacy value | Nothing — harmless by design. |

## The advanced path (remote mode — run your own service)

If you prefer to run your own `member-registration-service` instance (a
separate repository), leave the mode unset (`remote`) and configure it exactly
as before:

| Variable | Value |
|---|---|
| `CONTROL_API_MEMBER_REGISTRATION_SERVICE_BASE_URL` | your instance, e.g. `http://member-registration-service.registration.svc.cluster.local:8092/api/v1` |
| `CONTROL_API_MEMBER_REGISTRATION_HMAC_SECRET` | the per-tenant HMAC secret your instance minted |
| `CONTROL_API_MEMBER_REGISTRATION_HMAC_KID` | the matching key id |
| `CONTROL_API_MEMBER_REGISTRATION_TENANT_ID` | the matching tenant id |

Email delivery (SMTP/provider) is configured in that service — see its
repository's docs.

## Choosing

- **Hosted mode**: zero setup, emails "just work", subject to evenfire's
  per-domain send quotas and abuse controls. Your instance is identified to the
  hub by your UI domain.
- **Remote mode**: full control and your own sender identity, at the cost of
  deploying and operating the service plus email DNS (SPF/DKIM) yourself.

## Related

- [Open core: self-host vs hosted](../concepts/open-core-and-hosted.md) — why
  this service lives outside the repo
- [Desktop setup & updates](desktop-setup-and-updates.md) — the invitation flow
  these emails feed into
- [Production notes](../deploy/production.md) — deployment checklist
