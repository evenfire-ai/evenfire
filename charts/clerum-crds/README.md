# clerum-crds Helm Chart

Installs evenfire Custom Resource Definitions (API group `clerum.io` — historical
code name; public product name is **evenfire**).

## CRDs

| Kind                 | Plural                             |
| -------------------- | ---------------------------------- |
| Host                 | `hosts.clerum.io`                  |
| Context              | `contexts.clerum.io`               |
| McpServer            | `mcpservers.clerum.io`             |
| LlmHook              | `llmhooks.clerum.io`               |
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

## Chart options

| Key           | Default | Description              |
| ------------- | ------- | ------------------------ |
| `installCRDs` | `true`  | Reserved for future use. |
