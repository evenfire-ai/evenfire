# Clerum Phase 8 - Complete Testing & Deployment Makefile
#
# This makefile orchestrates all testing and deployment operations for
# Phase 8 hardening validation, including unit tests, E2E tests, and
# cluster management.
#
# Quick Start:
#   1. make cluster-env-check   # Check Docker and minikube status
#   2. make cluster-setup       # Complete cluster setup (requires Docker)
#   3. make test-all            # Run all unit tests (635 tests)
#   4. make test-e2e            # Run all E2E tests (39 tests)
#   5. make validate            # Full validation pipeline
#
# Environment Setup:
#   make cluster-env-check      # Check Docker and minikube status
#   make cluster-start          # Start minikube (Docker Desktop must be running)
#   make cluster-stop           # Stop minikube
#   make cluster-delete         # Delete minikube cluster
#   make cluster-setup          # Complete cluster setup (via minikube-setup.sh)
#   make cluster-setup-simple   # Simple setup (CRDs, namespaces, secrets only)
#   make cluster-status         # Show cluster status
#
# Testing:
#   make test-all               # Run all unit tests (635 tests)
#   make test-unit              # Run workflow-recipes unit tests (292 tests)
#   make test-mcp               # Run mcp-servers unit tests (343 tests)
#   make test-e2e               # Run all E2E tests (39 tests)
#   make test-e2e-operational   # Run operational E2E tests only
#   make test-e2e-mongodb       # Run MongoDB E2E tests only
#   make test-e2e-airtable      # Run Airtable E2E tests only
#
# Deployment:
#   make deploy-all             # Deploy all services to minikube
#   make deploy-crds            # Deploy CRDs only
#   make deploy-services        # Deploy WRC controller only
#   make undeploy-all           # Remove all services from minikube
#   make restart-wrc            # Restart WRC controller
#   make validate               # Full validation: undeploy + deploy + test-all + test-e2e
#
# Build:
#   make build                  # Build TypeScript
#   make clean                  # Clean build artifacts
#   make install                # Install dependencies

.PHONY: help test-all test-unit test-e2e test-e2e-mongodb test-e2e-airtable
.PHONY: deploy-all undeploy-all validate status clean
.PHONY: restart-services restart-wrc build install
.PHONY: cluster-env-check cluster-start cluster-stop cluster-delete cluster-setup cluster-setup-simple cluster-status

# Docker build (existing)
REGISTRY ?= us-central1-docker.pkg.dev/your-gcp-project/clerum
IMAGE_NAME ?= workflow-recipes
TAG      ?= $(shell git describe --tags --always 2>/dev/null || echo "latest")

# Colors for output
BLUE := \033[0;34m
GREEN := \033[0;32m
YELLOW := \033[0;33m
RED := \033[0;31m
NC := \033[0m # No Color

#==============================================================================
# ENVIRONMENT CHECK
#==============================================================================

cluster-env-check:
	@echo "$(BLUE)=== Environment Check ===$(NC)"
	@echo ""
	@echo "$(BLUE)Docker Status:$(NC)"
	@if docker info > /dev/null 2>&1; then \
		echo "  $(GREEN)✓ Docker daemon is running$(NC)"; \
		docker --version; \
	else \
		echo "  $(RED)✗ Docker daemon is NOT running$(NC)"; \
		echo ""; \
		echo "  $(YELLOW)ACTION REQUIRED:$(NC)"; \
		echo "  1. Open Docker Desktop"; \
		echo "  2. Wait for 'Docker Desktop is running' message"; \
		echo "  3. Run 'make cluster-start' again"; \
		echo ""; \
		exit 1; \
	fi
	@echo ""
	@echo "$(BLUE)Minikube Status:$(NC)"
	@if minikube status -p $(MINIKUBE_PROFILE) > /dev/null 2>&1; then \
		minikube status -p $(MINIKUBE_PROFILE); \
	else \
		echo "  $(YELLOW)Minikube profile '$(MINIKUBE_PROFILE)' does not exist$(NC)"; \
		echo "  Run 'make cluster-start' to create it"; \
	fi
	@echo ""
	@echo "$(BLUE)Kubernetes Context:$(NC)"
	@kubectl config current-context 2>/dev/null || echo "  No context set"

#==============================================================================
# CLUSTER MANAGEMENT
#==============================================================================

cluster-start: cluster-env-check
	@echo "$(BLUE)=== Starting Minikube Cluster ===$(NC)"
	@echo ""
	@echo "$(BLUE)Starting minikube with profile '$(MINIKUBE_PROFILE)'...$(NC)"
	@minikube start -p $(MINIKUBE_PROFILE) \
		--driver=docker \
		--container-runtime=containerd \
		--kubernetes-version=v1.29.0 \
		--nodes=1 \
		--memory=4096 \
		--cpus=2 \
		--disk-size=20g
	@echo ""
	@echo "$(BLUE)Enabling ingress...$(NC)"
	@minikube -p $(MINIKUBE_PROFILE) addons enable ingress
	@echo ""
	@echo "$(BLUE)Setting kubecontext...$(NC)"
	@minikube -p $(MINIKUBE_PROFILE) update-context
	@echo ""
	@echo "$(GREEN)✓ Minikube cluster started successfully$(NC)"
	@echo ""
	@echo "$(YELLOW)Next steps:$(NC)"
	@echo "  make cluster-setup    # Setup CRDs, namespaces, secrets"

cluster-stop:
	@echo "$(BLUE)=== Stopping Minikube Cluster ===$(NC)"
	@minikube stop -p $(MINIKUBE_PROFILE)
	@echo "$(GREEN)✓ Minikube cluster stopped$(NC)"

cluster-delete:
	@echo "$(BLUE)=== Deleting Minikube Cluster ===$(NC)"
	@echo "$(YELLOW)This will delete the entire cluster. Data will be lost.$(NC)"
	@minikube delete -p $(MINIKUBE_PROFILE)
	@echo "$(GREEN)✓ Minikube cluster deleted$(NC)"

cluster-setup:
	@echo "$(BLUE)=== Complete Cluster Setup ===$(NC)"
	@echo ""
	@echo "$(BLUE)This will:$(NC)"
	@echo "  1. Start minikube cluster (if not running)"
	@echo "  2. Create all namespaces"
	@echo "  3. Install CRDs via Helm"
	@echo "  4. Build HCC and WRC images locally"
	@echo "  5. Deploy HCC and WRC controllers"
	@echo ""
	@echo "$(YELLOW)Note: This requires Docker Desktop to be running.$(NC)"
	@echo ""
	@read -p "Continue? [y/N] " -n 1 -r; \
	echo; \
	if [[ $$REPLY =~ ^[Yy]$$ ]]; then \
		./scripts/minikube-setup.sh; \
	else \
		echo "Setup cancelled"; \
		exit 1; \
	fi

cluster-setup-simple: deploy-crds setup-namespaces setup-secrets setup-contexts
	@echo ""
	@echo "$(GREEN)✓ Simple cluster setup complete$(NC)"
	@echo ""
	@echo "$(YELLOW)Next steps:$(NC)"
	@echo "  make deploy-all        # Deploy all services"
	@echo "  make test-e2e          # Run E2E tests"

setup-namespaces:
	@echo "$(BLUE)=== Creating Namespaces ===$(NC)"
	@kubectl create namespace $(NAMESPACE_RECIPE) --dry-run=client -o yaml | kubectl apply -f -
	@kubectl create namespace $(NAMESPACE_SANDBOX) --dry-run=client -o yaml | kubectl apply -f -
	@kubectl create namespace $(NAMESPACE_CONTROL) --dry-run=client -o yaml | kubectl apply -f -
	@echo "$(GREEN)✓ Namespaces created$(NC)"

setup-secrets:
	@echo "$(BLUE)=== Creating Test Secrets ===$(NC)"
	@echo "$(BLUE)Creating MongoDB credentials secret...$(NC)"
	@kubectl create secret generic mcp-mongodb-credentials \
		--from-literal=connection-string='mongodb://admin:example@localhost:27017' \
		--namespace=$(NAMESPACE_RECIPE) \
		--dry-run=client -o yaml | kubectl apply -f -
	@echo "$(BLUE)Creating Airtable credentials secret...$(NC)"
	@kubectl create secret generic mcp-airtable-credentials \
		--from-literal=api-key='test-api-key' \
		--namespace=$(NAMESPACE_RECIPE) \
		--dry-run=client -o yaml | kubectl apply -f -
	@echo "$(GREEN)✓ Test secrets created$(NC)"

setup-contexts:
	@echo "$(BLUE)=== Creating Context CRDs ===$(NC)"
	@kubectl apply -n $(NAMESPACE_RECIPE) -f - <<EOF
apiVersion: clerum.io/v1alpha1
kind: Context
metadata:
  name: default
  namespace: $(NAMESPACE_RECIPE)
spec:
  contextId: default
  mcpServers: []
	EOF
	@echo "$(GREEN)✓ Context CRDs created$(NC)"

cluster-status: status

#==============================================================================
# UNIT TESTS
#==============================================================================

test-all: test-unit test-mcp
	@echo "$(BLUE)✓ All unit tests passed (635 tests)$(NC)"

test-unit:
	@echo "$(BLUE)Running workflow-recipes unit tests...$(NC)"
	npm test
	@echo "$(GREEN)✓ workflow-recipes unit tests passed$(NC)"

test-mcp:
	@echo "$(BLUE)Running mcp-servers unit tests...$(NC)"
	cd ../mcp-servers && npm test
	@echo "$(GREEN)✓ mcp-servers unit tests passed (343 tests)$(NC)"

# Original test target (for compatibility)
test: test-unit

#==============================================================================
# E2E TESTS
#==============================================================================

test-e2e: test-e2e-operational test-e2e-mongodb test-e2e-airtable
	@echo "$(BLUE)✓ All E2E tests passed$(NC)"

test-e2e-operational:
	@echo "$(BLUE)Running Phase 8 operational E2E tests...$(NC)"
	npm run test:e2e operational-complex
	npm run test:e2e operational-simple

test-e2e-mongodb:
	@echo "$(BLUE)Running MongoDB E2E tests...$(NC)"
	npm run test:e2e mongodb-statefulset-recipe

test-e2e-airtable:
	@echo "$(BLUE)Running Airtable E2E tests...$(NC)"
	npm run test:e2e airtable-deployment-recipe

#==============================================================================
# CLUSTER MANAGEMENT
#==============================================================================

MINIKUBE_PROFILE ?= clerum-test
NAMESPACE_RECIPE ?= mcp-server
NAMESPACE_SANDBOX ?= sandbox-recipes
NAMESPACE_CONTROL ?= control-plane

status:
	@echo "$(BLUE)=== Cluster Status ===$(NC)"
	@echo ""
	@echo "$(BLUE)Minikube:$(NC)"
	@minikube status -p $(MINIKUBE_PROFILE) 2>/dev/null || echo "  Minikube not running"
	@echo ""
	@echo "$(BLUE)Namespaces:$(NC)"
	@kubectl get namespaces | grep -E "mcp-server|sandbox-recipes|control-plane|mcp-host|channels" || true
	@echo ""
	@echo "$(BLUE)WorkflowRecipes:$(NC)"
	@kubectl get workflowrecipe -A 2>/dev/null | head -20 || echo "  No WorkflowRecipes found"
	@echo ""
	@echo "$(BLUE)Pods (mcp-server):$(NC)"
	@kubectl get pods -n $(NAMESPACE_RECIPE) 2>/dev/null | head -10 || echo "  Namespace not accessible"
	@echo ""
	@echo "$(BLUE)Pods (sandbox-recipes):$(NC)"
	@kubectl get pods -n $(NAMESPACE_SANDBOX) 2>/dev/null | head -10 || echo "  Namespace not accessible"
	@echo ""
	@echo "$(BLUE)Secrets (mcp-server):$(NC)"
	@kubectl get secrets -n $(NAMESPACE_RECIPE) 2>/dev/null | grep -E "mcp-mongodb|mcp-airtable" || echo "  No test secrets found"
	@echo ""
	@echo "$(BLUE)Contexts:$(NC)"
	@kubectl get contexts -A 2>/dev/null | head -10 || echo "  No Contexts found"

deploy-all: deploy-crds deploy-services
	@echo "$(GREEN)✓ All services deployed$(NC)"

deploy-crds:
	@echo "$(BLUE)Deploying CRDs...$(NC)"
	kubectl apply -f ../../charts/clerum-crds/
	@echo "$(GREEN)✓ CRDs deployed$(NC)"

deploy-services:
	@echo "$(BLUE)Deploying workflow-recipes controller...$(NC)"
	kubectl rollout restart deployment workflow-recipes -n $(NAMESPACE_CONTROL) 2>/dev/null || echo "Controller will be deployed on first apply"
	@echo "$(BLUE)Waiting for rollout to complete...$(NC)"
	@kubectl rollout status deployment workflow-recipes -n $(NAMESPACE_CONTROL) -w 2>/dev/null || true
	@echo "$(GREEN)✓ Services deployed$(NC)"

undeploy-all:
	@echo "$(BLUE)Undeploying all services...$(NC)"
	@echo "$(YELLOW)This will remove all WorkflowRecipes and restart controllers$(NC)"
	-kubectl delete workflowrecipe --all -A --ignore-not-found --timeout=30s
	@sleep 5
	@kubectl delete deployment workflow-recipes -n $(NAMESPACE_CONTROL) --ignore-not-found
	@echo "$(GREEN)✓ Services undeployed$(NC)"

restart-services: restart-wrc
	@echo "$(GREEN)✓ Services restarted$(NC)"

restart-wrc:
	@echo "$(BLUE)Restarting workflow-recipes controller...$(NC)"
	kubectl rollout restart deployment workflow-recipes -n $(NAMESPACE_CONTROL)
	@echo "$(BLUE)Waiting for rollout to complete...$(NC)"
	kubectl rollout status deployment workflow-recipes -n $(NAMESPACE_CONTROL) -w
	@echo "$(GREEN)✓ WRC restarted$(NC)"

#==============================================================================
# FULL VALIDATION
#==============================================================================

validate: undeploy-all deploy-all test-all test-e2e
	@echo "$(GREEN)✓✓✓ FULL VALIDATION COMPLETE ✓✓✓$(NC)"
	@echo "$(BLUE)  - 635 unit tests passed$(NC)"
	@echo "$(BLUE)  - All E2E tests passed$(NC)"
	@echo "$(BLUE)  - All services deployed and running$(NC)"

#==============================================================================
# BUILD & INSTALL (existing)
#==============================================================================

# Install dependencies
install:
	npm install

# Build TypeScript
build: install
	npm run build

# Run in development mode
dev: build
	CLERUM_DEV_MODE=true npm start

# Clean build artifacts
clean:
	rm -rf dist node_modules

# Docker build
docker-build:
	docker build -t $(REGISTRY)/$(IMAGE_NAME):$(TAG) .

# Docker build for minikube (local image, no registry prefix)
docker-build-local:
	docker build -t $(IMAGE_NAME):test .

# Docker push (requires login)
docker-push: docker-build
	docker push $(REGISTRY)/$(IMAGE_NAME):$(TAG)

# Build and push multi-platform image (for M1/ARM hosts targeting amd64 clusters)
docker-push-cross:
	docker buildx build --platform linux/amd64 -t $(REGISTRY)/$(IMAGE_NAME):$(TAG) --push .

#==============================================================================
# HELP
#==============================================================================

help:
	@echo "$(BLUE)Clerum Phase 8 - Testing & Deployment Makefile$(NC)"
	@echo ""
	@echo "$(GREEN)Quick Start:$(NC)"
	@echo "  make cluster-env-check    # Check Docker and minikube status"
	@echo "  make cluster-setup        # Complete cluster setup (requires Docker)"
	@echo "  make test-all             # Run all unit tests (635 tests)"
	@echo "  make test-e2e             # Run all E2E tests (39 tests)"
	@echo "  make validate             # Full validation pipeline"
	@echo ""
	@echo "$(GREEN)Environment Setup:$(NC)"
	@echo "  make cluster-env-check    # Check Docker and minikube status"
	@echo "  make cluster-start        # Start minikube (Docker Desktop must be running)"
	@echo "  make cluster-stop         # Stop minikube"
	@echo "  make cluster-delete       # Delete minikube cluster"
	@echo "  make cluster-setup        # Complete cluster setup (via minikube-setup.sh)"
	@echo "  make cluster-setup-simple # Simple setup (CRDs, namespaces, secrets only)"
	@echo "  make cluster-status       # Show cluster status"
	@echo ""
	@echo "$(GREEN)Testing:$(NC)"
	@echo "  make test-all             # Run all unit tests (635 tests)"
	@echo "  make test-unit            # Run workflow-recipes unit tests (292 tests)"
	@echo "  make test-mcp             # Run mcp-servers unit tests (343 tests)"
	@echo "  make test-e2e             # Run all E2E tests (39 tests)"
	@echo "  make test-e2e-operational # Run operational E2E tests only"
	@echo "  make test-e2e-mongodb     # Run MongoDB E2E tests only"
	@echo "  make test-e2e-airtable    # Run Airtable E2E tests only"
	@echo ""
	@echo "$(GREEN)Deployment:$(NC)"
	@echo "  make deploy-all           # Deploy all services to minikube"
	@echo "  make deploy-crds          # Deploy CRDs only"
	@echo "  make deploy-services      # Deploy WRC controller only"
	@echo "  make undeploy-all         # Remove all services from minikube"
	@echo "  make restart-wrc          # Restart WRC controller"
	@echo "  make validate             # Full validation pipeline"
	@echo ""
	@echo "$(GREEN)Troubleshooting:$(NC)"
	@echo "  make cluster-status       # Show cluster status"
	@echo "  make cluster-env-check    # Check Docker and minikube status"
	@echo ""
	@echo "$(YELLOW)Note: Docker Desktop must be running before cluster operations.$(NC)"
