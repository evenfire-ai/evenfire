# LLM providers, credentials, and the model allowlist (operator guide)

This guide is for cluster operators. It covers how to configure LLM provider
credentials (including the multi-slot providers **Google Vertex AI** and
**Amazon Bedrock**), how to manage the operator-declared model allowlist, and how
the per-session model selector behaves in the desktop app.

The canonical provider set — **24 providers**, from `openai`, `claude`
(Anthropic), `zai` and `bailian` through the own-SDK `vertex` / `bedrock`, the
OpenAI-compatible additions and `azure`, to `openai-compatible` (a model you run
yourself on the LAN, reached through an egress broker — see §8) — and their
credential slots live in the shared `@clerum/llm-providers` package, which the
Control UI, control-api, mcp-host, and the workflow runtime all consume. See the
[providers overview](../llm-providers/README.md) for the full list and the
per-surface support matrix (`bedrock` and `azure` are host-only; `openai-compatible`
is host-only too). A Host is bound to **one** provider (`spec.model.provider`);
the allowlist and selector operate within that provider.

## 1. Where credentials and non-secret config live

Provider credentials are stored in the per-Host **LLM Secret** (`chatllm-api-keys`
family, labelled `clerum.io/host-secret: "true"`, referenced by the Host CRD
`spec.secretRef`). Manage it in Control UI under **Secrets → LLM**.

Some providers also need **non-secret** configuration (a GCP project, an AWS
region). Those are **not** credentials and never go in the Secret — they are
per-Host environment variables managed under **Host → Environment**
(`host-<ref>-env`, the `HostEnvTable` editor on the Host detail page). The
secrets form only shows a hint linking there; it does not duplicate the editor.

| Provider                    | Secret slots (in the LLM Secret)              | Non-secret env (Host → Environment)               |
| --------------------------- | --------------------------------------------- | ------------------------------------------------- |
| OpenAI                      | `openai-api-key`                              | —                                                 |
| Anthropic (`claude`)        | `claude-api-key`                              | —                                                 |
| Z.AI (`zai`)                | `zai-api-key`                                 | —                                                 |
| Bailian                     | `bailian-api-key`                             | —                                                 |
| Google Vertex AI (`vertex`) | `vertex-service-account-json`                 | `VERTEX_PROJECT_ID` (required), `VERTEX_LOCATION` |
| Amazon Bedrock (`bedrock`)  | `aws-access-key-id` + `aws-secret-access-key` | `AWS_REGION` (required)                           |
| Azure OpenAI (`azure`)      | `azure-openai-api-key`                        | `AZURE_OPENAI_ENDPOINT` (required), `AZURE_OPENAI_API_VERSION` |
| OpenAI-compatible (`openai-compatible`) | `openai-compatible-api-key` _(may be empty)_ | `spec.model.baseURL` (required — a **Host CRD** field, not a Host-env var) — see §8 |

Every other provider (the OpenAI-compatible additions — `openrouter`, `gemini`,
`deepseek`, `groq`, `together`, `fireworks`, `mistral`, `xai`, `cerebras`,
`deepinfra`, `perplexity`, `moonshot`, `nebius`, `novita`, `minimax`) uses a single
`<id>-api-key` slot and needs no non-secret env.

The secrets form is **write-only**: existing values are never displayed (the API
returns key names only). To rotate a key, re-enter it.

## 2. Configuring Google Vertex AI

1. Create a GCP **service account** with access to the Vertex AI API and
   generate a **JSON key**.
2. In Control UI, open **Secrets → LLM** (create or edit the Host's LLM Secret),
   expand the **Google Vertex AI** group, and paste the entire service-account
   JSON into the `vertex-service-account-json` field.
   - The form validates the JSON shape before saving: it must parse and contain
     `client_email` and `private_key`. control-api enforces the same check on
     write (a malformed or incomplete JSON is rejected with `400`).
   - The driver builds GCP credentials **from the JSON in memory** — it never
     writes a key file and does not use `GOOGLE_APPLICATION_CREDENTIALS`.
3. On the Host, open **Host → Environment** and set:
   - `VERTEX_PROJECT_ID` — the GCP project id (required).
   - `VERTEX_LOCATION` — the region, e.g. `us-central1` (optional; provider
     default applies if unset).
4. Set the Host `spec.model.provider: vertex` and pick a Vertex model from the
   allowlist (e.g. `gemini-2.5-pro`).

## 3. Configuring Amazon Bedrock

1. Create an AWS IAM principal with permission to call the Bedrock Runtime
   **Converse** API and obtain an **access key id / secret access key** pair.
2. In Control UI, open **Secrets → LLM**, expand the **Amazon Bedrock** group,
   and enter **both** `aws-access-key-id` and `aws-secret-access-key`.
   - The pair must be written **together in a single save**. Saving only one of
     the two is rejected (client-side and by control-api with `400`) so a Host is
     never left half-configured — this would otherwise surface only at runtime.
3. On the Host, open **Host → Environment** and set `AWS_REGION` (required), e.g.
   `us-east-1`.
4. Set the Host `spec.model.provider: bedrock` and pick a Bedrock model from the
   allowlist. Bedrock model ids are runtime-qualified, e.g.
   `anthropic.claude-sonnet-4-6-v1:0`.

### Bedrock and Azure in workflows

`bedrock`, `azure` and `openai-compatible` are **not admissible in WorkflowRecipe
steps**: all three are deliberately absent from the recipe CRD's provider enum,
so a recipe pinning any of them is rejected at admission. The workflow `configure`
transport carries a single credential string, which can deliver neither Bedrock's
key pair nor Azure's required endpoint; `openai-compatible` is excluded on top of
that (D-7) because it needs a per-Host `baseURL` and a provisioned egress broker,
and a bare workflow step carries neither. All three remain fully supported for
interactive Hosts; the other 20 providers are admissible in recipes — see the
[providers overview](../llm-providers/README.md) for the per-surface matrix and
the `clerum-model-secret-mapping` caveat.

> **Dev-mode note.** When mcp-host runs in dev mode with no explicit
> `spec.model`, it auto-detects the provider from whichever credential env vars
> are present, in canonical id order (`openai` → `claude` → `zai` → `bailian` →
> `vertex` → `bedrock` → the rest). Because Bedrock's slots are the standard AWS variables
> (`aws-access-key-id` / `aws-secret-access-key`), a shell that already exports
> generic AWS credentials — with `AWS_REGION` also set — can auto-select
> `bedrock` when no higher-priority provider key is exported. Set `spec.model`
> explicitly (or unset the AWS vars) if that is not what you want in dev.

## 4. Extra credential slots (for provider fallback, R5)

Each provider group in the secrets form has an **Add credential slot** action.
It creates an additional key in the **same** LLM Secret with a suggested name
like `openai-api-key-fb1` (editable, validated as a Kubernetes data key). These
extra keys are how a Host's fallback policy (`spec.llmPolicy.fallbacks[]` with a
pinned `credentialSlot`) references a second credential of the same provider
(e.g. a backup Anthropic key). Because the listing enumerates the
Secret's real key names, extra slots simply appear with their own present/absent
status — there is no parallel registry to maintain.

## 5. The model allowlist

**The set of usable models is operator-declared, not a static catalog.** It lives
in the control-api Postgres table `llm_allowed_models` and is managed in Control
UI under **LLM Models** (`/llm-models`), backed by
`GET/POST/PUT/DELETE /admin/llm-models`. Every mutation is audited
(`llm_allowed_models_audit`) and re-materializes the delivery ConfigMap.

Fail-closed semantics: a model is usable only if a row exists for
`(provider, model)` with `enabled = true`. A provider with no enabled rows is
unusable and is flagged in the wizard.

### Propagation to runtime (ConfigMap)

control-api materializes the allowlist into the **`clerum-llm-allowed-models`**
ConfigMap in the `mcp-host` namespace (`<provider>` → JSON array of
`{ model, displayName?, contextWindowTokens? }`). mcp-host and the workflow
runtime read it — there is no hot call from mcp-host to control-api (the
NetworkPolicy denies it by design). Changes therefore propagate **without a
redeploy**: edit the allowlist, and the wizard, the host editor, and the runtime
selector reflect it after the ConfigMap update.

- The write is best-effort after the Postgres commit, with retry, a content hash
  annotation, and re-materialization on control-api boot. If the write fails the
  operator sees a `503` (`configmap_write_failed` — "saved, propagation delayed")
  and the `clerum_llm_allowlist_configmap_write_failures_total` metric increments.
- `CLERUM_LLM_ALLOWED_MODELS_CM` is a canary knob for **mcp-host only**; do not
  re-point it independently or the read/write seam breaks.

### ConfigMap-absent / degraded semantics

If the ConfigMap does not exist yet (a rollout in progress, or the migration has
not run), mcp-host and the WRC operate in an **explicit degraded mode**: only the
model already configured on the Host/step is permitted — neither fully open nor
bricking existing Hosts. This emits a `WARN` and increments
`clerum_llm_allowlist_missing_total`. Recipe pods never read the ConfigMap; their
gate is the WRC, and for them the "absent" state is permanent by design.

An out-of-allowlist model on an **already-deployed** Host/recipe is **not**
interrupted (`WARN` + `clerum_llm_model_not_allowed_total`, marked "out of
allowlist" in the UI). Hard enforcement applies to **new** selections: host
create/edit via control-api, the runtime set-model call, and workflow `configure`.

## 6. The per-session model selector (desktop app)

Users change the agent's model per **chat session** (Claude-Code / Codex style),
restricted to the provider's allowlist:

- The change is **session state, not process state** — one Host serves many
  chats/users, so a switch never affects another user's chat.
- It applies **from the next task** ("applies to your next message"); in-flight
  tasks finish with the model they started on. `usage_events` records the model
  actually served, so cost attribution is exact.
- The selection survives a pod restart (persisted on the session). If a persisted
  model later falls out of the allowlist, the agent falls back to the Host default
  with a notice in the UI.
- The context-window indicator reflects the active model's window (the
  operator-declared `context_window_tokens`, falling back to
  `CLERUM_CONTEXT_MAX_TOKENS`).
- The set-model endpoint requires the `host:model:write` scope; without it the
  call returns **403**. Hosts too old to project a model simply don't render the
  selector.

## 7. Quick verification

1. Create/enable a Vertex and a Bedrock model under **LLM Models**.
2. Create an LLM Secret: paste a Vertex service-account JSON (confirm a malformed
   JSON is rejected) and enter a Bedrock key pair (confirm a single key is
   rejected).
3. Set `VERTEX_PROJECT_ID` / `AWS_REGION` under **Host → Environment**.
4. Create a Host with `provider: vertex` (or `bedrock`), run a chat with a
   tool-call, and confirm the calls appear in `usage_events`.
5. Disable a model in **LLM Models** and confirm the wizard and the runtime
   selector stop offering it without a redeploy.

## 8. Local OpenAI-compatible models via the egress broker

The `openai-compatible` provider points a Host at a model an operator runs
**themselves** on the private LAN (vLLM, Ollama, LM Studio, TGI, …). Unlike every
other provider, the endpoint is not a fixed vendor URL — the operator supplies it
as `spec.model.baseURL`, a field that lives on the **Host CRD**, not in the LLM
Secret and not in Host-env. The API key slot (`openai-compatible-api-key`) is
optional: leave it empty when the local server needs no auth, but `spec.secretRef`
must still point at a Secret that exists.

**The mcp-host agent never dials the LAN address directly.** Doing so would let a
model endpoint be turned into an SSRF pivot from inside the cluster. Instead HCC
provisions a small **egress broker** per `(Host, endpoint)` — a mirrored
Deployment + Service + ConfigMap + Secret in the `llm-egress` namespace — and the
agent talks only to that broker over the cluster-internal Service. The broker is
the single hop permitted out to the LAN, and only to the one operator address,
pinned by a `/32` egress NetworkPolicy HCC emits alongside it.

```mermaid
sequenceDiagram
  participant Op as Operator
  participant CA as control-api (admission)
  participant HCC as host-context-controller
  participant MH as mcp-host (agent)
  participant BR as egress broker (llm-egress ns)
  participant LAN as LAN model (192.168.x.y)

  Op->>CA: Host spec.model.baseURL = private LAN IP
  Note over CA: validate — private RFC1918 only;<br/>reject .svc / metadata / CGNAT
  CA->>HCC: admitted Host
  Note over HCC: provision broker per (Host, endpoint):<br/>Deployment+Service+CM+Secret mirror<br/>+ /32 broker→LAN egress NP<br/>+ mcp-host→broker ingress NP
  MH->>BR: chat completion (cluster-internal Service)
  BR->>LAN: proxied request (only /32 allowed out)
  LAN-->>BR: response
  BR-->>MH: response
```

Three things to know as an operator:

- **Rollout order is CRD → control-api → control-ui.** Adding `openai-compatible`
  is a **structural** CRD change (new enum value + additive `baseURL` field).
  `apiextensions/v1` silently prunes unknown fields, so the `hosts.clerum.io` CRD
  must be applied **before** any Host that sets `baseURL` — a Host written against
  the old CRD loses the field on admission with a 200. Apply
  `charts/clerum-crds/crds/host.yaml`, then roll control-api, then control-ui.
- **The address must be a private LAN IP.** The CRD rejects cluster-internal
  `.svc` / `.svc.cluster.local` targets by shape; metadata (169.254/16) and CGNAT
  (100.64/10) ranges are rejected downstream by control-api / HCC, because CEL
  cannot do CIDR arithmetic. The address must be a private, non-reserved RFC1918
  address; the runtime `/32` NetworkPolicy then constrains the broker to exactly
  that destination.
- **The cluster-internal guard is required, not optional.** HCC needs two
  categories of ranges to reject a `baseURL` that lands inside cluster space —
  which CEL cannot compute — and is **fail-closed** on both: with
  `CONTEXT_MAPPER_OAI_EGRESS_REQUIRE_CLUSTER_CIDRS=true` (the base default) it
  refuses to provision **any** broker until they are set.
  - `CONTEXT_MAPPER_CLUSTER_INTERNAL_CIDRS` — the **pod + Service** ranges, to
    reject an apiserver/pod ClusterIP.
  - `CONTEXT_MAPPER_CLUSTER_NODE_CIDRS` — the **node + control-plane** ranges
    (node InternalIPs and the apiserver endpoint, each as `/32`, plus node-pool
    subnets). Without this a node IP — which is RFC1918 (e.g. a minikube node at
    `192.168.49.2`) — would read as a legitimate LAN target, so
    `https://192.168.49.2:10250/` (the kubelet) would be accepted. The same
    opt-out knob exempts **both** categories.

  Even so, HCC always pins the apiserver ClusterIP via a zero-config floor
  derived from `KUBERNETES_SERVICE_HOST`, so that one address is rejected before
  the guard is even configured. The ranges are environment-specific and
  gitignored, so the minikube overlay **renders and applies the patch by
  default** — `make minikube-deploy-all` runs `make
  minikube-detect-cluster-cidrs`, which fills in both categories from the live
  cluster (node InternalIPs + apiserver endpoint for the node ranges), and
  `patches/llm-egress-cluster-cidrs.yaml` is already in the overlay's
  `patchesStrategicMerge` (see
  `deploy/overlays/minikube/patches/llm-egress-cluster-cidrs.yaml.template`). On
  a managed cluster (GKE, ...) the node ranges are not discoverable the same way:
  declare `CONTEXT_MAPPER_CLUSTER_NODE_CIDRS` explicitly as the node-pool subnet
  plus the control-plane `masterIpv4CidrBlock` (e.g.
  `10.128.0.0/20,172.16.0.0/28`). A deploy that deliberately runs without the
  guard sets `CONTEXT_MAPPER_OAI_EGRESS_REQUIRE_CLUSTER_CIDRS=false`; then the
  feature falls back to the always-on RFC1918 + `/32` NetworkPolicy tier only.
- **The apiserver-reachable ranges stay opt-in.**
  `CONTEXT_MAPPER_K8S_API_CIDRS` also drives the `allow-k8s-api-egress-*`
  NetworkPolicies and the watch-recovery E2E fixtures, so it is **not** set by the
  default patch. Turn it on deliberately when you want HCC to also reject a
  `baseURL` inside the apiserver CIDRs beyond the ClusterIP floor.

A ready-to-adapt example (primary + fallback, both local) lives at
[`charts/clerum-crds/examples/host-openai-compatible-lan.yaml`](../../charts/clerum-crds/examples/host-openai-compatible-lan.yaml).
