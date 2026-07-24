# Get started on minikube

`make minikube-setup` stands up the whole platform on a local cluster — every
service, deny-all NetworkPolicies, the JWT chain, and a seeded agent named
`chatllm`. It starts with an empty connector context — mcp-host's native tools
(shell, file read/write, HTTP, memory) need no MCP server; install connectors
from the registry when you want more. Setup infers the provider from whichever
single LLM key you set in `.env`.

## Prerequisites

Docker Desktop with **≥10 GB RAM / 6 CPUs** · `minikube` v1.30+ · `kubectl` ·
`python3` · Node.js 24+ · `git` · `make` · `ruby` (renders the control-api DB
migration overlay; ships with macOS, `apt-get install ruby` on Debian/Ubuntu).

## Bring the platform up

```bash
git clone https://github.com/evenfire-ai/evenfire.git && cd evenfire
cp .env.example .env
# edit .env: set ADMIN_PASSWORD (required — no default ships) and ONE LLM key
# (setup infers the matching provider)
make minikube-setup     # first run ~5–10 min (image builds dominate); re-run safe
make minikube-status    # wait for every deployment READY
```

## Say hello (desktop app)

The UIs run from your workstation, so install their dependencies once, then run
them against the cluster:

```bash
make install-all && npm --prefix control-ui install
npm run ui              # Control UI + Profile UI + Desktop App
```

Log in as `admin@evenfire.local` using the `ADMIN_PASSWORD` you set in `.env`,
message the `chatllm` agent, and ask it to run a command or generate a PDF —
then approve the tool call from the chat. The same password logs into the
Control UI as `admin`. The Desktop App is the client you just used; Control UI
is the admin console for the same fleet — both are toured in
[docs/surfaces/](../surfaces/README.md).

## Prefer the API path?

The full curl walkthrough exercises the real session → scoped-RPC → rpc-proxy
JWT chain, with troubleshooting notes:
[quickstart.md](quickstart.md) ·
[deploy/minikube.md](../deploy/minikube.md) · production:
[deploy/production.md](../deploy/production.md).

## See also

- [See it work: a tool call, end to end](../concepts/tool-call-end-to-end.md)
- [Learning path](learning-path.md) — role-based route through the docs
