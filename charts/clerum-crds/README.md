# clerum-crds Helm Chart

Installs evenfire Custom Resource Definitions (API group `clerum.io` — historical
code name; public product name is **evenfire**).

## CRDs

| Kind                 | Plural                             |
| -------------------- | ---------------------------------- |
| Host                 | `hosts.clerum.io`                  |
| Context              | `contexts.clerum.io`               |
| McpServer            | `mcpservers.clerum.io`             |
| CommunicationChannel | `communicationchannels.clerum.io`  |
| WorkflowRecipe       | `workflowrecipes.clerum.io`        |
| WorkflowRecipePolicy | `workflowrecipepolicies.clerum.io` |
| SharedFileSystem     | `sharedfilesystems.clerum.io`      |
| GlobalFileSystem     | `globalfilesystems.clerum.io`      |

Human-readable reference: [docs/crds/README.md](../../docs/crds/README.md).

## Install

From the repo root:

```bash
helm install clerum-crds ./charts/clerum-crds
```

With a custom release name and/or namespace:

```bash
helm install my-crds ./charts/clerum-crds -n clerum-system --create-namespace
```

Optional samples:

```bash
kubectl apply -f charts/clerum-crds/examples/
```

## Upgrade / Uninstall

- **Upgrade:** Helm 3 does **not** upgrade manifests in the chart’s `crds/`
  directory on `helm upgrade`. Re-apply CRD YAML after chart changes:

  ```bash
  helm upgrade --install clerum-crds ./charts/clerum-crds
  kubectl apply -f ./charts/clerum-crds/crds/
  ```

  To apply a single CRD:  
  `kubectl apply -f charts/clerum-crds/crds/communicationchannel.yaml`.

- **Uninstall:** `helm uninstall clerum-crds` does **not** delete the CRDs, so
  existing Custom Resources are not orphaned. Remove CRDs manually if needed.

## Deploy order for additive schema fields

When a release adds a new optional field to a CRD (e.g. `context.spec.displayName`),
apply components in this order so the apiserver never prunes the new field:

1. **CRDs first** — `kubectl apply -f ./charts/clerum-crds/crds/` (Helm 3 will not
   do this on `helm upgrade`; see above). Until the CRD declares the field, the
   apiserver **silently prunes** it on every write and returns 200.
2. **control-api next** — it carries the read-after-write guard that turns a prune
   into a `*_crd_outdated` 409 instead of silent data loss, plus the write path.
3. **control-ui / profile-ui last** — the writers of the field.

The full safe order is **CRD → control-api → control-ui**, not merely "CRD before
UI": an old control-api against a new CRD still works, but a new UI against an old
CRD (or `kubectl`/GitOps writes against an old CRD) loses the field with a 200.
The guard only defends requests that flow through a control-api already carrying
it — it cannot protect direct apiserver writes, which is why the CRD must land
first regardless of how the field is written.

## Chart options

| Key           | Default | Description              |
| ------------- | ------- | ------------------------ |
| `installCRDs` | `true`  | Reserved for future use. |
