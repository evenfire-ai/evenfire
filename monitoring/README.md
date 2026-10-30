# Monitoring

Helm values and Grafana dashboard configs for the Clerum observability stack. This directory does not contain applications -- it provides configuration for Grafana and Loki deployed via their official Helm charts.

This starter does not configure a Prometheus scraper or Alertmanager. Control API
password-admission metrics and suggested alert queries are documented in
[password admission availability and monitoring](../docs/operations/password-admission.md).

## Contents

| Path                                     | Description                                                                              |
| ---------------------------------------- | ---------------------------------------------------------------------------------------- |
| `namespace.yaml`                         | Creates the `monitoring` Kubernetes namespace                                            |
| `grafana/values.yaml`                    | Grafana Helm values (Loki datasource, dashboard provider, persistence, security context) |
| `loki/values.yaml`                       | Loki-stack Helm values (Loki + Promtail, 100 Gi persistence by default)                  |
| `dashboards/loki-grafana-dashboard.json` | Pre-built Grafana dashboard for Loki log exploration                                     |
| `Makefile`                               | Install/upgrade/uninstall targets for both charts                                        |

## Prerequisites

- Kubernetes cluster with Helm 3 installed
- A storage class for the PVCs (default: `do-block-storage`; override with `STORAGE_CLASS=...`, e.g. `standard` on minikube)

## Setup

> **On minikube**, the safer path is [Monitoring and observability](../docs/operations/monitoring.md#install-on-minikube):
> it uses explicit `--context` commands with the minikube storage class and a
> smaller Loki volume. That page also explains what this starter covers (logs
> only; no metrics scraping is shipped).

```bash
# Add Grafana Helm repo and create namespace
make setup

# Install Loki stack (Loki + Promtail)
make install_loki

# Install Grafana (creates/updates the grafana-dashboards ConfigMap first)
make install_grafana
```

On minikube, override the storage class and sizes:

```bash
make install_loki install_grafana STORAGE_CLASS=standard LOKI_SIZE=10Gi GRAFANA_SIZE=2Gi
```

### Make variables

| Variable             | Default            | Description                                 |
| -------------------- | ------------------ | ------------------------------------------- |
| `STORAGE_CLASS`      | `do-block-storage` | Storage class for the Loki and Grafana PVCs |
| `LOKI_SIZE`          | `100Gi`            | Loki PVC size                               |
| `GRAFANA_SIZE`       | `10Gi`             | Grafana PVC size                            |
| `GRAFANA_PORT`       | `3000`             | Local port for `port_forward_grafana`       |
| `LOKI_CHART_VERSION` | `2.9.10`           | loki-stack chart version                    |

## Makefile Targets

These targets pass no `--context` / `--kube-context`: they run `kubectl` and
`helm` against your kubeconfig's **current** context. Check
`kubectl config current-context` before you run any of them, or use the
explicit commands in
[docs/operations/monitoring.md](../docs/operations/monitoring.md#install-on-minikube).

| Target                 | Description                                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------------------- |
| `setup`                | Add Grafana Helm repo + create namespace                                                          |
| `install_loki`         | Install loki-stack chart (`LOKI_CHART_VERSION`, default 2.9.10)                                   |
| `upgrade_loki`         | Upgrade loki-stack release                                                                        |
| `uninstall_loki`       | Remove loki-stack release                                                                         |
| `dashboards`           | Create or update the `grafana-dashboards` ConfigMap from every file in `dashboards/` (idempotent) |
| `install_grafana`      | Run `dashboards`, then install Grafana chart                                                      |
| `upgrade_grafana`      | Run `dashboards`, then upgrade Grafana release                                                    |
| `uninstall_grafana`    | Remove Grafana release                                                                            |
| `port_forward_grafana` | Forward Grafana UI to `localhost:$(GRAFANA_PORT)` (default 3000)                                  |
| `status`               | Show pods, DaemonSets, and PVCs in the monitoring namespace                                       |

## Grafana Configuration

The `grafana/values.yaml` configures:

- Loki as a datasource at `http://loki.monitoring:3100` with the fixed uid `P8E80F9AEF21F6940`, which the bundled dashboard references (change both together)
- Dashboard auto-provisioning from the `grafana-dashboards` ConfigMap
- 10 Gi persistent storage (override with `GRAFANA_SIZE`)
- Non-root security context (UID/GID 472, read-only root filesystem)

## Dashboard Inventory

| File                                     | Description                                                             |
| ---------------------------------------- | ----------------------------------------------------------------------- |
| `dashboards/loki-grafana-dashboard.json` | Log exploration dashboard sourced from Grafana community (gnetId 15141) |

The Grafana values mount the `grafana-dashboards` ConfigMap, so it must exist before the Grafana pod can start. `make install_grafana` and `make upgrade_grafana` create or update it automatically; run `make dashboards` on its own after editing a dashboard file.

## Accessing Grafana

```bash
make port_forward_grafana
# Open localhost:3000
# Default user: admin (password set via secret or Helm override)

# Control UI also uses localhost:3000 on minikube; pick another port if both run:
make port_forward_grafana GRAFANA_PORT=3001
```

To forward against an explicit cluster context instead of the current one:
`kubectl --context <your-context> port-forward -n monitoring svc/grafana 3001:80`.
