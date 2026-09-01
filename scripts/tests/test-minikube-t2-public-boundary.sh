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
  # A repository-local binary cannot be made line-safe by BSD sed. Keep the
  # path header (so sensitive filenames are still rejected), but skip binary
  # contents instead of allowing the scanner itself to fail by locale.
  if ! LC_ALL=C grep -Iq . "$ROOT/$path"; then
    continue
  fi
  sed 's/^/+/' "$ROOT/$path"
done >>"$tmp"

python3 - "$tmp" <<'PY'
from pathlib import Path
import ipaddress
import re
import sys
from urllib.parse import urlsplit

diff = Path(sys.argv[1]).read_text(errors="replace")
bad = []
current = ""
safe_source_paths = {
    "control-api/src/routes/admin/communicationchannelcredentials.ts",
    "control-api/test/routes.admincommunicationchannelcredentials.test.ts",
    # Public Control UI source and documentation may use the domain term
    # "credential" without containing materialized secret data.
    "control-ui/components/llmcredentialfields/index.tsx",
    "control-ui/components/llmcredentialfields/types.ts",
    "control-ui/components/__tests__/llmcredentialfields.test.tsx",
    "docs/agent-models-credentials-ux.md",
    "deploy/scripts/lib/gfs-credential-rollout.sh",
    "deploy/scripts/lib/gfs-credential-secret.sh",
    "deploy/scripts/reconcile-gfs-deploy-credentials.sh",
}
source_fixture_path = re.compile(
    r"(?i)(?:^|/)(?:tests?|__tests__)/|(?:\.test|\.spec|\.integration\.test)\.(?:cjs|cts|js|jsx|mjs|mts|ts|tsx)$"
)
safe_fixture_literals = {
    "body-user-token",
    "consumed-member-token",
    "correct-password",
    "created-token",
    "current-password",
    "flow-token",
    "google-session",
    "google-session-jwt",
    "inert-until-activation",
    "invitation-link-token",
    "invitation-token",
    "live-secret-capability",
    "member-registration-flow-token",
    "member-setup-token",
    "must-never-leave-control-api",
    "must-never-reach-browser-route",
    "must-never-serialize",
    "old-password",
    "one-use-flow",
    "password-reset-flow",
    "password-reset-token",
    "password-session",
    "replacement-token",
    "rotated-session",
    "rpc-token",
    "session-token",
    "single-use-token",
    "source-token",
    "stale-token",
    "successor",
    "switched-token",
    "team-b-token",
    "unexpected-token",
    "user123!",
    "v2-token",
    "valid-password",
    "wrong-password",
}
contract_control_values = {
    "private PostgreSQL URL": (
        "postgresql://postgres@127.0.0.1/postgres",
        "postgres://secret@internal/var/run/service.sock",
        "DATABASE_URL=%s://private-host:5432/db",
        "DATABASE_URL=postgresql://db_user:prod_password@127.0.0.1/postgres",
    ),
    "credentialed PostgreSQL URL": (
        "DATABASE_URL=postgresql://db_user:prod_password@127.0.0.1/postgres",
    ),
    "private runtime URL": (
        "PUBLIC_CALLBACK=http://127.0.0.1:18443/status",
    ),
    "credential assignment": (
        "token: 'replacement-token'",
        "password: 'valid-password'",
        'password: "ProdCustomerPassword123"',
    ),
    "bearer token": (
        "Authorization: Bearer abcdefghijklmnopqrstuvwxyz1234567890",
    ),
    "private key": (
        "-----BEGIN PRIVATE KEY-----",
    ),
}

def is_source_fixture(path: str) -> bool:
    lowered = path.lower()
    return bool(source_fixture_path.search(lowered))

def is_credentialed_postgres_url(text: str) -> bool:
    return bool(re.search(r"(?i)postgres(?:ql)?://[^\s\"'<>:]+:[^\s\"'<>@]+@", text))

def is_synthetic_postgres_fixture_url(text: str) -> bool:
    try:
        parsed = urlsplit(text)
        host = parsed.hostname
    except ValueError:
        return False
    if parsed.scheme.lower() not in {"postgres", "postgresql"} or not host:
        return False
    if parsed.password is not None:
        return False
    if host.lower() == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False

def safe_contract_control_value(path: str, reason: str, value: str) -> bool:
    if path not in {
        "scripts/tests/test-minikube-t2-contract.sh",
        "scripts/tests/test-minikube-t2-public-boundary.sh",
    }:
        return False
    return any(control in value for control in contract_control_values.get(reason, ()))

def safe_source_fixture_value(path: str, reason: str, value: str, match: re.Match[str]) -> bool:
    if not is_source_fixture(path):
        return False
    if reason in {"credentialed PostgreSQL URL", "private key", "bearer token"}:
        return False
    if reason == "private runtime URL":
        # Loopback/private URLs in source fixtures describe synthetic test
        # topology. The same literal in a materialized public artifact remains
        # rejected because only recognized source/test paths reach this branch.
        return True
    if reason == "private PostgreSQL URL":
        matched_url = match.group(0)
        if is_credentialed_postgres_url(matched_url):
            return False
        return is_synthetic_postgres_fixture_url(matched_url)
    if reason == "credential assignment":
        literal = match.group(1) if match.lastindex else ""
        return literal in safe_fixture_literals
    return False

for line in diff.splitlines():
    if line.startswith("+++ b/"):
        current = line[6:]
        path = current.lower()
        path_parts = path.split("/")
        if (
            path == ".env"
            or path.startswith(".env.")
            or path.endswith((".pem", ".key", ".p12", ".pfx", ".log"))
            or path.endswith(("/kubeconfig", "/config"))
            or (
                (
                    any(token in path for token in ("id_rsa", "id_ed25519"))
                    or any(part in {"credential", "credentials", "wallet", "keystore"} for part in path_parts)
                )
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
    # The boundary is intended to catch materialized credentials, not source
    # identifiers or test fixtures.  The old expression accepted an optional
    # quote and an arbitrary unquoted expression, so ordinary code such as
    # ordinary implementation expressions were reported as public
    # credentials. Keep literal/YAML-style values under
    # inspection, and handle shell-style uppercase assignments separately.
    patterns = (
        (r"postgres(?:ql)?://[^\s\"'<>:]+:[^\s\"'<>@]+@", "credentialed PostgreSQL URL"),
        (r"(?i)postgres(?:ql)?://(?:[^\s\"'<>@]+@)?(?:localhost|127(?:\.[0-9]{1,3}){3}|\[::1\]|10\.[0-9.]+|192\.168\.[0-9.]+|172\.(?:1[6-9]|2[0-9]|3[01])\.[0-9.]+|[A-Za-z0-9.-]*(?:private|internal|local|cluster|postgres)[A-Za-z0-9.-]*)(?::[0-9]+)?(?:/|$)", "private PostgreSQL URL"),
        (r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----", "private key"),
        (r"(?i)\bBearer\s+[A-Za-z0-9._~-]{24,}", "bearer token"),
        (r"(?i)\b(?:api[_-]?key|password|secret|token|private[_-]?key)\s*[:=]\s*[\"']([^\"'\r\n]{8,})[\"']", "credential assignment"),
        (r"\b(?:API[_-]?KEY|PASSWORD|SECRET|TOKEN|PRIVATE[_-]?KEY)\s*=\s*([A-Za-z0-9_./:+@=-]{8,})", "credential assignment"),
        (r"https?://(?:127\.0\.0\.1|localhost|10\.[0-9.]+|192\.168\.[0-9.]+|172\.(?:1[6-9]|2[0-9]|3[01])\.[0-9.]*)(?::[0-9]{2,5})(?:/|$)", "private runtime URL"),
    )
    safe_fixture = re.compile(
        r"(?i)(?:credential|synthetic|discard|must[-_]?not|upstream[-_]?token|"
        r"revision|fixture|placeholder|dummy|fake|example|changeme|local[-_]?only|"
        r"test[-_]?token)"
    )
    line_rejected = False
    for expression, reason in patterns:
        for match in re.finditer(expression, value):
            if reason == "private key" and "evidence-scanner" in current:
                continue
            if (
                reason == "credential assignment"
                and match.group(1)
                and (safe_fixture.search(match.group(1)) or "$" in match.group(1))
            ):
                continue
            if safe_source_fixture_value(current, reason, value, match):
                continue
            if safe_contract_control_value(current, reason, value):
                continue
            bad.append((current or "<unknown>", reason))
            line_rejected = True
            break
        if line_rejected:
            break

if bad:
    print("PUBLIC_BOUNDARY_REJECTED", file=sys.stderr)
    for path, reason in bad:
        print(f"- {path}: {reason}", file=sys.stderr)
    raise SystemExit(1)
print("PUBLIC_BOUNDARY_PASS")
PY
