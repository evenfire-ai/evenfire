#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TMP_DIR="$(mktemp -d)"
source "${ROOT}/scripts/tests/lib/minikube-fixture-repo.sh"

minikube_test_fixture_repo_init "${ROOT}" "${TMP_DIR}"
cleanup() {
  local status=$?
  if ! minikube_test_assert_host_unchanged; then
    status=1
  fi
  rm -rf "${TMP_DIR}"
  return "${status}"
}
trap cleanup EXIT

STATE_DIR="${TMP_DIR}/state"
LOG_FILE="${TMP_DIR}/kubectl.log"
OUT_FILE="${TMP_DIR}/sync.out"
SOURCE_HASH="$(printf 'public-key' | shasum -a 256 | awk '{print $1}')"
mkdir -p "${STATE_DIR}"
printf 'old-mcp-key' >"${STATE_DIR}/mcp.key"

# The production helper requires a live parent T2 lease. Keep the behavior
# tests isolated with a lease owned by this test shell rather than adding a
# production-only bypass.
T2_LOCK_ROOT="${TMP_DIR}/locks"
T2_LOCK_TOKEN='auth-sync-test-token'
T2_LOCK_DIR="${T2_LOCK_ROOT}/fake.lock"
T2_PROCESS_START=unavailable
T2_TEST_BRANCH="${MINIKUBE_TEST_BRANCH}"
T2_TEST_HEAD="${MINIKUBE_TEST_HEAD}"
T2_TEST_WORKTREE_ID="${MINIKUBE_TEST_WORKTREE_ID}"
T2_TEST_LOCK_KEY="${MINIKUBE_TEST_LOCK_KEY}"
mkdir -p "${T2_LOCK_DIR}"
cat >"${T2_LOCK_DIR}/owner.env" <<EOF
REPOSITORY=${MINIKUBE_TEST_PROJECT_DIR}
BRANCH=${T2_TEST_BRANCH}
HEAD=${T2_TEST_HEAD}
PROFILE=fake
CONTEXT=fake
WORKTREE_ID=${T2_TEST_WORKTREE_ID}
LOCK_KEY=${T2_TEST_LOCK_KEY}
TOKEN=${T2_LOCK_TOKEN}
PID=$$
PROCESS_START=${T2_PROCESS_START}
EOF
export T2_PROJECT_DIR="${MINIKUBE_TEST_PROJECT_DIR}" T2_PROFILE=fake T2_CONTEXT=fake T2_LOCK_ROOT T2_LOCK_TOKEN

# The discovery helper resolves target-key provenance from a sanitized view of
# the exact ConfigMaps and Secrets referenced by candidate containers. These
# fixtures exercise kubelet ordering without exposing object values.
DISCOVERY_INVENTORY='[
  {"kind":"ConfigMap","namespace":"mcp-host","name":"mcp-host-config","present":true,"uid":"target-uid","resourceVersion":"10","keys":["CLERUM_AUTH_JWT_PUBLIC_KEY"]},
  {"kind":"ConfigMap","namespace":"mcp-host","name":"override-present","present":true,"uid":"override-uid","resourceVersion":"11","keys":["CLERUM_AUTH_JWT_PUBLIC_KEY"]},
  {"kind":"ConfigMap","namespace":"mcp-host","name":"override-key-absent","present":true,"uid":"override-empty-uid","resourceVersion":"12","keys":["OTHER_KEY"]},
  {"kind":"ConfigMap","namespace":"mcp-host","name":"optional-config-absent","present":false,"keys":[]},
  {"kind":"Secret","namespace":"mcp-host","name":"secret-present","present":true,"uid":"secret-uid","resourceVersion":"13","keys":["CLERUM_AUTH_JWT_PUBLIC_KEY"]},
  {"kind":"Secret","namespace":"mcp-host","name":"secret-key-absent","present":true,"uid":"secret-empty-uid","resourceVersion":"14","keys":["OTHER_KEY"]},
  {"kind":"Secret","namespace":"mcp-host","name":"optional-secret-absent","present":false,"keys":[]}
]'

write_discovery_fixture() {
  DISCOVERY_FIXTURE="$1" python3 - <<'PY'
import json
import os

target = {"configMapRef": {"name": "mcp-host-config"}}


def key_ref(kind, name, key="CLERUM_AUTH_JWT_PUBLIC_KEY", optional=False):
    field = "configMapKeyRef" if kind == "ConfigMap" else "secretKeyRef"
    return {"valueFrom": {field: {"name": name, "key": key, "optional": optional}}}


def env_from(kind, name, prefix="", optional=False):
    field = "configMapRef" if kind == "ConfigMap" else "secretRef"
    source = {field: {"name": name, "optional": optional}}
    if prefix:
        source["prefix"] = prefix
    return source


def deployment(name, container, expression=None, replicas=1):
    selector = {"matchLabels": {"app": name}}
    if expression is not None:
        selector = {"matchExpressions": [expression]}
    return {
        "apiVersion": "apps/v1",
        "kind": "Deployment",
        "metadata": {
            "name": name,
            "namespace": "mcp-host",
            "uid": f"{name}-uid",
            "resourceVersion": "20",
        },
        "spec": {
            "replicas": replicas,
            "selector": selector,
            "template": {"spec": {"containers": [{"name": "runtime", **container}]}},
        },
    }


fixture = os.environ["DISCOVERY_FIXTURE"]
if fixture == "effective":
    items = [
        deployment("optional-cm-absent", {"envFrom": [target], "env": [{"name": "CLERUM_AUTH_JWT_PUBLIC_KEY", **key_ref("ConfigMap", "optional-config-absent", optional=True)}]}),
        deployment("optional-cm-key-absent", {"envFrom": [target], "env": [{"name": "CLERUM_AUTH_JWT_PUBLIC_KEY", **key_ref("ConfigMap", "override-key-absent", optional=True)}]}),
        deployment("optional-cm-key-present", {"envFrom": [target], "env": [{"name": "CLERUM_AUTH_JWT_PUBLIC_KEY", **key_ref("ConfigMap", "override-present", optional=True)}]}),
        deployment("optional-secret-absent", {"envFrom": [target], "env": [{"name": "CLERUM_AUTH_JWT_PUBLIC_KEY", **key_ref("Secret", "optional-secret-absent", optional=True)}]}),
        deployment("optional-secret-key-absent", {"envFrom": [target], "env": [{"name": "CLERUM_AUTH_JWT_PUBLIC_KEY", **key_ref("Secret", "secret-key-absent", optional=True)}]}),
        deployment("optional-secret-key-present", {"envFrom": [target], "env": [{"name": "CLERUM_AUTH_JWT_PUBLIC_KEY", **key_ref("Secret", "secret-present", optional=True)}]}),
        deployment("self-expansion", {"envFrom": [target], "env": [{"name": "CLERUM_AUTH_JWT_PUBLIC_KEY", "value": "$(CLERUM_AUTH_JWT_PUBLIC_KEY)"}]}),
        deployment("cm-shadow", {"envFrom": [target, env_from("ConfigMap", "override-present")]}),
        deployment("cm-no-shadow", {"envFrom": [target, env_from("ConfigMap", "override-key-absent")]}),
        deployment("optional-envfrom-cm-absent", {"envFrom": [target, env_from("ConfigMap", "optional-config-absent", optional=True)]}),
        deployment("secret-shadow", {"envFrom": [target, env_from("Secret", "secret-present")]}),
        deployment("secret-no-shadow", {"envFrom": [target, env_from("Secret", "secret-key-absent")]}),
        deployment("optional-envfrom-secret-absent", {"envFrom": [target, env_from("Secret", "optional-secret-absent", optional=True)]}),
        deployment("target-last", {"envFrom": [env_from("ConfigMap", "override-present"), target]}),
        deployment("secret-target-last", {"envFrom": [env_from("Secret", "secret-present"), target]}),
        deployment("prefix-shadow", {"envFrom": [env_from("ConfigMap", "mcp-host-config", "AUTH_"), env_from("ConfigMap", "override-present", "AUTH_")]}),
        deployment("prefix-distinct", {"envFrom": [env_from("ConfigMap", "mcp-host-config", "AUTH_"), env_from("ConfigMap", "override-present", "OTHER_")]}),
        deployment("dot-prefix", {"envFrom": [env_from("ConfigMap", "mcp-host-config", ".")]}),
        deployment("hyphen-prefix", {"envFrom": [env_from("ConfigMap", "mcp-host-config", "-")]}),
    ]
elif fixture == "required-missing":
    items = [deployment("required-missing", {"envFrom": [target], "env": [{"name": "CLERUM_AUTH_JWT_PUBLIC_KEY", **key_ref("ConfigMap", "optional-config-absent")}]} )]
elif fixture == "required-config-key-missing":
    items = [deployment("required-config-key-missing", {"envFrom": [target], "env": [{"name": "CLERUM_AUTH_JWT_PUBLIC_KEY", **key_ref("ConfigMap", "override-key-absent")}]} )]
elif fixture == "required-secret-key-missing":
    items = [deployment("required-secret-key-missing", {"envFrom": [target], "env": [{"name": "CLERUM_AUTH_JWT_PUBLIC_KEY", **key_ref("Secret", "secret-key-absent")}]} )]
elif fixture == "complex-expansion":
    items = [deployment("complex-expansion", {"envFrom": [target], "env": [{"name": "CLERUM_AUTH_JWT_PUBLIC_KEY", "value": "$(CLERUM_AUTH_JWT_PUBLIC_KEY)$(EMPTY)"}]})]
elif fixture == "escaped-expansion":
    items = [deployment("escaped-expansion", {"envFrom": [target], "env": [{"name": "ESCAPED_LITERAL", "value": "$$(CLERUM_AUTH_JWT_PUBLIC_KEY)"}]})]
elif fixture == "invalid-prefix":
    items = [deployment("invalid-prefix", {"envFrom": [env_from("ConfigMap", "mcp-host-config", "..")]})]
elif fixture == "zero-replicas":
    items = [deployment("zero-replicas", {"envFrom": [target]}, replicas=0)]
elif fixture == "empty-selectors":
    items = [
        deployment("selector-in-empty", {"envFrom": [target]}, {"key": "tier", "operator": "In", "values": [""]}),
        deployment("selector-notin-empty", {"envFrom": [target]}, {"key": "tier", "operator": "NotIn", "values": [""]}),
    ]
else:
    raise SystemExit(f"unknown discovery fixture: {fixture}")

print(json.dumps({"apiVersion": "v1", "kind": "DeploymentList", "items": items}))
PY
}

resolve_discovery_fixture() {
  local fixture="$1"
  write_discovery_fixture "${fixture}" | CONSUMER_OBJECT_INVENTORY="${DISCOVERY_INVENTORY}" \
    python3 "${ROOT}/scripts/minikube/discover-configmap-key-consumers.py" \
      --namespace mcp-host --config-map mcp-host-config --key CLERUM_AUTH_JWT_PUBLIC_KEY
}

assert_file_equals() {
  local file="$1" expected="$2" label="$3" actual
  if ! actual="$(cat "${file}" 2>&1)"; then
    echo "FAIL: ${label} could not read ${file}: ${actual}" >&2
    exit 1
  fi
  if [[ "${actual}" != "${expected}" ]]; then
    echo "FAIL: ${label}: expected '${expected}', got '${actual}'" >&2
    exit 1
  fi
}

assert_file_absent() {
  local file="$1" label="$2"
  if [[ -e "${file}" ]]; then
    echo "FAIL: ${label}: unexpected file ${file}" >&2
    exit 1
  fi
}

assert_file_contains() {
  local file="$1" pattern="$2" label="$3"
  if ! grep -q -- "${pattern}" "${file}"; then
    echo "FAIL: ${label}: pattern not found: ${pattern}" >&2
    cat "${file}" >&2 || true
    exit 1
  fi
}

assert_text_contains() {
  local text="$1" pattern="$2" label="$3"
  if ! grep -q -- "${pattern}" <<<"${text}"; then
    echo "FAIL: ${label}: pattern not found: ${pattern}" >&2
    printf '%s\n' "${text}" >&2
    exit 1
  fi
}

effective_output="$(resolve_discovery_fixture effective)" || {
  echo 'FAIL: effective-binding fixture was not resolvable' >&2
  exit 1
}
for expected in optional-cm-absent optional-cm-key-absent optional-secret-absent \
  optional-secret-key-absent optional-envfrom-cm-absent optional-envfrom-secret-absent \
  self-expansion cm-no-shadow secret-no-shadow target-last secret-target-last prefix-distinct \
  dot-prefix hyphen-prefix; do
  grep -q "${expected}" <<<"${effective_output}" || {
    echo "FAIL: ${expected} lost its effective target binding" >&2
    exit 1
  }
done
assert_text_contains "${effective_output}" '\.CLERUM_AUTH_JWT_PUBLIC_KEY' 'dot-prefixed effective name'
assert_text_contains "${effective_output}" '-CLERUM_AUTH_JWT_PUBLIC_KEY' 'hyphen-prefixed effective name'
escaped_output="$(resolve_discovery_fixture escaped-expansion)" || {
  echo 'FAIL: escaped-expansion fixture was not resolvable' >&2
  exit 1
}
assert_text_contains "${escaped_output}" 'escaped-expansion' 'escaped expansion target binding'
for shadowed in optional-cm-key-present optional-secret-key-present cm-shadow secret-shadow prefix-shadow; do
  if grep -q "${shadowed}" <<<"${effective_output}"; then
    echo "FAIL: ${shadowed} retained a shadowed target binding" >&2
    exit 1
  fi
done

if resolve_discovery_fixture required-missing >/dev/null 2>&1; then
  echo 'FAIL: a missing required override was treated as a provable contract' >&2
  exit 1
fi
if resolve_discovery_fixture required-config-key-missing >/dev/null 2>&1; then
  echo 'FAIL: a present ConfigMap missing a required key was treated as provable' >&2
  exit 1
fi
if resolve_discovery_fixture required-secret-key-missing >/dev/null 2>&1; then
  echo 'FAIL: a present Secret missing a required key was treated as provable' >&2
  exit 1
fi
if resolve_discovery_fixture complex-expansion >/dev/null 2>&1; then
  echo 'FAIL: a composite target-derived expansion was treated as a provable contract' >&2
  exit 1
fi
invalid_prefix_output="$(resolve_discovery_fixture invalid-prefix)" || {
  echo 'FAIL: invalid envFrom prefix did not fail closed as a non-binding' >&2
  exit 1
}
if grep -q 'invalid-prefix' <<<"${invalid_prefix_output}"; then
  echo 'FAIL: kubelet-invalid envFrom name was reported as a target binding' >&2
  exit 1
fi
zero_replicas_output="$(resolve_discovery_fixture zero-replicas)" || {
  echo 'FAIL: replicas-zero discovery fixture was not resolvable' >&2
  exit 1
}
assert_text_contains "${zero_replicas_output}" 'app=zero-replicas' 'replicas-zero selector'
selector_output="$(resolve_discovery_fixture empty-selectors)" || {
  echo 'FAIL: valid empty selector values were rejected' >&2
  exit 1
}
assert_text_contains "${selector_output}" 'tier in ()' 'In selector with empty value'
assert_text_contains "${selector_output}" 'tier notin ()' 'NotIn selector with empty value'

cat >"${TMP_DIR}/kubectl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail

while [[ "${1:-}" == --context* ]]; do
  if [[ "${1}" == "--context" ]]; then shift 2; else shift; fi
done
while [[ "${1:-}" == -n || "${1:-}" == --namespace ]]; do shift 2; done
printf '%s\n' "$*" >>"${TEST_KUBECTL_LOG}"

increment() {
  local name="$1" file count=0
  file="${TEST_STATE_DIR}/${name}.count"
  [[ -f "${file}" ]] && count="$(cat "${file}")"
  printf '%s' "$((count + 1))" >"${file}"
}

if [[ "${1:-}" == get && "${2:-}" == secret && "${3:-}" == rpc-proxy-secrets ]]; then
  if [[ "$*" == *'.metadata.resourceVersion'* ]]; then
    printf '42'
  elif [[ "$*" == *'-o json' ]]; then
    source_b64="${TEST_SOURCE_B64:-cHVibGljLWtleQ==}"
    source_rv=42
    if [[ -n "${TEST_ROTATE_ON_SOURCE_SNAPSHOT:-}" ]]; then
      snapshot_file="${TEST_STATE_DIR}/source-json-snapshot.count"
      snapshot_count=0
      [[ -f "${snapshot_file}" ]] && snapshot_count="$(cat "${snapshot_file}")"
      snapshot_count=$((snapshot_count + 1))
      printf '%s' "${snapshot_count}" >"${snapshot_file}"
      if (( snapshot_count >= TEST_ROTATE_ON_SOURCE_SNAPSHOT )); then
        source_b64='cm90YXRlZA=='
        source_rv=43
      fi
    fi
    printf '{"metadata":{"resourceVersion":"%s"},"data":{"RPC_PROXY_JWT_PUBLIC_KEY":"%s"}}' "${source_rv}" "${source_b64}"
  elif [[ "$*" == *jsonpath* ]]; then
    printf '%s' "${TEST_SOURCE_B64:-cHVibGljLWtleQ==}"
  fi
  exit 0
fi

if [[ "${1:-}" == get && "${2:-}" == configmap && "${3:-}" == mcp-host-config ]]; then
  if [[ "$*" == *auth-key-applied-sha256* ]]; then
    [[ -f "${TEST_STATE_DIR}/mcp.applied" ]] && cat "${TEST_STATE_DIR}/mcp.applied"
  elif [[ "$*" == *'-o json' ]]; then
    python3 - <<'PY'
import json
import os
from pathlib import Path
state = Path(os.environ['TEST_STATE_DIR'])
annotations = {}
if (state / 'mcp.applied').exists():
    annotations['clerum.io/auth-key-applied-sha256'] = (state / 'mcp.applied').read_text()
print(json.dumps({'metadata': {'name': 'mcp-host-config', 'namespace': 'mcp-host',
                               'uid': 'mcp-host-config-uid', 'resourceVersion': '42',
                               'annotations': annotations},
                  'data': {'CLERUM_AUTH_JWT_PUBLIC_KEY': (state / 'mcp.key').read_text()}}))
PY
  elif [[ "$*" == *jsonpath* ]]; then
    cat "${TEST_STATE_DIR}/mcp.key"
  fi
  exit 0
fi

if [[ "${1:-}" == get && "${2:-}" == configmap && "${3:-}" == gfs-config ]]; then
  [[ "${TEST_GFS_PRESENT:-0}" == 1 ]] || {
    echo 'Error from server (NotFound): configmaps "gfs-config" not found' >&2
    exit 1
  }
  if [[ "$*" == *auth-key-applied-sha256* ]]; then
    [[ -f "${TEST_STATE_DIR}/gfs.applied" ]] && cat "${TEST_STATE_DIR}/gfs.applied"
  elif [[ "$*" == *'-o json' ]]; then
    python3 - <<'PY'
import json
import os
from pathlib import Path
state = Path(os.environ['TEST_STATE_DIR'])
annotations = {}
if (state / 'gfs.applied').exists():
    annotations['clerum.io/auth-key-applied-sha256'] = (state / 'gfs.applied').read_text()
print(json.dumps({'metadata': {'resourceVersion': '42', 'annotations': annotations},
                  'data': {'jwt-public-key': (state / 'gfs.key').read_text()}}))
PY
  elif [[ "$*" == *jsonpath* ]]; then
    cat "${TEST_STATE_DIR}/gfs.key"
  fi
  exit 0
fi

# Runtime-contract discovery reads the real Deployment pod templates in one
# namespace-scoped snapshot. Keep these fixtures faithful to Kubernetes JSON:
# selectors are independent from Deployment names, WFC uses an explicit
# configMapKeyRef, and an HCC-owned unrelated Deployment has no target binding.
if [[ "${1:-}" == get && ( "${2:-}" == deployment || "${2:-}" == deployments ) && "$*" == *'-o json'* ]]; then
  python3 - <<'PY'
import json
import os

target_ref = {"configMapRef": {"name": "mcp-host-config"}}
direct_ref = {
    "valueFrom": {
        "configMapKeyRef": {
            "name": "mcp-host-config",
            "key": "CLERUM_AUTH_JWT_PUBLIC_KEY",
        }
    }
}


def deployment(name, labels, containers, replicas=1, managed_by="host-context-controller"):
    return {
        "apiVersion": "apps/v1",
        "kind": "Deployment",
        "metadata": {
            "name": name,
            "namespace": "mcp-host",
            "uid": f"{name}-uid",
            "resourceVersion": "30",
            "labels": {"clerum.io/managed-by": managed_by},
        },
        "spec": {
            "replicas": replicas,
            "selector": {"matchLabels": labels},
            "template": {
                "metadata": {"labels": labels},
                "spec": {"containers": containers},
            },
        },
    }


def mcp(name="chatllm", replicas=1, selector=None):
    labels = selector or {"app": name}
    return deployment(
        name,
        labels,
        [{"name": "mcp-host", "envFrom": [target_ref], "env": []}],
        replicas,
    )


def wfc(replicas=1):
    return deployment(
        "wfc-21352205ce",
        {
            "app": "workspace-files-controller",
            "clerum.io/sharedfilesystem": "workspace-alpha",
            "clerum.io/sharedfilesystem-namespace": "mcp-host",
        },
        [{"name": "workspace-files-controller", "env": [{"name": "WSF_JWT_PUBLIC_KEY", **direct_ref}]}],
        replicas,
    )


mode = os.environ.get("TEST_MCP_DEPLOYMENTS", "chatllm")
replicas = int(os.environ.get("TEST_MCP_REPLICAS", "1"))
if mode == "none":
    items = []
elif mode == "custom":
    items = [mcp("custom-host", replicas)]
elif mode == "runtime-contract":
    items = [
        mcp("chatllm", replicas, {"app": "mcp-runtime", "clerum.io/host": "alpha"}),
        wfc(replicas),
        deployment(
            "hcc-unrelated",
            {"app": "unrelated-runtime"},
            [{"name": "unrelated", "envFrom": [{"configMapRef": {"name": "unrelated-config"}}]}],
            replicas,
        ),
        deployment(
            "wrc-recipe-host",
            {"app": "workflow-recipe-runtime"},
            [
                {
                    "name": "mcp-host",
                    "env": [
                        {
                            "name": "CLERUM_AUTH_JWT_PUBLIC_KEY",
                            "valueFrom": {
                                "configMapKeyRef": {
                                    "name": "clerum-wrc-public-key",
                                    "key": "CLERUM_WRC_SIGNING_PUBLIC_KEY",
                                }
                            },
                        }
                    ],
                }
            ],
            replicas,
            managed_by="wrc",
        ),
    ]
elif mode == "multiple-bindings":
    items = [
        deployment(
            "multi-consumer",
            {"app": "multi-runtime", "clerum.io/host": "multi"},
            [
                {
                    "name": "prefixed",
                    "envFrom": [{"prefix": "AUTH_", **target_ref}],
                    "env": [],
                },
                {
                    "name": "direct",
                    "env": [{"name": "DIRECT_JWT_PUBLIC_KEY", **direct_ref}],
                },
                {
                    "name": "overridden",
                    "envFrom": [target_ref],
                    "env": [{"name": "CLERUM_AUTH_JWT_PUBLIC_KEY", "value": "literal-override"}],
                },
                {
                    "name": "optional-kept",
                    "envFrom": [target_ref],
                    "env": [
                        {
                            "name": "CLERUM_AUTH_JWT_PUBLIC_KEY",
                            "valueFrom": {
                                "configMapKeyRef": {
                                    "name": "optional-config-absent",
                                    "key": "CLERUM_AUTH_JWT_PUBLIC_KEY",
                                    "optional": True,
                                }
                            },
                        }
                    ],
                },
                {
                    "name": "self-expanded",
                    "envFrom": [target_ref],
                    "env": [
                        {
                            "name": "CLERUM_AUTH_JWT_PUBLIC_KEY",
                            "value": "$(CLERUM_AUTH_JWT_PUBLIC_KEY)",
                        }
                    ],
                },
                {
                    "name": "shadowed",
                    "envFrom": [
                        target_ref,
                        {"configMapRef": {"name": "override-present"}},
                    ],
                },
            ],
            replicas,
        )
    ]
elif mode == "option-binding":
    items = [
        deployment(
            "option-consumer",
            {"app": "option-runtime"},
            [{"name": "option-runtime", "env": [{"name": "--version", **direct_ref}]}],
            replicas,
        )
    ]
else:
    items = [mcp("chatllm", replicas)]

print(json.dumps({"apiVersion": "v1", "kind": "List", "items": items}))
PY
  exit 0
fi

if [[ "${1:-}" == get && "${2:-}" == configmap && "${3:-}" == override-present ]]; then
  if [[ "$*" == *'-o json'* ]]; then
    printf '%s' '{"metadata":{"name":"override-present","namespace":"mcp-host","uid":"override-present-uid","resourceVersion":"50"},"data":{"CLERUM_AUTH_JWT_PUBLIC_KEY":"shadow"}}'
  fi
  exit 0
fi

if [[ "${1:-}" == get && "${2:-}" == configmap && "${3:-}" == optional-config-absent ]]; then
  if [[ "$*" == *--ignore-not-found* ]]; then
    exit 0
  fi
  echo 'Error from server (NotFound): configmaps "optional-config-absent" not found' >&2
  exit 1
fi

if [[ "${1:-}" == patch && "${2:-}" == configmap ]]; then
  target="${3}"
  patch_payload=""
  while [[ $# -gt 0 ]]; do
    if [[ "$1" == -p ]]; then patch_payload="${2:-}"; break; fi
    shift
  done
  case "${target}:${patch_payload}" in
    mcp-host-config:*'"data"'*) printf 'public-key' >"${TEST_STATE_DIR}/mcp.key"; increment mcp-data-patch ;;
    mcp-host-config:*auth-key-applied-sha256*) printf '%s' "${TEST_SOURCE_HASH}" >"${TEST_STATE_DIR}/mcp.applied"; increment mcp-marker-patch ;;
    gfs-config:*'"data"'*) printf 'public-key' >"${TEST_STATE_DIR}/gfs.key"; increment gfs-data-patch ;;
    gfs-config:*auth-key-applied-sha256*) printf '%s' "${TEST_SOURCE_HASH}" >"${TEST_STATE_DIR}/gfs.applied"; increment gfs-marker-patch ;;
    *) echo "unexpected ConfigMap patch: ${target}" >&2; exit 91 ;;
  esac
  exit 0
fi

if [[ "${1:-}" == get && "${2:-}" == deployment/* ]]; then
  case "${2}" in
    deployment/gfsc-writer|deployment/gfsc-reader)
      if [[ "${TEST_GFS_DEPLOYMENTS:-0}" == 1 ]]; then
        [[ "$*" == *'.spec.replicas'* ]] && printf '1'
        exit 0
      fi
      printf 'Error from server (NotFound): deployments.apps "%s" not found\n' "${2#deployment/}" >&2
      exit 1 ;;
    *) exit 1 ;;
  esac
fi

if [[ "${1:-}" == get && "${2:-}" == secret && "${3:-}" == gfs-controller-db ]]; then
  printf 'ZHNuLXZhbHVl'
  exit 0
fi

if [[ "${1:-}" == rollout && "${2:-}" == restart && "${3:-}" == deployment/* ]]; then
  increment "${3#deployment/}-restart"
  exit 0
fi

if [[ "${1:-}" == rollout && "${2:-}" == status && "${3:-}" == deployment/* ]]; then
  exit 0
fi

if [[ "${1:-}" == get && "${2:-}" == pods ]]; then
  if [[ "$*" != *'.metadata.name'* && "$*" == *gfsc-role=reader* ]]; then
    printf 'True|\n'
    exit 0
  fi
  case "$*" in
    *app=chatllm*) printf 'chatllm-pod|True|\n' ;;
    *app=custom-host*) printf 'custom-host-pod|True|\n' ;;
    *'app=mcp-runtime,clerum.io/host=alpha'*) printf 'chatllm-pod|True|\n' ;;
    *'app=workspace-files-controller,clerum.io/sharedfilesystem=workspace-alpha,clerum.io/sharedfilesystem-namespace=mcp-host'*)
      if [[ "${TEST_NO_READY_AFTER_ROLLOUT:-}" == wfc-21352205ce && \
            -f "${TEST_STATE_DIR}/wfc-21352205ce-restart.count" ]]; then
        :
      else
        printf 'wfc-21352205ce-pod|True|\n'
      fi
      ;;
    *'app=multi-runtime,clerum.io/host=multi'*) printf 'multi-consumer-pod|True|\n' ;;
    *app=option-runtime*) printf 'option-consumer-pod|True|\n' ;;
    *gfsc-role=writer*) printf 'gfsc-writer-pod|True|\n' ;;
    *gfsc-role=reader*) printf 'gfsc-reader-pod|True|\n' ;;
    *) echo "unexpected pod selector: $*" >&2; exit 92 ;;
  esac
  exit 0
fi

if [[ "${1:-}" == exec ]]; then
  input_file="${TEST_STATE_DIR}/exec-input"
  cat >"${input_file}"
  expected_key="${TEST_RUNTIME_KEY}"
  [[ "$*" == *GFS_JWT_PUBLIC_KEY* ]] && expected_key="${TEST_RUNTIME_KEY_GFS:-${expected_key}}"
  [[ "$*" == *CLERUM_AUTH_JWT_PUBLIC_KEY* ]] && expected_key="${TEST_RUNTIME_KEY_MCP:-${expected_key}}"
  [[ "$*" == *WSF_JWT_PUBLIC_KEY* ]] && expected_key="${TEST_RUNTIME_KEY_WFC:-${expected_key}}"

  pod="${3:-}"
  container=""
  previous=""
  for argument in "$@"; do
    if [[ "${previous}" == -c ]]; then
      container="${argument}"
      break
    fi
    previous="${argument}"
  done
  env_name="${!#}"
  case "${pod}" in
    chatllm-pod) deployment_name=chatllm ;;
    custom-host-pod) deployment_name=custom-host ;;
    wfc-21352205ce-pod) deployment_name=wfc-21352205ce ;;
    multi-consumer-pod) deployment_name=multi-consumer ;;
    option-consumer-pod) deployment_name=option-consumer ;;
    gfsc-writer-pod) deployment_name=gfsc-writer ;;
    gfsc-reader-pod) deployment_name=gfsc-reader ;;
    *) deployment_name="${pod%-pod}" ;;
  esac
  binding="${deployment_name}/${container}/${env_name}"
  if [[ ",${TEST_STALE_BINDINGS:-}," == *",${binding},"* ]]; then
    if [[ ! -f "${TEST_STATE_DIR}/${deployment_name}-restart.count" ]]; then
      expected_key=old-key
    fi
  fi
  if [[ ",${TEST_PERSIST_STALE_BINDINGS:-}," == *",${binding},"* ]]; then
    expected_key=old-key
  fi
  remote_argv=()
  capture_remote=false
  for argument in "$@"; do
    if [[ "${capture_remote}" == true ]]; then
      remote_argv+=("${argument}")
    elif [[ "${argument}" == -- ]]; then
      capture_remote=true
    fi
  done
  (( ${#remote_argv[@]} > 0 )) || {
    echo 'kubectl exec fixture did not receive a remote argv' >&2
    exit 93
  }
  exec /usr/bin/env -- "${env_name}=${expected_key}" "${remote_argv[@]}" <"${input_file}"
fi

echo "unexpected kubectl invocation: $*" >&2
exit 99
SH
cat >"${TMP_DIR}/ps" <<'SH'
#!/usr/bin/env bash
case " $* " in
  *' -o state='*) printf 'R\n' ;;
  *' -o lstart='*) printf 'unavailable\n' ;;
  *) exit 1 ;;
esac
SH
chmod +x "${TMP_DIR}/kubectl" "${TMP_DIR}/ps"

run_sync() {
  local source_hash="${TEST_SOURCE_HASH_OVERRIDE:-${SOURCE_HASH}}"
  TEST_KUBECTL_LOG="${LOG_FILE}" TEST_STATE_DIR="${STATE_DIR}" \
    TEST_SOURCE_HASH="${source_hash}" PATH="${TMP_DIR}:$PATH" \
    "$@"
}

# Fault after the ConfigMap patch: the active pod still has the old key. The
# durable marker must remain absent so a retry cannot misclassify this as done.
if run_sync env TEST_RUNTIME_KEY=old-key \
  bash "${ROOT}/scripts/minikube/sync-auth-key.sh" --context fake --require-mcp --skip-gfs \
  >"${OUT_FILE}" 2>&1; then
  echo "FAIL: MCP sync accepted a pod that had not consumed the target key" >&2
  exit 1
fi
assert_file_equals "${STATE_DIR}/mcp.key" public-key 'MCP ConfigMap patch'
assert_file_absent "${STATE_DIR}/mcp.applied" 'failed MCP proof marker'
assert_file_contains "${OUT_FILE}" 'has not consumed the target auth key' 'interrupted MCP consumer diagnostic'

# The key now matches, but the absent marker must resume—not skip—consumer
# convergence. A live pod that already consumed the target key need not restart.
: >"${LOG_FILE}"
run_sync env TEST_RUNTIME_KEY=public-key \
  bash "${ROOT}/scripts/minikube/sync-auth-key.sh" --context fake --require-mcp --skip-gfs \
  >"${OUT_FILE}" 2>&1
assert_file_equals "${STATE_DIR}/mcp.applied" "${SOURCE_HASH}" 'resumed MCP marker'
assert_file_equals "${STATE_DIR}/mcp-data-patch.count" 1 'MCP data patch count'
assert_file_equals "${STATE_DIR}/chatllm-restart.count" 1 'MCP restart count'
assert_file_contains "${OUT_FILE}" 'matches source but consumer attestation is pending; resuming convergence' 'MCP resume diagnostic'

# A fully attested rerun is idempotent and must not touch the deployment.
: >"${LOG_FILE}"
# A converged pod must report the target key; an arbitrary value would
# correctly trigger a recovery rollout rather than exercise idempotence.
run_sync env TEST_RUNTIME_KEY=public-key \
  bash "${ROOT}/scripts/minikube/sync-auth-key.sh" --context fake --require-mcp --skip-gfs \
  >"${OUT_FILE}" 2>&1
assert_file_equals "${STATE_DIR}/chatllm-restart.count" 1 'idempotent MCP restart count'
if grep -Eq '^(rollout|patch)' "${LOG_FILE}"; then
  echo "FAIL: converged MCP sync was not idempotent" >&2
  cat "${LOG_FILE}" >&2
  exit 1
fi

# A previous run may have attested the ConfigMap before HCC created a new
# managed deployment. A later run must inspect that new pod instead of
# returning on the old ConfigMap annotation alone.
: >"${LOG_FILE}"
if run_sync env TEST_RUNTIME_KEY=old-key TEST_MCP_DEPLOYMENTS=custom \
  bash "${ROOT}/scripts/minikube/sync-auth-key.sh" --context fake --require-mcp --skip-gfs \
  >"${OUT_FILE}" 2>&1; then
  echo "FAIL: newly created MCP consumer with stale key was accepted" >&2
  exit 1
fi
assert_file_equals "${STATE_DIR}/custom-host-restart.count" 1 'new consumer restart count'

# A stateless HCC Host can be intentionally suspended at replicas=0. The
# ConfigMap still converges, but there is no pod to restart or prove; a future
# pod must consume the current ConfigMap value.
printf 'old-mcp-key' >"${STATE_DIR}/mcp.key"
rm -f "${STATE_DIR}/mcp.applied"
run_sync env TEST_MCP_REPLICAS=0 TEST_RUNTIME_KEY=old-key \
  bash "${ROOT}/scripts/minikube/sync-auth-key.sh" --context fake --require-mcp --skip-gfs \
  >"${OUT_FILE}" 2>&1
assert_file_equals "${STATE_DIR}/mcp.key" public-key 'replicas-zero ConfigMap value'
assert_file_equals "${STATE_DIR}/mcp.applied" "${SOURCE_HASH}" 'replicas-zero marker'
assert_file_equals "${STATE_DIR}/chatllm-restart.count" 1 'replicas-zero restart count'
assert_file_contains "${OUT_FILE}" 'Skipping suspended mcp-host/chatllm' 'replicas-zero diagnostic'

run_sync env TEST_RUNTIME_KEY=public-key TEST_MCP_DEPLOYMENTS=custom \
  bash "${ROOT}/scripts/minikube/sync-auth-key.sh" --context fake --require-mcp --skip-gfs \
  >"${OUT_FILE}" 2>&1
assert_file_equals "${STATE_DIR}/custom-host-restart.count" 1 'custom consumer restart count'

# Repeat the interrupted-then-resumed contract for the two real GFSC
# deployments. This also prevents a regression to deployment/gfs-controller.
printf 'old-gfs-key' >"${STATE_DIR}/gfs.key"
: >"${LOG_FILE}"
if run_sync env TEST_RUNTIME_KEY=public-key TEST_RUNTIME_KEY_MCP=public-key TEST_RUNTIME_KEY_GFS=old-key \
  TEST_GFS_PRESENT=1 TEST_GFS_DEPLOYMENTS=1 \
  bash "${ROOT}/scripts/minikube/sync-auth-key.sh" --context fake --require-gfs \
  >"${OUT_FILE}" 2>&1; then
  echo "FAIL: GFS sync accepted a writer that had not consumed the target key" >&2
  exit 1
fi
[[ "$(cat "${STATE_DIR}/gfs.key")" == public-key ]] || {
  cat "${OUT_FILE}" >&2
  cat "${LOG_FILE}" >&2
  echo "FAIL: GFS ConfigMap was not patched before consumer proof" >&2
  exit 1
}
assert_file_absent "${STATE_DIR}/gfs.applied" 'failed GFSC proof marker'

: >"${LOG_FILE}"
if ! run_sync env TEST_RUNTIME_KEY=public-key TEST_RUNTIME_KEY_MCP=public-key TEST_RUNTIME_KEY_GFS=public-key \
  TEST_GFS_PRESENT=1 TEST_GFS_DEPLOYMENTS=1 \
  bash "${ROOT}/scripts/minikube/sync-auth-key.sh" --context fake --require-gfs \
  >"${OUT_FILE}" 2>&1; then
  cat "${OUT_FILE}" >&2
  cat "${LOG_FILE}" >&2
  echo "FAIL: GFS sync did not resume after an interrupted consumer proof" >&2
  exit 1
fi
assert_file_equals "${STATE_DIR}/gfs.applied" "${SOURCE_HASH}" 'GFSC marker'
assert_file_equals "${STATE_DIR}/gfsc-writer-restart.count" 1 'GFSC writer restart count'
assert_file_absent "${STATE_DIR}/gfsc-reader-restart.count" 'converged GFSC reader restart'
if grep -q 'rollout restart deployment/gfsc-' "${LOG_FILE}"; then
  echo "FAIL: already-converged GFSC pods were restarted unnecessarily" >&2
  cat "${LOG_FILE}" >&2
  exit 1
fi
if grep -q 'deployment/gfs-controller' "${LOG_FILE}"; then
  echo "FAIL: GFS auth sync targeted the nonexistent deployment/gfs-controller" >&2
  exit 1
fi

# ConfigMap values commonly end in the PEM newline. The source must be
# compared and attested byte-for-byte; command substitution must not silently
# remove that newline and trigger a false rollout failure.
NEWLINE_SOURCE_HASH="$(printf 'public-key\n' | shasum -a 256 | awk '{print $1}')"
printf 'public-key\n' >"${STATE_DIR}/mcp.key"
rm -f "${STATE_DIR}/mcp.applied"
if ! TEST_SOURCE_HASH_OVERRIDE="${NEWLINE_SOURCE_HASH}" run_sync env \
  TEST_SOURCE_B64='cHVibGljLWtleQo=' TEST_RUNTIME_KEY=$'public-key\n' \
  bash "${ROOT}/scripts/minikube/sync-auth-key.sh" --context fake --require-mcp --skip-gfs \
  >"${OUT_FILE}" 2>&1; then
  cat "${OUT_FILE}" >&2
  cat "${LOG_FILE}" >&2
  echo "FAIL: auth-key sync rejected an exact PEM-style trailing newline" >&2
  exit 1
fi
assert_file_equals "${STATE_DIR}/mcp.applied" "${NEWLINE_SOURCE_HASH}" 'trailing-newline source marker'
if grep -q 'rollout restart deployment/' "${LOG_FILE}"; then
  echo "FAIL: exact trailing-newline convergence triggered an unnecessary rollout" >&2
  cat "${LOG_FILE}" >&2
  exit 1
fi

# ConfigMap drift and process drift are independent. Both the envFrom-backed
# MCP host and the direct configMapKeyRef-backed WFC already run with the
# source key, so repairing the ConfigMap must not restart either Deployment.
# The HCC-owned unrelated Deployment and the WRC recipe host deliberately use
# other ConfigMaps and must be ignored despite the broad owner label or the
# recipe host's identical effective environment-variable name.
printf 'old-mcp-key' >"${STATE_DIR}/mcp.key"
rm -f "${STATE_DIR}/mcp.applied"
: >"${LOG_FILE}"
if ! run_sync env TEST_RUNTIME_KEY=public-key TEST_RUNTIME_KEY_MCP=public-key \
  TEST_RUNTIME_KEY_WFC=public-key TEST_MCP_DEPLOYMENTS=runtime-contract \
  bash "${ROOT}/scripts/minikube/sync-auth-key.sh" --context fake --require-mcp --skip-gfs \
  >"${OUT_FILE}" 2>&1; then
  cat "${OUT_FILE}" >&2
  cat "${LOG_FILE}" >&2
  echo 'FAIL: runtime-contract consumers did not converge after ConfigMap repair' >&2
  exit 1
fi
assert_file_equals "${STATE_DIR}/mcp.applied" "${SOURCE_HASH}" 'runtime-contract marker'
if grep -q 'rollout restart deployment/' "${LOG_FILE}"; then
  echo 'FAIL: ConfigMap-only drift restarted already-converged runtime consumers' >&2
  cat "${LOG_FILE}" >&2
  exit 1
fi
if grep -q 'deployment/hcc-unrelated' "${LOG_FILE}"; then
  echo 'FAIL: unrelated HCC Deployment was treated as an auth-key consumer' >&2
  cat "${LOG_FILE}" >&2
  exit 1
fi
if grep -q 'deployment/wrc-recipe-host' "${LOG_FILE}"; then
  echo 'FAIL: a WRC recipe host using clerum-wrc-public-key was treated as a platform auth-key consumer' >&2
  cat "${LOG_FILE}" >&2
  exit 1
fi
assert_file_contains "${LOG_FILE}" '-l app=workspace-files-controller,clerum.io/sharedfilesystem=workspace-alpha,clerum.io/sharedfilesystem-namespace=mcp-host' 'WFC selector proof'
assert_file_contains "${LOG_FILE}" '-c workspace-files-controller -- node -e .* -- WSF_JWT_PUBLIC_KEY' 'WFC binding proof'

# A rotation must restart only the stale MCP host. WFC is independently
# verified through its own binding and remains untouched.
printf 'public-key' >"${STATE_DIR}/mcp.key"
rm -f "${STATE_DIR}/mcp.applied" \
  "${STATE_DIR}/chatllm-restart.count" "${STATE_DIR}/wfc-21352205ce-restart.count"
: >"${LOG_FILE}"
if ! run_sync env TEST_RUNTIME_KEY=public-key TEST_MCP_DEPLOYMENTS=runtime-contract \
  TEST_STALE_BINDINGS='chatllm/mcp-host/CLERUM_AUTH_JWT_PUBLIC_KEY' \
  bash "${ROOT}/scripts/minikube/sync-auth-key.sh" --context fake --require-mcp --skip-gfs \
  >"${OUT_FILE}" 2>&1; then
  cat "${OUT_FILE}" >&2
  cat "${LOG_FILE}" >&2
  echo 'FAIL: stale MCP host did not converge after its selective rollout' >&2
  exit 1
fi
assert_file_equals "${STATE_DIR}/chatllm-restart.count" 1 'selective MCP restart count'
assert_file_absent "${STATE_DIR}/wfc-21352205ce-restart.count" 'unnecessary WFC restart'

# The inverse rotation proves the production WFC contract: real selector,
# real container, and effective env name. Only WFC may restart.
rm -f "${STATE_DIR}/mcp.applied" \
  "${STATE_DIR}/chatllm-restart.count" "${STATE_DIR}/wfc-21352205ce-restart.count"
: >"${LOG_FILE}"
if ! run_sync env TEST_RUNTIME_KEY=public-key TEST_MCP_DEPLOYMENTS=runtime-contract \
  TEST_STALE_BINDINGS='wfc-21352205ce/workspace-files-controller/WSF_JWT_PUBLIC_KEY' \
  bash "${ROOT}/scripts/minikube/sync-auth-key.sh" --context fake --require-mcp --skip-gfs \
  >"${OUT_FILE}" 2>&1; then
  cat "${OUT_FILE}" >&2
  cat "${LOG_FILE}" >&2
  echo 'FAIL: stale WFC did not converge after its selective rollout' >&2
  exit 1
fi
assert_file_equals "${STATE_DIR}/wfc-21352205ce-restart.count" 1 'selective WFC restart count'
assert_file_absent "${STATE_DIR}/chatllm-restart.count" 'unnecessary MCP restart'
assert_file_contains "${LOG_FILE}" 'rollout restart deployment/wfc-21352205ce' 'WFC rollout'
assert_file_contains "${LOG_FILE}" '-l app=workspace-files-controller,clerum.io/sharedfilesystem=workspace-alpha,clerum.io/sharedfilesystem-namespace=mcp-host' 'WFC selector after rollout'
assert_file_contains "${LOG_FILE}" '-c workspace-files-controller -- node -e .* -- WSF_JWT_PUBLIC_KEY' 'WFC binding after rollout'

# A rollout that still yields no Ready, provable WFC pod must fail closed and
# leave the convergence marker absent.
rm -f "${STATE_DIR}/mcp.applied" \
  "${STATE_DIR}/chatllm-restart.count" "${STATE_DIR}/wfc-21352205ce-restart.count"
: >"${LOG_FILE}"
if run_sync env TEST_RUNTIME_KEY=public-key TEST_MCP_DEPLOYMENTS=runtime-contract \
  TEST_STALE_BINDINGS='wfc-21352205ce/workspace-files-controller/WSF_JWT_PUBLIC_KEY' \
  TEST_NO_READY_AFTER_ROLLOUT=wfc-21352205ce \
  bash "${ROOT}/scripts/minikube/sync-auth-key.sh" --context fake --require-mcp --skip-gfs \
  >"${OUT_FILE}" 2>&1; then
  cat "${OUT_FILE}" >&2
  echo 'FAIL: auth-key sync accepted WFC without a Ready pod after rollout' >&2
  exit 1
fi
assert_file_equals "${STATE_DIR}/wfc-21352205ce-restart.count" 1 'failed WFC rollout restart count'
assert_file_absent "${STATE_DIR}/mcp.applied" 'failed WFC rollout marker'
assert_file_contains "${OUT_FILE}" 'no active pod proved consumption of the target auth key' 'no-ready WFC diagnostic'

# Multiple containers and effective bindings must all be proved. envFrom
# prefix changes the runtime name; an explicit literal env overrides the
# unprefixed envFrom value and therefore is not a target-key binding.
rm -f "${STATE_DIR}/mcp.applied" "${STATE_DIR}/multi-consumer-restart.count"
: >"${LOG_FILE}"
if ! run_sync env TEST_RUNTIME_KEY=public-key TEST_MCP_DEPLOYMENTS=multiple-bindings \
  bash "${ROOT}/scripts/minikube/sync-auth-key.sh" --context fake --require-mcp --skip-gfs \
  >"${OUT_FILE}" 2>&1; then
  cat "${OUT_FILE}" >&2
  cat "${LOG_FILE}" >&2
  echo 'FAIL: multiple effective auth-key bindings were not proved' >&2
  exit 1
fi
assert_file_absent "${STATE_DIR}/multi-consumer-restart.count" 'unnecessary multi-binding restart'
assert_file_contains "${LOG_FILE}" '-c prefixed -- node -e .* -- AUTH_CLERUM_AUTH_JWT_PUBLIC_KEY' 'prefixed binding proof'
assert_file_contains "${LOG_FILE}" '-c direct -- node -e .* -- DIRECT_JWT_PUBLIC_KEY' 'direct binding proof'
assert_file_contains "${LOG_FILE}" '-c optional-kept -- node -e .* -- CLERUM_AUTH_JWT_PUBLIC_KEY' 'optional binding proof'
assert_file_contains "${LOG_FILE}" '-c self-expanded -- node -e .* -- CLERUM_AUTH_JWT_PUBLIC_KEY' 'self-expanded binding proof'
if grep -q -- '-c overridden --' "${LOG_FILE}"; then
  echo 'FAIL: an explicit literal env override was treated as a ConfigMap binding' >&2
  cat "${LOG_FILE}" >&2
  exit 1
fi
if grep -q -- '-c shadowed --' "${LOG_FILE}"; then
  echo 'FAIL: a later envFrom source that contains the key did not shadow the target binding' >&2
  cat "${LOG_FILE}" >&2
  exit 1
fi

# One stale binding makes the whole Deployment stale, but it is restarted only
# once and every binding is re-proved after rollout.
rm -f "${STATE_DIR}/mcp.applied" "${STATE_DIR}/multi-consumer-restart.count"
: >"${LOG_FILE}"
if ! run_sync env TEST_RUNTIME_KEY=public-key TEST_MCP_DEPLOYMENTS=multiple-bindings \
  TEST_STALE_BINDINGS='multi-consumer/direct/DIRECT_JWT_PUBLIC_KEY' \
  bash "${ROOT}/scripts/minikube/sync-auth-key.sh" --context fake --require-mcp --skip-gfs \
  >"${OUT_FILE}" 2>&1; then
  cat "${OUT_FILE}" >&2
  cat "${LOG_FILE}" >&2
  echo 'FAIL: multiple-binding Deployment did not converge after one rollout' >&2
  exit 1
fi
assert_file_equals "${STATE_DIR}/multi-consumer-restart.count" 1 'multi-binding restart count'
assert_file_equals <(grep -c 'rollout restart deployment/multi-consumer' "${LOG_FILE}") 1 'multi-binding rollout count'

# A Kubernetes-valid environment name that resembles a Node option must still
# reach the comparison script as data. It starts stale, triggers exactly one
# rollout, and can pass only after the fake runtime switches to the source key.
rm -f "${STATE_DIR}/mcp.applied" "${STATE_DIR}/option-consumer-restart.count"
: >"${LOG_FILE}"
if ! run_sync env TEST_RUNTIME_KEY=public-key TEST_MCP_DEPLOYMENTS=option-binding \
  TEST_STALE_BINDINGS='option-consumer/option-runtime/--version' \
  bash "${ROOT}/scripts/minikube/sync-auth-key.sh" --context fake --require-mcp --skip-gfs \
  >"${OUT_FILE}" 2>&1; then
  cat "${OUT_FILE}" >&2
  cat "${LOG_FILE}" >&2
  echo 'FAIL: option-like env binding did not converge after one rollout' >&2
  exit 1
fi
if [[ ! -f "${STATE_DIR}/option-consumer-restart.count" || \
      "$(cat "${STATE_DIR}/option-consumer-restart.count")" != 1 ]]; then
  echo 'FAIL: Node accepted an option-like env name without executing the stale-value probe' >&2
  cat "${LOG_FILE}" >&2
  exit 1
fi
assert_file_contains "${LOG_FILE}" '-c option-runtime -- node -e .* -- --version' 'option-like binding proof'

# A source rotation after consumer proof must invalidate the run before the
# final success message, even when the previous convergence marker was already
# written. This is the race the resourceVersion+key snapshot closes.
printf 'old-key' >"${STATE_DIR}/mcp.key"
rm -f "${STATE_DIR}/mcp.applied" "${STATE_DIR}/source-json-snapshot.count"
: >"${LOG_FILE}"
if TEST_ROTATE_ON_SOURCE_SNAPSHOT=3 run_sync env \
  TEST_RUNTIME_KEY=public-key TEST_MCP_DEPLOYMENTS=chatllm \
  bash "${ROOT}/scripts/minikube/sync-auth-key.sh" --context fake --require-mcp --skip-gfs \
  >"${OUT_FILE}" 2>&1; then
  cat "${OUT_FILE}" >&2
  echo 'FAIL: auth-key sync certified a source that rotated after consumer proof' >&2
  exit 1
fi
assert_file_contains "${OUT_FILE}" 'auth source rotated during convergence' 'final source rotation diagnostic'

# Preserve the remote fail-closed barriers used by evenfire-infra. A substring
# match is not authorization, and shared-profile bootstrap can never carry the
# remote capability.
: >"${LOG_FILE}"
if GFS_REMOTE_RECONCILE_AUTHORIZED=true ALLOWED_CONTEXTS=not-fake run_sync env \
  TEST_RUNTIME_KEY=public-key TEST_MCP_DEPLOYMENTS=none \
  bash "${ROOT}/scripts/minikube/sync-auth-key.sh" --context fake --require-mcp --skip-gfs \
  >"${OUT_FILE}" 2>&1; then
  echo 'FAIL: remote auth reconciliation accepted a non-exact context match' >&2
  exit 1
fi
assert_file_contains "${OUT_FILE}" 'remote auth-key convergence requires an explicit allowlisted context' 'remote allowlist diagnostic'

if GFS_REMOTE_RECONCILE_AUTHORIZED=true ALLOWED_CONTEXTS=fake run_sync env \
  TEST_RUNTIME_KEY=public-key TEST_MCP_DEPLOYMENTS=none \
  bash "${ROOT}/scripts/minikube/sync-auth-key.sh" --context fake --require-mcp --skip-gfs \
    --shared-profile-bootstrap >"${OUT_FILE}" 2>&1; then
  echo 'FAIL: shared-profile bootstrap accepted remote reconciliation authorization' >&2
  exit 1
fi
assert_file_contains "${OUT_FILE}" '--shared-profile-bootstrap cannot carry remote reconciliation authorization' 'shared-profile authorization diagnostic'

echo "PASS: auth-key convergence is durable, resumable, consumer-proven, and idempotent"
