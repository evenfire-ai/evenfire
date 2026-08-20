#!/usr/bin/env bash
# Public/private boundary check for the local Minikube contract.
set -euo pipefail
set +x
set +u

ROOT="${T2_PUBLIC_ROOT:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)}"
BASE="$T2_PUBLIC_BASE_REF"
if [ -z "$BASE" ]; then BASE=origin/dev; fi
TMP_ROOT="$TMPDIR"
if [ -z "$TMP_ROOT" ]; then TMP_ROOT=/tmp; fi
set -u
tmp="$(mktemp "$TMP_ROOT/evenfire-public-boundary.XXXXXX")"
cleanup() { rm -f "$tmp"; }
trap cleanup EXIT

if ! git -C "$ROOT" rev-parse --verify --quiet "$BASE^{commit}" >/dev/null 2>&1; then
  printf 'PUBLIC_BOUNDARY_BASE_UNRESOLVED: %s\n' "$BASE" >&2
  exit 1
fi

{
  git -C "$ROOT" diff --no-color --unified=0 "$BASE...HEAD"
  git -C "$ROOT" diff --no-color --unified=0
  git -C "$ROOT" diff --cached --no-color --unified=0
} >"$tmp"

git -C "$ROOT" ls-files --others --exclude-standard -z |
while IFS= read -r -d '' path; do
  [ -f "$ROOT/$path" ] || continue
  printf '+++ b/%s\n' "$path"
  sed 's/^/+/' "$ROOT/$path"
done >>"$tmp"

python3 - "$tmp" <<'PY'
from pathlib import Path
import re
import sys

diff = Path(sys.argv[1]).read_text(errors="replace")
bad = []
current = ""
safe_source_paths = {
    "deploy/scripts/lib/gfs-credential-rollout.sh",
    "deploy/scripts/lib/gfs-credential-secret.sh",
    "deploy/scripts/reconcile-gfs-deploy-credentials.sh",
}
for line in diff.splitlines():
    if line.startswith("+++ b/"):
        current = line[6:]
        path = current.lower()
        if (
            path == ".env"
            or path.startswith(".env.")
            or path.endswith((".pem", ".key", ".p12", ".pfx", ".log"))
            or path.endswith(("/kubeconfig", "/config"))
            or (
                any(token in path for token in ("id_rsa", "id_ed25519", "credential", "wallet", "keystore"))
                and path not in safe_source_paths
            )
            or "screenshot" in path
            or "e2e-artifacts" in path
        ):
            if not (path.endswith(".env.example") or path.endswith(".env.test")):
                bad.append((current, "sensitive file name"))
        continue
    if not line.startswith("+") or line.startswith("+++"):
        continue
    value = line[1:]
    patterns = (
        (r"postgres(?:ql)?://[^\s\"'<>:]+:[^\s\"'<>@]+@", "credentialed PostgreSQL URL"),
        (r"(?i)postgres(?:ql)?://(?:[^\s\"'<>@]+@)?(?:localhost|127\.0\.0\.1|10\.[0-9.]+|192\.168\.[0-9.]+|172\.(?:1[6-9]|2[0-9]|3[01])\.[0-9.]+|[A-Za-z0-9.-]*(?:private|internal|local|cluster|postgres)[A-Za-z0-9.-]*)(?::[0-9]+)?(?:/|$)", "private PostgreSQL URL"),
        (r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----", "private key"),
        (r"(?i)\bBearer\s+[A-Za-z0-9._~-]{24,}", "bearer token"),
        (r"(?i)\b(?:api[_-]?key|password|secret|token|private[_-]?key)\s*[:=]\s*[\"']?(?![$<{`]|os\.environ|process\.env|secret_field|quote\()[^\s\"']{8,}", "credential assignment"),
        (r"https?://(?:127\.0\.0\.1|localhost|10\.[0-9.]+|192\.168\.[0-9.]+|172\.(?:1[6-9]|2[0-9]|3[01])\.[0-9.]+)", "private runtime URL"),
    )
    for expression, reason in patterns:
        if re.search(expression, value):
            bad.append((current or "<unknown>", reason))
            break

if bad:
    print("PUBLIC_BOUNDARY_REJECTED", file=sys.stderr)
    for path, reason in bad:
        print(f"- {path}: {reason}", file=sys.stderr)
    raise SystemExit(1)
print("PUBLIC_BOUNDARY_PASS")
PY
