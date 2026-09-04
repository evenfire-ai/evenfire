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
	codex-llm-proxy \
	webhook-gateway \
	stdio-bridge \
	profile-ui \
	desktop-app \
	profile-ui \
	mcp-servers \
	packages/desktop-app-links \
	packages/workflow-runtime-core \
	packages/workflow-sdk \
	packages/llm-provider-attempt-contract

# Services that have unit tests
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
	codex-llm-proxy \
	webhook-gateway \
	stdio-bridge \
	profile-ui \
	desktop-app \
	mcp-servers \
	packages/desktop-app-links \
	packages/workflow-runtime-core \
	packages/workflow-sdk \
	packages/network-policy-core \
	packages/llm-provider-attempt-contract

# ── Optional private infra (gcp-*, promotion) ──────────────────────────────
-include Makefile.infra
# ── Optional OSS-launch tooling (public snapshot / infra carve) — monorepo-only
-include Makefile.oss

# ── Prerequisites ────────────────────────────────────────────────────
.PHONY: prereqs
prereqs: ## Check every dependency for minikube-setup up front (Docker/minikube/kubectl/node/…) with per-platform install commands
	@bash scripts/check-prereqs.sh

.PHONY: doctor
doctor: prereqs ## Alias for 'prereqs'

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

.PHONY: test-codex-subscription-t0
test-codex-subscription-t0: ## Run the Codex subscription T0 aggregator (counts, no skips)
	@bash scripts/tests/test-codex-subscription-t0.sh

# ── Build Preflight ──────────────────────────────────────────────────
.PHONY: build-preflight
build-preflight: ## Run local build preflight across deployable packages
	@bash scripts/build-preflight.sh

# ── Minikube Cluster ─────────────────────────────────────────────────
MINIKUBE_PROFILE ?= clerum-test
# Startup supports the documented shared local profile before a branch-owned
# T2 lease exists. The mode is passed only by minikube-start; standalone auth
# sync remains lease-protected.
MINIKUBE_STARTUP_AUTH_SYNC_MODE ?= locked
MINIKUBE_MULTI_NODE ?= false
MINIKUBE_NODES ?=
MINIKUBE_MEMORY ?= 10240
MINIKUBE_CPUS ?= 6
SKIP_UIS ?= false
E2E_KUBECONTEXT ?= $(MINIKUBE_PROFILE)
KC := kubectl --context=$(MINIKUBE_PROFILE)
LOCAL_KUBE_CONTEXT ?=
# Exact selectors with an established deployment route in scripts/minikube/dev.sh.
# Keep this public Make boundary aligned with build-images.sh so typos fail
# before a lock is acquired or any image/deployment mutation begins.
MINIKUBE_DEPLOY_SERVICE_SELECTORS := control-api control-ui external-rest-api hcc mcp-host profile-ui rpc-proxy
MINIKUBE_DEPLOY_SERVICE := $(strip $(SVC))
MINIKUBE_DEPLOY_SERVICE_SUPPORTED := $(and $(filter 1,$(words $(MINIKUBE_DEPLOY_SERVICE))),$(filter $(MINIKUBE_DEPLOY_SERVICE_SELECTORS),$(MINIKUBE_DEPLOY_SERVICE)))
MINIKUBE_DEPLOY_NAMESPACE := $(strip $(NS))
minikube_deployment = $(if $(filter mcp-host,$(strip $(1))),chatllm,$(strip $(1)))
DEPLOYMENT ?= $(call minikube_deployment,$(MINIKUBE_DEPLOY_SERVICE))
MINIKUBE_EFFECTIVE_DEPLOYMENT := $(or $(strip $(DEPLOYMENT)),$(call minikube_deployment,$(MINIKUBE_DEPLOY_SERVICE)))

.PHONY: minikube-start
minikube-start: ## Start minikube cluster (starts Docker Desktop if needed)
	@if ! scripts/minikube/docker-cli-env.sh --check-info; then \
		echo "Starting Docker Desktop..."; \
		open -a "Docker Desktop" 2>/dev/null || open -a Docker 2>/dev/null || true; \
		echo "Waiting for Docker daemon..."; \
		docker_start_timeout="$${MINIKUBE_DOCKER_START_TIMEOUT_SECONDS:-60}"; \
		MINIKUBE_DOCKER_START_TIMEOUT_SECONDS="$$docker_start_timeout" \
			scripts/minikube/docker-cli-env.sh --wait-for-info || { \
				echo "ERROR: Docker not available after $${docker_start_timeout}s"; \
				exit 1; \
			}; \
		echo "Docker ready."; \
	fi
	MINIKUBE_PROFILE="$(MINIKUBE_PROFILE)" MINIKUBE_MULTI_NODE="$(MINIKUBE_MULTI_NODE)" MINIKUBE_NODES="$(MINIKUBE_NODES)" MINIKUBE_MEMORY="$(MINIKUBE_MEMORY)" MINIKUBE_CPUS="$(MINIKUBE_CPUS)" scripts/minikube/start.sh
	@$(MAKE) --no-print-directory MINIKUBE_STARTUP_AUTH_SYNC_MODE=shared-profile-mcp minikube-sync-auth-key-if-present

.PHONY: minikube-stop
minikube-stop: ## Stop minikube cluster
	minikube stop -p $(MINIKUBE_PROFILE)

# Images come from ghcr by default: `make minikube-setup` on a clean clone
# pulls ~25 published images instead of building 28 from source. Build
# everything locally with `make minikube-setup-local` (or IMAGE_SOURCE=local).
IMAGE_SOURCE ?= ghcr
# GFS Secret/role mutation is owned by the canonical T2 lease. Callers that
# intentionally run the full T2 transition set this to true and pass the
# inherited opaque T2_LOCK_TOKEN; ordinary deploys render/filter GFS resources.
MINIKUBE_GFS_MUTATION ?= false

.PHONY: minikube-setup
minikube-setup: ## Clean install from scratch, PULLING published images (IMAGE_SOURCE=local or `make minikube-setup-local` builds instead). Rebuilds the DB; REUSE_DB=true keeps it. SKIP_UIS=true omits Control/Profile UI. Runs 'prereqs' first (SKIP_PREREQS=true to bypass). Needs ADMIN_PASSWORD in .env.
	@if [ "$(SKIP_PREREQS)" != "true" ]; then $(MAKE) --no-print-directory prereqs; fi
	@T2_PROJECT_DIR="$(CURDIR)" T2_PROFILE="$(MINIKUBE_PROFILE)" T2_CONTEXT="$(MINIKUBE_PROFILE)" \
		T2_SKIP_LOCK="$(T2_SKIP_LOCK)" T2_LOCK_TOKEN="$(T2_LOCK_TOKEN)" \
		MINIKUBE_SKIP_UIS="$(SKIP_UIS)" MINIKUBE_SEED_PROFILE="$(SEED_PROFILE)" REUSE_DB="$(REUSE_DB)" \
		IMAGE_SOURCE="$(IMAGE_SOURCE)" MINIKUBE_IMAGE_TAG="$(MINIKUBE_IMAGE_TAG)" \
		scripts/minikube/full-setup.sh $(ARGS)

.PHONY: minikube-setup-local
minikube-setup-local: ## Clean install building every image from source (the pre-2026-08 behaviour; ~20 min on a clean clone). Use when you are changing service code, or when no published image exists for your platform.
	@$(MAKE) --no-print-directory minikube-setup IMAGE_SOURCE=local

.PHONY: minikube-setup-e2e
minikube-setup-e2e: ## Full setup + E2E fixtures (test user, e2e-* recipes, demo MCP servers). Pulls published images, then builds the two unpublished E2E coordinator fixtures.
	@$(MAKE) --no-print-directory minikube-setup SEED_PROFILE=e2e
	@if [ "$(IMAGE_SOURCE)" = "ghcr" ]; then \
		echo "Building the two unpublished E2E coordinator fixtures..."; \
		$(MAKE) --no-print-directory minikube-build-e2e-fixtures; \
	fi

.PHONY: minikube-teardown
minikube-teardown: ## Remove deployments (keep namespaces/CRDs)
	@scripts/minikube/teardown.sh

.PHONY: minikube-pull-images minikube-pull-images-body
minikube-pull-images: ## Pull ALL published images into minikube at the pinned release tag (MINIKUBE_IMAGE_TAG=<tag> overrides the pin for this run only)
	@T2_PROJECT_DIR="$(CURDIR)" T2_PROFILE="$(MINIKUBE_PROFILE)" T2_CONTEXT="$(MINIKUBE_PROFILE)" \
		T2_SKIP_LOCK="$(T2_SKIP_LOCK)" T2_LOCK_TOKEN="$(T2_LOCK_TOKEN)" \
		bash scripts/minikube/with-t2-mutation-lock.sh -- \
		$(MAKE) --no-print-directory minikube-pull-images-body

minikube-pull-images-body:
	@T2_PROJECT_DIR="$(CURDIR)" T2_PROFILE="$(MINIKUBE_PROFILE)" T2_CONTEXT="$(MINIKUBE_PROFILE)" \
		T2_SKIP_LOCK=true T2_LOCK_TOKEN="$(T2_LOCK_TOKEN)" \
		bash scripts/minikube/require-t2-mutation-lock.sh
	@T2_PROJECT_DIR="$(CURDIR)" T2_PROFILE="$(MINIKUBE_PROFILE)" T2_CONTEXT="$(MINIKUBE_PROFILE)" \
		MINIKUBE_PROFILE="$(MINIKUBE_PROFILE)" MINIKUBE_IMAGE_TAG="$(MINIKUBE_IMAGE_TAG)" \
		CONTROL_API_REAL_PG_CONTEXT="$(MINIKUBE_PROFILE)" \
		scripts/minikube/pull-images.sh

.PHONY: minikube-build-images minikube-build-images-body
minikube-build-images: ## Build and load ALL Docker images into minikube (with SHA verification)
	@T2_PROJECT_DIR="$(CURDIR)" T2_PROFILE="$(MINIKUBE_PROFILE)" T2_CONTEXT="$(MINIKUBE_PROFILE)" \
		T2_SKIP_LOCK="$(T2_SKIP_LOCK)" T2_LOCK_TOKEN="$(T2_LOCK_TOKEN)" \
		bash scripts/minikube/with-t2-mutation-lock.sh -- \
		$(MAKE) --no-print-directory minikube-build-images-body

minikube-build-images-body:
	@T2_PROJECT_DIR="$(CURDIR)" T2_PROFILE="$(MINIKUBE_PROFILE)" T2_CONTEXT="$(MINIKUBE_PROFILE)" \
		T2_SKIP_LOCK=true T2_LOCK_TOKEN="$(T2_LOCK_TOKEN)" \
		bash scripts/minikube/require-t2-mutation-lock.sh
	@MINIKUBE_PROFILE="$(MINIKUBE_PROFILE)" scripts/minikube/build-images.sh

.PHONY: minikube-build-custom-coordinator-fixture minikube-build-custom-coordinator-fixture-body
minikube-build-custom-coordinator-fixture: ## Build only the custom coordinator E2E fixture image in minikube
	@T2_PROJECT_DIR="$(CURDIR)" T2_PROFILE="$(MINIKUBE_PROFILE)" T2_CONTEXT="$(MINIKUBE_PROFILE)" \
		T2_SKIP_LOCK="$(T2_SKIP_LOCK)" T2_LOCK_TOKEN="$(T2_LOCK_TOKEN)" \
		bash scripts/minikube/with-t2-mutation-lock.sh -- \
		$(MAKE) --no-print-directory minikube-build-custom-coordinator-fixture-body

minikube-build-custom-coordinator-fixture-body:
	@T2_PROJECT_DIR="$(CURDIR)" T2_PROFILE="$(MINIKUBE_PROFILE)" T2_CONTEXT="$(MINIKUBE_PROFILE)" \
		T2_SKIP_LOCK=true T2_LOCK_TOKEN="$(T2_LOCK_TOKEN)" \
		bash scripts/minikube/require-t2-mutation-lock.sh
	@MINIKUBE_PROFILE="$(MINIKUBE_PROFILE)" scripts/minikube/build-images.sh --only=workflow-custom-sdk-e2e

.PHONY: minikube-build-e2e-fixtures minikube-build-e2e-fixtures-body
minikube-build-e2e-fixtures: ## Build the two unpublished coordinator E2E fixtures under one mutation lease
	@T2_PROJECT_DIR="$(CURDIR)" T2_PROFILE="$(MINIKUBE_PROFILE)" T2_CONTEXT="$(MINIKUBE_PROFILE)" \
		T2_SKIP_LOCK="$(T2_SKIP_LOCK)" T2_LOCK_TOKEN="$(T2_LOCK_TOKEN)" \
		bash scripts/minikube/with-t2-mutation-lock.sh -- \
		$(MAKE) --no-print-directory minikube-build-e2e-fixtures-body

minikube-build-e2e-fixtures-body:
	@T2_PROJECT_DIR="$(CURDIR)" T2_PROFILE="$(MINIKUBE_PROFILE)" T2_CONTEXT="$(MINIKUBE_PROFILE)" \
		T2_SKIP_LOCK=true T2_LOCK_TOKEN="$(T2_LOCK_TOKEN)" \
		bash scripts/minikube/require-t2-mutation-lock.sh
	@MINIKUBE_PROFILE="$(MINIKUBE_PROFILE)" scripts/minikube/build-images.sh --only=workflow-custom-sdk-e2e
	@MINIKUBE_PROFILE="$(MINIKUBE_PROFILE)" scripts/minikube/build-images.sh --only=workflow-plugin-sdk-e2e

.PHONY: minikube-verify-images
minikube-verify-images: ## Verify every image the cluster runs is present. The mode comes from deploy/minikube/.image-manifest.json (what was actually built/pulled), not from IMAGE_SOURCE; SEED_PROFILE=e2e also checks the two E2E fixtures.
	@IMAGE_SOURCE="$(IMAGE_SOURCE)" MINIKUBE_IMAGE_TAG="$(MINIKUBE_IMAGE_TAG)" \
		MINIKUBE_SEED_PROFILE="$(SEED_PROFILE)" \
		scripts/minikube/build-images.sh --verify-only

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

.PHONY: minikube-deploy-all minikube-deploy-all-body
minikube-deploy-all: ## Deploy ALL services via Kustomize minikube overlay
	@T2_PROJECT_DIR="$(CURDIR)" T2_PROFILE="$(MINIKUBE_PROFILE)" T2_CONTEXT="$(MINIKUBE_PROFILE)" \
		T2_SKIP_LOCK="$(T2_SKIP_LOCK)" T2_LOCK_TOKEN="$(T2_LOCK_TOKEN)" \
		MINIKUBE_GFS_MUTATION="$(MINIKUBE_GFS_MUTATION)" \
		bash scripts/minikube/with-t2-mutation-lock.sh -- \
		$(MAKE) --no-print-directory minikube-deploy-all-body

minikube-deploy-all-body:
	@T2_PROJECT_DIR="$(CURDIR)" T2_PROFILE="$(MINIKUBE_PROFILE)" T2_CONTEXT="$(MINIKUBE_PROFILE)" \
		T2_SKIP_LOCK=true T2_LOCK_TOKEN="$(T2_LOCK_TOKEN)" \
		bash scripts/minikube/require-t2-mutation-lock.sh
	@$(MAKE) --no-print-directory minikube-detect-k8s-api-ip
	@# Upgrade path: adopt/validate writer and stage reader before HCC cutover.
	@if [ "$(MINIKUBE_GFS_MUTATION)" != "true" ]; then echo "[minikube-deploy-all] GFS mutation disabled for this non-T2 sync"; fi
	@if [ "$(MINIKUBE_GFS_MUTATION)" = "true" ]; then \
		CONTEXT=$(MINIKUBE_PROFILE) bash deploy/scripts/apply-gfs-writer-secret.sh; \
		writer_dsn="$$(kubectl --context=$(MINIKUBE_PROFILE) -n gfs get secret gfs-controller-db -o 'jsonpath={.data.connection-string}')" || { \
			echo "[minikube-deploy-all] failed to classify the existing GFS writer Secret; refusing HCC cutover" >&2; exit 1; \
		}; \
		if [[ -n "$$writer_dsn" ]]; then \
			kubectl --context=$(MINIKUBE_PROFILE) -n control-plane rollout status deployment/control-api --timeout=5s >/dev/null 2>&1 || { \
				echo "[minikube-deploy-all] existing GFS writer detected but control-api is not Ready; refusing HCC cutover" >&2; exit 1; \
			}; \
			T2_PROJECT_DIR="$(CURDIR)" T2_PROFILE="$(MINIKUBE_PROFILE)" T2_CONTEXT="$(MINIKUBE_PROFILE)" CONTEXT=$(MINIKUBE_PROFILE) T2_SKIP_LOCK="$(T2_SKIP_LOCK)" T2_LOCK_TOKEN="$(T2_LOCK_TOKEN)" bash deploy/scripts/reconcile-gfs-deploy-credentials.sh; \
		else \
			echo "[minikube-deploy-all] fresh bootstrap: reader staging deferred until post-migration full-setup (GFSC fail-closed)"; \
		fi; \
	fi
	@# THE OVERLAY FOLLOWS THE CLUSTER, NOT THIS SHELL. Hardcoding
	@# deploy/overlays/minikube applied clerum/*:test image refs to a cluster
	@# that pulled ghcr release images: nothing ever built those tags there, so
	@# a deploy/*-only change produced cluster-wide ImagePullBackOff, and a
	@# pre-gate full-deployment silently flipped a ghcr cluster to local refs
	@# with no record. image-mode.sh resolves it from what the last image
	@# acquisition recorded. It runs HERE, after minikube-detect-k8s-api-ip
	@# above, because an overridden tag renders from a copy of deploy/ that must
	@# already contain the generated k8s-api-ip.yaml.
	@set -o pipefail; \
	render_dir="$$(bash scripts/minikube/image-mode.sh --render-dir)" && \
	if [ "$(MINIKUBE_GFS_MUTATION)" = "true" ]; then \
		kubectl --context=$(MINIKUBE_PROFILE) kustomize "$$render_dir" | kubectl --context=$(MINIKUBE_PROFILE) apply -f -; \
	else \
		filtered_manifest="$$(mktemp "$${TMPDIR:-/tmp}/evenfire-gfs-filter.XXXXXX")"; \
		trap 'rm -f -- "$$filtered_manifest"' EXIT; \
		if ! kubectl --context=$(MINIKUBE_PROFILE) kustomize "$$render_dir" | python3 scripts/minikube/filter-gfs-resources.py >"$$filtered_manifest"; then \
			echo "[minikube-deploy-all] failed to render or filter the non-GFS overlay" >&2; exit 1; \
		fi; \
		if [ -s "$$filtered_manifest" ]; then \
			kubectl --context=$(MINIKUBE_PROFILE) apply -f "$$filtered_manifest"; \
		else \
			echo "[minikube-deploy-all] filtered overlay contains no non-GFS resources; skipping apply"; \
		fi; \
	fi
	CONTEXT=$(MINIKUBE_PROFILE) bash deploy/scripts/apply-inter-service-tokens.sh
	@if [ "$(MINIKUBE_GFS_MUTATION)" = "true" ]; then \
		$(KC) apply -f deploy/overlays/minikube/instances/; \
	else \
		filtered_manifest="$$(mktemp "$${TMPDIR:-/tmp}/evenfire-gfs-instances-filter.XXXXXX")"; \
		trap 'rm -f -- "$$filtered_manifest"' EXIT; \
		if ! python3 scripts/minikube/filter-gfs-resources.py deploy/overlays/minikube/instances/*.yaml >"$$filtered_manifest"; then \
			echo "[minikube-deploy-all] failed to filter the non-GFS instance resources" >&2; exit 1; \
		fi; \
		if [ -s "$$filtered_manifest" ]; then \
			$(KC) apply -f "$$filtered_manifest"; \
		else \
			echo "[minikube-deploy-all] filtered instances contain no non-GFS resources; skipping apply"; \
		fi; \
	fi
	@# Kustomize reapplies the persisted mcp-host ConfigMap, which can overwrite
	@# CLERUM_AUTH_JWT_PUBLIC_KEY with an older repo value. Always re-sync from
	@# rpc-proxy-secrets after each full overlay apply so Desktop/rpc-proxy/mcp-host
	@# stay on the same JWT validation key.
	@MINIKUBE_GFS_MUTATION="$(MINIKUBE_GFS_MUTATION)" $(MAKE) --no-print-directory minikube-sync-auth-key
	@# The pre-overlay helper migrates legacy last-applied ownership without
	@# removing the provisioning-owned connection-string. When the GFS stack is
	@# deployed AND control-api is Ready (migration 0048 applied), re-provision
	@# the gfs_controller DSN so gfsc never runs with an empty or stale
	@# credential (issue #775). Fails loud if provisioning itself fails. When
	@# control-api is not Ready yet (fresh cluster mid-setup), provisioning is
	@# deferred LOUDLY to the full-setup/pre-gate-sync flow that already orders
	@# it after control-api migrations.
	@if [ "$(MINIKUBE_GFS_MUTATION)" = "true" ]; then \
		gfs_config_probe="$$(kubectl --context=$(MINIKUBE_PROFILE) get configmap gfs-config -n gfs 2>&1)" || { \
			if [[ "$$gfs_config_probe" == *NotFound* || "$$gfs_config_probe" == *"not found"* ]]; then \
				echo "[minikube-deploy-all] GFS is not deployed; skipping post-overlay credential reconciliation"; \
				gfs_config_probe=""; \
			else \
				echo "[minikube-deploy-all] unable to inspect GFS configmap; refusing to continue: $$gfs_config_probe" >&2; exit 1; \
			fi; \
		}; \
		if [ -n "$$gfs_config_probe" ]; then \
			if kubectl --context=$(MINIKUBE_PROFILE) -n control-plane rollout status deployment/control-api --timeout=5s >/dev/null 2>&1; then \
				CONTEXT=$(MINIKUBE_PROFILE) T2_SKIP_LOCK="$(T2_SKIP_LOCK)" T2_LOCK_TOKEN="$(T2_LOCK_TOKEN)" bash deploy/scripts/wait-gfsc-secret-references.sh; \
				T2_PROJECT_DIR="$(CURDIR)" T2_PROFILE="$(MINIKUBE_PROFILE)" T2_CONTEXT="$(MINIKUBE_PROFILE)" CONTEXT=$(MINIKUBE_PROFILE) T2_SKIP_LOCK="$(T2_SKIP_LOCK)" T2_LOCK_TOKEN="$(T2_LOCK_TOKEN)" bash deploy/scripts/reconcile-gfs-deploy-credentials.sh; \
			else \
				echo "[minikube-deploy-all] control-api not Ready — gfs DSN provisioning DEFERRED to full-setup/pre-gate-sync ordering (gfsc stays fail-closed until then)"; \
			fi; \
		fi; \
	else \
		echo "[minikube-deploy-all] skipping post-overlay GFS credential reconciliation"; \
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

.PHONY: minikube-deploy-crds minikube-deploy-crds-body
minikube-deploy-crds: ## Install/upgrade CRDs via Helm chart + apply CRD YAML (idempotent)
	@T2_PROJECT_DIR="$(CURDIR)" T2_PROFILE="$(MINIKUBE_PROFILE)" T2_CONTEXT="$(MINIKUBE_PROFILE)" \
		T2_SKIP_LOCK="$(T2_SKIP_LOCK)" T2_LOCK_TOKEN="$(T2_LOCK_TOKEN)" \
		MINIKUBE_GFS_MUTATION="$(MINIKUBE_GFS_MUTATION)" \
		bash scripts/minikube/with-t2-mutation-lock.sh -- \
		$(MAKE) --no-print-directory minikube-deploy-crds-body

minikube-deploy-crds-body:
	@T2_PROJECT_DIR="$(CURDIR)" T2_PROFILE="$(MINIKUBE_PROFILE)" T2_CONTEXT="$(MINIKUBE_PROFILE)" \
		T2_SKIP_LOCK=true T2_LOCK_TOKEN="$(T2_LOCK_TOKEN)" \
		bash scripts/minikube/require-t2-mutation-lock.sh
	kubectl --context=$(MINIKUBE_PROFILE) apply -f deploy/base/namespaces.yaml
	@if [ "$(MINIKUBE_GFS_MUTATION)" != "true" ]; then \
		echo "[minikube-deploy-crds] GFS CRD mutation disabled for this non-T2 gate"; \
		helm upgrade --install --skip-crds --kube-context=$(MINIKUBE_PROFILE) clerum-crds ./charts/clerum-crds; \
		for crd in ./charts/clerum-crds/crds/*.yaml; do \
			case "$$crd" in *globalfilesystem.yaml) continue ;; esac; \
			kubectl --context=$(MINIKUBE_PROFILE) apply -f "$$crd"; \
		done; \
	else \
		helm upgrade --install --kube-context=$(MINIKUBE_PROFILE) clerum-crds ./charts/clerum-crds; \
		kubectl --context=$(MINIKUBE_PROFILE) apply -f ./charts/clerum-crds/crds/; \
	fi

.PHONY: minikube-deploy-service minikube-deploy-service-body
minikube-deploy-service: ## Rebuild single image + rollout restart deployment (usage: make minikube-deploy-service SVC=mcp-host NS=mcp-host [DEPLOYMENT=chatllm])
	@$(if $(MINIKUBE_DEPLOY_SERVICE),:,echo "ERROR: SVC required. Usage: make minikube-deploy-service SVC=mcp-host NS=mcp-host [DEPLOYMENT=chatllm]"; exit 1)
	@$(if $(MINIKUBE_DEPLOY_SERVICE_SUPPORTED),:,echo "ERROR: unsupported SVC selector. Supported: $(MINIKUBE_DEPLOY_SERVICE_SELECTORS)"; exit 1)
	@$(if $(MINIKUBE_DEPLOY_NAMESPACE),:,echo "ERROR: NS required. Usage: make minikube-deploy-service SVC=mcp-host NS=mcp-host [DEPLOYMENT=chatllm]"; exit 1)
	@$(if $(MINIKUBE_EFFECTIVE_DEPLOYMENT),:,echo "ERROR: effective DEPLOYMENT could not be resolved from SVC"; exit 1)
	@T2_PROJECT_DIR="$(CURDIR)" T2_PROFILE="$(MINIKUBE_PROFILE)" T2_CONTEXT="$(MINIKUBE_PROFILE)" \
		T2_SKIP_LOCK="$(T2_SKIP_LOCK)" T2_LOCK_TOKEN="$(T2_LOCK_TOKEN)" \
		bash scripts/minikube/with-t2-mutation-lock.sh -- \
		$(MAKE) --no-print-directory minikube-deploy-service-body

minikube-deploy-service-body:
	@T2_PROJECT_DIR="$(CURDIR)" T2_PROFILE="$(MINIKUBE_PROFILE)" T2_CONTEXT="$(MINIKUBE_PROFILE)" \
		T2_SKIP_LOCK=true T2_LOCK_TOKEN="$(T2_LOCK_TOKEN)" \
		bash scripts/minikube/require-t2-mutation-lock.sh
	@$(if $(MINIKUBE_DEPLOY_SERVICE),:,echo "ERROR: SVC required. Usage: make minikube-deploy-service SVC=mcp-host NS=mcp-host [DEPLOYMENT=chatllm]"; exit 1)
	@$(if $(MINIKUBE_DEPLOY_SERVICE_SUPPORTED),:,echo "ERROR: unsupported SVC selector. Supported: $(MINIKUBE_DEPLOY_SERVICE_SELECTORS)"; exit 1)
	@$(if $(MINIKUBE_DEPLOY_NAMESPACE),:,echo "ERROR: NS required. Usage: make minikube-deploy-service SVC=mcp-host NS=mcp-host [DEPLOYMENT=chatllm]"; exit 1)
	@$(if $(MINIKUBE_EFFECTIVE_DEPLOYMENT),:,echo "ERROR: effective DEPLOYMENT could not be resolved from SVC"; exit 1)
	@echo "Deploying image selector $(MINIKUBE_DEPLOY_SERVICE) to deployment/$(MINIKUBE_EFFECTIVE_DEPLOYMENT) in namespace $(MINIKUBE_DEPLOY_NAMESPACE)"
	@MINIKUBE_PROFILE="$(MINIKUBE_PROFILE)" scripts/minikube/build-images.sh --only=$(MINIKUBE_DEPLOY_SERVICE)
	kubectl --context=$(MINIKUBE_PROFILE) -n $(MINIKUBE_DEPLOY_NAMESPACE) rollout restart deployment/$(MINIKUBE_EFFECTIVE_DEPLOYMENT)
	kubectl --context=$(MINIKUBE_PROFILE) -n $(MINIKUBE_DEPLOY_NAMESPACE) rollout status deployment/$(MINIKUBE_EFFECTIVE_DEPLOYMENT) --timeout=180s

.PHONY: minikube-restart-deploy minikube-restart-deploy-body
minikube-restart-deploy: ## Restart a single deployment without rebuilding (usage: make minikube-restart-deploy SVC=mcp-host NS=mcp-host [DEPLOYMENT=chatllm])
	@$(if $(MINIKUBE_DEPLOY_SERVICE),:,echo "ERROR: SVC required. Usage: make minikube-restart-deploy SVC=mcp-host NS=mcp-host [DEPLOYMENT=chatllm]"; exit 1)
	@$(if $(MINIKUBE_DEPLOY_SERVICE_SUPPORTED),:,echo "ERROR: unsupported SVC selector. Supported: $(MINIKUBE_DEPLOY_SERVICE_SELECTORS)"; exit 1)
	@$(if $(MINIKUBE_DEPLOY_NAMESPACE),:,echo "ERROR: NS required. Usage: make minikube-restart-deploy SVC=mcp-host NS=mcp-host [DEPLOYMENT=chatllm]"; exit 1)
	@$(if $(MINIKUBE_EFFECTIVE_DEPLOYMENT),:,echo "ERROR: effective DEPLOYMENT could not be resolved from SVC"; exit 1)
	@T2_PROJECT_DIR="$(CURDIR)" T2_PROFILE="$(MINIKUBE_PROFILE)" T2_CONTEXT="$(MINIKUBE_PROFILE)" \
		T2_SKIP_LOCK="$(T2_SKIP_LOCK)" T2_LOCK_TOKEN="$(T2_LOCK_TOKEN)" \
		bash scripts/minikube/with-t2-mutation-lock.sh -- \
		$(MAKE) --no-print-directory minikube-restart-deploy-body

minikube-restart-deploy-body:
	@T2_PROJECT_DIR="$(CURDIR)" T2_PROFILE="$(MINIKUBE_PROFILE)" T2_CONTEXT="$(MINIKUBE_PROFILE)" \
		T2_SKIP_LOCK=true T2_LOCK_TOKEN="$(T2_LOCK_TOKEN)" \
		bash scripts/minikube/require-t2-mutation-lock.sh
	@$(if $(MINIKUBE_DEPLOY_SERVICE),:,echo "ERROR: SVC required. Usage: make minikube-restart-deploy SVC=mcp-host NS=mcp-host [DEPLOYMENT=chatllm]"; exit 1)
	@$(if $(MINIKUBE_DEPLOY_SERVICE_SUPPORTED),:,echo "ERROR: unsupported SVC selector. Supported: $(MINIKUBE_DEPLOY_SERVICE_SELECTORS)"; exit 1)
	@$(if $(MINIKUBE_DEPLOY_NAMESPACE),:,echo "ERROR: NS required. Usage: make minikube-restart-deploy SVC=mcp-host NS=mcp-host [DEPLOYMENT=chatllm]"; exit 1)
	@$(if $(MINIKUBE_EFFECTIVE_DEPLOYMENT),:,echo "ERROR: effective DEPLOYMENT could not be resolved from SVC"; exit 1)
	@echo "Restarting deployment/$(MINIKUBE_EFFECTIVE_DEPLOYMENT) in namespace $(MINIKUBE_DEPLOY_NAMESPACE)"
	kubectl --context=$(MINIKUBE_PROFILE) -n $(MINIKUBE_DEPLOY_NAMESPACE) rollout restart deployment/$(MINIKUBE_EFFECTIVE_DEPLOYMENT)
	kubectl --context=$(MINIKUBE_PROFILE) -n $(MINIKUBE_DEPLOY_NAMESPACE) rollout status deployment/$(MINIKUBE_EFFECTIVE_DEPLOYMENT) --timeout=180s

# ── Minikube Secrets & Keys ─────────────────────────────────────────
#
# KEY INVARIANT: After generating new keys, the public key must be in sync across:
#   1. rpc-proxy-secrets (namespace: rpc-proxy)  → RPC_PROXY_JWT_PUBLIC_KEY
#   2. mcp-host-config   (namespace: mcp-host)   → CLERUM_AUTH_JWT_PUBLIC_KEY
#   3. gfs-config        (namespace: gfs)        → jwt-public-key
#   4. deploy/overlays/minikube/configmaps/mcp-host-config.yaml  (persisted in repo)
#
# Use `make minikube-sync-auth-key` to copy the public key automatically
# from rpc-proxy-secrets into both runtime ConfigMaps after key regeneration.
#
.PHONY: minikube-gen-keys minikube-gen-keys-body
minikube-gen-keys: ## Generate JWT signing keys + auto-sync to mcp-host-config
	@T2_PROJECT_DIR="$(CURDIR)" T2_PROFILE="$(MINIKUBE_PROFILE)" T2_CONTEXT="$(MINIKUBE_PROFILE)" \
		T2_SKIP_LOCK="$(T2_SKIP_LOCK)" T2_LOCK_TOKEN="$(T2_LOCK_TOKEN)" \
		bash scripts/minikube/with-t2-mutation-lock.sh -- \
		$(MAKE) --no-print-directory minikube-gen-keys-body

minikube-gen-keys-body:
	@T2_PROJECT_DIR="$(CURDIR)" T2_PROFILE="$(MINIKUBE_PROFILE)" T2_CONTEXT="$(MINIKUBE_PROFILE)" \
		T2_SKIP_LOCK=true T2_LOCK_TOKEN="$(T2_LOCK_TOKEN)" \
		bash scripts/minikube/require-t2-mutation-lock.sh
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
	@# LLM API keys — all 22 providers from the registry; reads the main checkout
	@# .env when running from a worktree. Original four keep placeholder fallbacks.
	@CONTEXT=$(MINIKUBE_PROFILE) bash scripts/minikube/apply-llm-secret.sh

.PHONY: minikube-apply-namespaces
minikube-apply-namespaces: ## Create all namespaces
	$(KC) apply -f deploy/base/namespaces.yaml

.PHONY: minikube-sync-auth-key minikube-sync-auth-key-body minikube-sync-auth-key-shared-profile
minikube-sync-auth-key: ## Sync JWT public key from rpc-proxy-secrets into runtime ConfigMaps when drift exists
	@T2_PROJECT_DIR="$(CURDIR)" T2_PROFILE="$(MINIKUBE_PROFILE)" T2_CONTEXT="$(MINIKUBE_PROFILE)" \
		T2_SKIP_LOCK="$(T2_SKIP_LOCK)" T2_LOCK_TOKEN="$(T2_LOCK_TOKEN)" \
		MINIKUBE_GFS_MUTATION="$(MINIKUBE_GFS_MUTATION)" \
		bash scripts/minikube/with-t2-mutation-lock.sh -- \
		$(MAKE) --no-print-directory minikube-sync-auth-key-body

minikube-sync-auth-key-body:
	@T2_PROJECT_DIR="$(CURDIR)" T2_PROFILE="$(MINIKUBE_PROFILE)" T2_CONTEXT="$(MINIKUBE_PROFILE)" \
		T2_SKIP_LOCK=true T2_LOCK_TOKEN="$(T2_LOCK_TOKEN)" \
		bash scripts/minikube/require-t2-mutation-lock.sh
	@if [ "$(MINIKUBE_GFS_MUTATION)" = "true" ]; then \
		T2_PROJECT_DIR="$(CURDIR)" T2_PROFILE="$(MINIKUBE_PROFILE)" T2_CONTEXT="$(MINIKUBE_PROFILE)" T2_SKIP_LOCK="$(T2_SKIP_LOCK)" T2_LOCK_TOKEN="$(T2_LOCK_TOKEN)" \
		bash scripts/minikube/sync-auth-key.sh --context=$(MINIKUBE_PROFILE); \
	else \
		T2_PROJECT_DIR="$(CURDIR)" T2_PROFILE="$(MINIKUBE_PROFILE)" T2_CONTEXT="$(MINIKUBE_PROFILE)" T2_SKIP_LOCK="$(T2_SKIP_LOCK)" T2_LOCK_TOKEN="$(T2_LOCK_TOKEN)" \
		bash scripts/minikube/sync-auth-key.sh --context=$(MINIKUBE_PROFILE) --skip-gfs --require-mcp; \
	fi

minikube-sync-auth-key-shared-profile: ## Sync only MCP auth on the documented shared profile during startup
	@T2_PROJECT_DIR="$(CURDIR)" T2_PROFILE="$(MINIKUBE_PROFILE)" T2_CONTEXT="$(MINIKUBE_PROFILE)" \
		bash scripts/minikube/sync-auth-key.sh --context=$(MINIKUBE_PROFILE) --shared-profile-bootstrap --skip-gfs --require-mcp

.PHONY: minikube-sync-auth-key-if-present
minikube-sync-auth-key-if-present: ## Sync JWT public key only when minikube auth resources already exist
	@kubectl_probe_is_not_found() { \
	  probe_output="$$1"; \
	  probe_kind="$$2"; \
	  probe_name="$$3"; \
	  [[ "$$probe_output" =~ ^Error[[:space:]]+from[[:space:]]+server[[:space:]]+\(NotFound\):[[:space:]] ]] || return 1; \
	  probe_detail="$${probe_output#*): }"; \
	  case "$$probe_kind" in \
	    secret) case "$$probe_detail" in secret\ *|secrets\ *) ;; *) return 1 ;; esac ;; \
	    configmap) case "$$probe_detail" in configmap\ *|configmaps\ *) ;; *) return 1 ;; esac ;; \
	    *) return 1 ;; \
	  esac; \
	  [[ "$$probe_detail" == *"\"$$probe_name\""* ]] || return 1; \
	}; \
	rpc_probe_status=0; \
	rpc_probe_output="$$( $(KC) get secret rpc-proxy-secrets -n rpc-proxy 2>&1 )" || rpc_probe_status=$$?; \
	if [ "$$rpc_probe_status" -ne 0 ]; then \
	  if kubectl_probe_is_not_found "$$rpc_probe_output" secret rpc-proxy-secrets; then \
	    echo "Skipping auth key sync (rpc-proxy-secrets not found yet)."; exit 0; \
	  fi; \
	  printf '%s\n' "$$rpc_probe_output" >&2; exit "$$rpc_probe_status"; \
	fi; \
	mcp_probe_status=0; \
	mcp_probe_output="$$( $(KC) get configmap mcp-host-config -n mcp-host 2>&1 )" || mcp_probe_status=$$?; \
	if [ "$$mcp_probe_status" -ne 0 ]; then \
	  if kubectl_probe_is_not_found "$$mcp_probe_output" configmap mcp-host-config; then \
	    echo "Skipping auth key sync (mcp-host-config not found yet)."; exit 0; \
	  fi; \
	  printf '%s\n' "$$mcp_probe_output" >&2; exit "$$mcp_probe_status"; \
	fi; \
	if [ "$(MINIKUBE_STARTUP_AUTH_SYNC_MODE)" = "shared-profile-mcp" ]; then \
		$(MAKE) --no-print-directory minikube-sync-auth-key-shared-profile; \
	elif [ "$(T2_MUTATION_LOCK_WRAPPED)" = "true" ]; then \
		$(MAKE) --no-print-directory minikube-sync-auth-key-body; \
	else \
	  $(MAKE) --no-print-directory minikube-sync-auth-key; \
	fi

.PHONY: minikube-sync-codex-subscription-url
minikube-sync-codex-subscription-url: ## Resolve branch Control UI URL and sync CONTROL_API_CONTROL_UI_BASE_URL for Codex OAuth
	@bash scripts/minikube/sync-codex-subscription-control-ui-url.sh --context=$(MINIKUBE_PROFILE)

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

.PHONY: test-gfs-real-postgres-minikube
test-gfs-real-postgres-minikube: ## Run GFS T1 real-Postgres suites against a validated branch-owned Minikube profile
	@CONTEXT="$(MINIKUBE_PROFILE)" bash scripts/e2e/gfs-real-pg-minikube-gate.sh

.PHONY: minikube-t2-preflight
minikube-t2-preflight: ## Read-only readiness planner (not T0/T1/T2); fail-loud on an unbootstrapped profile
	@MINIKUBE_PROFILE="$(MINIKUBE_PROFILE)" CONTROL_API_REAL_PG_CONTEXT="$(CONTROL_API_REAL_PG_CONTEXT)" \
		scripts/minikube/t2-preflight.sh

.PHONY: minikube-t2
minikube-t2: ## Full orchestrator: T0, Real PostgreSQL T1, then exact-head T2
	@MINIKUBE_PROFILE="$(MINIKUBE_PROFILE)" CONTROL_API_REAL_PG_CONTEXT="$(CONTROL_API_REAL_PG_CONTEXT)" \
		scripts/minikube/t2.sh

.PHONY: minikube-t2-np08-hcc-authorization
minikube-t2-np08-hcc-authorization: minikube-t2 ## Run canonical T2 including the required deployed NP-08 Host-to-HCC authorization journey
.PHONY: minikube-t2-runtime
minikube-t2-runtime: ## Exact-head T2 after T0 and T1 already passed on this HEAD and profile
	@T2_RUN_T0=false T2_RUN_T1=false \
		MINIKUBE_PROFILE="$(MINIKUBE_PROFILE)" CONTROL_API_REAL_PG_CONTEXT="$(CONTROL_API_REAL_PG_CONTEXT)" \
		scripts/minikube/t2.sh

.PHONY: minikube-t2-real-postgres
minikube-t2-real-postgres: ## Run the explicit local Real PostgreSQL lane without changing CI's DSN contract
	@MINIKUBE_PROFILE="$(MINIKUBE_PROFILE)" CONTROL_API_REAL_PG_CONTEXT="$(CONTROL_API_REAL_PG_CONTEXT)" \
		scripts/e2e/minikube-real-postgres.sh

.PHONY: minikube-t2-public-boundary
minikube-t2-public-boundary: ## Reject secrets, credentials, private URLs, and raw runtime artifacts from the public diff
	@scripts/tests/test-minikube-t2-public-boundary.sh

.PHONY: minikube-t2-scenarios
minikube-t2-scenarios: ## Exercise the fail-loud negative cases and transition classifier without a cluster
	@scripts/tests/test-minikube-t2-scenarios.sh

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

.PHONY: local-app-onboarding
local-app-onboarding: ## Run Desktop App showing the first-run onboarding flow (isolated; real environments untouched)
	@$(MAKE) --no-print-directory EVENFIRE_ONBOARDING_PREVIEW=true local-app

.PHONY: local-app
local-app: ## Run Desktop App locally against minikube API port-forwards (EVENFIRE_ONBOARDING_PREVIEW=true previews onboarding)
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
	env -u ELECTRON_RUN_AS_NODE EXTERNAL_REST_API_BASE_URL=http://127.0.0.1:8091 RPC_PROXY_BASE_URL=http://127.0.0.1:8094 CONTROL_API_BASE_URL=http://127.0.0.1:8090 EVENFIRE_ONBOARDING_PREVIEW="$(EVENFIRE_ONBOARDING_PREVIEW)" npm --prefix desktop-app run dev

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

.PHONY: minikube-db-reset minikube-db-reset-body
minikube-db-reset: ## Reset control-api postgres (re-enables first-time admin setup)
	@T2_PROJECT_DIR="$(CURDIR)" T2_PROFILE="$(MINIKUBE_PROFILE)" T2_CONTEXT="$(MINIKUBE_PROFILE)" \
		T2_SKIP_LOCK="$(T2_SKIP_LOCK)" T2_LOCK_TOKEN="$(T2_LOCK_TOKEN)" \
		CONTROL_DB_RESET_PVC_UID="$(CONTROL_DB_RESET_PVC_UID)" CONTROL_DB_RESET_RESUME="$(CONTROL_DB_RESET_RESUME)" \
		bash scripts/minikube/with-t2-mutation-lock.sh -- \
		$(MAKE) --no-print-directory minikube-db-reset-body

minikube-db-reset-body:
	@T2_PROJECT_DIR="$(CURDIR)" T2_PROFILE="$(MINIKUBE_PROFILE)" T2_CONTEXT="$(MINIKUBE_PROFILE)" \
		T2_SKIP_LOCK=true T2_LOCK_TOKEN="$(T2_LOCK_TOKEN)" \
		bash scripts/minikube/require-t2-mutation-lock.sh
	@if [ -z "$(CONTROL_DB_RESET_PVC_UID)" ]; then echo "ERROR: CONTROL_DB_RESET_PVC_UID=<approved UID|none> is required"; exit 1; fi
	@reset_args="--expected-pvc-uid $(CONTROL_DB_RESET_PVC_UID)"; \
	 if [ "$(CONTROL_DB_RESET_PVC_UID)" = "none" ]; then reset_args="--expect-no-pvc"; fi; \
	 if [ "$(CONTROL_DB_RESET_RESUME)" = "true" ]; then reset_args="$$reset_args --resume"; fi; \
	 CONTEXT=$(MINIKUBE_PROFILE) bash deploy/scripts/reset-control-db-storage.sh $$reset_args
	@$(KC) apply -k deploy/overlays/minikube -l app=control-postgres
	@echo "Scaling up postgres..."
	@$(KC) scale deploy/control-postgres --replicas=1 -n control-plane
	@$(KC) wait --for=condition=Available deploy/control-postgres -n control-plane --timeout=90s
	@T2_PROJECT_DIR="$(CURDIR)" T2_PROFILE="$(MINIKUBE_PROFILE)" T2_CONTEXT="$(MINIKUBE_PROFILE)" \
		T2_SKIP_LOCK=true T2_LOCK_TOKEN="$(T2_LOCK_TOKEN)" CONTEXT=$(MINIKUBE_PROFILE) \
		bash deploy/scripts/converge-control-db-after-reset.sh \
		  --overlay deploy/overlays/minikube --job-name control-api-db-migrate-reset
	@echo "DB reset complete. First-time admin setup is available again."

.PHONY: minikube-seed-test-data
minikube-seed-test-data: ## Seed E2E user + agent + context via canonical-root credentials (local fallback only when unset)
	@CONTEXT=$(MINIKUBE_PROFILE) bash scripts/e2e/seed-e2e-data.sh

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
test-e2e-wrc-internal-dependency-networkpolicy: ## Run issues #485/#582 WRC dependency convergence/finalizer E2E gate
	@echo "Running WRC internal-dependency NetworkPolicy E2E gate..."
	KUBECONTEXT=$(E2E_KUBECONTEXT) bash scripts/e2e/e2e-wrc-internal-dependency-networkpolicy.sh

.PHONY: test-e2e-codex-subscription-network-boundary
test-e2e-codex-subscription-network-boundary: ## Codex LLM proxy NetworkPolicy boundary (exit 3 before deploy)
	@echo "Running Codex subscription network-boundary gate..."
	KUBECONTEXT=$(E2E_KUBECONTEXT) bash scripts/e2e/e2e-codex-subscription-network-boundary.sh

.PHONY: test-e2e-codex-subscription-runtime
test-e2e-codex-subscription-runtime: ## Codex subscription runtime acceptance (RED until HCC/WRC/mcp-host wiring)
	@echo "Running Codex subscription runtime acceptance..."
	KUBECONTEXT=$(E2E_KUBECONTEXT) bash scripts/e2e/e2e-codex-subscription-runtime.sh

.PHONY: test-e2e-codex-subscription-playwright
test-e2e-codex-subscription-playwright: ## Codex subscription Control UI guardians (5 tests; Desktop deferred until connected subscription)
	@echo "Running Codex subscription Control UI Playwright guardians..."
	@if [ -z "$${KUBECONTEXT:-$(E2E_KUBECONTEXT)}" ]; then \
		echo "Refusing Codex subscription Playwright: explicit Kubernetes context is required" >&2; \
		exit 1; \
	fi
	MINIKUBE_PROFILE="$${KUBECONTEXT:-$(E2E_KUBECONTEXT)}" KUBECONTEXT="$${KUBECONTEXT:-$(E2E_KUBECONTEXT)}" bash scripts/e2e/e2e-codex-subscription-playwright.sh

.PHONY: test-e2e-plugin-workload-sdk
test-e2e-plugin-workload-sdk: ## Run Plugin Workload SDK E2E gate (minikube only; requires E2E_PLUGIN_SDK_WRITE_CONFIRM=1)
	@echo "Running Plugin Workload SDK E2E gate..."
	@if [ -z "$${KUBECONTEXT:-$(E2E_KUBECONTEXT)}" ]; then \
		echo "Refusing Plugin Workload SDK E2E: explicit Kubernetes context is required" >&2; \
		exit 1; \
	fi
	KUBECONTEXT="$${KUBECONTEXT:-$(E2E_KUBECONTEXT)}" bash scripts/e2e/e2e-plugin-workload-sdk.sh

.PHONY: test-e2e-plugin-workload-sdk-desktop
test-e2e-plugin-workload-sdk-desktop: ## Run the explicit opt-in Electron/WebContentsView Plugin Workload SDK gate
	@set -eu; \
	ctx="$${KUBECONTEXT:-$(E2E_KUBECONTEXT)}"; \
	test -n "$$ctx" || { echo "Refusing Desktop Plugin Workload SDK E2E: explicit Kubernetes context is required" >&2; exit 1; }; \
	test "$${E2E_PLUGIN_SDK_WRITE_CONFIRM:-}" = 1 || { echo "Refusing Desktop Plugin Workload SDK E2E: set E2E_PLUGIN_SDK_WRITE_CONFIRM=1" >&2; exit 1; }; \
	test -n "$${CONTROL_UI_BASE_URL:-}" || { echo "CONTROL_UI_BASE_URL must be set to the branch-owned random port" >&2; exit 1; }; \
	test -n "$${CONTROL_API_BASE_URL:-}" || { echo "CONTROL_API_BASE_URL must be set to the branch-owned random port" >&2; exit 1; }; \
	test -n "$${EXTERNAL_REST_API_BASE_URL:-}" || { echo "EXTERNAL_REST_API_BASE_URL must be set to the branch-owned random port" >&2; exit 1; }; \
	test -n "$${RPC_PROXY_BASE_URL:-}" || { echo "RPC_PROXY_BASE_URL must be set to the branch-owned random port" >&2; exit 1; }; \
	test -n "$${E2E_PLUGIN_SDK_EXPECT_PROVIDER:-}" || { echo "Refusing Desktop Plugin Workload SDK E2E: set E2E_PLUGIN_SDK_EXPECT_PROVIDER to the provider this run must exercise (openai | claude | codex-subscription)" >&2; exit 1; }; \
	. scripts/e2e/e2e-lib.sh; \
	require_branch_profile_urls "$$ctx" "$${CLERUM_PROFILE_PORTS_ENV:-$${E2E_PROFILE_PORTS_ENV:-}}"; \
	echo "[E2E-GUARD] Desktop Plugin Workload SDK gate: context=$$ctx; expected provider=$${E2E_PLUGIN_SDK_EXPECT_PROVIDER}; URLs supplied by the branch profile"; \
	cd desktop-app && KUBECONTEXT="$$ctx" E2E_K8S_CONTEXT="$$ctx" E2E_PLUGIN_SDK_DESKTOP=1 npm run build && \
	KUBECONTEXT="$$ctx" E2E_K8S_CONTEXT="$$ctx" E2E_PLUGIN_SDK_DESKTOP=1 E2E_PLUGIN_SDK_EXPECT_PROVIDER="$$E2E_PLUGIN_SDK_EXPECT_PROVIDER" ./node_modules/.bin/playwright test --config test/e2e-playwright/playwright.config.ts plugin-workload-sdk-sandbox-ui.spec.ts

.PHONY: test-e2e-plugin-workload-sdk-desktop-no-grant
test-e2e-plugin-workload-sdk-desktop-no-grant: ## Run the no-grant Codex guard (#533 regression) against its own ungranted SDK-only recipe
	@set -eu; \
	ctx="$${KUBECONTEXT:-$(E2E_KUBECONTEXT)}"; \
	test -n "$$ctx" || { echo "Refusing Desktop Plugin Workload SDK no-grant guard: explicit Kubernetes context is required" >&2; exit 1; }; \
	test "$${E2E_PLUGIN_SDK_WRITE_CONFIRM:-}" = 1 || { echo "Refusing Desktop Plugin Workload SDK no-grant guard: set E2E_PLUGIN_SDK_WRITE_CONFIRM=1" >&2; exit 1; }; \
	test -n "$${CONTROL_UI_BASE_URL:-}" || { echo "CONTROL_UI_BASE_URL must be set to the branch-owned random port" >&2; exit 1; }; \
	test -n "$${CONTROL_API_BASE_URL:-}" || { echo "CONTROL_API_BASE_URL must be set to the branch-owned random port" >&2; exit 1; }; \
	test -n "$${EXTERNAL_REST_API_BASE_URL:-}" || { echo "EXTERNAL_REST_API_BASE_URL must be set to the branch-owned random port" >&2; exit 1; }; \
	test -n "$${RPC_PROXY_BASE_URL:-}" || { echo "RPC_PROXY_BASE_URL must be set to the branch-owned random port" >&2; exit 1; }; \
	test -n "$${E2E_PLUGIN_SDK_NO_GRANT_RECIPE_NAME:-}" || { echo "Refusing Desktop Plugin Workload SDK no-grant guard: set E2E_PLUGIN_SDK_NO_GRANT_RECIPE_NAME to a Codex SDK-only recipe whose execution binding is missing (never the granted happy-path recipe)" >&2; exit 1; }; \
	test -n "$${E2E_PLUGIN_SDK_NO_GRANT_APP_TITLE:-}" || { echo "Refusing Desktop Plugin Workload SDK no-grant guard: set E2E_PLUGIN_SDK_NO_GRANT_APP_TITLE to the ungranted app's Desktop catalog title" >&2; exit 1; }; \
	. scripts/e2e/e2e-lib.sh; \
	require_branch_profile_urls "$$ctx" "$${CLERUM_PROFILE_PORTS_ENV:-$${E2E_PROFILE_PORTS_ENV:-}}"; \
	echo "[E2E-GUARD] Desktop Plugin Workload SDK no-grant guard: context=$$ctx; recipe=$${E2E_PLUGIN_SDK_NO_GRANT_RECIPE_NAMESPACE:-sandbox-recipes}/$${E2E_PLUGIN_SDK_NO_GRANT_RECIPE_NAME}; URLs supplied by the branch profile"; \
	cd desktop-app && KUBECONTEXT="$$ctx" E2E_K8S_CONTEXT="$$ctx" E2E_PLUGIN_SDK_DESKTOP=1 E2E_PLUGIN_SDK_NO_GRANT=1 npm run build && \
	KUBECONTEXT="$$ctx" E2E_K8S_CONTEXT="$$ctx" E2E_PLUGIN_SDK_DESKTOP=1 E2E_PLUGIN_SDK_NO_GRANT=1 \
		E2E_PLUGIN_SDK_NO_GRANT_RECIPE_NAME="$$E2E_PLUGIN_SDK_NO_GRANT_RECIPE_NAME" \
		E2E_PLUGIN_SDK_NO_GRANT_RECIPE_NAMESPACE="$${E2E_PLUGIN_SDK_NO_GRANT_RECIPE_NAMESPACE:-sandbox-recipes}" \
		E2E_PLUGIN_SDK_NO_GRANT_APP_TITLE="$$E2E_PLUGIN_SDK_NO_GRANT_APP_TITLE" \
		./node_modules/.bin/playwright test --config test/e2e-playwright/playwright.config.ts plugin-workload-sdk-no-grant-guard.spec.ts

.PHONY: test-e2e-plugin-workload-sdk-desktop-codex-fallback
test-e2e-plugin-workload-sdk-desktop-codex-fallback: ## Run the Codex -> authorized fallback journey (#533 acceptance criterion 8); stops codex-llm-proxy and restores it
	@set -eu; \
	ctx="$${KUBECONTEXT:-$(E2E_KUBECONTEXT)}"; \
	test -n "$$ctx" || { echo "Refusing Desktop Plugin Workload SDK fallback journey: explicit Kubernetes context is required" >&2; exit 1; }; \
	test "$${E2E_PLUGIN_SDK_WRITE_CONFIRM:-}" = 1 || { echo "Refusing Desktop Plugin Workload SDK fallback journey: set E2E_PLUGIN_SDK_WRITE_CONFIRM=1" >&2; exit 1; }; \
	test -n "$${CONTROL_UI_BASE_URL:-}" || { echo "CONTROL_UI_BASE_URL must be set to the branch-owned random port" >&2; exit 1; }; \
	test -n "$${CONTROL_API_BASE_URL:-}" || { echo "CONTROL_API_BASE_URL must be set to the branch-owned random port" >&2; exit 1; }; \
	test -n "$${EXTERNAL_REST_API_BASE_URL:-}" || { echo "EXTERNAL_REST_API_BASE_URL must be set to the branch-owned random port" >&2; exit 1; }; \
	test -n "$${RPC_PROXY_BASE_URL:-}" || { echo "RPC_PROXY_BASE_URL must be set to the branch-owned random port" >&2; exit 1; }; \
	test "$${E2E_PLUGIN_SDK_EXPECT_PROVIDER:-}" = codex-subscription || { echo "Refusing Desktop Plugin Workload SDK fallback journey: set E2E_PLUGIN_SDK_EXPECT_PROVIDER=codex-subscription; this journey exists only for the Codex primary" >&2; exit 1; }; \
	. scripts/e2e/e2e-lib.sh; \
	require_branch_profile_urls "$$ctx" "$${CLERUM_PROFILE_PORTS_ENV:-$${E2E_PROFILE_PORTS_ENV:-}}"; \
	echo "[E2E-GUARD] Desktop Plugin Workload SDK fallback journey: context=$$ctx; recipe=$${E2E_PLUGIN_SDK_RECIPE_NAMESPACE:-sandbox-recipes}/$${E2E_PLUGIN_SDK_RECIPE_NAME:-evenfire-prompt-notify-app}; codex-llm-proxy will be stopped and restored"; \
	trap 'kubectl --context "$$ctx" -n control-plane scale deployment/codex-llm-proxy --replicas=1 >/dev/null || echo "[E2E-GUARD] FAILED to restore control-plane/codex-llm-proxy to replicas=1 — restore it before running any other lane on this profile" >&2' EXIT; \
	cd desktop-app && KUBECONTEXT="$$ctx" E2E_K8S_CONTEXT="$$ctx" E2E_PLUGIN_SDK_DESKTOP=1 E2E_PLUGIN_SDK_CODEX_FALLBACK=1 npm run build && \
	KUBECONTEXT="$$ctx" E2E_K8S_CONTEXT="$$ctx" E2E_PLUGIN_SDK_DESKTOP=1 E2E_PLUGIN_SDK_CODEX_FALLBACK=1 \
		E2E_PLUGIN_SDK_EXPECT_PROVIDER="$$E2E_PLUGIN_SDK_EXPECT_PROVIDER" \
		E2E_PLUGIN_SDK_RECIPE_NAME="$${E2E_PLUGIN_SDK_RECIPE_NAME:-evenfire-prompt-notify-app}" \
		E2E_PLUGIN_SDK_RECIPE_NAMESPACE="$${E2E_PLUGIN_SDK_RECIPE_NAMESPACE:-sandbox-recipes}" \
		E2E_PLUGIN_SDK_APP_TITLE="$${E2E_PLUGIN_SDK_APP_TITLE:-Prompt & Notify}" \
		./node_modules/.bin/playwright test --config test/e2e-playwright/playwright.config.ts plugin-workload-sdk-codex-fallback.spec.ts

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
	@test -n "$(E2E_EXPECTED_PRE_GATE_GATE)" || { echo "Set E2E_EXPECTED_PRE_GATE_GATE to the gate recorded by the branch-owned pre-gate sync" >&2; exit 1; }
	E2E_HCC_WATCH_FAULT_INJECTION=1 E2E_EXPECTED_PRE_GATE_GATE="$(E2E_EXPECTED_PRE_GATE_GATE)" MINIKUBE_PROFILE=$(E2E_KUBECONTEXT) KUBECONTEXT=$(E2E_KUBECONTEXT) bash scripts/e2e/e2e-hcc-communicationchannel-watch-recovery.sh

.PHONY: test-e2e-hcc-readiness-bootstrap
test-e2e-hcc-readiness-bootstrap: ## Prove HCC readiness while its initial Host fleet pass remains active
	@echo "Running HCC initial-fleet readiness gate..."
	@test -n "$(E2E_EXPECTED_PRE_GATE_GATE)" || { echo "Set E2E_EXPECTED_PRE_GATE_GATE to the gate recorded by the branch-owned pre-gate sync" >&2; exit 1; }
	E2E_HCC_READINESS_FAULT_INJECTION=1 E2E_EXPECTED_PRE_GATE_GATE="$(E2E_EXPECTED_PRE_GATE_GATE)" MINIKUBE_PROFILE=$(E2E_KUBECONTEXT) KUBECONTEXT=$(E2E_KUBECONTEXT) bash scripts/e2e/e2e-hcc-readiness-bootstrap.sh

.PHONY: test-e2e-hcc-watch-churn-readiness
test-e2e-hcc-watch-churn-readiness: ## Prove HCC readiness CONVERGES under sustained apiserver watch churn (PR #205 GKE livelock). Positive-only; the livelock RED lives in host-context-controller/src/k8sClient.test.ts. EXPECT_LIVELOCK=1 is refused.
	@echo "Running HCC watch-churn readiness gate..."
	@test -n "$(E2E_EXPECTED_PRE_GATE_GATE)" || { echo "Set E2E_EXPECTED_PRE_GATE_GATE to the gate recorded by the branch-owned pre-gate sync" >&2; exit 1; }
	E2E_HCC_WATCH_FAULT_INJECTION=1 EXPECT_LIVELOCK=$(EXPECT_LIVELOCK) E2E_EXPECTED_PRE_GATE_GATE="$(E2E_EXPECTED_PRE_GATE_GATE)" MINIKUBE_PROFILE=$(E2E_KUBECONTEXT) KUBECONTEXT=$(E2E_KUBECONTEXT) bash scripts/e2e/e2e-hcc-watch-churn-readiness.sh

.PHONY: test-e2e-hcc-mcp-context-readiness
test-e2e-hcc-mcp-context-readiness: ## Prove HCC readiness during exact MCP/Context/NetworkPolicy initial convergence
	@echo "Running HCC MCP/Context/NetworkPolicy readiness gate..."
	@test -n "$(E2E_EXPECTED_PRE_GATE_GATE)" || { echo "Set E2E_EXPECTED_PRE_GATE_GATE to the gate recorded by the branch-owned pre-gate sync" >&2; exit 1; }
	E2E_HCC_MCP_READINESS_FAULT_INJECTION=1 E2E_EXPECTED_PRE_GATE_GATE="$(E2E_EXPECTED_PRE_GATE_GATE)" MINIKUBE_PROFILE=$(E2E_KUBECONTEXT) KUBECONTEXT=$(E2E_KUBECONTEXT) bash scripts/e2e/e2e-hcc-mcp-context-readiness.sh

.PHONY: test-e2e-hcc-rollout-readiness
test-e2e-hcc-rollout-readiness: ## Measure the HCC Recreate rollout window (D1/c4). EXPECT_STUCK=1 reproduces the D1b outage; EXPECT_RECOVERY=1 proves the evenfire#391 rollout-undo path. The two flags are EXCLUSIVE; default both 0 = healthy measurement.
	@echo "Running HCC rollout readiness gate..."
	@test -n "$(E2E_EXPECTED_PRE_GATE_GATE)" || { echo "Set E2E_EXPECTED_PRE_GATE_GATE to the gate recorded by the branch-owned pre-gate sync" >&2; exit 1; }
	E2E_HCC_ROLLOUT_FAULT_INJECTION=1 E2E_EXPECTED_PRE_GATE_GATE="$(E2E_EXPECTED_PRE_GATE_GATE)" \
	  MINIKUBE_PROFILE=$(E2E_KUBECONTEXT) KUBECONTEXT=$(E2E_KUBECONTEXT) \
	  EXPECT_STUCK=$(EXPECT_STUCK) EXPECT_RECOVERY=$(EXPECT_RECOVERY) \
	  bash scripts/e2e/e2e-hcc-rollout-readiness.sh

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
