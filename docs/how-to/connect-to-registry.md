# How to: connect a self-hosted deployment to the registry

The Evenfire registry (`registry.evenfire.ai`) is a shared catalog of connectors
and recipes. A **managed** deployment is connected for you; a **self-hosted**
deployment connects itself, once. Depending on how the registry is configured,
that either completes on its own or waits for an Evenfire operator to approve
the request. This guide covers the self-hoster's side of that flow. Once
connected you can install from the catalog, [publish under your own org](publish-plugin-to-registry.md),
and use registry SSO from your Control UI.

## Prerequisites

- `REGISTRY_CONNECTION_MODE=self-hosted` on `control-api`. The default is
  `managed`, and the connect flow only runs in self-hosted mode — a managed
  deployment is connected automatically, so the panel has nothing to configure.
- `CLERUM_REGISTRY_URL` set, with outbound HTTPS to the registry.
- `CLERUM_REGISTRY_URL` must be in the allowlist. `https://registry.evenfire.ai`
  and `http://registry-api.registry.svc.cluster.local:8085` are built in; add
  any other registry URL via `CLERUM_REGISTRY_URL_ALLOWLIST`. control-api
  refuses to start if the configured URL is not allowlisted.
- You are an **admin** in your Control UI.

## Connect

Open **Control UI → Registry → Connect** (`/registry/connect`). The panel walks
one of two state machines, depending on how the registry is configured:

- Auto-approved: `disconnected → connecting → connected`
- Operator-approved: `disconnected → pending → approved → connected`

1. **Request access.** You enter an organization name and a contact email. Your
   control-api generates a signing keypair, registers with the registry, and
   saves the row. (The keypair is how the registry knows later requests really
   come from this deployment. It never leaves your cluster.)

2. **What happens next depends on the registry.**
   - **Open registration enabled** — the registry approves immediately and the
     panel finishes connecting on its own. No operator is involved and no claim
     token is ever shown to a human. If that automatic step cannot complete (a
     network blip, or the registry briefly unavailable), the panel shows
     **Finishing the connection** with a **Finish connecting** button; press it
     to retry. In most cases, retrying with **Finish connecting** will succeed and
     you never need a token. If the panel says to contact support, do that: a
     suspended deployment can be reversed by Evenfire, and **Start over** would
     destroy a keypair you may still need. Only use **Start over** when the
     panel says the deployment's one-time credentials were issued but never
     stored. That connection cannot be recovered: **Start over** permanently
     deletes the deployment's stored registry credentials and gives up the
     organization name. If you use **Start over**, you must register again
     under a different organization name.

   - **Open registration disabled** — the request lands as **pending**. An
     Evenfire operator reviews it and either approves or rejects it. On
     approval you receive a one-time claim token out of band; paste it into the
     panel to finish connecting. Use **Refresh status** to check whether the
     decision has landed.

3. **Connected.** The deployment holds its machine credentials and can read the
   catalog, publish entries, and push images to its own org.

## What connecting gives you

- **Install** connectors and recipes from the catalog into your cluster.
- **Publish** your own connectors and recipes under `@<your-org>/…` — see
  [Publish a plugin to the registry](publish-plugin-to-registry.md).
- **SSO** to registry API keys from your own Control UI.

## API keys for programmatic publishing

Once connected, browsing the public catalog, publishing, and image push/pull all
work using the credential stored when you claimed the connection — no further
setup is needed for those.

**Creating and managing API keys** (`efrk_` org keys, used for CI and other
programmatic publishing) needs registry authentication active. In self-hosted,
connecting is sufficient: authentication turns on automatically the moment
this deployment holds machine credentials, which is as soon as the connect
flow above completes. There is no flag to set and no restart.

The registry URL allowlist still applies regardless of authentication: any
explicitly self-hosted deployment with a registry URL configured must have
that URL in the allowlist. `registry.evenfire.ai` is allowed by default; add
others via `CLERUM_REGISTRY_URL_ALLOWLIST`.

## If something goes wrong

- **Already connected** — a deployment has one connection; there is nothing more
  to do.
- **Request rejected** — the operator declined (often an org-name conflict).
  Adjust the requested name and request again.
- **Claim token expired or rejected** — ask the operator to re-issue it; tokens
  are single-use and time-limited.

## Not in this repo

The approval side lives in Evenfire's operator console, which is part of the
managed service, not this repository — this guide covers only the self-hoster's
side. See [Open core: self-host vs hosted](../concepts/open-core-and-hosted.md).
