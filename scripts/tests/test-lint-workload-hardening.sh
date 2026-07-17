#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT

write_workload() {
  local path="$1"
  local readonly="$2"
  cat >"${path}" <<YAML
apiVersion: apps/v1
kind: Deployment
metadata:
  name: test-app
  namespace: test-ns
spec:
  template:
    spec:
      automountServiceAccountToken: false
      securityContext:
        runAsNonRoot: true
        seccompProfile:
          type: RuntimeDefault
      containers:
        - name: app
          image: example/app:test
          securityContext:
            allowPrivilegeEscalation: false
            capabilities:
              drop:
                - ALL
            readOnlyRootFilesystem: ${readonly}
            runAsNonRoot: true
YAML
}

write_nginx_workload() {
  local path="$1"
  local config_mode="$2"
  local include_tmp_mount="${3:-true}"
  local nginx_conf
  if [[ "${config_mode}" == "tmp-paths" ]]; then
    nginx_conf='    pid /tmp/nginx.pid;
    events {}
    http {
      client_body_temp_path /tmp/client_temp;
      proxy_temp_path /tmp/proxy_temp;
      fastcgi_temp_path /tmp/fastcgi_temp;
      uwsgi_temp_path /tmp/uwsgi_temp;
      scgi_temp_path /tmp/scgi_temp;
      server {
        listen 8080;
      }
    }'
  else
    nginx_conf='    events {}
    http {
      server {
        listen 8080;
      }
    }'
  fi

  local tmp_mount=""
  local tmp_volume=""
  if [[ "${include_tmp_mount}" == "true" ]]; then
    tmp_mount='            - name: nginx-tmp
              mountPath: /tmp'
    tmp_volume='        - name: nginx-tmp
          emptyDir: {}'
  fi

  cat >"${path}" <<YAML
apiVersion: v1
kind: ConfigMap
metadata:
  name: test-nginx-config
  namespace: test-ns
data:
  nginx.conf: |
${nginx_conf}
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: test-nginx
  namespace: test-ns
spec:
  template:
    spec:
      automountServiceAccountToken: false
      securityContext:
        runAsNonRoot: true
        seccompProfile:
          type: RuntimeDefault
      containers:
        - name: nginx
          image: nginx:1.30.1-alpine
          securityContext:
            allowPrivilegeEscalation: false
            capabilities:
              drop:
                - ALL
            readOnlyRootFilesystem: true
            runAsNonRoot: true
          volumeMounts:
            - name: nginx-config
              mountPath: /etc/nginx/nginx.conf
              subPath: nginx.conf
${tmp_mount}
      volumes:
        - name: nginx-config
          configMap:
            name: test-nginx-config
${tmp_volume}
YAML
}

write_exceptions() {
  local path="$1"
  local body="$2"
  cat >"${path}" <<YAML
exceptions:
${body}
YAML
}

run_lint() {
  bash "${ROOT}/deploy/scripts/lint-workload-hardening.sh" --rendered "$1" --exceptions "$2"
}

write_exceptions "${TMP_DIR}/empty.yaml" ""
write_workload "${TMP_DIR}/safe.yaml" true
run_lint "${TMP_DIR}/safe.yaml" "${TMP_DIR}/empty.yaml" >/dev/null
echo "PASS: restricted workload is accepted"

write_workload "${TMP_DIR}/writable-root.yaml" false
if run_lint "${TMP_DIR}/writable-root.yaml" "${TMP_DIR}/empty.yaml" >/tmp/lint-workload-root.out 2>&1; then
  echo "FAIL: writable root should fail without exception" >&2
  exit 1
fi
grep -q "readOnlyRootFilesystem" /tmp/lint-workload-root.out
echo "PASS: writable root without exception is rejected"

write_exceptions "${TMP_DIR}/writable-exception.yaml" '  - workload: test-ns/test-app
    allowWritableRootFilesystem:
      - app
    reason: "runtime image needs writable-root validation"'
run_lint "${TMP_DIR}/writable-root.yaml" "${TMP_DIR}/writable-exception.yaml" >/dev/null
echo "PASS: writable-root exception is accepted"

write_nginx_workload "${TMP_DIR}/nginx-safe.yaml" tmp-paths
run_lint "${TMP_DIR}/nginx-safe.yaml" "${TMP_DIR}/empty.yaml" >/dev/null
echo "PASS: read-only nginx with writable runtime paths is accepted"

write_nginx_workload "${TMP_DIR}/nginx-missing-runtime-paths.yaml" missing-paths
if run_lint "${TMP_DIR}/nginx-missing-runtime-paths.yaml" "${TMP_DIR}/empty.yaml" >/tmp/lint-workload-nginx-runtime.out 2>&1; then
  echo "FAIL: read-only nginx without /tmp runtime directives should fail" >&2
  exit 1
fi
grep -q "runtime paths under /tmp" /tmp/lint-workload-nginx-runtime.out
echo "PASS: read-only nginx without /tmp runtime directives is rejected"

write_nginx_workload "${TMP_DIR}/nginx-missing-tmp-mount.yaml" tmp-paths false
if run_lint "${TMP_DIR}/nginx-missing-tmp-mount.yaml" "${TMP_DIR}/empty.yaml" >/tmp/lint-workload-nginx-tmp.out 2>&1; then
  echo "FAIL: read-only nginx without writable /tmp should fail" >&2
  exit 1
fi
grep -q "does not mount /tmp from emptyDir" /tmp/lint-workload-nginx-tmp.out
echo "PASS: read-only nginx without writable /tmp is rejected"
