# How to: connect a self-hosted deployment to the registry

The Evenfire registry (`registry.evenfire.ai`) is a shared catalog of connectors
and recipes. A **managed** deployment is connected for you; a **self-hosted**
deployment connects itself, once — after an Evenfire operator approves the
request. This guide covers the self-hoster's side of that flow. Once connected
you can install from the catalog, [publish under your own org](publish-plugin-to-registry.md),
and use registry SSO from your Control UI.

## Prerequisites

- `REGISTRY_CONNECTION_MODE=self-hosted` on `control-api`. The default is
  `managed`, and the connect flow only runs in self-hosted mode — a managed
  deployment is connected automatically, so the panel has nothing to configure.
- `CLERUM_REGISTRY_URL` set, with outbound HTTPS to the registry.
- You are an **admin** in your Control UI.

## Connect

Open **Control UI → Registry → Connect** (`/registry/connect`). The panel walks a
small state machine — `disconnected → pending → approved → connected`:

1. **Request.** Enter a **requested org name** and a **contact email**, and
   submit. Your control-api generates a signing keypair, registers the request
   with the registry, and saves it as **pending**. (The keypair is how the
   registry later confirms the claim really comes from your deployment — you
   never handle it.) A reserved or blocked org name is refused up front.
2. **Wait for approval.** An Evenfire operator reviews the request and either
   approves or rejects it. The panel polls the registry, so the decision appears
   without you re-submitting.
3. **Claim.** On approval the operator sends you a **one-time claim token**
   out-of-band. Paste it into the panel to finish connecting. The token is
   single-use and short-lived.
4. **Connected.** The panel shows your bound org. You can now install catalog
   entries, mint publish keys, and use registry SSO.

## What connecting gives you

- **Install** connectors and recipes from the catalog into your cluster.
- **Publish** your own connectors and recipes under `@<your-org>/…` — see
  [Publish a plugin to the registry](publish-plugin-to-registry.md).
- **SSO** to registry API keys from your own Control UI.

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
