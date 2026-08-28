#!/bin/bash
# Public entry point for the HCC NetworkPolicy orphan census.
#
# k8s-context-guard-v2 requires a static context name in this file.
# The token below is the sanctioned public placeholder used by every other
# script in this repo. The live GKE project/cluster name is not committed
# here — leak-guards forbid it. Supply the real context from evenfire-infra
# or a local kubeconfig alias, never from this tree.
#
# kubectl --context=gke_your-gcp-project_us-central1-a_example-dev
#
# Classification lives in hcc-netpol-orphan-census.sh. Do not duplicate it.
# Feeds #478 (census series) and #484 (census↔controller parity).
#
# Usage:
#   ./scripts/ops/hcc-netpol-orphan-census-clerum-dev.sh

set -euo pipefail
umask 077

CONTEXT=gke_your-gcp-project_us-central1-a_example-dev
export CONTEXT

ROOT="$(cd "$(dirname "$0")" && pwd)"
exec "${ROOT}/hcc-netpol-orphan-census.sh"
