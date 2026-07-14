setup:
	helm repo add grafana https://grafana.github.io/helm-charts
	helm repo update
	kubectl apply -f namespace.yaml

install_loki:
	cd loki && helm install loki grafana/loki-stack --version "2.9.10" --namespace=monitoring -f values.yaml

upgrade_loki:
	cd loki && helm upgrade loki grafana/loki-stack --version "2.9.10" --namespace=monitoring -f values.yaml

uninstall_loki:
	helm uninstall loki --namespace=monitoring

install_grafana:
	cd grafana && helm install grafana grafana/grafana --namespace=monitoring -f values.yaml

upgrade_grafana:
	cd grafana && helm upgrade grafana grafana/grafana --namespace=monitoring -f values.yaml

uninstall_grafana:
	helm uninstall grafana --namespace=monitoring

port_forward_grafana:
	kubectl port-forward -n monitoring svc/grafana 3000:80

status:
	kubectl get pods -n monitoring
	kubectl get daemonset -n monitoring
	kubectl get pvc -n monitoring
