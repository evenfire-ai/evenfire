# Monitoring

Helm values and Grafana dashboard configs for the Clerum observability stack. This directory does not contain applications -- it provides configuration for Grafana and Loki deployed via their official Helm charts.

## Contents

| Path | Description |
|------|-------------|
| `namespace.yaml` | Creates the `monitoring` Kubernetes namespace |
| `grafana/values.yaml` | Grafana Helm values (Loki datasource, dashboard provider, persistence, security context) |
| `loki/values.yaml` | Loki-stack Helm values (Loki + Promtail, 100 Gi persistence) |
| `dashboards/loki-grafana-dashboard.json` | Pre-built Grafana dashboard for Loki log exploration |
| `Makefile` | Install/upgrade/uninstall targets for both charts |

## Prerequisites

- Kubernetes cluster with Helm 3 installed
- A storage class matching the values files (default: `do-block-storage`; adjust for GKE/minikube)

## Setup

```bash
# Add Grafana Helm repo and create namespace
make setup

# Install Loki stack (Loki + Promtail)
make install_loki

# Install Grafana
make install_grafana
```

## Makefile Targets

| Target | Description |
|--------|-------------|
| `setup` | Add Grafana Helm repo + create namespace |
| `install_loki` | Install loki-stack chart (v2.9.10) |
| `upgrade_loki` | Upgrade loki-stack release |
| `uninstall_loki` | Remove loki-stack release |
| `install_grafana` | Install Grafana chart |
| `upgrade_grafana` | Upgrade Grafana release |
| `uninstall_grafana` | Remove Grafana release |
| `port_forward_grafana` | Forward Grafana UI to `localhost:3000` |
| `status` | Show pods, DaemonSets, and PVCs in the monitoring namespace |

## Grafana Configuration

The `grafana/values.yaml` configures:
- Loki as a datasource at `http://loki.monitoring:3100`
- Dashboard auto-provisioning from the `grafana-dashboards` ConfigMap
- 10 Gi persistent storage
- Non-root security context (UID/GID 472, read-only root filesystem)

## Dashboard Inventory

| File | Description |
|------|-------------|
| `dashboards/loki-grafana-dashboard.json` | Log exploration dashboard sourced from Grafana community (gnetId 15141) |

To load the dashboard, create a ConfigMap and reference it in the Grafana values:

```bash
kubectl create configmap grafana-dashboards \
  --from-file=dashboards/loki-grafana-dashboard.json \
  -n monitoring
```

## Accessing Grafana

```bash
make port_forward_grafana
# Open http://localhost:3000
# Default user: admin (password set via secret or Helm override)
```
