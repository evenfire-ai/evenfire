# Optional local Registry

Evenfire uses the configured centralized Registry by default. Bootstrap does
not deploy or seed a sibling `evenfire-registry` checkout merely because that
directory exists. Existing centralized connection, authentication and client
registration settings retain their normal behavior.

With the branch-owned Minikube profile and its matching context already
resolved and exported, request a local sibling explicitly:

```bash
MINIKUBE_DEPLOY_EVENFIRE_REGISTRY=true make minikube-t2
```

The flag accepts only `true` or `false` and defaults to `false`. An explicit
request requires a real checkout, Dockerfile, Minikube overlay and deployment
helper; missing prerequisites fail before cluster mutation. The local catalog
seed runs only for a requested local stack when its seed target is available.
An attempted deployment or seed failure is an error.

The standalone `make minikube-deploy-evenfire-registry` command is also an
explicit local deployment request. Neither command changes the centralized
Registry configuration automatically.

To remove a previously deployed optional local stack from this owned profile:

```bash
make minikube-remove-evenfire-registry
```

This public target validates the profile mutation lease and removes only the
named local Registry Deployments and Services in namespace `registry`. It
retains the namespace, PVCs, Secrets and ConfigMaps. It does not alter the
container-image registry in `kube-system` or the centralized Registry.

T1/T2 checks are unchanged: any deployed workload with positive desired
replicas must satisfy readiness. Omitting a future deployment does not excuse
an existing unready one; remove the optional local workloads through the
public target before certification.
