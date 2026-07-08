# clerum-crds Helm Chart

Installs the Clerum Custom Resource Definitions:

- **CommunicationChannel** (`communicationchannels.clerum.io`)
- **Context** (`contexts.clerum.io`)
- **Host** (`hosts.clerum.io`)
- **McpServer** (`mcpservers.clerum.io`)

## Install

From the repo root:

```bash
helm install clerum-crds ./charts/clerum-crds
```

With a custom release name and/or namespace:

```bash
helm install my-crds ./charts/clerum-crds -n clerum-system --create-namespace
```

## Upgrade / Uninstall

- **Upgrade:** Helm does **not** upgrade manifests in the chart’s `crds/` directory on `helm upgrade` (Helm 3 behavior). From the repo root run **`make gcp-deploy-crds`**, which runs `helm upgrade --install` and then **`kubectl apply -f ./charts/clerum-crds/crds/`** so OpenAPI schema changes (e.g. new optional fields on `CommunicationChannel`) reach the cluster. To apply a single CRD: `kubectl apply -f charts/clerum-crds/crds/communicationchannel.yaml`.
- **Uninstall:** `helm uninstall clerum-crds` does **not** delete the CRDs, so existing Custom Resources are not orphaned. Remove CRDs manually if needed.

## Chart options

| Key           | Default | Description                    |
|---------------|---------|--------------------------------|
| `installCRDs` | `true`  | Reserved for future use.       |
