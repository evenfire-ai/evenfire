# How to: publish a plugin to the registry

Once your deployment is [connected](connect-to-registry.md), an **org owner** can
publish connectors and recipes under your `@<org>/` scope. You can import an
entry by hand from the Control UI, or — for scripts and CI — publish with an
**org API key** (`efrk_…`). This guide covers the API-key path.

## Prerequisites

- A [connected deployment](connect-to-registry.md) — publishing is scoped to
  your org, which connecting establishes.
- You are an **org owner** (only owners mint publish keys).

## 1. Mint an org API key (`efrk_…`)

In **Control UI → your org → API keys**, create a key. It is:

- **org-scoped** — it can publish only under your `@<org>/` scope;
- long-lived, opaque, and **revocable** (rotate or revoke on the same screen);
- sent as `Authorization: Bearer efrk_…`.

Pass the key via an **environment variable or CI secret** only — never a CLI
flag, a Makefile, a committed file, or logs.

Check the key and learn your org scope:

```bash
curl -s -H "Authorization: Bearer $REGISTRY_API_KEY" \
  https://registry.evenfire.ai/api/v1/whoami
# → {"type":"machine","orgName":"<org>","scopes":["registry:publish", …]}
```

## 2. Push a connector image to your org namespace

A **local** connector runs from an image the registry hosts under your org. Push
it before publishing the entry that references it.

**Control UI → Publisher → Docker credentials** (`/publisher/credentials`)
generates a durable push credential and hands you the login command, a
downloadable `dockerconfigjson` for CI, and your exact push coordinate. A key
minted at **Marketplace → API keys** works identically — both are `efrk_` org
keys.

Log in with the literal username `_`:

```bash
echo "$REGISTRY_API_KEY" | docker login registry.evenfire.ai -u _ --password-stdin
```

Then tag and push into `<org>/<name>`:

```bash
docker tag my-connector:local registry.evenfire.ai/acme/db-tools:1.4.0
docker push registry.evenfire.ai/acme/db-tools:1.4.0
```

### Four things that go wrong here

1. **No `@` in the image path.** The entry is named `@acme/db-tools`, but the
   image is `registry.evenfire.ai/acme/db-tools:1.4.0`. Docker reads `@` as the
   digest delimiter and refuses `registry.evenfire.ai/@acme/…` outright with
   `invalid reference format`. The scope prefix belongs in the entry name and
   nowhere else.

2. **The org segment is not optional.** `registry.evenfire.ai/db-tools:1.4.0`
   is outside your namespace, and your key only grants `<org>/…`. The path is
   always host, then org, then name.

3. **`<name>` must equal the entry's name.** For an evenfire-hosted local
   plugin, the pull grant is resolved from the OCI path as
   `@<org>/<name>`, so the image repo path has to match the entry exactly.
   Publishing `@acme/db-tools` with an `imageRef` of
   `registry.evenfire.ai/acme/dbtools` is rejected with a `422` naming both
   values. The check runs at publish **and** at install, because a mismatch
   would otherwise deny the cross-org pull and surface as a silent
   `ImagePullBackOff` in someone else's cluster.

4. **Docker manifest format.** The registry advertises
   `http.compat: ["docker2s2"]`, so Docker schema-2 manifests are accepted and a
   plain `docker push` works. If your tooling emits OCI-only images and the push
   is rejected, re-tag to Docker manifest format.

The **tag** is yours to choose. Only the repo path (`<org>/<name>`) is checked
against the entry name, so a tag that differs from the entry `version` is
allowed — though matching them keeps things legible.

For CI, download the `dockerconfigjson` and mount it as `~/.docker/config.json`
or a Kubernetes `dockerconfigjson` secret. Keys are listable and revocable from
the same panel.

## 3. Publish — `POST /api/v1/entries`

Required fields: `name` (**`@<org>/<name>`**), `version` (semver), `entryType`
(`recipe` | `mcp-server`), `description`, `author`, `origin`, `category`,
`contentCreatorTag`, `configCreatorTag`. For a recipe, also send `recipe` — the
recipe document as a **string** (≤ 100 KB). Optional: `tags`, `visibility`
(`public` | `private`).

```bash
curl -s -X POST https://registry.evenfire.ai/api/v1/entries \
  -H "Authorization: Bearer $REGISTRY_API_KEY" \
  -H "Content-Type: application/json" -d @entry.json
```

Three gotchas for org-key callers:

1. The name **must** be scoped `@<org>/<name>` — a bare name is rejected
   (`400 scope_required`). `@clerum` / `@evenfire` names are curator-only.
2. The bare `<name>` **must equal** the recipe's `metadata.name` — a mismatch is
   `400 INVALID_INPUT`. Use `metadata.name`, not your repo name.
3. For a **local connector**, `imageRef` points at the image you pushed in
   step 2 and its repo path must be `<org>/<name>`, matching this entry's name
   without the `@`. A mismatch is a `422` naming both values.

To build the recipe itself, see the
[`@clerum/workflow-sdk`](../../packages/workflow-sdk/README.md) and the
[WorkflowRecipe CRD reference](../crds/workflowrecipe.md).

## 4. Verify

A `private` entry is hidden from the default listing — pass `?visibility=all`:

```bash
curl -s -H "Authorization: Bearer $REGISTRY_API_KEY" \
  "https://registry.evenfire.ai/api/v1/entries?q=<name>&visibility=all"
```

## 5. Update

- Re-publishing the **same `name` + `version` → `409 CONFLICT`.** Bump the
  version to ship a change.
- Change metadata in place (visibility, tags, description) with
  `PUT …/entries/@<org>%2F<name>/versions/<version>`; delete a version with
  `DELETE …/versions/<version>`.

## Scope & visibility

An org key publishes **only** under `@<org>/`. A `@<org>/`-scoped entry — even
`public` — is surfaced to your org's own clusters and members, not the global
anonymous marketplace.

> The registry API above (`registry.evenfire.ai`) is the shared registry
> service, which is not part of this repository; connecting to it is covered in
> [Connect to the registry](connect-to-registry.md).
