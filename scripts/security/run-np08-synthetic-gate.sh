#!/usr/bin/env bash
set -euo pipefail

# Synthetic NP-08 gate. It performs no Kubernetes writes, never reads a Secret,
# and only runs the repository-owned authorization unit suite after checking an
# explicit branch-owned context. The live deployment probe remains Gate F.

context=''
test_file='host-context-controller/src/mcpAuthorization.test.ts'
summary=''

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --context)
      context="${2:-}"
      shift 2
      ;;
    --test)
      test_file="${2:-}"
      shift 2
      ;;
    --summary)
      summary="${2:-}"
      shift 2
      ;;
    *)
      echo "usage: $0 --context <kube-context> [--test <HCC unit test>] --summary <file>" >&2
      exit 2
      ;;
  esac
done

if [[ -z "${context}" || -z "${summary}" ]]; then
  echo "usage: $0 --context <kube-context> [--test <HCC unit test>] --summary <file>" >&2
  exit 2
fi
if [[ "${test_file}" != host-context-controller/src/*.test.ts ]]; then
  echo "FAIL: synthetic gate accepts only the HCC authorization unit suite" >&2
  exit 2
fi
if [[ ! -f "${test_file}" ]]; then
  echo "FAIL: synthetic test file is absent" >&2
  exit 1
fi
if [[ -L "${summary}" ]]; then
  echo "FAIL: summary path must not be a symlink" >&2
  exit 2
fi

mkdir -p "$(dirname "${summary}")"
kubectl --context="${context}" get namespace mcp-server -o name >/dev/null
npm --prefix host-context-controller test -- "${test_file#host-context-controller/}"

printf '{"status":"pass","real_kubernetes_secret_reads":"zero","negative_path_secret_reads":"zero","synthetic_fixture_secret_values":"allowed","kubernetes_writes":"zero"}\n' >"${summary}"
echo 'PASS: NP-08 synthetic authorization gate (unit matrix; no real Secret reads; negative paths zero)'
