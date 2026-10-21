# Optional Loki + Grafana starter. Run targets from this directory.
#
# Overridable variables (defaults match the values files):
#   STORAGE_CLASS   PVC storage class for Loki and Grafana (minikube: standard)
#   LOKI_SIZE       Loki PVC size
#   GRAFANA_SIZE    Grafana PVC size
#   GRAFANA_PORT    local port for port_forward_grafana (Control UI also uses
#                   3000 on minikube, so pick another port when both run)
#   KUBE_CONTEXT    kube context for every kubectl/helm call (empty: the
#                   kubeconfig's current context)
#
# Example (minikube):
#   make install_loki install_grafana KUBE_CONTEXT=clerum-test STORAGE_CLASS=standard LOKI_SIZE=10Gi GRAFANA_SIZE=2Gi
#   make port_forward_grafana KUBE_CONTEXT=clerum-test GRAFANA_PORT=3001

STORAGE_CLASS ?= do-block-storage
LOKI_SIZE ?= 100Gi
GRAFANA_SIZE ?= 10Gi
GRAFANA_PORT ?= 3000
LOKI_CHART_VERSION ?= 2.9.10
KUBE_CONTEXT ?=

KUBECTL = kubectl$(if $(KUBE_CONTEXT), --context $(KUBE_CONTEXT))
HELM = helm$(if $(KUBE_CONTEXT), --kube-context $(KUBE_CONTEXT))

LOKI_SET = --set loki.persistence.storageClassName=$(STORAGE_CLASS) \
	--set loki.persistence.size=$(LOKI_SIZE)
GRAFANA_SET = --set persistence.storageClassName=$(STORAGE_CLASS) \
	--set persistence.size=$(GRAFANA_SIZE)

.PHONY: setup install_loki upgrade_loki uninstall_loki dashboards \
	install_grafana upgrade_grafana uninstall_grafana port_forward_grafana status

setup:
	helm repo add grafana https://grafana.github.io/helm-charts
	helm repo update
	$(KUBECTL) apply -f namespace.yaml

install_loki:
	$(HELM) install loki grafana/loki-stack --version "$(LOKI_CHART_VERSION)" --namespace=monitoring -f loki/values.yaml $(LOKI_SET)

upgrade_loki:
	$(HELM) upgrade loki grafana/loki-stack --version "$(LOKI_CHART_VERSION)" --namespace=monitoring -f loki/values.yaml $(LOKI_SET)

uninstall_loki:
	$(HELM) uninstall loki --namespace=monitoring

# Creates or updates the grafana-dashboards ConfigMap that grafana/values.yaml
# mounts (dashboardsConfigMaps.default). Grafana pods cannot start without it.
dashboards:
	$(KUBECTL) create configmap grafana-dashboards \
		--from-file=dashboards/ \
		--namespace=monitoring --dry-run=client -o yaml | $(KUBECTL) apply -f -

install_grafana: dashboards
	$(HELM) install grafana grafana/grafana --namespace=monitoring -f grafana/values.yaml $(GRAFANA_SET)

upgrade_grafana: dashboards
	$(HELM) upgrade grafana grafana/grafana --namespace=monitoring -f grafana/values.yaml $(GRAFANA_SET)

uninstall_grafana:
	$(HELM) uninstall grafana --namespace=monitoring

port_forward_grafana:
	$(KUBECTL) port-forward -n monitoring svc/grafana $(GRAFANA_PORT):80

status:
	$(KUBECTL) get pods -n monitoring
	$(KUBECTL) get daemonset -n monitoring
	$(KUBECTL) get pvc -n monitoring
