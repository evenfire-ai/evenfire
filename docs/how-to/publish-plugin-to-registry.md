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

## 2. Publish — `POST /api/v1/entries`

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

Two gotchas for org-key callers:

1. The name **must** be scoped `@<org>/<name>` — a bare name is rejected
   (`400 scope_required`). `@clerum` / `@evenfire` names are curator-only.
2. The bare `<name>` **must equal** the recipe's `metadata.name` — a mismatch is
   `400 INVALID_INPUT`. Use `metadata.name`, not your repo name.

To build the recipe itself, see the
[`@clerum/workflow-sdk`](../../packages/workflow-sdk/README.md) and the
[WorkflowRecipe CRD reference](../crds/workflowrecipe.md).

## 3. Verify

A `private` entry is hidden from the default listing — pass `?visibility=all`:

```bash
curl -s -H "Authorization: Bearer $REGISTRY_API_KEY" \
  "https://registry.evenfire.ai/api/v1/entries?q=<name>&visibility=all"
```

## 4. Update

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
