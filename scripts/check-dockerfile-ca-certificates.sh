#!/usr/bin/env bash
# Lint: any image that installs a TLS-using system tool must also install a CA
# bundle, in the same package list.
#
# Why: `node:*-slim` installs ca-certificates to fetch Node, then purges it with
# `apt-get purge --auto-remove`, leaving /etc/ssl/certs empty. `--no-install-
# recommends` then stops apt from pulling it back in as a recommendation of
# git/curl/wget. The result is an image whose shipped tools cannot verify any
# certificate, while Node's own fetch keeps working (Node bundles its own CA
# store and never consults /etc/ssl/certs). That asymmetry makes the image look
# healthy on every normal code path and only break for tools the agent invokes,
# and the failure surfaces as `curl` exit 000 / git "CAfile: none", which reads
# like an egress problem rather than a missing bundle.
#
# The rule is deliberately about the declaration, not the base image: bases
# differ and get re-pinned, so an image that ships git/curl/wget states its CA
# dependency explicitly instead of inheriting it by luck. Re-declaring it on a
# base that already has it is a no-op layer.
#
# Exempt a deliberate, reviewed case with a `# CA-CERTS-OK: <reason>` comment
# anywhere in the same RUN instruction.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

violations=0

while IFS= read -r dockerfile; do
  output="$(awk -v file="$dockerfile" '
    # Packages whose whole job is to talk TLS to the outside world.
    BEGIN {
      split("git curl wget", tls_tools, " ")
    }

    # Report every TLS tool installed without ca-certificates alongside it.
    function check(cmd, lineno,   mgr, rest, list, cut, n, tok, i, j, has_ca, found, seen) {
      has_ca = 0
      found = ""
      # A single RUN can chain several installs; walk them all.
      rest = cmd
      while (1) {
        if (match(rest, /apt(-get)?[ \t]+(-[^ \t]+[ \t]+)*install/)) {
          mgr = "apt"
        } else if (match(rest, /apk[ \t]+add/)) {
          mgr = "apk"
        } else {
          break
        }
        list = substr(rest, RSTART + RLENGTH)
        rest = list
        # A package list ends at the next shell operator.
        cut = match(list, /(&&|\|\||[;|])/)
        if (cut > 0) list = substr(list, 1, cut - 1)

        n = split(list, tok, /[ \t]+/)
        for (i = 1; i <= n; i++) {
          if (tok[i] == "" || substr(tok[i], 1, 1) == "-") continue
          sub(/=.*$/, "", tok[i])   # strip pinned versions: nodejs=24.16.0-1
          if (tok[i] == "ca-certificates" || tok[i] == "ca-certificates-bundle") {
            has_ca = 1
            continue
          }
          for (j in tls_tools) {
            if (tok[i] == tls_tools[j] && !(tok[i] in seen)) {
              seen[tok[i]] = 1
              found = (found == "" ? tok[i] : found " " tok[i])
            }
          }
        }
      }
      if (found != "" && !has_ca) {
        printf "%s:%d: installs %s without ca-certificates\n", file, lineno, found
      }
    }

    {
      line = $0
      sub(/\r$/, "", line)
      stripped = line
      gsub(/^[ \t]+|[ \t]+$/, "", stripped)

      # Comments may sit between continuation lines; keep the exemption marker.
      if (substr(stripped, 1, 1) == "#") {
        if (stripped ~ /CA-CERTS-OK:/) exempt = 1
        next
      }

      if (buf == "") start = NR
      buf = buf " " line

      if (line ~ /\\[ \t]*$/) {
        sub(/\\[ \t]*$/, " ", buf)
        next
      }

      if (buf ~ /CA-CERTS-OK:/) exempt = 1
      if (!exempt) check(buf, start)
      buf = ""
      exempt = 0
      delete seen
    }
  ' "$dockerfile")"

  if [ -n "$output" ]; then
    while IFS= read -r v; do
      echo "VIOLATION: $v" >&2
      violations=$((violations + 1))
    done <<<"$output"
  fi
done < <(find . -type f -name 'Dockerfile*' \
           -not -path '*/node_modules/*' -not -path './.git/*' | sort)

if [ "$violations" -ne 0 ]; then
  echo "FAIL: $violations image(s) ship a TLS-using tool with no CA bundle." >&2
  echo "      Add ca-certificates to the same package list, or annotate the RUN with '# CA-CERTS-OK: <reason>'." >&2
  exit 1
fi
echo "PASS: every image shipping git/curl/wget also installs a CA bundle."
