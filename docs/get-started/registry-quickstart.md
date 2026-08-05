# Registry quickstart — connect, install, publish

The Evenfire registry (`registry.evenfire.ai`) is a shared catalog of
**connectors** (MCP servers) and **plugins** (WorkflowRecipes). A **managed**
deployment is connected for you. A **self-hosted** deployment connects itself,
once, and from then on can install from the catalog and publish under its own
`@<org>/` scope.

This guide walks the whole round trip on a local minikube cluster, then notes
what changes on a real one.

> **What you get:** a connected deployment, a connector and a plugin installed
> and running in your cluster, an org API key for CI, and your first published
> entry.
> **Time:** ~15 minutes once your cluster is up.

## Prerequisites

- A running evenfire platform. If you do not have one, start with the
  [Quickstart](quickstart.md).
- An **admin** login for the Control UI.
- Outbound HTTPS from `control-api` to the registry.

## 1. Confirm self-hosted mode

The connect flow only runs when `control-api` is in self-hosted mode. The
minikube overlay already sets it, along with the registry URL, in
`deploy/overlays/minikube/configmaps/control-api-config.yaml`:

```yaml
CLERUM_REGISTRY_URL: 'https://registry.evenfire.ai'
REGISTRY_CONNECTION_MODE: 'self-hosted'
```

Confirm what your cluster is actually running:

```bash
kubectl -n control-plane get configmap control-api-config \
  -o jsonpath='{.data.REGISTRY_CONNECTION_MODE}{"\n"}{.data.CLERUM_REGISTRY_URL}{"\n"}'
```

**On a real cluster**, set these on `control-api`:

| Setting                         | Value                                                                  |
| ------------------------------- | ---------------------------------------------------------------------- |
| `REGISTRY_CONNECTION_MODE`      | `self-hosted`. The default is `managed`, which has nothing to connect. |
| `CLERUM_REGISTRY_URL`           | `https://registry.evenfire.ai`                                         |
| `CLERUM_REGISTRY_URL_ALLOWLIST` | Only needed for a registry URL that is not built in (comma-separated). |

`https://registry.evenfire.ai` and the in-cluster
`http://registry-api.registry.svc.cluster.local:8085` are allowlisted by
default. **`control-api` refuses to start** if `CLERUM_REGISTRY_URL` is set to
something outside the allowlist, so add the URL before you deploy it.

## 2. Connect

Open **Control UI → Marketplace**. While the deployment is unconnected, the
catalog shows a banner with a **Connect to registry** button; the panel itself
lives at **Marketplace → Connect** (`/marketplace/connect`).

1. Enter an **Organization name** and a **Contact email**, then press
   **Request registration**. The organization name becomes your `@<org>/`
   publish scope.

   Your `control-api` generates a signing keypair and registers with the
   registry. The private key never leaves your cluster; it is how the registry
   recognizes later requests from this deployment.

2. The registry approves immediately and your control-api redeems the
   credentials inline. No operator is involved and no claim token is ever shown
   to a human. If that last step does not land (a network blip, or the registry
   briefly unavailable), the panel offers **Finish connecting** — press it to
   retry.

3. The panel reports **connected**. Your deployment now holds machine
   credentials for the catalog, publishing, and image push/pull.

> ⚠️ **Do not press Start over** unless the panel explicitly tells you to. It
> permanently deletes this deployment's registry credentials and gives up the
> organization name, and you must then register under a **different** name. A
> suspended deployment can be reversed by Evenfire; a destroyed keypair cannot.

For the full state machine and every failure branch, see
[Connect to the registry](../how-to/connect-to-registry.md).

## 3. Install a connector

**Marketplace → Connectors** lists the MCP servers in the catalog. Pick one and
press **Install**.

| Field           | Notes                                                                                             |
| --------------- | ------------------------------------------------------------------------------------------------- |
| **Name**        | Optional. Left blank, it is generated from the entry name and version. Must be a valid K8s name.  |
| **Context**     | **Required.** The agent context that gets the tool.                                               |
| **Credentials** | Only if the entry declares them. Fill in **all** fields or **none** (empty installs it pending).  |
| **Egress**      | Review the external hosts the connector needs. Default-deny networking means unlisted hosts fail. |

The install runs as a server-side saga: it verifies the bundle digest, creates
the `McpServer`, wires it into the context, and rolls back if a step fails.

Verify it landed:

```bash
kubectl -n mcp-server get mcpservers
```

## 4. Install a plugin

**Marketplace → Plugins** lists WorkflowRecipes. **Install** opens a three-step
review:

1. **Package** — the recipe manifest as published.
2. **Security** — manifest validation plus the egress bindings each workload
   needs. Edit them here before anything is created.
3. **Install** — the final manifest, then the `WorkflowRecipe` is created.

Recipes are stored in `sandbox-recipes`, alongside the coordinator and mcp-host
pods they orchestrate:

```bash
kubectl -n sandbox-recipes get workflowrecipes
```

### Private images pull themselves

If the connector or plugin you installed runs a **private** image on the evenfire
registry, you do not create a pull Secret and you do not put credentials in the
entry. On the first install that needs one, control-api mints a pull credential
from your connection's own registry identity and writes it as a Secret named
`evenfire-registry-pull` into all three platform workload namespaces:

```bash
kubectl get secret -A -l clerum.io/managed-by=control-api
# NAMESPACE         NAME                     TYPE                             DATA
# mcp-server        evenfire-registry-pull   kubernetes.io/dockerconfigjson   1
# sandbox-recipes   evenfire-registry-pull   kubernetes.io/dockerconfigjson   1
# sandbox-ui        evenfire-registry-pull   kubernetes.io/dockerconfigjson   1
```

Then the reference is attached for you. control-api writes it onto the `McpServer`
for connectors, and workflow-recipes injects it into the rendered pod template for
recipe workloads. Recipes never name it themselves. `evenfire-registry-pull` is a
reserved name: declare it in a recipe's `imagePullSecrets` and the install is
rejected, and the admin Secrets API refuses to create, modify or delete it.

Two things follow from this that are worth knowing up front:

- **It is one credential per organization, rotated on each mint.** All three copies
  always hold the same key. That is why control-api writes all three together
  rather than one namespace at a time.
- **It repairs itself.** control-api re-checks the Secret at startup and every 10
  minutes (`REGISTRY_PULL_SECRET_RECONCILE_INTERVAL_MS`), so a copy that was
  deleted or emptied comes back without an install to trigger it.

If you would rather provision the Secret yourself, read the pre-provisioning rules
in [Connect to the registry](../how-to/connect-to-registry.md#api-keys-for-programmatic-publishing)
first. A half-external setup, where you supply some namespaces and leave others to
control-api, is not supported.

## 5. Mint an org API key

The Control UI publishes using the credential stored at connect time, so
nothing more is needed to publish by hand. **CI and scripts** need an org API
key (`efrk_…`).

Open **Marketplace → API keys** (`/marketplace/keys`) and press **+ Create
key**. On self-hosted, registry authentication switches on automatically the
moment the deployment holds machine credentials, which is as soon as step 2
finished. There is no flag to set and no restart.

The key is org-scoped, long-lived, revocable, and **shown once**. Pass it
through an environment variable or CI secret. Never a CLI flag, a Makefile, a
committed file, or logs.

```bash
curl -s -H "Authorization: Bearer $REGISTRY_API_KEY" \
  https://registry.evenfire.ai/api/v1/whoami
# → {"type":"machine","orgName":"<org>","scopes":["registry:publish", …]}
```

## 6. Push an image (local connectors only)

A **local** connector runs from an image the registry hosts under your org. Push
it before publishing the entry that points at it. Recipes have no image and skip
this step.

**Publisher → Docker credentials** (`/publisher/credentials`) generates a push
credential and shows your exact coordinate. Log in with the literal username
`_`, then push into `<org>/<name>`:

```bash
echo "$REGISTRY_API_KEY" | docker login registry.evenfire.ai -u _ --password-stdin
docker tag my-connector:local registry.evenfire.ai/acme/db-tools:1.4.0
docker push registry.evenfire.ai/acme/db-tools:1.4.0
```

The path is **exactly two segments**, `<org>/<name>`, each lowercase
alphanumerics separated by single `.`, `_`, or `-`. Every catalog entry looks
like `registry.evenfire.ai/evenfire/mcp-whois:1.0.0`.

| Wrong                 | Why                                                                   |
| --------------------- | --------------------------------------------------------------------- |
| `/@acme/db-tools`     | The `@` belongs to the entry name only. Docker rejects the reference. |
| `/db-tools`           | No org segment, and your key only grants `<org>/…`.                   |
| `/acme/team/db-tools` | Three segments. Nested namespaces are rejected.                       |
| `/Acme/DB-Tools`      | Uppercase is invalid.                                                 |

A malformed path **fails silently** — the registry drops the unparseable scope,
so you get a token with no access and a plain denial from Docker. Two other
quiet denials: a key without the `registry:publish` scope, and exceeding the
self-hosted quota of **10 repos / 2 GiB / 200 entry versions**.

`<name>` must also equal the entry's name. `@acme/db-tools` published against
`registry.evenfire.ai/acme/dbtools` is rejected with a `422` at publish and
again at install, since a mismatch denies the pull and surfaces as an
`ImagePullBackOff` in someone else's cluster. The tag is yours to pick.

> **Your images are private and stay that way.** An org that onboarded through
> open registration cannot flip a repo public (`403 selfhosted_public_disabled`)
> and does not hold `registry:grant`. They install into your own clusters
> fine; sharing one with another organization needs Evenfire.

## 7. Publish your first entry

### From the Control UI

**Marketplace → + Publish to Marketplace**. Choose **Connector** or **Plugin**,
then fill in the required fields:

- Both: **Name**, **Version**, **Author**, **Description**.
- Connector: **Image Ref** (local mode) or **Endpoint URL** (remote mode).
- Plugin: the **Plugin YAML / JSON** body.

**Visibility** is `public` or `private`. A `@<org>/`-scoped entry is surfaced to
your own org's clusters and members either way, not to the global anonymous
marketplace.

### From CI

```bash
curl -s -X POST https://registry.evenfire.ai/api/v1/entries \
  -H "Authorization: Bearer $REGISTRY_API_KEY" \
  -H "Content-Type: application/json" -d @entry.json
```

Two rules trip up most first publishes:

1. The name **must** be scoped `@<org>/<name>`. A bare name is rejected with
   `400 scope_required`, and `@clerum` / `@evenfire` names are curator-only.
2. For a recipe, the bare `<name>` **must equal** the recipe's
   `metadata.name`, not your repo name. A mismatch is `400 INVALID_INPUT`.

Field-by-field reference and the update/delete routes are in
[Publish a plugin to the registry](../how-to/publish-plugin-to-registry.md).

## Troubleshooting

| Symptom                                               | Cause and fix                                                                                                                                                                                                                                                                                                                      |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `control-api` will not start, complains about the URL | `CLERUM_REGISTRY_URL` is not in the allowlist. Add it to `CLERUM_REGISTRY_URL_ALLOWLIST` (see step 1).                                                                                                                                                                                                                             |
| No Connect panel, no banner                           | The deployment is in `managed` mode. Managed deployments are connected for you and have nothing to configure.                                                                                                                                                                                                                      |
| `org_name_taken` on registration                      | Another deployment holds that organization name. Pick a different one and register again. Nothing was saved.                                                                                                                                                                                                                       |
| `org_blocklisted` on registration                     | The name is reserved. Pick a different one.                                                                                                                                                                                                                                                                                        |
| Connect panel stuck at **Finishing the connection**   | The inline redeem did not land. Press **Finish connecting**; it needs no token. Reach for **Start over** only when the panel says the credentials were issued but never stored.                                                                                                                                                    |
| `deployment_suspended`                                | Evenfire suspended the deployment. Contact support. Do **not** press Start over: a suspension is reversible, a destroyed keypair is not.                                                                                                                                                                                           |
| `409 CONFLICT` on publish                             | That `name` + `version` already exists. Bump the version; versions are immutable.                                                                                                                                                                                                                                                  |
| `400 scope_required` on publish                       | The entry name is unscoped. Use `@<org>/<name>`.                                                                                                                                                                                                                                                                                   |
| `invalid reference format` from `docker`              | The `@` scope prefix is in the image path. It belongs in the entry name only: push to `registry.evenfire.ai/<org>/<name>`, not `/@<org>/<name>`.                                                                                                                                                                                   |
| `docker push` denied, credential is good              | Three quiet causes, likeliest first: a malformed repo path (the scope is dropped, not rejected), a key without `registry:publish`, or the self-hosted quota (10 repos / 2 GiB / 200 versions).                                                                                                                                     |
| `403 selfhosted_public_disabled`                      | An open-registration org cannot make an image repo public. Images stay private to your org; cross-org sharing needs a grant Evenfire issues.                                                                                                                                                                                       |
| `422` naming the `imageRef`                           | The image repo path does not equal the entry name. `@acme/db-tools` needs `registry.evenfire.ai/acme/db-tools`. Checked at publish and install, since a mismatch denies the pull.                                                                                                                                                  |
| `403` when managing **grants**                        | Expected. Deployments that onboarded through self-hosted connect do not hold `registry:grant`. Receiving and installing granted plugins still works.                                                                                                                                                                               |
| Connector installed but cannot reach its API          | Egress. Default-deny networking blocks anything not declared in the install's egress step.                                                                                                                                                                                                                                         |
| `409 foreign_secret_would_be_revoked` on install      | You pre-provisioned `evenfire-registry-pull` in some platform namespaces but not all three. The pull key is one per org and rotate-on-call, so control-api will not mint and revoke your copy. Supply all three namespaces, or delete yours and let control-api manage them.                                                       |
| `409 foreign_secret_unusable` on install              | An `evenfire-registry-pull` Secret you own sits in the namespace this install targets, and it cannot serve a pull: wrong `type`, or a `.dockerconfigjson` with no entry for your registry host or an entry carrying no credential. Fix it in place or delete it. Nothing was created; the install fails before the CRD is written. |
| `422 workflowWorkloadSecretRefReserved` on install    | The recipe declares `evenfire-registry-pull` in `imagePullSecrets`. Remove it. The platform attaches the reference itself, after the ownership filter that would otherwise strip a declared name.                                                                                                                                  |
| `ImagePullBackOff` on a private evenfire image        | Check the pod actually got the reference (`kubectl get pod <p> -o jsonpath='{.spec.imagePullSecrets}'`). If it is empty on a recipe workload, `CLERUM_REGISTRY_URL` differs between control-api and workflow-recipes: injection keys off the image host matching that URL. Both read the same `control-api-config` key by default. |

## Next steps

- [Connect to the registry](../how-to/connect-to-registry.md) — every connect
  state and recovery path.
- [Publish a plugin to the registry](../how-to/publish-plugin-to-registry.md) —
  the full publish API, updates, visibility.
- [`@clerum/workflow-sdk`](../../packages/workflow-sdk/README.md) and the
  [WorkflowRecipe CRD](../crds/workflowrecipe.md) — building the plugin you
  publish.
- [Open core: self-host vs hosted](../concepts/open-core-and-hosted.md) — what
  lives in this repo versus the managed service.

> The registry service itself is part of Evenfire's managed offering, not this
> repository. This guide covers only the self-hoster's side of the flow.
