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
admin password-reset emails are then sent from `no-reply@evenfire.ai` through
evenfire's infrastructure. Emailed links pass through a short
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

If the hub is unreachable, control-api still boots (invitations return a clear
`503 member_registration_unavailable` until enrollment succeeds — it retries
automatically on the next invite).

To point at a different hub (e.g. staging), set
`CONTROL_API_MEMBER_REGISTRATION_EXTERNAL_HUB_BASE_URL`.

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
