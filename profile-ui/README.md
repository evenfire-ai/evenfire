# Profile UI

`profile-ui` is a Next.js frontend for Evenfire user profile access and invitation confirmation.

## Features

- Password login through `external-rest-api /api/v1/auth/password-login`
- Authenticated profile home with the signed-in user and email
- Authenticated settings route placeholder
- Invitation confirmation route at `/invitations/[token]`
- Desktop app authorization route at `/desktop-setup`

## Environment

See `.env.example`.

Important variables:

- `NEXT_PUBLIC_EXTERNAL_REST_API_BASE_URL`
- `EXTERNAL_REST_API_INTERNAL_URL` (server-side proxy target)

## Local

```bash
cd profile-ui
npm install
EXTERNAL_REST_API_INTERNAL_URL=http://localhost:8091 npm run dev -- --port 3001
```

Invitation flow:

- `control-ui` creates the invite in `control-api`
- `control-ui` asks `external-rest-api` to trigger invite delivery, and `external-rest-api` delegates the actual email send to `member-registration-service`
- `profile-ui` loads `/invitations/[token]` without requiring profile login
- the invited user accepts the invitation through the unauthenticated invitation route
- after confirmation, `profile-ui` lets the invited user set their password before downloading Evenfire
- password setup sends only the invitation token, email, and password to `external-rest-api`; the temporary invitation session stays server-side

## Deploy

```bash
cd profile-ui
make deploy
```
