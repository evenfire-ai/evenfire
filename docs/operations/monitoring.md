# Monitoring

This page is for operators. It covers what evenfire ships for logs, metrics,
health checks and tracing, and what it does not ship.

Short version:

- `deploy/base` ships no monitoring stack. There is no Prometheus, no
  `ServiceMonitor`/`PodMonitor`, and no `prometheus.io/scrape` annotations.
- The optional `monitoring/` directory is a **logs-only** starter: Loki,
  Promtail and Grafana, with one log dashboard.
- Most services expose a Prometheus `/metrics` endpoint. You bring your own
  Prometheus to scrape them.
- Usage and cost live in control-api and the Control UI (**Cost & Usage**), not
  in Grafana.

## The `monitoring/` starter

[`monitoring/`](../../monitoring/README.md) is separate from `deploy/base`. Nothing in
the kustomize tree installs it. It holds Helm values for the official Grafana
charts:

| Path                                     | What it does                                                                                     |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `namespace.yaml`                         | Creates the `monitoring` namespace                                                               |
| `loki/values.yaml`                       | `grafana/loki-stack` chart `2.9.10`: Loki (100 Gi PVC) plus Promtail                             |
| `grafana/values.yaml`                    | `grafana/grafana` chart: Loki datasource at `http://loki.monitoring:3100`, 10 Gi PVC, non-root   |
| `dashboards/loki-grafana-dashboard.json` | One Grafana dashboard for Kubernetes logs                                                        |
| `Makefile`                               | `setup`, `install_*`, `upgrade_*`, `uninstall_*`, `dashboards`, `port_forward_grafana`, `status` |

Loki is the only datasource. The starter does not install Prometheus or any
metrics dashboard.

### Dashboard

There is one dashboard, **Loki Kubernetes Logs** (Grafana community dashboard
15141). It has two panels:

- a log-volume time series: `count_over_time` over the selected streams;
- a log panel with the matching lines.

You filter by `namespace`, `stream` and `container`, plus a free-text search.
The panels reference the Loki datasource by the fixed UID
`P8E80F9AEF21F6940`, which `grafana/values.yaml` sets on the provisioned Loki
datasource. If you change one, change the other.

### Install on minikube

The values files default to the `do-block-storage` StorageClass. Minikube uses
`standard`. Loki also asks for a 100 Gi volume, which is more than most local
clusters want. Override both at install time.

The dashboard ConfigMap must exist before Grafana starts, because
`grafana/values.yaml` mounts the `grafana-dashboards` ConfigMap.

Every command below names the target cluster explicitly. Set `KCTX` to your
minikube profile (`clerum-test` by default) and check it before you run
anything:

```bash
KCTX=clerum-test
kubectl --context "$KCTX" get nodes   # confirm this is the cluster you mean

# Helm repo + monitoring namespace
helm repo add grafana https://grafana.github.io/helm-charts
helm repo update
kubectl --context "$KCTX" apply -f monitoring/namespace.yaml

# Dashboard ConfigMap (before Grafana)
kubectl --context "$KCTX" create configmap grafana-dashboards \
  --from-file=monitoring/dashboards/loki-grafana-dashboard.json \
  -n monitoring

# Loki + Promtail, with a minikube storage class and a smaller volume
helm --kube-context "$KCTX" install loki grafana/loki-stack --version 2.9.10 \
  -n monitoring \
  -f monitoring/loki/values.yaml \
  --set loki.persistence.storageClassName=standard \
  --set loki.persistence.size=10Gi

# Grafana
helm --kube-context "$KCTX" install grafana grafana/grafana -n monitoring \
  -f monitoring/grafana/values.yaml \
  --set persistence.storageClassName=standard

kubectl --context "$KCTX" get pods,daemonset,pvc -n monitoring
# Control UI already uses localhost:3000 on minikube, so forward Grafana elsewhere:
kubectl --context "$KCTX" port-forward -n monitoring svc/grafana 3001:80   # then open localhost:3001
```

The admin user is `admin`. The values file does not set a password. Set
`adminPassword` with `--set` or an existing Secret, or read the one the chart
generates. On a cluster whose StorageClass matches the values files, the same
`helm --kube-context` commands work without the `--set` overrides.

The targets in `monitoring/Makefile` (`setup`, `install_*`, `upgrade_*`,
`uninstall_*`, `dashboards`, `status`, `port_forward_grafana`) take no context:
they run `kubectl` and `helm` against your kubeconfig's **current** context.
Use them only after `kubectl config current-context` shows the intended
cluster; the explicit commands above are the safer default. `install_grafana`
and `upgrade_grafana` create or update the `grafana-dashboards` ConfigMap
first. The `STORAGE_CLASS`, `LOKI_SIZE`, `GRAFANA_SIZE` and `GRAFANA_PORT`
variables cover the minikube overrides, for example
`make install_loki install_grafana STORAGE_CLASS=standard LOKI_SIZE=10Gi` and
`make port_forward_grafana GRAFANA_PORT=3001`. See the
[`monitoring/` README](../../monitoring/README.md#make-variables).

## Logs

All first-party services write logs to stdout, so Promtail (or any collector)
picks them up. The format differs by service:

| Service                                                                         | Format                                                                         | Level variable |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | -------------- |
| control-api                                                                     | Pino JSON, `svc: control-api`, ISO timestamps, token paths removed             | `LOG_LEVEL`    |
| workspace-files-controller                                                      | Pino and Pino HTTP JSON                                                        | `LOG_LEVEL`    |
| codex-llm-proxy, grok-llm-proxy                                                 | Pino JSON                                                                      | `LOG_LEVEL`    |
| mcp-host                                                                        | JSON lines (`timestamp`, `level`, `component`, `msg`), sensitive keys redacted | `LOG_LEVEL`    |
| host-context-controller                                                         | JSON lines from its own logger, sensitive keys redacted                        | `LOG_LEVEL`    |
| workflow-recipes (controller and coordinator), workflow-approval-request-reader | JSON lines from their own loggers                                              | `LOG_LEVEL`    |

Other services may still print plain text. Don't assume every line is JSON.
The repository logging standard is in [CLAUDE.md](../../CLAUDE.md) under
"Logging standard".

## Metrics

Each endpoint below serves Prometheus text format without authentication.
None of them is wired to a scraper by default.

| Service                       | Where it runs                                    | Port                                | Notes                                                                                                             |
| ----------------------------- | ------------------------------------------------ | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| control-api                   | `deploy/base` Deployment                         | `8090`                              | Node process metrics plus approvals, notifications, OAuth, rate limits, GFS upload, governed trace, LLM allowlist |
| host-context-controller (HCC) | `deploy/base` Deployment                         | `8081`                              | See [HCC metrics](../../host-context-controller/README.md#metrics)                                                |
| mcp-host                      | Stamped per Host by HCC                          | `8080` (`CONTEXT_MAPPER_HOST_PORT`) | Guardrails, LLM allowlist and fallback, runtime auth, conversation store, plugin SDK, process metrics             |
| workflow-recipes (WRC)        | `deploy/base` Deployment                         | `8082`                              | Same port as its MCP endpoint                                                                                     |
| workflow coordinator          | Per-run pod in `sandbox-recipes`, started by WRC | `8090`                              | Health server also serves `/metrics`                                                                              |
| webhook-gateway               | Per-recipe Deployment stamped by WRC             | `9090`                              | Only when a recipe sets `spec.webhooks[]`                                                                         |
| codex-llm-proxy               | `deploy/base` Deployment                         | `9090`                              | See [codex-llm-proxy README](../../codex-llm-proxy/README.md)                                                     |
| grok-llm-proxy                | `deploy/base` Deployment                         | `9090`                              | See [grok-llm-proxy README](../../grok-llm-proxy/README.md)                                                       |
| mcp-proxy                     | `deploy/base` Deployment                         | `8083`                              |                                                                                                                   |
| gfs-controller                | Stamped by HCC in the `gfs` namespace            | `8087` (`GFS_PORT`)                 | SLI counters                                                                                                      |

webhook-proxy's port `9090` is named `health`. It only answers `/healthz` and
`/readyz`. It serves no `/metrics`.

control-api's `/metrics` is not forwarded by the nginx gateway in front of it.
Scrape the control-api pod or Service directly.

### NetworkPolicy and scraping

The cluster runs default-deny NetworkPolicies. `deploy/base` and WRC allow
ingress from a namespace named `monitoring` only to:

- codex-llm-proxy and grok-llm-proxy, port `9090`;
- webhook-gateway pods, port `9090` (WRC sets this from
  `WRC_MONITORING_NAMESPACE`, default `monitoring`);
- webhook-proxy, port `9090` (health only).

To scrape control-api, HCC, mcp-host, WRC, mcp-proxy or gfs-controller, add
your own NetworkPolicy that allows your Prometheus to reach those ports.

### Useful series

| Metric                                                | Service     | Meaning                                                                                                      |
| ----------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------ |
| `clerum_mcp_host_guardrail_decisions_total`           | mcp-host    | Guardrail outcomes by `lane`, `decision`, `source`, `execution_mode`, `phase`, `outcome`, `reason_code`      |
| `clerum_mcp_host_guardrail_boundary_duration_ms`      | mcp-host    | Guardrail evaluation latency, excluding tool or model execution                                              |
| `clerum_llm_allowlist_missing_total`                  | mcp-host    | Times mcp-host saw the LLM allowlist ConfigMap absent and fell back to the Host-configured model only        |
| `clerum_llm_model_not_allowed_total`                  | mcp-host    | The Host-configured model is outside the operator allowlist. Signal only; mcp-host does not reject the model |
| `clerum_llm_fallback_total`                           | mcp-host    | mcp-host switched to a configured fallback provider/model, labelled `from`, `to`, `reason`                   |
| `mcp_host_runtime_auth_degraded`                      | mcp-host    | Gauge. Runtime auth is degraded; readiness returns `503` while it is set                                     |
| `clerum_llm_allowlist_configmap_write_failures_total` | control-api | Failed writes of the `clerum-llm-allowed-models` ConfigMap, by `phase` (`mutation`, `boot`, `sync`)          |

For guardrail behaviour, see [Configure guardrails](../how-to/configure-guardrails.md).

## Health and readiness

| Service                          | Port   | Liveness                          | Readiness            | Readiness can fail with                                                                                                         |
| -------------------------------- | ------ | --------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| control-api                      | `8090` | `/health`                         | `/health`            |                                                                                                                                 |
| host-context-controller          | `8081` | `/health` (also startup)          | `/ready`             | `503` with `reasons[]`, for example `controller_stopped`, `mcp_watch_unsynced`, `context_watch_unsynced`, `host_watch_unsynced` |
| mcp-host                         | `8080` | `/v1/runtime/live` (also startup) | `/v1/runtime/health` | `503 {"status":"degraded"}` when runtime auth is degraded; liveness stays `200`                                                 |
| gfs-controller                   | `8087` | `/healthz`                        | `/readyz`            | `503` with `code` `not_mounted` (drive volume missing) or `not_ready` (permission store unreachable)                            |
| workspace-files-controller       | `8086` | `/healthz`                        | `/readyz`            | `503` when the mount is missing, not a directory, or not writable                                                               |
| workflow-recipes                 | `8082` | `/health`                         | `/health`            |                                                                                                                                 |
| mcp-proxy                        | `8083` | `/health` (also startup)          | `/ready`             |                                                                                                                                 |
| codex-llm-proxy, grok-llm-proxy  | `9090` | `/healthz`                        | `/readyz`            |                                                                                                                                 |
| webhook-proxy                    | `9090` | `/healthz`                        | `/healthz`           |                                                                                                                                 |
| rpc-proxy                        | `8094` | `/health`                         | `/health`            |                                                                                                                                 |
| external-rest-api                | `8091` | `/health`                         | `/health`            |                                                                                                                                 |
| workflow-approval-request-reader | `8098` | `/health`                         | `/health`            |                                                                                                                                 |
| Control UI                       | `3000` | `/`                               | `/`                  |                                                                                                                                 |

For how HCC readiness works, see [HCC readiness flows](../architecture/hcc-readiness-flows.md).

## Governed tracing

Governed tracing is control-plane evidence, not an OpenTelemetry pipeline.
control-api is the only writer and reader. It records agent runs,
administrative actions and infrastructure telemetry in Postgres. evenfire does
not export traces to an external backend. See
[Governed tracing architecture](../architecture/governed-tracing.md).

The Control UI has trace pages under `/traces` (Administrative, Dashboard,
Infrastructure, Run replay). The **Traces** section is hidden from the
sidebar. You reach the pages by URL, for example `/traces/operations`.

## Usage and cost

Token usage, LLM prices, token budgets and infrastructure cost live in
control-api and the Control UI under **Cost & Usage**
(`/cost-and-usage/usage`). They are not in Grafana or the `monitoring/`
starter. Token budgets are cost control, not a security boundary. See
[claims guardrails](../meta/claims-guardrails.md).

## What to alert on

These signals exist in the code today. Thresholds are up to you.

| Signal                                                                                  | Why                                                                                     |
| --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| HCC `/ready` returns `503` (pod not Ready)                                              | Watches are unsynced or the controller stopped. Hosts and MCP servers stop reconciling. |
| gfs-controller `/readyz` returns `503`                                                  | GFS cannot serve files: volume not mounted or permission store unreachable.             |
| workspace-files-controller `/readyz` returns `503`                                      | The workspace mount is missing or read-only.                                            |
| mcp-host `/v1/runtime/health` returns `503`, or `mcp_host_runtime_auth_degraded` is `1` | The Host's runtime auth is degraded.                                                    |
| `rate(clerum_llm_allowlist_configmap_write_failures_total[15m]) > 0`                    | Postgres and the delivered LLM allowlist ConfigMap have drifted.                        |
| `increase(clerum_llm_allowlist_missing_total[15m]) > 0`                                 | mcp-host is running without the allowlist ConfigMap.                                    |
| `clerum_mcp_host_guardrail_decisions_total{reason_code="hook_unavailable"}` increasing  | A guardrail hook is unreachable. With `failMode: closed`, users get refusals.           |
| `increase(clerum_llm_fallback_total[15m]) > 0`                                          | Primary LLM calls are failing over.                                                     |

Because no Prometheus ships, you need your own Prometheus, the NetworkPolicies
described above, and your own alert rules to use the metric signals. Readiness
failures also show up as pods that are not Ready in `kubectl get pods`.
