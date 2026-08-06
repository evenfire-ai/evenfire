# Publish your first plugin — a beginner's guide

New to Evenfire plugins? Start here. This guide walks you all the way from "I
have some code" to "my plugin is installed and running in my cluster," with no
prior knowledge assumed. By the end you'll have published a private plugin under
your organization and installed it from the Control UI.

If you already know the ropes and just want the API details, jump to
[Reference: the publish API](#reference-the-publish-api) at the bottom.

---

## What is a plugin?

A **plugin** is a small application that runs on the Evenfire platform. Under the
hood it's a single file called a **WorkflowRecipe** — a YAML document that
describes what your plugin is made of. A plugin can include any mix of:

- **MCP servers** — tools your AI agents can call (search, lookups, actions).
- **A web UI** — a page embedded in the app.
- **Background jobs** — work that runs on a schedule (e.g. a nightly scan).
- **Webhooks** — endpoints that react to outside events.
- **LLM access** — steps that call a language model through the platform.

Each of those pieces is a **workload** — a container image plus a bit of config.
You write the recipe, push your images, publish it, and the platform turns it
into the right Kubernetes objects, wires up networking, and runs it for you.

> You don't need to know Kubernetes. The recipe hides it. If a term here is new,
> keep going — the steps are copy-pasteable.

## The big picture

Publishing a plugin is four steps:

```
  1. Write            2. Push               3. Publish            4. Install
  ┌──────────┐        ┌──────────┐          ┌──────────┐         ┌──────────┐
  │ recipe   │        │ your     │          │ register │         │ from the │
  │ .yaml    │  ───▶  │ images → │   ───▶   │ under    │  ───▶   │ Control  │
  │          │        │ registry │          │ @your-org│         │ UI       │
  └──────────┘        └──────────┘          └──────────┘         └──────────┘
   describe it         ship the code         list it in           run it in
                       (containers)          your Marketplace     your cluster
```

Do them in order the first time. After that, shipping an update is just
"push new images → publish a new version."

## Before you start

You need:

- A **connected deployment.** Publishing is scoped to your organization, and
  connecting is what establishes that. See
  [Connect to the registry](connect-to-registry.md).
- To be an **org owner.** Only owners can create publish keys.
- **Docker** installed locally (to build and push your images).

That's it. Let's go.

---

## Step 1 — Get your organization API key

Everything you publish is authenticated with one **org API key** (it starts with
`efrk_…`). This single key does two jobs: it lets you **push images** and
**publish entries**, both only under your own `@your-org` scope.

1. Open the **Control UI**.
2. Go to **Marketplace → your org (`@your-org`) → API Keys**.
3. Create a key and copy it somewhere safe — you won't see it again.

Keep the key in an environment variable, never in a file you commit or a command
you paste into chat:

```bash
export REGISTRY_API_KEY="efrk_…"
```

Quick sanity check — this also tells you your exact org name:

```bash
curl -s -H "Authorization: Bearer $REGISTRY_API_KEY" \
  https://registry.evenfire.ai/api/v1/whoami
# → {"type":"machine","orgName":"your-org","scopes":["registry:publish", …]}
```

## 2. Push a connector image to your org namespace

A **local** connector runs from an image the registry hosts under your org. Push
it before publishing the entry that references it.

**Control UI → Publisher → Docker credentials** (`/publisher/credentials`)
generates a durable push credential and hands you the login command, a
downloadable `dockerconfigjson` for CI, and your exact push coordinate. A key
minted at **Marketplace → API keys** works identically — both are `efrk_` org
keys.

Your key needs the **`registry:publish`** scope. Without it the registry still
issues a token, but with the push action stripped, so the push is denied with no
message explaining why. Check first:

```bash
curl -s -H "Authorization: Bearer $REGISTRY_API_KEY" \
  https://registry.evenfire.ai/api/v1/whoami   # scopes must include registry:publish
```

Log in with the literal username `_`:

```bash
echo "$REGISTRY_API_KEY" | docker login registry.evenfire.ai -u _ --password-stdin
```

Then tag and push into `<org>/<name>`:

```bash
docker tag my-connector:local registry.evenfire.ai/acme/db-tools:1.4.0
docker push registry.evenfire.ai/acme/db-tools:1.4.0
```

### The repo path is stricter than Docker's

The registry accepts **exactly two segments**, `<org>/<name>`, each matching
`^[a-z0-9]+(?:[._-][a-z0-9]+)*$`. Every entry in the catalog looks like
`registry.evenfire.ai/evenfire/mcp-whois:1.0.0` — host, org, name, tag.

| Wrong                                     | Why                                                                                                                                                                      |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `registry.evenfire.ai/@acme/db-tools`     | The `@` belongs to the **entry name**, never the image path. Docker reads it as the digest delimiter and refuses the reference outright with `invalid reference format`. |
| `registry.evenfire.ai/db-tools`           | One segment. There is no namespace, and your key only grants `<org>/…`.                                                                                                  |
| `registry.evenfire.ai/acme/team/db-tools` | Three segments. Nested namespaces are rejected — a path must resolve unambiguously to one org and one repo.                                                              |
| `registry.evenfire.ai/Acme/DB-Tools`      | Uppercase. Segments are lowercase alphanumerics separated by single `.`, `_`, or `-`.                                                                                    |
| `registry.evenfire.ai/acme/db__tools`     | Doubled separator. Also no leading or trailing separator.                                                                                                                |

**A malformed path fails silently.** The registry drops an unparseable scope
rather than erroring on it, so you get a token carrying no access and Docker
reports a plain denial. If a push is refused and the credential is definitely
good, re-read the path before anything else.

### Three more things that go wrong

1. **`<name>` must equal the entry's name.** For an evenfire-hosted local
   plugin, the pull grant is resolved from the OCI path as `@<org>/<name>`, so
   the image repo path has to match the entry exactly. Publishing
   `@acme/db-tools` with an `imageRef` of `registry.evenfire.ai/acme/dbtools`
   is rejected with a `422` naming both values. The check runs at publish
   **and** at install, because a mismatch would otherwise deny the cross-org
   pull and surface as a silent `ImagePullBackOff` in someone else's cluster.

2. **Docker manifest format.** The registry advertises
   `http.compat: ["docker2s2"]`, so Docker schema-2 manifests are accepted and a
   plain `docker push` works. If your tooling emits OCI-only images and the push
   is rejected, re-tag to Docker manifest format.

3. **Quotas apply to self-hosted orgs.** A deployment that onboarded through
   open registration gets **10 image repos**, **2 GiB** of storage, and **200
   entry versions** by default. Exceeding a limit denies the push the same
   quiet way a bad path does — the token comes back without the push action.
   The 11th repo is the usual surprise; delete an unused one or ask Evenfire to
   raise the cap.

The **tag** is yours to choose. Only the repo path is checked against the entry
name, so a tag that differs from the entry `version` is allowed, though the
catalog convention is to match them.

For CI, download the `dockerconfigjson` and mount it as `~/.docker/config.json`
or a Kubernetes `dockerconfigjson` secret. Keys are listable and revocable from
the same panel.

### Who can pull what you pushed

Images you push are **private to your org**, and a self-hosted deployment cannot
change that:

- Flipping an image repo to public returns `403 selfhosted_public_disabled` for
  any org that onboarded through open registration. The block exists to stop
  unmetered anonymous-pull egress.
- Cross-org pull needs a **grant**, and a self-hosted deployment's credentials
  carry `registry:read`, `registry:publish`, `registry:update`, and
  `registry:delete` — not `registry:grant`.

So your images install cleanly into your own clusters. Sharing one with another
organization currently needs Evenfire to issue the grant. Plan around that
before you build a distribution story on top of a self-hosted push.

**Private is the normal case, and you do not ship credentials for it.** Because
your images stay private to your org, every install of your entry is an
authenticated pull. You do not put a pull Secret in the recipe, and you do not
ask installers to create one. On the first install that needs it, the installing
deployment mints its own pull credential from its own registry identity and
attaches it to the workloads. Your entry stays credential-free and portable
across the clusters your org runs.

Two rules follow for anything you publish:

- **Never declare `evenfire-registry-pull` in a workload's `imagePullSecrets`.**
  The name is reserved. An entry that declares it is rejected at install with
  `422 workflowWorkloadSecretRefReserved`. The platform attaches the reference
  after the filter that would otherwise strip a recipe-declared Secret name.
- **`imagePullSecrets` is still yours to use for a third-party registry.** If a
  workload pulls from GHCR or Docker Hub, name your own Secret there as before.
  The automatic credential covers images on the evenfire registry only, matched
  by image host.

## 3. Publish — `POST /api/v1/entries`

## Step 2 — Write your recipe

The recipe is a YAML file describing your plugin. The simplest useful plugin is
a single MCP server. Save this as `recipe.yaml` and change the names to yours:

```yaml
apiVersion: clerum.io/v1alpha1
kind: WorkflowRecipe
metadata:
  name: hello-plugin          # ← your plugin's identity (lowercase, no spaces)
spec:
  description: My first plugin — a single MCP server.
  contextRef: context1        # required whenever a workload has a transport
  workloads:
    - id: server
      type: deployment
      image: registry.evenfire.ai/your-org/hello-plugin:0.1.0  # ← set in Step 3
      port: 3000
      transport:
        type: streamableHttp
        path: /mcp
```

Two things a beginner must get right:

- **`metadata.name`** is your plugin's identity. Use lowercase letters, numbers,
  and dashes (like a domain name). You'll reuse it when you publish.
- **`image`** must point at your organization's registry namespace:
  `registry.evenfire.ai/your-org/<something>:<tag>`. We create that image next.

Want a plugin with a web UI, a nightly job, or an LLM step instead? Copy one of
the ready-made examples and adapt it — see
[Where to go next](#where-to-go-next). The rules are the same; only the `spec`
grows.

## Step 3 — Build and push your images

Your workloads run from **container images**. Each `image:` in the recipe has to
actually exist in your org's registry namespace. Log in once with your API key
(the username is a literal underscore, `_`):

```bash
docker login registry.evenfire.ai -u _ -p "$REGISTRY_API_KEY"
```

Then build, tag with the **exact coordinate** you put in the recipe, and push:

```bash
# from the folder with your app's Dockerfile
docker build -t registry.evenfire.ai/your-org/hello-plugin:0.1.0 .
docker push registry.evenfire.ai/your-org/hello-plugin:0.1.0
```

The image coordinate is always:

```
registry.evenfire.ai/<your-org>/<name>:<tag>
```

Repeat for every workload in your recipe. The `image:` in the recipe and the tag
you push must match character-for-character.

> Tip: the Control UI's **Marketplace → your org → API Keys** page shows the
> exact `docker login`, `docker tag`, and `docker push` commands prefilled for
> your org, so you can copy them instead of typing.

## Step 4 — Publish the entry

Publishing registers your recipe in the Marketplace under your org. Create an
`entry.json` describing it:

```json
{
  "name": "@your-org/hello-plugin",
  "version": "0.1.0",
  "entryType": "recipe",
  "description": "My first plugin — a single MCP server.",
  "author": "your-org",
  "contactEmail": "you@example.com",
  "origin": "human-authored",
  "category": "utility",
  "tags": ["mcp", "example"],
  "visibility": "private",
  "contentCreatorTag": "community",
  "configCreatorTag": "community",
  "recipe": "<paste your recipe.yaml here, as a single JSON string>"
}
```

A few of these fields are short controlled labels — the values above come
straight from a real published entry, so they're safe to reuse:

- **`origin`** — where the recipe came from; `human-authored` for one you wrote.
- **`contentCreatorTag`** / **`configCreatorTag`** — who authored it; `community`
  for a plugin published by your org (as opposed to a first-party one).
- **`category`** — a one-word bucket like `utility`, `workflow`, `research`, or
  `security`. Pick the closest fit; you can see what others use in the
  Marketplace's category filter.

The `recipe` field is your whole `recipe.yaml` as one JSON string. You don't have
to escape it by hand — build the file with a one-liner:

```bash
jq -n --arg recipe "$(cat recipe.yaml)" \
  '{name:"@your-org/hello-plugin", version:"0.1.0", entryType:"recipe",
    description:"My first plugin — a single MCP server.", author:"your-org",
    contactEmail:"you@example.com", origin:"human-authored", category:"utility",
    tags:["mcp","example"], visibility:"private",
    contentCreatorTag:"community", configCreatorTag:"community",
    recipe:$recipe}' > entry.json
```

Then publish:

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
   
Get these two right and the rest is easy:

- **`name` must be `@your-org/<plugin>`** — a bare name is rejected. The `@clerum`
  and `@evenfire` scopes are reserved.
- **The `<plugin>` part of `name` must equal `metadata.name` in your recipe.** Here
  both are `hello-plugin`. A mismatch is rejected.

`visibility: private` means the plugin is shared with **your organization's own
clusters and members** — exactly what you want for an internal plugin. It won't
appear in any public catalog.

## Step 5 — Install it

Now install what you just published, right from the UI:

1. **Control UI → Marketplace → your org (`@your-org`) → Entries.**
2. Find your plugin (`hello-plugin`) in the list. Multiple versions of the same
   plugin collapse into one row showing the latest — expand the row to install an
   older version if you need to.
3. Click **Install**. Step through the short wizard — review the package, confirm
   external network access (egress) if your plugin needs it, and pick a model if
   it uses an LLM — then finish.

Your plugin appears under **Plugins**, where you can watch it start and check its
status.

That's the whole loop: **write → push → publish → install.**

## Shipping an update

A published `name` + `version` is permanent — you can't overwrite `0.1.0`. To ship
a change:

1. Rebuild and push new images with a new tag (e.g. `:0.2.0`).
2. Update the `image:` tags and bump `version` in your recipe/entry to `0.2.0`.
3. Publish again.

The Entries list will show the new version as the latest; installs pick it up.

You *can* tweak an entry's description, tags, or visibility in place without a new
version — see the reference below.

## When something goes wrong

- **Plugin doesn't appear after publishing?** Private entries are hidden from the
  default catalog listing — look under **Marketplace → your org → Entries**, not
  the general catalog.
- **Publish rejected with a name error?** The `<plugin>` part of `@your-org/<plugin>`
  must exactly equal `metadata.name` in the recipe.
- **Publish rejected as a conflict?** That `name` + `version` already exists — bump
  the version.
- **Plugin installs but a workload won't start?** Open the plugin on the **Plugins**
  page and read the workload status; most first-time issues are a typo in an
  `image:` coordinate (it must match exactly what you pushed).

## Where to go next

- **Full authoring reference** — every recipe field, the security model, web UIs,
  webhooks, scheduled jobs, and LLM/agent steps: the
  `WORKFLOW_RECIPE_GUIDE.md` in the Evenfire Recipe Guide.
- **Ready-made examples** to copy and adapt: `examples/mcp-server.yaml`,
  `examples/sandbox-ui.yaml`, `examples/snippet-workflow.yaml`,
  `examples/agentic-workflow.yaml`.
- **Connecting your deployment** (if you haven't yet):
  [Connect to the registry](connect-to-registry.md).

---

## Reference: the publish API

For scripts and CI. All requests use your org API key as
`Authorization: Bearer efrk_…`.

**Publish** — `POST /api/v1/entries`

Required: `name` (`@<org>/<name>`), `version` (semver), `entryType`
(`recipe` | `mcp-server`), `description`, `author`, `origin`, `category`,
`contentCreatorTag`, `configCreatorTag`. For a recipe, also `recipe` (the recipe
document as a string, ≤ 100 KB). Optional: `tags`, `visibility`
(`public` | `private`).

**Verify** — a `private` entry needs `?visibility=all`:

```bash
curl -s -H "Authorization: Bearer $REGISTRY_API_KEY" \
  "https://registry.evenfire.ai/api/v1/entries?q=<name>&visibility=all"
```

**Update / retire**

- Re-publishing the same `name` + `version` → `409 CONFLICT`. Bump the version.
- Edit metadata in place: `PUT …/entries/@<org>%2F<name>/versions/<version>`.
- Remove a version: `DELETE …/versions/<version>`.

**Scope & visibility.** An org key publishes **only** under `@<org>/`. A
`@<org>/`-scoped entry is surfaced to your org's own clusters and members, not the
global anonymous marketplace.

> The registry API (`registry.evenfire.ai`) is the shared registry service, which
> is not part of this repository; connecting to it is covered in
> [Connect to the registry](connect-to-registry.md).
