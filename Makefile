# Clerum — Root Makefile
# Orchestrates build, test, and deployment across all services.
#
# DEPLOYMENT GUIDE: docs/deploy/MINIKUBE-DEPLOY-GUIDE.md
#
# ─── JWT AUTH CHAIN (CRITICAL) ──────────────────────────────────────────────
#
#   control-api  →  issues RPC token  →  Desktop App
#                     iss=control-api
#                     aud=rpc-proxy       ← NOTE: audience is "rpc-proxy", not "mcp-host"
#                     TTL=300s
#
#   Desktop App  →  Bearer <rpc_token>  →  rpc-proxy:8094
#   rpc-proxy    →  Bearer <rpc_token>  →  chatllm:8080  (SAME token, passthrough)
#   chatllm      →  validates token with iss=control-api, aud=rpc-proxy
#
#   ALL THREE keys must be the same RSA-4096 pair:
#     rpc-proxy-secrets.RPC_PROXY_JWT_PUBLIC_KEY
#     mcp-host-config.CLERUM_AUTH_JWT_PUBLIC_KEY
#     jwt-signing-keys.CONTROL_API_RPC_JWT_PRIVATE_KEY  (private side)
#
#   After `make minikube-gen-keys`: run `make minikube-sync-auth-key` to push
#   the new public key into mcp-host-config and restart affected pods.
#
# ────────────────────────────────────────────────────────────────────────────

SHELL := /bin/bash
.DEFAULT_GOAL := help

# ── Service directories ──────────────────────────────────────────────
SERVICES := \
	channel-reader \
	workflow-approval-request-reader \
	mcp-host \
	host-context-controller \
	workflow-recipes \
	control-api \
	external-rest-api \
	rpc-proxy \
	mcp-proxy \
	webhook-proxy \
	webhook-gateway \
	stdio-bridge \
	desktop-app \
	mcp-servers \
	packages/workflow-runtime-core \
	packages/workflow-sdk

# Services that have unit tests (vitest)
TEST_SERVICES := \
	workflow-approval-request-reader \
	mcp-host \
	host-context-controller \
	workflow-recipes \
	control-api \
	external-rest-api \
	rpc-proxy \
	mcp-proxy \
	webhook-proxy \
	webhook-gateway \
	stdio-bridge \
	desktop-app \
	mcp-servers \
	packages/workflow-runtime-core \
	packages/workflow-sdk

# ── Optional private infra (gcp-*, promotion) ──────────────────────────────
-include Makefile.infra
# ── Optional OSS-launch tooling (public snapshot / infra carve) — monorepo-only
-include Makefile.oss

# ── Install ──────────────────────────────────────────────────────────
.PHONY: install-git-hooks
install-git-hooks: ## Configure Git to use tracked hooks from .githooks
	@git config core.hooksPath .githooks
	@chmod +x .githooks/pre-commit
	@chmod +x .githooks/commit-msg
	@echo "Git hooks path set to .githooks"

.PHONY: install-all
install-all: ## npm install in all services (parallel)
	@npm install --no-audit --no-fund
	@echo "Installing dependencies across all services..."
	@for svc in $(SERVICES); do \
		( cd $$svc && npm install --no-audit --no-fund ) & \
	done; \
	wait
	@cd tests/e2e && npm install --no-audit --no-fund
	@echo "All installs complete."

# ── Unit Tests ───────────────────────────────────────────────────────
.PHONY: test-unit-all
test-unit-all: ## Run unit tests across all services
	@echo "Running unit tests..."
	@failed=""; \
	for svc in $(TEST_SERVICES); do \
		echo "── $$svc ──"; \
		( cd $$svc && npm test ) || failed="$$failed $$svc"; \
	done; \
	if [ -n "$$failed" ]; then \
		echo "FAILED:$$failed"; exit 1; \
	fi
	@echo "All unit tests passed."

# ── Build Preflight ──────────────────────────────────────────────────
.PHONY: build-preflight
build-preflight: ## Run local build preflight across deployable packages
	@bash scripts/build-preflight.sh

# ── Minikube Cluster ─────────────────────────────────────────────────
MINIKUBE_PROFILE ?= clerum-test
MINIKUBE_MULTI_NODE ?= false
MINIKUBE_NODES ?=
MINIKUBE_MEMORY ?= 10240
MINIKUBE_CPUS ?= 6
SKIP_UIS ?= false
E2E_KUBECONTEXT ?= $(MINIKUBE_PROFILE)
KC := kubectl --context=$(MINIKUBE_PROFILE)
LOCAL_KUBE_CONTEXT ?=
minikube_deployment = $(if $(filter mcp-host,$(1)),chatllm,$(1))
MINIKUBE_DEPLOYMENT = $(or $(DEPLOYMENT),$(call minikube_deployment,$(SVC)))

.PHONY: minikube-start
minikube-start: ## Start minikube cluster (starts Docker Desktop if needed)
	@if ! docker info >/dev/null 2>&1; then \
		echo "Starting Docker Desktop..."; \
		open -a "Docker Desktop" 2>/dev/null || open -a Docker 2>/dev/null || true; \
		echo "Waiting for Docker daemon..."; \
		for i in $$(seq 1 30); do docker info >/dev/null 2>&1 && break; sleep 2; done; \
		docker info >/dev/null 2>&1 || { echo "ERROR: Docker not available after 60s"; exit 1; }; \
		echo "Docker ready."; \
	fi
	MINIKUBE_PROFILE="$(MINIKUBE_PROFILE)" MINIKUBE_MULTI_NODE="$(MINIKUBE_MULTI_NODE)" MINIKUBE_NODES="$(MINIKUBE_NODES)" MINIKUBE_MEMORY="$(MINIKUBE_MEMORY)" MINIKUBE_CPUS="$(MINIKUBE_CPUS)" scripts/minikube/start.sh
	@$(MAKE) --no-print-directory minikube-sync-auth-key-if-present

.PHONY: minikube-stop
minikube-stop: ## Stop minikube cluster
	minikube stop -p $(MINIKUBE_PROFILE)

.PHONY: minikube-setup
minikube-setup: ## Clean install from scratch (rebuilds the DB; REUSE_DB=true keeps it). SKIP_UIS=true omits Control/Profile UI. Needs ADMIN_PASSWORD in .env.
	@MINIKUBE_SKIP_UIS="$(SKIP_UIS)" MINIKUBE_SEED_PROFILE="$(SEED_PROFILE)" REUSE_DB="$(REUSE_DB)" \
		scripts/minikube/full-setup.sh $(ARGS)

.PHONY: minikube-setup-e2e
minikube-setup-e2e: ## Full setup + E2E fixtures (test user, e2e-* recipes, demo MCP servers).
	@$(MAKE) --no-print-directory minikube-setup SEED_PROFILE=e2e

.PHONY: minikube-teardown
minikube-teardown: ## Remove deployments (keep namespaces/CRDs)
	@scripts/minikube/teardown.sh

.PHONY: minikube-build-images
minikube-build-images: ## Build and load ALL Docker images into minikube (with SHA verification)
	@scripts/minikube/build-images.sh

.PHONY: minikube-build-custom-coordinator-fixture
minikube-build-custom-coordinator-fixture: ## Build only the custom coordinator E2E fixture image in minikube
	@scripts/minikube/build-images.sh --only=workflow-custom-sdk-e2e

.PHONY: minikube-verify-images
minikube-verify-images: ## Verify all image SHAs match between local Docker and minikube
	@scripts/minikube/build-images.sh --verify-only

.PHONY: minikube-verify
minikube-verify: ## Verify all McpServers have resolved envSecrets (standalone smoke check)
	@KUBE_CONTEXT=$(MINIKUBE_PROFILE) bash scripts/minikube/verify-mcpserver-secrets.sh

.PHONY: minikube-verify-gfs
minikube-verify-gfs: ## Verify gfs permission-store wiring (Secret DSN populated, gfsc rolled after rotation, /readyz green)
	@CONTEXT=$(MINIKUBE_PROFILE) bash scripts/minikube/verify-gfs.sh

# ── Minikube Deploy ────────────────────────────────────────────────────
# Individual stack deploys removed — use minikube-deploy-all or minikube-setup.
# The old targets (minikube-deploy-core, -mcp, -profiles, -channels, -ui)
# only applied ConfigMaps, not actual deployments, and were misleading.

.PHONY: minikube-deploy-instances
minikube-deploy-instances: ## Apply CRD test instances (context, host, channel)
	$(KC) apply -f deploy/overlays/minikube/instances/

.PHONY: minikube-detect-k8s-api-ip
minikube-detect-k8s-api-ip: ## Patch overlays/minikube/patches/k8s-api-ip.yaml with current node IP
	@CONTEXT=$(MINIKUBE_PROFILE) deploy/scripts/minikube-detect-k8s-api-ip.sh

.PHONY: minikube-deploy-all
minikube-deploy-all: ## Deploy ALL services via Kustomize minikube overlay
	@$(MAKE) --no-print-directory minikube-detect-k8s-api-ip
	kubectl --context=$(MINIKUBE_PROFILE) kustomize deploy/overlays/minikube | kubectl --context=$(MINIKUBE_PROFILE) apply -f -
	CONTEXT=$(MINIKUBE_PROFILE) bash deploy/scripts/apply-inter-service-tokens.sh
	$(KC) apply -f deploy/overlays/minikube/instances/
	@# Kustomize reapplies the persisted mcp-host ConfigMap, which can overwrite
	@# CLERUM_AUTH_JWT_PUBLIC_KEY with an older repo value. Always re-sync from
	@# rpc-proxy-secrets after each full overlay apply so Desktop/rpc-proxy/mcp-host
	@# stay on the same JWT validation key.
	@$(MAKE) --no-print-directory minikube-sync-auth-key
	@# The overlay apply may recreate/replace the gfs-controller-db Secret (and
	@# the one-time transition to the provisioning-owned connection-string key
	@# removes the legacy empty key from last-applied). When the GFS stack is
	@# deployed AND control-api is Ready (migration 0048 applied), re-provision
	@# the gfs_controller DSN so gfsc never runs with an empty or stale
	@# credential (issue #775). Fails loud if provisioning itself fails. When
	@# control-api is not Ready yet (fresh cluster mid-setup), provisioning is
	@# deferred LOUDLY to the full-setup/pre-gate-sync flow that already orders
	@# it after control-api migrations.
	@if kubectl --context=$(MINIKUBE_PROFILE) get configmap gfs-config -n gfs >/dev/null 2>&1; then \
		if kubectl --context=$(MINIKUBE_PROFILE) -n control-plane rollout status deployment/control-api --timeout=5s >/dev/null 2>&1; then \
			CONTEXT=$(MINIKUBE_PROFILE) bash deploy/scripts/provision-gfs-db.sh; \
		else \
			echo "[minikube-deploy-all] control-api not Ready — gfs DSN provisioning DEFERRED to full-setup/pre-gate-sync ordering (gfsc stays fail-closed until then)"; \
		fi; \
	fi

.PHONY: minikube-verify-networkpolicies
minikube-verify-networkpolicies: ## Verify rendered minikube NetworkPolicies exist in cluster
	@profile_cache="$${HOME}/.cache/clerum/minikube-profiles/$(MINIKUBE_PROFILE)"; \
	if [ -f "$$profile_cache/deploy/scripts/verify-networkpolicies.sh" ]; then \
		echo "Using branch-profile cached overlay: $$profile_cache/deploy"; \
		bash "$$profile_cache/deploy/scripts/verify-networkpolicies.sh" --overlay minikube --context $(MINIKUBE_PROFILE); \
	else \
		echo "Using worktree overlay: deploy"; \
		bash deploy/scripts/verify-networkpolicies.sh --overlay minikube --context $(MINIKUBE_PROFILE); \
	fi

.PHONY: minikube-restart-all
minikube-restart-all: ## Restart all Clerum deployments
	@for ns in control-plane mcp-host mcp-server profiles rpc-proxy channels; do \
		$(KC) rollout restart deploy -n $$ns 2>/dev/null || true; \
	done
	@echo "All deployments restarted."

.PHONY: minikube-deploy-crds
minikube-deploy-crds: ## Install/upgrade CRDs via Helm chart + apply CRD YAML (idempotent)
	kubectl --context=$(MINIKUBE_PROFILE) apply -f deploy/base/namespaces.yaml
	helm upgrade --install --kube-context=$(MINIKUBE_PROFILE) clerum-crds ./charts/clerum-crds
	kubectl --context=$(MINIKUBE_PROFILE) apply -f ./charts/clerum-crds/crds/

.PHONY: minikube-deploy-service
minikube-deploy-service: ## Rebuild single image + rollout restart deployment (usage: make minikube-deploy-service SVC=mcp-host NS=mcp-host [DEPLOYMENT=chatllm])
	@if [ -z "$(SVC)" ]; then echo "ERROR: SVC required. Usage: make minikube-deploy-service SVC=mcp-host NS=mcp-host [DEPLOYMENT=chatllm]"; exit 1; fi
	@if [ -z "$(NS)" ]; then echo "ERROR: NS required. Usage: make minikube-deploy-service SVC=mcp-host NS=mcp-host [DEPLOYMENT=chatllm]"; exit 1; fi
	@echo "Deploying image selector $(SVC) to deployment/$(MINIKUBE_DEPLOYMENT) in namespace $(NS)"
	@scripts/minikube/build-images.sh --only=$(SVC)
	kubectl --context=$(MINIKUBE_PROFILE) -n $(NS) rollout restart deployment/$(MINIKUBE_DEPLOYMENT)
	kubectl --context=$(MINIKUBE_PROFILE) -n $(NS) rollout status deployment/$(MINIKUBE_DEPLOYMENT) --timeout=180s

.PHONY: minikube-restart-deploy
minikube-restart-deploy: ## Restart a single deployment without rebuilding (usage: make minikube-restart-deploy SVC=mcp-host NS=mcp-host [DEPLOYMENT=chatllm])
	@if [ -z "$(SVC)" ]; then echo "ERROR: SVC required. Usage: make minikube-restart-deploy SVC=mcp-host NS=mcp-host [DEPLOYMENT=chatllm]"; exit 1; fi
	@if [ -z "$(NS)" ]; then echo "ERROR: NS required. Usage: make minikube-restart-deploy SVC=mcp-host NS=mcp-host [DEPLOYMENT=chatllm]"; exit 1; fi
	@echo "Restarting deployment/$(MINIKUBE_DEPLOYMENT) in namespace $(NS)"
	kubectl --context=$(MINIKUBE_PROFILE) -n $(NS) rollout restart deployment/$(MINIKUBE_DEPLOYMENT)
	kubectl --context=$(MINIKUBE_PROFILE) -n $(NS) rollout status deployment/$(MINIKUBE_DEPLOYMENT) --timeout=180s

# ── Minikube Secrets & Keys ─────────────────────────────────────────
#
# KEY INVARIANT: After generating new keys, the public key must be in sync across:
#   1. rpc-proxy-secrets (namespace: rpc-proxy)  → RPC_PROXY_JWT_PUBLIC_KEY
#   2. mcp-host-config   (namespace: mcp-host)   → CLERUM_AUTH_JWT_PUBLIC_KEY
#   3. deploy/overlays/minikube/configmaps/mcp-host-config.yaml  (persisted in repo)
#
# Use `make minikube-sync-auth-key` to copy the public key automatically
# from rpc-proxy-secrets into mcp-host-config after key regeneration.
#
.PHONY: minikube-gen-keys
minikube-gen-keys: ## Generate JWT signing keys + auto-sync to mcp-host-config
	@scripts/minikube/generate-keys.sh
	@if [ -f deploy/minikube/secrets/jwt-signing-keys.yaml ]; then \
	  $(KC) apply -f deploy/minikube/secrets/jwt-signing-keys.yaml; \
	else \
	  echo "JWT signing key manifest not present; using existing cluster keys."; \
	fi
	@echo "Syncing auth key..."
	@$(MAKE) --no-print-directory minikube-sync-auth-key

.PHONY: minikube-apply-secrets
minikube-apply-secrets: ## Apply all secrets to cluster (LLM keys read from .env if present)
	@# Apply JWT signing keys ONLY if they don't already exist (anti-pattern: regenerating
	@# keys invalidates all tokens and breaks admin login). Use FORCE_REGEN=true to override.
	@if ! $(KC) get secret control-api-secrets -n control-plane >/dev/null 2>&1; then \
	  echo "Creating JWT signing keys (first time)..."; \
	  if [ ! -f deploy/minikube/secrets/jwt-signing-keys.yaml ]; then \
	    scripts/minikube/generate-keys.sh; \
	  fi; \
	  $(KC) apply -f deploy/minikube/secrets/jwt-signing-keys.yaml; \
	else \
	  echo "JWT signing keys already exist — skipping (use FORCE_REGEN=true make minikube-gen-keys to regenerate)"; \
	fi
	$(KC) apply -f deploy/overlays/minikube/secrets/inter-service-tokens.yaml
	@channel_file="$(ls deploy/overlays/minikube/secrets/channel-*.yaml 2>/dev/null | head -n 1)"; \
	if [ -n "$$channel_file" ]; then \
	  $(KC) apply -f "$$channel_file"; \
	else \
	  echo "Channel file not present; per-Host channel values are managed through Control UI/control-api."; \
	fi
	@# LLM API keys — read from the main checkout .env when running from a worktree
	@ENV_FILE=""; GIT_COMMON_DIR="$$(git rev-parse --git-common-dir 2>/dev/null || true)"; if [ -n "$$GIT_COMMON_DIR" ]; then case "$$GIT_COMMON_DIR" in /*) GIT_COMMON_ABS="$$GIT_COMMON_DIR" ;; *) GIT_COMMON_ABS="$$(cd "$$GIT_COMMON_DIR" && pwd)" ;; esac; MAIN_REPO_DIR="$$(cd "$$GIT_COMMON_ABS/.." && pwd)"; if [ -f "$$MAIN_REPO_DIR/.env" ]; then ENV_FILE="$$MAIN_REPO_DIR/.env"; fi; fi; if [ -z "$$ENV_FILE" ] && [ -f .env ]; then ENV_FILE=".env"; fi; if [ -f "$$ENV_FILE" ]; then set -a && . "$$ENV_FILE" && set +a; fi; \
	  kubectl --context=$(MINIKUBE_PROFILE) create secret generic chatllm-api-keys \
	    --namespace=mcp-host \
	    --from-literal=openai-api-key="$${OPENAI_API_KEY:-sk-test-placeholder-openai-key-00000000000000000000}" \
	    --from-literal=claude-api-key="$${CLAUDE_API_KEY:-sk-ant-api03-test-placeholder-claude-key-000000000000000000000000000000000000000000000000000000}" \
	    --from-literal=zai-api-key="$${ZAI_API_KEY:-zai-test-placeholder-zai-key-00000000000000000000}" \
	    --from-literal=bailian-api-key="$${BAILIAN_API_KEY:-sk-test-placeholder-bailian-key-00000000000000000000}" \
	    --dry-run=client -o yaml | kubectl --context=$(MINIKUBE_PROFILE) apply -f -
	@echo "  LLM API keys applied (provider: $${CLERUM_MODEL_PROVIDER:-zai})"

.PHONY: minikube-apply-namespaces
minikube-apply-namespaces: ## Create all namespaces
	$(KC) apply -f deploy/base/namespaces.yaml

.PHONY: minikube-sync-auth-key
minikube-sync-auth-key: ## Sync JWT public key from rpc-proxy-secrets -> mcp-host-config only when drift exists
	@bash scripts/minikube/sync-auth-key.sh --context=$(MINIKUBE_PROFILE)

.PHONY: minikube-sync-auth-key-if-present
minikube-sync-auth-key-if-present: ## Sync JWT public key only when minikube auth resources already exist
	@if ! $(KC) get secret rpc-proxy-secrets -n rpc-proxy >/dev/null 2>&1; then \
	  echo "Skipping auth key sync (rpc-proxy-secrets not found yet)."; \
	elif ! $(KC) get configmap mcp-host-config -n mcp-host >/dev/null 2>&1; then \
	  echo "Skipping auth key sync (mcp-host-config not found yet)."; \
	else \
	  $(MAKE) --no-print-directory minikube-sync-auth-key; \
	fi

# ── Minikube Port Forwards ──────────────────────────────────────────
.PHONY: minikube-pf-control-ui
minikube-pf-control-ui: ## Port-forward Control UI → localhost:3000
	$(KC) port-forward svc/control-ui -n control-plane 3000:3000

.PHONY: minikube-pf-control-api
minikube-pf-control-api: ## Port-forward Control API → localhost:8090
	scripts/dev/resilient-kubectl-port-forward.sh "$(MINIKUBE_PROFILE)" control-plane control-api 8090 8090

.PHONY: minikube-pf-external-api
minikube-pf-external-api: ## Port-forward External REST API → localhost:8091
	scripts/dev/resilient-kubectl-port-forward.sh "$(MINIKUBE_PROFILE)" profiles external-rest-api 8091 8091

.PHONY: minikube-pf-rpc-proxy
minikube-pf-rpc-proxy: ## Port-forward RPC Proxy → localhost:8094
	scripts/dev/resilient-kubectl-port-forward.sh "$(MINIKUBE_PROFILE)" rpc-proxy rpc-proxy 8094 8094

.PHONY: minikube-pf-mcp-host
minikube-pf-mcp-host: ## Port-forward MCP Host → localhost:8080
	$(KC) port-forward svc/mcp-host -n mcp-host 8080:8080

.PHONY: minikube-pf-desktop
minikube-pf-desktop: ## Port-forward all services needed by Desktop App (background)
	@echo "Starting port-forwards for Desktop App..."
	@$(KC) port-forward svc/control-api -n control-plane 8090:8090 &
	@$(KC) port-forward svc/external-rest-api -n profiles 8091:8091 &
	@$(KC) port-forward svc/rpc-proxy -n rpc-proxy 8094:8094 &
	@echo "Desktop App ready: control-api=:8090  external-rest-api=:8091  rpc-proxy=:8094"
	@echo "  Recipe Manager needs CONTROL_API_ADMIN_USERNAME + CONTROL_API_ADMIN_PASSWORD"
	@echo "Press Ctrl+C to stop all port-forwards"
	@wait

.PHONY: minikube-pf-all
minikube-pf-all: ## Port-forward ALL services (Control UI + Desktop App)
	@scripts/minikube/pf-all-stack.sh --hold

.PHONY: minikube-pf-all-bg
minikube-pf-all-bg: ## Refresh background port-forwards for gate automation
	@scripts/minikube/pf-all-stack.sh

.PHONY: minikube-pre-gate-sync
minikube-pre-gate-sync: ## Enforce minikube sync before a gate (use GATE=<name>)
	@scripts/minikube/pre-gate-sync.sh --gate "$${GATE:-manual}" $(ARGS)

.PHONY: minikube-verify-network-policy
minikube-verify-network-policy: ## Prove NetworkPolicy enforcement in clerum-test/minikube before custom-image gates
	@CONTEXT="$(MINIKUBE_PROFILE)" scripts/minikube/verify-network-policy-enforcement.sh

# E2E_CONTEXT drives which cluster desktop-app Playwright runs against.
# Only these are permitted; "gke_your-gcp-project_us-central1-a_clerum" (prod) is hard-blocked.
E2E_CONTEXT ?= clerum-test
E2E_DESKTOP_ALLOWED_CONTEXTS := clerum-test gke_your-gcp-project_us-central1-a_example-dev
E2E_PROD_CONTEXT := gke_your-gcp-project_us-central1-a_clerum

.PHONY: e2e-desktop-app
e2e-desktop-app: ## Deterministic desktop-app Playwright E2E (validates context → pf → seed → test). Override with E2E_CONTEXT=<ctx>
	@if [ "$(E2E_CONTEXT)" = "$(E2E_PROD_CONTEXT)" ]; then \
		echo "[E2E-GUARD] Production context $(E2E_PROD_CONTEXT) is hard-blocked." >&2; exit 1; \
	fi
	@echo "$(E2E_DESKTOP_ALLOWED_CONTEXTS)" | tr ' ' '\n' | grep -qx "$(E2E_CONTEXT)" || { \
		echo "[E2E-GUARD] E2E_CONTEXT=$(E2E_CONTEXT) not in allow-list: $(E2E_DESKTOP_ALLOWED_CONTEXTS)" >&2; exit 1; \
	}
	@echo "[E2E-GUARD] Target context: $(E2E_CONTEXT)"
	@kubectl config use-context "$(E2E_CONTEXT)" >/dev/null
	@echo "[E2E-GUARD] Killing stale port-forwards on 8090/8091/8094..."
	@lsof -ti tcp:8090 -sTCP:LISTEN 2>/dev/null | xargs -r kill 2>/dev/null || true
	@lsof -ti tcp:8091 -sTCP:LISTEN 2>/dev/null | xargs -r kill 2>/dev/null || true
	@lsof -ti tcp:8094 -sTCP:LISTEN 2>/dev/null | xargs -r kill 2>/dev/null || true
	@sleep 1
	@if [ "$(E2E_CONTEXT)" = "clerum-test" ]; then \
		echo "[E2E-GUARD] Starting port-forwards against clerum-test..."; \
		kubectl --context=$(E2E_CONTEXT) port-forward svc/control-api -n control-plane 8090:8090 >/tmp/pf-control-api.log 2>&1 & \
		kubectl --context=$(E2E_CONTEXT) port-forward svc/external-rest-api -n profiles 8091:8091 >/tmp/pf-external-rest.log 2>&1 & \
		kubectl --context=$(E2E_CONTEXT) port-forward svc/rpc-proxy -n rpc-proxy 8094:8094 >/tmp/pf-rpc-proxy.log 2>&1 & \
		sleep 3; \
		echo "[E2E-GUARD] Seeding test data..."; \
		scripts/minikube/seed-test-data.sh; \
	else \
		echo "[E2E-GUARD] context=$(E2E_CONTEXT) — expecting URLs in desktop-app/.env.e2e to target GKE dev ingress. Skipping localhost pf + minikube seed."; \
	fi
	@echo "[E2E-GUARD] Launching Playwright..."
	cd desktop-app && E2E_K8S_CONTEXT=$(E2E_CONTEXT) npm run test:e2e:playwright

# ── Local Frontends ────────────────────────────────────────────────
.PHONY: local-web
local-web: ## Run Control UI locally against minikube control-api port-forward
	@set -euo pipefail; \
	cleanup() { \
		local pids; \
		pids="$$(jobs -p || true)"; \
		if [ -n "$$pids" ]; then kill $$pids 2>/dev/null || true; fi; \
		wait || true; \
	}; \
	is_port_open() { \
		local port="$$1"; \
		(echo >"/dev/tcp/127.0.0.1/$$port") >/dev/null 2>&1; \
	}; \
	ensure_port_free() { \
		local name="$$1"; \
		local port="$$2"; \
		if is_port_open "$$port"; then \
			echo "$$name port $$port is already in use on 127.0.0.1" >&2; \
			return 1; \
		fi; \
	}; \
	wait_for_port() { \
		local name="$$1"; \
		local port="$$2"; \
		local pid="$$3"; \
		local health_url="$${4:-}"; \
		local exit_code=0; \
		local deadline=$$((SECONDS + $${LOCAL_UI_API_READY_TIMEOUT_SECONDS:-90})); \
		while true; do \
			if [ -n "$$health_url" ] && curl -fsS --max-time 2 "$$health_url" >/dev/null 2>&1; then \
				echo "$$name ready at $$health_url"; \
				return 0; \
			fi; \
			if [ -z "$$health_url" ] && is_port_open "$$port"; then \
				echo "$$name ready on 127.0.0.1:$$port"; \
				return 0; \
			fi; \
			if ! kill -0 "$$pid" 2>/dev/null; then \
				wait "$$pid" || exit_code=$$?; \
				echo "$$name exited before port $$port became ready" >&2; \
				return 1; \
			fi; \
			if (( SECONDS >= deadline )); then \
				if [ -n "$$health_url" ]; then \
					echo "Timed out waiting for $$name at $$health_url" >&2; \
				else \
					echo "Timed out waiting for $$name on port $$port" >&2; \
				fi; \
				return 1; \
			fi; \
			sleep 0.25; \
		done; \
	}; \
	trap cleanup EXIT INT TERM; \
	local_context="$(LOCAL_KUBE_CONTEXT)"; \
	if [ -z "$$local_context" ]; then \
		local_context="$$(MINIKUBE_PROFILE="$(MINIKUBE_PROFILE)" GCP_DEV_CONTEXT="$(GCP_DEV_CONTEXT)" GCP_PROD_CONTEXT="$(GCP_PROD_CONTEXT)" scripts/dev/resolve-local-ui-kube-context.sh)"; \
	fi; \
	echo "Using Kubernetes context $$local_context for local-web port-forward"; \
	ensure_port_free control-api 8090; \
	$(MAKE) --no-print-directory MINIKUBE_PROFILE="$$local_context" minikube-pf-control-api & \
	api_pid=$$!; \
	wait_for_port control-api 8090 "$$api_pid" http://127.0.0.1:8090/health; \
	CONTROL_API_INTERNAL_URL=http://localhost:8090 npm --prefix control-ui run dev

.PHONY: local-app
local-app: ## Run Desktop App locally against minikube API port-forwards
	@set -euo pipefail; \
	cleanup() { \
		local pids; \
		pids="$$(jobs -p || true)"; \
		if [ -n "$$pids" ]; then kill $$pids 2>/dev/null || true; fi; \
		wait || true; \
	}; \
	is_port_open() { \
		local port="$$1"; \
		(echo >"/dev/tcp/127.0.0.1/$$port") >/dev/null 2>&1; \
	}; \
	ensure_port_free() { \
		local name="$$1"; \
		local port="$$2"; \
		if is_port_open "$$port"; then \
			echo "$$name port $$port is already in use on 127.0.0.1" >&2; \
			return 1; \
		fi; \
	}; \
	wait_for_port() { \
		local name="$$1"; \
		local port="$$2"; \
		local pid="$$3"; \
		local health_url="$${4:-}"; \
		local exit_code=0; \
		local deadline=$$((SECONDS + $${LOCAL_UI_API_READY_TIMEOUT_SECONDS:-90})); \
		while true; do \
			if [ -n "$$health_url" ] && curl -fsS --max-time 2 "$$health_url" >/dev/null 2>&1; then \
				echo "$$name ready at $$health_url"; \
				return 0; \
			fi; \
			if [ -z "$$health_url" ] && is_port_open "$$port"; then \
				echo "$$name ready on 127.0.0.1:$$port"; \
				return 0; \
			fi; \
			if ! kill -0 "$$pid" 2>/dev/null; then \
				wait "$$pid" || exit_code=$$?; \
				echo "$$name exited before port $$port became ready" >&2; \
				return 1; \
			fi; \
			if (( SECONDS >= deadline )); then \
				if [ -n "$$health_url" ]; then \
					echo "Timed out waiting for $$name at $$health_url" >&2; \
				else \
					echo "Timed out waiting for $$name on port $$port" >&2; \
				fi; \
				return 1; \
			fi; \
			sleep 0.25; \
		done; \
	}; \
	trap cleanup EXIT INT TERM; \
	local_context="$(LOCAL_KUBE_CONTEXT)"; \
	if [ -z "$$local_context" ]; then \
		local_context="$$(MINIKUBE_PROFILE="$(MINIKUBE_PROFILE)" GCP_DEV_CONTEXT="$(GCP_DEV_CONTEXT)" GCP_PROD_CONTEXT="$(GCP_PROD_CONTEXT)" scripts/dev/resolve-local-ui-kube-context.sh)"; \
	fi; \
	echo "Using Kubernetes context $$local_context for local-app port-forwards"; \
	ensure_port_free control-api 8090; \
	ensure_port_free external-rest-api 8091; \
	ensure_port_free rpc-proxy 8094; \
	$(MAKE) --no-print-directory MINIKUBE_PROFILE="$$local_context" minikube-pf-control-api & \
	control_api_pid=$$!; \
	$(MAKE) --no-print-directory MINIKUBE_PROFILE="$$local_context" minikube-pf-external-api & \
	external_api_pid=$$!; \
	$(MAKE) --no-print-directory MINIKUBE_PROFILE="$$local_context" minikube-pf-rpc-proxy & \
	rpc_proxy_pid=$$!; \
	wait_for_port control-api 8090 "$$control_api_pid" http://127.0.0.1:8090/health; \
	wait_for_port external-rest-api 8091 "$$external_api_pid" http://127.0.0.1:8091/health; \
	wait_for_port rpc-proxy 8094 "$$rpc_proxy_pid" http://127.0.0.1:8094/health; \
	env -u ELECTRON_RUN_AS_NODE EXTERNAL_REST_API_BASE_URL=http://127.0.0.1:8091 RPC_PROXY_BASE_URL=http://127.0.0.1:8094 CONTROL_API_BASE_URL=http://127.0.0.1:8090 npm --prefix desktop-app run dev

.PHONY: local-ui
local-ui: ## Run Control UI, Profile UI, and Desktop App locally against minikube port-forwards
	@set -euo pipefail; \
	cleanup() { \
		local pids; \
		pids="$$(jobs -p || true)"; \
		if [ -n "$$pids" ]; then kill $$pids 2>/dev/null || true; fi; \
		wait || true; \
	}; \
	is_port_open() { \
		local port="$$1"; \
		(echo >"/dev/tcp/127.0.0.1/$$port") >/dev/null 2>&1; \
	}; \
	ensure_port_free() { \
		local name="$$1"; \
		local port="$$2"; \
		if is_port_open "$$port"; then \
			echo "$$name port $$port is already in use on 127.0.0.1" >&2; \
			return 1; \
		fi; \
	}; \
	wait_for_port() { \
		local name="$$1"; \
		local port="$$2"; \
		local pid="$$3"; \
		local health_url="$${4:-}"; \
		local exit_code=0; \
		local deadline=$$((SECONDS + $${LOCAL_UI_API_READY_TIMEOUT_SECONDS:-90})); \
		while true; do \
			if [ -n "$$health_url" ] && curl -fsS --max-time 2 "$$health_url" >/dev/null 2>&1; then \
				echo "$$name ready at $$health_url"; \
				return 0; \
			fi; \
			if [ -z "$$health_url" ] && is_port_open "$$port"; then \
				echo "$$name ready on 127.0.0.1:$$port"; \
				return 0; \
			fi; \
			if ! kill -0 "$$pid" 2>/dev/null; then \
				wait "$$pid" || exit_code=$$?; \
				echo "$$name exited before port $$port became ready" >&2; \
				return 1; \
			fi; \
			if (( SECONDS >= deadline )); then \
				if [ -n "$$health_url" ]; then \
					echo "Timed out waiting for $$name at $$health_url" >&2; \
				else \
					echo "Timed out waiting for $$name on port $$port" >&2; \
				fi; \
				return 1; \
			fi; \
			sleep 0.25; \
		done; \
	}; \
	monitor_frontend() { \
		local name="$$1"; \
		local pid="$$2"; \
		local exit_code=0; \
		if kill -0 "$$pid" 2>/dev/null; then \
			return 0; \
		fi; \
		wait "$$pid" || exit_code=$$?; \
		if [ "$$exit_code" -eq 0 ]; then exit_code=1; fi; \
		echo "$$name exited with code $$exit_code" >&2; \
		exit "$$exit_code"; \
	}; \
	trap cleanup EXIT INT TERM; \
	local_context="$(LOCAL_KUBE_CONTEXT)"; \
	if [ -z "$$local_context" ]; then \
		local_context="$$(MINIKUBE_PROFILE="$(MINIKUBE_PROFILE)" GCP_DEV_CONTEXT="$(GCP_DEV_CONTEXT)" GCP_PROD_CONTEXT="$(GCP_PROD_CONTEXT)" scripts/dev/resolve-local-ui-kube-context.sh)"; \
	fi; \
	echo "Using Kubernetes context $$local_context for local-ui port-forwards"; \
	ensure_port_free control-api 8090; \
	ensure_port_free external-rest-api 8091; \
	ensure_port_free profile-ui 3001; \
	ensure_port_free rpc-proxy 8094; \
	$(MAKE) --no-print-directory MINIKUBE_PROFILE="$$local_context" minikube-pf-control-api & \
	control_api_pid=$$!; \
	$(MAKE) --no-print-directory MINIKUBE_PROFILE="$$local_context" minikube-pf-external-api & \
	external_api_pid=$$!; \
	$(MAKE) --no-print-directory MINIKUBE_PROFILE="$$local_context" minikube-pf-rpc-proxy & \
	rpc_proxy_pid=$$!; \
	wait_for_port control-api 8090 "$$control_api_pid" http://127.0.0.1:8090/health; \
	wait_for_port external-rest-api 8091 "$$external_api_pid" http://127.0.0.1:8091/health; \
	wait_for_port rpc-proxy 8094 "$$rpc_proxy_pid" http://127.0.0.1:8094/health; \
	CONTROL_API_INTERNAL_URL=http://localhost:8090 npm --prefix control-ui run dev & \
	control_ui_pid=$$!; \
	$(MAKE) --no-print-directory -C profile-ui PORT=3001 dev & \
	profile_ui_pid=$$!; \
	env -u ELECTRON_RUN_AS_NODE EXTERNAL_REST_API_BASE_URL=http://127.0.0.1:8091 RPC_PROXY_BASE_URL=http://127.0.0.1:8094 CONTROL_API_BASE_URL=http://127.0.0.1:8090 npm --prefix desktop-app run dev & \
	desktop_app_pid=$$!; \
	while true; do \
		monitor_frontend control-ui "$$control_ui_pid"; \
		monitor_frontend profile-ui "$$profile_ui_pid"; \
		monitor_frontend desktop-app "$$desktop_app_pid"; \
		sleep 0.5; \
	done

# ── Minikube Status ─────────────────────────────────────────────────
.PHONY: minikube-status
minikube-status: ## Show status of all Clerum services in minikube
	@echo ""
	@echo "  CLERUM CLUSTER STATUS"
	@echo "  ====================="
	@echo ""
	@$(KC) get deploy -A \
		-o custom-columns=NS:.metadata.namespace,NAME:.metadata.name,READY:.status.readyReplicas,DESIRED:.spec.replicas \
		--no-headers 2>/dev/null | grep -v kube-system | \
		awk '$$4 != "0" { ready=($$3 == "<none>" ? 0 : $$3); desired=$$4; status=(ready==desired ? "OK" : "!! " ready "/" desired); printf "  %-16s %-45s %s\n", $$1, $$2, status }'
	@echo ""
	@$(KC) get sts -A --no-headers 2>/dev/null | \
		awk '{printf "  %-16s %-45s %s\n", $$1, $$2, ($$3=="1/1" ? "OK" : "!! "$$3)}'
	@echo ""

.PHONY: minikube-logs
minikube-logs: ## Show logs for a service (usage: make minikube-logs SVC=control-api NS=control-plane)
	$(KC) logs -n $(NS) deploy/$(SVC) --tail=50

.PHONY: minikube-db-reset
minikube-db-reset: ## Reset control-api postgres (re-enables first-time admin setup)
	@echo "Scaling down control-api and postgres..."
	@$(KC) scale deploy/control-api --replicas=0 -n control-plane
	@$(KC) scale deploy/control-postgres --replicas=0 -n control-plane
	@echo "Waiting for pods to terminate..."
	@sleep 6
	@$(KC) delete pvc control-postgres-data -n control-plane --ignore-not-found --wait=true
	@echo "Cleaning up Released PVs..."
	@$(KC) get pv --no-headers 2>/dev/null | grep 'control-postgres' | awk '{print $$1}' | xargs -r $(KC) delete pv 2>/dev/null || true
	@$(KC) apply -f deploy/base/control-plane/control-postgres.yaml
	@echo "Scaling up postgres..."
	@$(KC) scale deploy/control-postgres --replicas=1 -n control-plane
	@$(KC) wait --for=condition=Available deploy/control-postgres -n control-plane --timeout=90s
	@echo "Scaling up control-api..."
	@$(KC) scale deploy/control-api --replicas=1 -n control-plane
	@$(KC) wait --for=condition=Available deploy/control-api -n control-plane --timeout=90s
	@echo "DB reset complete. First-time admin setup is available again."

.PHONY: minikube-seed-test-data
minikube-seed-test-data: ## Seed E2E user + agent + context on minikube via admin API (idempotent; default password: changeme123!)
	@PASS=$${TEST_ADMIN_PASSWORD:-$${ADMIN_PASSWORD:-changeme123!}}; \
	 CONTEXT=$(MINIKUBE_PROFILE) ADMIN_PASSWORD=$$PASS bash scripts/e2e/seed-e2e-data.sh

.PHONY: minikube-seed-sandbox-ui-test-data
minikube-seed-sandbox-ui-test-data: ## Seed default sandbox-ui nginx fixture on minikube
	@CONTEXT=$(MINIKUBE_PROFILE) bash scripts/minikube/seed-sandbox-ui-test-data.sh

.PHONY: minikube-deploy-evenfire-registry
minikube-deploy-evenfire-registry: ## Build + deploy evenfire-registry side-by-side into the selected minikube profile
	@if [ -f scripts/minikube/deploy-evenfire-registry.sh ]; then \
	   MINIKUBE_PROFILE=$(MINIKUBE_PROFILE) SKIP_BUILD="$(SKIP_BUILD)" SKIP_WAIT="$(SKIP_WAIT)" EVENFIRE_REGISTRY_DIR="$(EVENFIRE_REGISTRY_DIR)" bash scripts/minikube/deploy-evenfire-registry.sh; \
	 else \
	   echo "skip: scripts/minikube/deploy-evenfire-registry.sh not present (sibling repo not included in this distribution)"; \
	 fi

.PHONY: minikube-seed-registry
minikube-seed-registry: ## Seed registry catalog — run seed from your registry server repo
	@echo "Registry seeding lives in the registry server repo (evenfire-registry or your own implementation)."
	@echo "First deploy it: make minikube-deploy-evenfire-registry"
	@echo "Then seed it from your registry server repo: make minikube-seed"
	@exit 1

.PHONY: backfill-637-secret-ownership
backfill-637-secret-ownership: ## Issue #637 — back-fill recipe Secret ownership labels (CONTEXT=<ctx>; default DRY-RUN; APPLY=yes to write; CONFIRM=yes required for prod)
	@test -n "$(CONTEXT)" || { echo "ERROR: set CONTEXT=<allowed kubectl context>"; exit 2; }
	@test -d packages/workflow-runtime-core/node_modules || { echo "ERROR: run 'npm ci' in packages/workflow-runtime-core first"; exit 2; }
	@test -d workflow-recipes/node_modules || { echo "ERROR: run 'npm ci' in workflow-recipes first"; exit 2; }
	@cd workflow-recipes && npm run --silent build >/dev/null
	@cd workflow-recipes && CONFIRM=$(CONFIRM) node dist/cli/backfillRecipeSecretOwnership.js --context $(CONTEXT) $(if $(filter yes,$(APPLY)),--apply,)

.PHONY: desktop-dev
desktop-dev: ## Build + launch Desktop App with all port-forwards
	@echo "═══ Building Desktop App ═══"
	@cd desktop-app && npm run build
	@echo ""
	@echo "═══ Starting port-forwards ═══"
	@kubectl port-forward svc/control-ui -n control-plane 3000:3000 2>/dev/null &
	@kubectl port-forward svc/control-api -n control-plane 8090:8090 2>/dev/null &
	@kubectl port-forward svc/external-rest-api -n profiles 8091:8091 2>/dev/null &
	@kubectl port-forward svc/rpc-proxy -n rpc-proxy 8094:8094 2>/dev/null &
	@sleep 2
	@echo ""
	@echo "  Control UI     → http://localhost:3000"
	@echo "  Control API    → http://localhost:8090"
	@echo "  External REST  → http://localhost:8091"
	@echo "  RPC Proxy      → http://localhost:8094"
	@echo ""
	@echo "═══ Launching Desktop App ═══"
	@cd desktop-app && npm start

# ── Integration Tests ────────────────────────────────────────────────
.PHONY: test-integration
test-integration: test-e2e-deps ## Run integration tests (tests/e2e/integration/)
	@echo "Running integration tests..."
	cd tests/e2e && npx vitest run integration/

.PHONY: test-contracts
test-contracts: test-e2e-deps ## Run contract tests only
	@echo "Running contract tests..."
	cd tests/e2e && npx vitest run integration/contracts.test.ts

# ── E2E Tests ────────────────────────────────────────────────────────
.PHONY: test-e2e-bash
test-e2e-bash: ## Run bash-based E2E suites (scripts/e2e/*.sh)
	@echo "Running bash E2E suites..."
	KUBECONTEXT=$(E2E_KUBECONTEXT) bash scripts/e2e/e2e-workflow-runtime-gate.sh
	KUBECONTEXT=$(E2E_KUBECONTEXT) bash scripts/e2e/e2e-wrc-internal-dependency-networkpolicy.sh
	KUBECONTEXT=$(E2E_KUBECONTEXT) bash scripts/e2e/e2e-workflow-backend-compat.sh
	KUBECONTEXT=$(E2E_KUBECONTEXT) bash scripts/e2e/e2e-sfs-legacy-job-cleanup.sh
	KUBECONTEXT=$(E2E_KUBECONTEXT) bash scripts/e2e/e2e-sfs-security.sh

.PHONY: test-e2e-workflow-runtime
test-e2e-workflow-runtime: ## Run workflow runtime E2E gate
	@echo "Running workflow runtime E2E gate..."
	KUBECONTEXT=$(E2E_KUBECONTEXT) bash scripts/e2e/e2e-workflow-runtime-gate.sh

.PHONY: test-e2e-wrc-internal-dependency-networkpolicy
test-e2e-wrc-internal-dependency-networkpolicy: ## Run issue #485 WRC internal-dependency NetworkPolicy E2E gate
	@echo "Running WRC internal-dependency NetworkPolicy E2E gate..."
	KUBECONTEXT=$(E2E_KUBECONTEXT) bash scripts/e2e/e2e-wrc-internal-dependency-networkpolicy.sh

.PHONY: test-e2e-plugin-workload-sdk
test-e2e-plugin-workload-sdk: ## Run Plugin Workload SDK E2E gate (minikube only; set E2E_ADMIN_TOKEN for the full happy path)
	@echo "Running Plugin Workload SDK E2E gate..."
	KUBECONTEXT=$(E2E_KUBECONTEXT) bash scripts/e2e/e2e-plugin-workload-sdk.sh

.PHONY: test-e2e-cron-tab-validation
test-e2e-cron-tab-validation: ## Run recipe cron tab E2E (set E2E_CRON_TAB_FIX_REQUIRED=1 when the fix must be present)
	@echo "Running cron tab validation E2E gate..."
	KUBECONTEXT=$(E2E_KUBECONTEXT) bash scripts/e2e/e2e-cron-tab-validation.sh

.PHONY: test-e2e-sfs-legacy-job-cleanup
test-e2e-sfs-legacy-job-cleanup: ## Run SharedFilesystem legacy wfc-init Job cleanup gate (#549, single-node)
	@echo "Running SFS legacy-job cleanup E2E gate..."
	KUBECONTEXT=$(E2E_KUBECONTEXT) bash scripts/e2e/e2e-sfs-legacy-job-cleanup.sh

.PHONY: test-e2e-sfs-security
test-e2e-sfs-security: ## Run SharedFilesystem security gate (#549: directory injection + retained-PVC reuse, single-node)
	@echo "Running SFS security E2E gate..."
	KUBECONTEXT=$(E2E_KUBECONTEXT) bash scripts/e2e/e2e-sfs-security.sh

.PHONY: test-e2e-sfs-rwo-multinode
test-e2e-sfs-rwo-multinode: ## Run SharedFilesystem RWO Multi-Attach gate (#549, REQUIRES a multi-node profile)
	@echo "Running SFS RWO multi-node E2E gate (needs >= 2 nodes)..."
	KUBECONTEXT=$(E2E_KUBECONTEXT) bash scripts/e2e/e2e-sfs-rwo-multinode.sh

.PHONY: test-e2e-sharedfilesystem-rwo
test-e2e-sharedfilesystem-rwo: ## Run SharedFileSystem RWO default + truthful status + wfc co-location gate (#592, REQUIRES a multi-node profile + this branch's HCC image)
	@echo "Running SFS #592 RWO/status/co-location E2E gate (needs >= 2 nodes)..."
	KUBECONTEXT=$(E2E_KUBECONTEXT) bash scripts/e2e/e2e-sharedfilesystem-rwo.sh

.PHONY: test-e2e-registry-decoupling
test-e2e-registry-decoupling: ## Run registry-decoupling E2E suite (minikube: needs control-api + registry PFs; GKE: set REGISTRY_API)
	@echo "Running registry-decoupling E2E suite..."
	@echo "Prereqs: minikube → make minikube-setup + PFs on :8090 (control-api) + :8085 (registry-api)"
	@echo "         GKE     → control-api PF + REGISTRY_API=https://example.com"
	KUBECONTEXT=$(E2E_KUBECONTEXT) bash scripts/e2e/e2e-registry-decoupling.sh

.PHONY: test-e2e-workflow-backend-compat
test-e2e-workflow-backend-compat: ## Run non-gating workflow backend compatibility E2E suites
	@echo "Running workflow backend compatibility suites..."
	KUBECONTEXT=$(E2E_KUBECONTEXT) bash scripts/e2e/e2e-workflow-backend-compat.sh

.PHONY: test-e2e-figure-b
test-e2e-figure-b: ## Run 1st-party AuthN, 3rd-party MCP-Host recipe sandbox workflow trigger gate
	@echo "Running 1st-party AuthN, 3rd-party MCP-Host (recipe sandbox) E2E gate..."
	KUBECONTEXT=$(E2E_KUBECONTEXT) bash scripts/e2e/e2e-figure-b-sandbox-mcphost.sh

.PHONY: test-e2e-figure-b-gateway-resilience
test-e2e-figure-b-gateway-resilience: ## Run 1st-party AuthN, 3rd-party MCP-Host gateway resilience gate
	@echo "Running 1st-party AuthN, 3rd-party MCP-Host gateway resilience gate..."
	KUBECONTEXT=$(E2E_KUBECONTEXT) bash scripts/e2e/e2e-figure-b-gateway-resilience.sh

.PHONY: test-e2e-stateless-phase0
test-e2e-stateless-phase0: ## Run stateless cold-start Phase-0 measurement (p95 gate + JSON artifact)
	@echo "Running stateless cold-start Phase-0 measurement..."
	KUBECONTEXT=$(E2E_KUBECONTEXT) bash scripts/e2e/stateless-cold-start-measure.sh

.PHONY: test-e2e-stateless-durability
test-e2e-stateless-durability: ## Run stateless host durability E2E gate (Phase 1a; needs port-forwards + seeded chatllm-stateless)
	@echo "Running stateless durability E2E gate..."
	KUBECONTEXT=$(E2E_KUBECONTEXT) bash scripts/e2e/e2e-stateless-durability.sh

.PHONY: test-e2e-stateless-suspend-wake
test-e2e-stateless-suspend-wake: ## Run stateless suspend/wake E2E gate (Phase 1 API + Phase 2 Desktop Playwright; needs port-forwards + seeded chatllm-stateless)
	@echo "Running stateless suspend/wake E2E gate..."
	KUBECONTEXT=$(E2E_KUBECONTEXT) bash scripts/e2e/e2e-stateless-suspend-wake.sh

.PHONY: test-e2e-stateless-wake-recovery
test-e2e-stateless-wake-recovery: ## Run stateless wake-recovery latency gate (R1 warm draining / R2 cold suspended / R3 drained-window p95 budgets; needs port-forwards + seeded chatllm-stateless)
	@echo "Running stateless wake-recovery latency gate..."
	KUBECONTEXT=$(E2E_KUBECONTEXT) bash scripts/e2e/e2e-stateless-wake-recovery.sh

.PHONY: test-e2e-hcc-communicationchannel-watch-recovery
test-e2e-hcc-communicationchannel-watch-recovery: ## Run isolated minikube HCC watch-recovery fault-injection gate
	@echo "Running HCC CommunicationChannel watch-recovery gate..."
	E2E_HCC_WATCH_FAULT_INJECTION=1 KUBECONTEXT=$(E2E_KUBECONTEXT) bash scripts/e2e/e2e-hcc-communicationchannel-watch-recovery.sh

.PHONY: test-e2e-stateless-multinode
test-e2e-stateless-multinode: ## Run stateless multi-node lane (opt-in: STATELESS_MULTINODE_GATE=1; needs >=2 schedulable nodes; exit 3 = cross-node UNVERIFIED)
	@echo "Running stateless multi-node lane..."
	STATELESS_MULTINODE_GATE=1 KUBECONTEXT=$(E2E_KUBECONTEXT) bash scripts/e2e/e2e-stateless-multinode.sh

.PHONY: test-e2e-stateless-idle-calibration
test-e2e-stateless-idle-calibration: ## Run stateless T_idle calibration sweep (compressed-local; needs port-forwards + seeded chatllm-stateless; ~26 min default matrix)
	@echo "Running stateless T_idle calibration sweep..."
	KUBECONTEXT=$(E2E_KUBECONTEXT) bash scripts/e2e/e2e-stateless-idle-calibration.sh

.PHONY: test-e2e-deps
test-e2e-deps: ## Install tests/e2e dependencies when missing
	@if [ ! -x tests/e2e/node_modules/.bin/vitest ]; then \
		echo "Installing tests/e2e dependencies with npm ci..."; \
		cd tests/e2e && npm ci --no-audit --no-fund; \
	fi

.PHONY: test-e2e-vitest
test-e2e-vitest: test-e2e-deps ## Run vitest-based E2E suites (tests/e2e/)
	@echo "Running vitest E2E suites..."
	bash scripts/e2e/run-vitest-e2e.sh

.PHONY: test-e2e-all
test-e2e-all: test-e2e-bash test-e2e-vitest ## Run all E2E tests (bash + vitest)

# ── Playwright Tests ─────────────────────────────────────────────────
.PHONY: test-playwright-install
test-playwright-install: ## Install Playwright deps + Chromium browser
	@cd tests/e2e/playwright && npm install --no-audit --no-fund
	@cd tests/e2e/playwright && npx playwright install chromium

.PHONY: test-playwright
test-playwright: ## Run all Playwright tests (Control UI + Desktop App)
	@echo "Running Playwright E2E tests..."
	cd tests/e2e/playwright && npx playwright test

.PHONY: test-playwright-control-ui
test-playwright-control-ui: ## Run Playwright tests for Control UI only (requires: make minikube-pf-all)
	@echo "Running Playwright Control UI tests..."
	cd tests/e2e/playwright && npx playwright test --project=control-ui

.PHONY: test-playwright-desktop
test-playwright-desktop: ## Run Playwright tests for Desktop App only (requires: cd desktop-app && npm run build)
	@echo "Running Playwright Desktop App tests..."
	cd tests/e2e/playwright && npx playwright test --project=desktop

.PHONY: test-playwright-headed
test-playwright-headed: ## Run Control UI Playwright tests in headed mode (visible browser)
	cd tests/e2e/playwright && npx playwright test --project=control-ui --headed

# ── CI Script Tests ──────────────────────────────────────────────────
.PHONY: test-ci-scripts
test-ci-scripts: ## Run unit tests for .github/scripts/* shell scripts
	@echo "── extract-pr-summary"
	@./tests/ci/extract-pr-summary.test.sh
	@echo "── enumerate-promoted-prs"
	@./tests/ci/enumerate-promoted-prs.test.sh

# ── Sync Check ───────────────────────────────────────────────────────
.PHONY: sync-check
sync-check: ## Diff prod vs minikube manifests, alert divergences
	@echo "Checking manifest sync..."
	@if [ -d deploy/overlays/minikube ] && [ -d charts ]; then \
		diff_output=$$(diff -rq deploy/overlays/minikube/ charts/ --exclude='*.tgz' 2>/dev/null || true); \
		if [ -n "$$diff_output" ]; then \
			echo "WARNING: Divergences found:"; \
			echo "$$diff_output"; \
			exit 1; \
		else \
			echo "Manifests are in sync."; \
		fi; \
	else \
		echo "Skipped: deploy/overlays/minikube/ or charts/ not found."; \
	fi

# ── Full Pipeline ────────────────────────────────────────────────────
.PHONY: validate-all
validate-all: install-all test-unit-all build-preflight minikube-setup-e2e test-integration test-e2e-all ## Full validation pipeline

.PHONY: collect-cluster-evidence
collect-cluster-evidence: ## Collect cluster evidence bundle (use OUT_DIR=/path if needed)
	@scripts/e2e/collect-cluster-evidence.sh "$${OUT_DIR:-}"

.PHONY: run-platform-security-gates
run-platform-security-gates: ## Execute the revised platform security gate runner
	@scripts/e2e/run-platform-security-gates.sh

# ── Help ─────────────────────────────────────────────────────────────
.PHONY: help
help: ## Show this help
	@grep -E '^[a-zA-Z0-9_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-24s\033[0m %s\n", $$1, $$2}'

