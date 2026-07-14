# Profile UI

Profile UI is a Next.js frontend for invited-member profile access and
invitation confirmation, on port 3001. It talks to exactly one backend
service — `external-rest-api` — and never reaches `control-api` or
`rpc-proxy`. Browser calls are same-origin (`/external-rest-api/*`, rewritten
by `next.config.js` to `EXTERNAL_REST_API_INTERNAL_URL`). Unlike the other
two surfaces, this one is deliberately small: its only job is to get a
person from "invited" to running the [Desktop App](desktop-app.md). See [UI
Surfaces](README.md) for how the three consoles divide the platform.

## The invitation flow

1. **An invite is created** — either by an admin in the [Control
   UI](control-ui.md) (through `control-api`), or by an authenticated
   Profile UI member at `/members/invite`, which posts to `external-rest-api
   POST /api/v1/members/invite`.
2. **The invited person opens `/invitations/[token]`** — no Profile UI login
   required. The page loads the invitation preview from `external-rest-api
   GET /api/v1/invitations/token/:token` before it renders.
3. **They accept it**, then **set a password** on the same screen: the
   invitation token, email, invitation id, and new password all go to
   `external-rest-api POST /api/v1/invitations/password`; the temporary
   invitation session never leaves the server.
4. **Profile UI offers a Download Evenfire link** — not an automatic
   handoff. The member installs the [Desktop App](desktop-app.md)
   themselves.
5. **The Desktop App completes the handoff later**, from its own sign-in
   screen: entering the invited email there makes the Desktop App look up
   the invitation profile and open Profile UI's `/desktop-setup?email=...`
   in the system browser. The member enters their password once more;
   Profile UI exchanges it for a short-lived authorization token
   (`external-rest-api POST /api/v1/invitations/desktop-authorization`) and
   hands it back to the installed app through the `evenfire://desktop-setup`
   deep link.

Step 5's lookup and completion both depend on `member-registration-service`,
which is **not in this repository** — see the Desktop App page's
[`member-registration-service` gap](desktop-app.md#the-member-registration-service-gap)
for what breaks without it.

## Routes

- `/` — password login when signed out, profile home once signed in.
- `/settings` → `/settings/profile`, plus `/settings/social` and
  `/settings/social/[network]` for channel linking.
- `/members`, `/members/[userId]`, and `/members/invite` — team membership
  management.
- `/approval-channels` and `/connected-accounts` — notification and
  linked-account preferences.
- `/invitations/[token]` and `/forgot-password` — reachable without a
  session.
- `/desktop-setup` — the Desktop App handoff, above.

## Deploy

Profile UI ships in the platform Kustomize bases —
`deploy/base/profiles/profile-ui.yaml`, a single-replica Deployment on port
3001 in the `profiles` namespace — applied from the repo root via the
overlays (`make minikube-deploy-all`). There is no per-service
`make deploy`.

```bash
npm run ui    # Control UI, Desktop App, and Profile UI together
```

## Next

- [UI Surfaces](README.md) — the persona matrix across all three consoles
- [Control UI](control-ui.md) — the admin console
- [Desktop App](desktop-app.md) — the end-user client
