# Control UI (Next.js)

Internal React/Next.js dashboard for `control-api`.

## Features

- Tabbed explorer for:
  - Hosts
  - Connectors
  - Communication Channels
  - LLM Secrets
- Row-style resource listing with click-to-expand details
- Secret-safe display (redacts secret-like fields in expanded JSON)
- Guided host creation wizard:
  1. Host naming
  2. Context creation + unique connector selection
  3. Communication channel setup (dropdown + inputs)
  4. Existing/new LLM secret selection
  5. Host model/provider config + review (OpenAI, Claude, Z.AI presets + custom model override)
- Profile admin tab (team/member administration):
  - users table with row action to load selected user context
  - explicit `userId` and team selectors
  - create/rename team
  - list/delete members
  - update member role
  - invite member
- LLM secrets management:
  - list host-secret resources
  - create/update/delete LLM API key secrets
  - backend-safe behavior (secret values are write-only from UI)

## Local

```bash
cd control-ui
npm install
```

Then from the repository root:

1. Start the UI with:

```bash
npm run web
```

This reuses the root `Makefile` to start `control-api` on `localhost:8090`, waits until the port is reachable, then runs `control-ui` locally. When you exit, the port-forward is stopped too.

## Deploy

```bash
cd control-ui
make docker-push
make deploy
```

In-cluster service URL:

`http://control-ui.control-plane.svc.cluster.local:3000`

Notes:

- Browser requests use same-origin `/control-api/*`.
- A dedicated Next.js route handler proxies those requests to `CONTROL_API_INTERNAL_URL`.
- UI assumes cluster-admin trust boundary (for example SSH/VPN access controls) and does not require end-user login.
