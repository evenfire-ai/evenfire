#!/usr/bin/env bash
# Cluster-free unit/integration evidence for the WRC gate. Runtime dataplane,
# business continuity, browser journeys, and T2 remain separate evidence lanes.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"

node -e 'if (Number(process.versions.node.split(".")[0]) !== 24) { process.stderr.write("WRC gate unit tests require Node 24\n"); process.exit(1) }'
bash -n "${ROOT}/scripts/e2e/e2e-wrc-egress-degradation.sh"

# These tests import the real pure oracle, DNS server, lifecycle, and runner.
# DNS uses ephemeral loopback sockets; Kubernetes is faked at its boundary.
# Executable entrypoint/lease refusal cases live in test-minikube-mutation-boundary.sh.
node --test --test-concurrency=1 \
  "${ROOT}/scripts/tests/wrc-egress-proof.test.cjs" \
  "${ROOT}/scripts/tests/wrc-egress-dns-proxy.test.cjs" \
  "${ROOT}/scripts/tests/wrc-egress-lifecycle.test.cjs" \
  "${ROOT}/scripts/tests/wrc-egress-gate.test.cjs"

printf 'WRC_EGRESS_UNIT_CONTRACT_PASS\n'
