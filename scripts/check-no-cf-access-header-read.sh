#!/usr/bin/env bash
# Lint: no application reads Cloudflare Access identity headers (Cf-Access-*)
# without an explicit, reviewed exemption. Cloudflare-injected headers are
# forgeable unless the assertion JWT is verified (spec §9.1, HIGH-3).
#
# Exempt a deliberate, reviewed read with a trailing `// CF-ACCESS-OK: <PR#>`
# comment on the SAME line as the read (the lint only inspects each matching
# line, not its neighbors).
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

trees=(control-ui control-api profile-ui external-rest-api rpc-proxy)
pattern='[Cc]f-[Aa]ccess-'
violations=0

for t in "${trees[@]}"; do
  [ -d "$t/src" ] || continue
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    if printf '%s' "$line" | grep -q 'CF-ACCESS-OK:'; then
      continue
    fi
    echo "VIOLATION: $line" >&2
    violations=$((violations + 1))
  done < <(grep -rnE "$pattern" "$t/src" \
             --include='*.ts' --include='*.tsx' --include='*.js' \
             --include='*.jsx' --include='*.mts' --include='*.cts' 2>/dev/null || true)
done

if [ "$violations" -ne 0 ]; then
  echo "FAIL: $violations unannotated Cf-Access-* header read(s)." >&2
  echo "      Verify the assertion JWT per spec §9.1, then annotate the same line with a trailing '// CF-ACCESS-OK: <PR#>' comment." >&2
  exit 1
fi
echo "PASS: no unannotated Cf-Access-* header reads."
