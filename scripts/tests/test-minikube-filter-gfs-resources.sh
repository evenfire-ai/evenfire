#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
FILTER="$ROOT/scripts/minikube/filter-gfs-resources.py"

python3 - "$FILTER" <<'PY'
import subprocess
import sys

filter_path = sys.argv[1]
source = """apiVersion: v1
kind: ConfigMap
metadata:
  name: keep
  namespace: default
data:
  embedded.yaml: |
    ---
    kind: Namespace
    metadata:
      name: gfs
---
apiVersion: example/v1
kind: Example
metadata:
  name: keep-example
spec:
  name: gfs
---
apiVersion: v1
kind: Namespace
metadata:
  name: gfs
"""

result = subprocess.run(
    [sys.executable, filter_path],
    input=source,
    text=True,
    capture_output=True,
    check=False,
)
if result.returncode != 0:
    raise SystemExit(f"filter failed: {result.stderr}")

output = result.stdout
assert "kind: ConfigMap" in output
assert "    ---\n    kind: Namespace" in output
assert "kind: Example" in output
assert "spec:\n  name: gfs" in output
assert "kind: Namespace\nmetadata:\n  name: gfs" not in output

empty = subprocess.run(
    [sys.executable, filter_path],
    input="apiVersion: v1\nkind: Namespace\nmetadata:\n  name: gfs\n",
    text=True,
    capture_output=True,
    check=False,
)
assert empty.returncode == 0
assert empty.stdout == ""
PY

printf 'PASS: GFS filter preserves block scalars, scopes metadata, and handles empty output\n'
