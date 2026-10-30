# Profile UI

`profile-ui` is a Next.js frontend for Evenfire user profile access and invitation confirmation.

## Features

- Password login through `external-rest-api /api/v1/auth/password-login`
- Authenticated profile home with the signed-in user and email
- Authenticated settings surface at `/settings` (redirects to `/settings/profile`) for editing your profile, changing your password, and managing social channels (`/settings/social`, `/settings/social/[network]`)
- Authenticated member invitation route at `/members/invite`, which posts to `external-rest-api /api/v1/members/invite`
- Invitation confirmation route at `/invitations/[token]`
- Desktop app authorization route at `/desktop-setup`

## Environment

See `.env.example`.

Important variables:

- `NEXT_PUBLIC_EXTERNAL_REST_API_BASE_URL`
- `NEXT_PUBLIC_PROFILE_DESKTOP_HANDOFF_ENABLED` (build-time; defaults to `false`)
- `EXTERNAL_REST_API_INTERNAL_URL` (server-side proxy target)

The Profile-to-Desktop environment handoff is disabled by default to protect older
Desktop clients from ambiguous REST-only links. Enable it only after the updated
Desktop consumer is released and operators have verified that older supported
clients are no longer in use. Image builds can set the repository variable
`PROFILE_DESKTOP_HANDOFF_ENABLED=true`; unset or `false` keeps the handoff disabled.
Changing this repository variable alone does not rebuild the Profile UI image.
The normal **Build & Publish** workflow builds Profile UI only when its source
paths change; dispatch that workflow with `build_all=true` to rebuild every
image when the variable was the only change. Production promotion reuses the
dev-built digest and does not rebuild, so create the desired digest before
promoting it.

Before enabling handoff, ensure Profile UI and Desktop use the same External
REST API endpoint, including the API path. Desktop rejects a link when the same
origin is already saved with a different API path.

## Local

```bash
cd profile-ui
npm install
EXTERNAL_REST_API_INTERNAL_URL=http://localhost:8091 npm run dev -- --port 3001
```

Invitation flow:

- an invite is created either by `control-ui` in `control-api`, or by an authenticated `profile-ui` user through `/members/invite`
- `control-ui` (or an authenticated `profile-ui` user via `/members/invite`) asks `external-rest-api` to create the invitation, which it does through `control-api`
- `profile-ui` loads `/invitations/[token]` without requiring profile login
- the invited user accepts the invitation through the unauthenticated invitation route
- after confirmation, `profile-ui` lets the invited user set their password before downloading Evenfire
- password setup sends the invitation token, email, invitation id, and password to `external-rest-api`; the temporary invitation session stays server-side

## Deploy

profile-ui ships as part of the platform Kustomize bases — its manifest is
`deploy/base/profiles/profile-ui.yaml`, applied from the repo root via the
overlays (`make minikube-deploy-all`). There is no per-service `make deploy`.
