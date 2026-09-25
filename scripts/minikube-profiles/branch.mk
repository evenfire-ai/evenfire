SHELL := /bin/bash

BRANCH_PROFILE_SCRIPT := $(dir $(abspath $(lastword $(MAKEFILE_LIST))))branch-profile.sh

HOST ?= 127.0.0.1
CACHE_ROOT ?= $(HOME)/.cache/clerum/minikube-profiles
MINIKUBE_MEMORY ?= 10240
MINIKUBE_CPUS ?= 6
MINIKUBE_CNI ?= calico
MINIKUBE_DRIVER ?= docker
CONFIRM_DELETE ?=
CONFIRM_PROFILE ?=
BRANCH_PROFILE_PROFILE ?=
ARGS ?=

.DEFAULT_GOAL := branch-profile-info

define run_branch_profile
@HOST="$(HOST)" \
CACHE_ROOT="$(CACHE_ROOT)" \
MINIKUBE_MEMORY="$(MINIKUBE_MEMORY)" \
MINIKUBE_CPUS="$(MINIKUBE_CPUS)" \
MINIKUBE_CNI="$(MINIKUBE_CNI)" \
MINIKUBE_DRIVER="$(MINIKUBE_DRIVER)" \
CONFIRM_DELETE="$(CONFIRM_DELETE)" \
CONFIRM_PROFILE="$(CONFIRM_PROFILE)" \
BRANCH_PROFILE_PROFILE="$(BRANCH_PROFILE_PROFILE)" \
ARGS="$(ARGS)" \
"$(BRANCH_PROFILE_SCRIPT)" "$(1)"
endef

.PHONY: branch-profile-resolve
branch-profile-resolve: ## Resolve the unique worktree/branch-owned profile without mutating profile state
	$(call run_branch_profile,resolve)

.PHONY: branch-profile-info
branch-profile-info:
	$(call run_branch_profile,info)

.PHONY: branch-profile-preflight
branch-profile-preflight:
	$(call run_branch_profile,preflight)

.PHONY: branch-profile-start
branch-profile-start:
	$(call run_branch_profile,start)

.PHONY: branch-profile-status
branch-profile-status:
	$(call run_branch_profile,status)

.PHONY: branch-profile-pf
branch-profile-pf:
	$(call run_branch_profile,pf)

.PHONY: branch-profile-pf-health
branch-profile-pf-health:
	$(call run_branch_profile,pf-health)

.PHONY: branch-profile-health
branch-profile-health:
	$(call run_branch_profile,health)

.PHONY: branch-profile-stop-pf
branch-profile-stop-pf:
	$(call run_branch_profile,stop-pf)

.PHONY: branch-profile-stop
branch-profile-stop:
	$(call run_branch_profile,stop)

.PHONY: branch-profile-delete
branch-profile-delete:
	$(call run_branch_profile,delete)

.PHONY: branch-profile-e2e-plan
branch-profile-e2e-plan:
	$(call run_branch_profile,e2e-plan)

.PHONY: branch-profile-sync-plan
branch-profile-sync-plan:
	$(call run_branch_profile,sync-plan)

.PHONY: branch-profile-prepare-shims
branch-profile-prepare-shims:
	$(call run_branch_profile,prepare-shims)

.PHONY: branch-profile-setup
branch-profile-setup:
	$(call run_branch_profile,setup)
