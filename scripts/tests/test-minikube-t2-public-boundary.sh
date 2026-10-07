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

python3 - "$tmp" "$ROOT" <<'PY'
from pathlib import Path
import re
import shlex
import sys

diff = Path(sys.argv[1]).read_text(errors="replace")
bad = []
current = ""
root = Path(sys.argv[2]).resolve()


def public_capture_source(relative):
    # Test/config source may describe screenshots. This never exempts its added
    # contents from the credential/private-URL checks below.
    candidate = Path(relative)
    if not re.search(r"\.(?:spec|test|config)\.(?:ts|tsx|js|mjs|cjs)$", candidate.name, re.I):
        return False
    if not any(part in {"src", "test", "tests"} for part in candidate.parts):
        return False
    filename = root / candidate
    try:
        if filename.is_symlink() or not filename.resolve().is_relative_to(root):
            return False
        raw = filename.read_bytes()
        if len(raw) > 1024 * 1024 or any(byte < 32 and byte not in {9, 10, 13} for byte in raw):
            return False
        text = raw.decode("utf-8")
    except (OSError, UnicodeError):
        return False
    return bool(re.search(r"(?m)^\s*(?:import\s|export\s|(?:const|let|var|type|interface|class|function)\s|(?:test|describe)\s*[.(])", text))

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
for line in diff.splitlines():
    changed_path = None
    if line.startswith("diff --git "):
        try:
            headers = shlex.split(line[len("diff --git "):])
        except ValueError:
            bad.append(("<diff>", "malformed path header"))
            continue
        if len(headers) != 2 or not headers[1].startswith("b/"):
            bad.append(("<diff>", "malformed path header"))
            continue
        changed_path = headers[1][2:]
    elif line.startswith("+++ b/"):
        changed_path = line[6:]
    if changed_path is not None:
        current = changed_path
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
            or ("screenshot" in path and not public_capture_source(current))
            or "e2e-artifacts" in path
        ):
            if not (path.endswith(".env.example") or path.endswith(".env.test")):
                finding = (current, "sensitive file name")
                if finding not in bad:
                    bad.append(finding)
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
        (r"(?i)postgres(?:ql)?://(?:[^\s\"'<>@]+@)?(?:localhost|127\.0\.0\.1|10\.[0-9.]+|192\.168\.[0-9.]+|172\.(?:1[6-9]|2[0-9]|3[01])\.[0-9.]+|[A-Za-z0-9.-]*(?:private|internal|local|cluster|postgres)[A-Za-z0-9.-]*)(?::[0-9]+)?(?:/|$)", "private PostgreSQL URL"),
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
    # The logger's redaction marker is not a credential; logger tests assert it
    # under secret-named keys. The exemption applies in any file, and only when
    # the whole value is the marker; a value that merely contains it is flagged.
    redaction_marker = re.compile(r"(?i)\[redacted\]")
    code_after_literal = re.compile(r"\s*[,)\]};+]")

    def open_quote_before(text, end):
        """The quote of the string literal still open at `end`, or None."""
        open_quote = None
        escaped = False
        for char in text[:end]:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif open_quote is None and char in "\"'":
                open_quote = char
            elif char == open_quote:
                open_quote = None
        return open_quote

    # Every match on the line is checked: an exempt first match must not hide a
    # real value later on the same line.
    for expression, reason in patterns:
        flagged = False
        compiled = re.compile(expression)
        position = 0
        while True:
            match = compiled.search(value, position)
            if match is None:
                break
            position = match.end()
            if reason == "private key" and "evidence-scanner" in current:
                continue
            # A key inside a string literal ending in `=` or `:` (for example
            # `label: 'password='`) is data: the quote after it closes that
            # literal, and the captured text is code up to the next literal.
            # Resume just after the closing quote, so a real assignment later
            # on the line is still read.
            if (
                reason == "credential assignment"
                and match.group(1)
                and value[match.start(1) - 1] in "\"'"
                and open_quote_before(value, match.start()) == value[match.start(1) - 1]
                and code_after_literal.match(match.group(1))
            ):
                position = match.start(1)
                continue
            if (
                reason == "credential assignment"
                and match.group(1)
                and (
                    safe_fixture.search(match.group(1))
                    or "$" in match.group(1)
                    or redaction_marker.fullmatch(match.group(1))
                )
            ):
                continue
            if (
                reason == "private runtime URL"
                and (
                    "/test/" in f"/{current.lower()}"
                    or "/tests/" in f"/{current.lower()}"
                    or current.lower().startswith("scripts/tests/")
                    or current.lower().endswith((".test.ts", ".test.tsx", ".spec.ts", ".spec.tsx"))
                )
            ):
                continue
            flagged = True
            break
        if flagged:
            bad.append((current or "<unknown>", reason))
            break

if bad:
    print("PUBLIC_BOUNDARY_REJECTED", file=sys.stderr)
    for path, reason in bad:
        print(f"- {path}: {reason}", file=sys.stderr)
    raise SystemExit(1)
print("PUBLIC_BOUNDARY_PASS")
PY
