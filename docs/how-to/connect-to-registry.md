# How to: connect a self-hosted deployment to the registry

The Evenfire registry (`registry.evenfire.ai`) is a shared catalog of connectors
and recipes. A **managed** deployment is connected for you; a **self-hosted**
deployment connects itself, once, with no human in the loop. You enter an
organization name and a contact email, and the panel finishes on its own. Once
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

Open **Control UI → Marketplace → Connect** (`/marketplace/connect`). The panel
walks `disconnected → connecting → connected`:

1. **Request registration.** You enter an organization name and a contact
   email. Your control-api generates a signing keypair, registers with the
   registry, and saves the row. (The keypair is how the registry knows later
   requests really come from this deployment. It never leaves your cluster.)

2. **The registry approves immediately** and your control-api redeems the
   credentials inline. No operator is involved, and no claim token is ever
   shown to a human.

   If that automatic step cannot complete (a network blip, or the registry
   briefly unavailable), the panel shows **Finishing the connection** with a
   **Finish connecting** button. Press it to retry; in most cases it succeeds.

3. **Connected.** The deployment holds its machine credentials and can read the
   catalog, publish entries, and push images to its own org.

> ⚠️ **Start over is destructive and is rarely the answer.** It permanently
> deletes this deployment's stored registry credentials and gives up the
> organization name, so you must register again under a **different** name.
> Use it only when the panel says the one-time credentials were issued but
> never stored. If the panel tells you to contact support, do that instead: a
> suspended deployment can be reversed by Evenfire, and **Start over** would
> destroy a keypair you may still need.

## What connecting gives you

- **Install** connectors and recipes from the catalog into your cluster.
- **Publish** your own connectors and recipes under `@<your-org>/…` — see
  [Publish a plugin to the registry](publish-plugin-to-registry.md).
- **SSO** to registry API keys from your own Control UI.

## API keys for programmatic publishing

Once connected, browsing the public catalog, publishing, and image push/pull all
work using the credential stored when the connection completed. No further setup
is needed for those.

> **In-cluster image pulls.** When you install a private plugin or recipe whose image
> lives on the evenfire registry, control-api (in self-hosted mode) automatically
> provisions the in-cluster `evenfire-registry-pull` Secret in every platform workload
> namespace — `mcp-server`, `sandbox-recipes` and `sandbox-ui` — so the pods can pull
> the image. You do not create that Secret by hand. It is minted from your
> connection's own registry identity.
>
> **If you pre-provision it yourself, do all three namespaces.** control-api never
> writes a Secret it does not own (one without the `clerum.io/managed-by: control-api`
> label), and the registry's pull credential is **per-organization and rotate-on-call**:
> minting a key for one namespace revokes the key in every other copy, including yours.
> So the moment control-api finds a **working** externally-provided copy in any of the
> three namespaces, it stops minting entirely rather than silently invalidating your
> credential. Installs that need a namespace you left empty then fail with
> `foreign_secret_would_be_revoked`, naming both namespaces. Provide the Secret in all
> three namespaces, or delete your copies and let control-api manage all three — a
> half-external setup is not supported.
>
> A **malformed** external copy is treated differently. One with the wrong `type`, or a
> `.dockerconfigjson` that carries no usable credential for your registry host, can never
> serve a pull, so it does not hold control-api back from minting for the other
> namespaces. "No usable credential" covers two cases: no entry for the host at all, and
> an entry that is present but empty. `{"auths":{"registry.evenfire.ai":{}}}` parses fine
> and matches the host, yet the kubelet finds nothing to send and pulls anonymously. An
> entry has to carry at least one non-empty `auth`, `password`, `identitytoken` or
> `registrytoken`. A malformed copy does fail any install that lands a workload in _its
> own_ namespace, with `foreign_secret_unusable`. Fix that Secret in place, or delete it
> and let control-api manage that namespace.
>
> This is a shape check, not a validity check. A well-formed copy is accepted even if its
> key has since been revoked at the registry. Proving otherwise would cost a registry
> round trip on every install.

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

Registration is refused up front, before anything is saved, in these cases:

- **`org_name_taken`** — another deployment already holds that organization
  name. Pick a different one and request again.
- **`org_blocklisted`** — the name is reserved. Pick a different one.
- **`invalid_contact_email`** — the address was rejected. Correct it and retry.
- **`registration_capacity` / `rate_limited`** — the registry is throttling
  registrations. Wait and retry; nothing is lost.

Once a registration has landed, the panel reports these instead:

- **Already connected** — a deployment has one connection; there is nothing more
  to do.
- **Finishing the connection** — the inline redeem did not land. Press **Finish
  connecting**. This is the normal recovery and needs no token.
- **`already_claimed`** — the one-time credentials were issued but never stored
  here. This connection cannot be recovered; **Start over** under a new
  organization name.
- **`deployment_suspended`** — Evenfire suspended the deployment. Contact
  support. Do **not** press Start over; a suspension can be reversed, a
  destroyed keypair cannot.

## Not in this repo

The registry service itself is part of Evenfire's managed offering, not this
repository — this guide covers only the self-hoster's side. See
[Open core: self-host vs hosted](../concepts/open-core-and-hosted.md).
