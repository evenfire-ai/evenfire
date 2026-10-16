#!/usr/bin/env bash
# Lint: every mcp-host image, and the CI job that tests mcp-host, installs the
# font packages the chart and document renderers look for.
#
# Why: the renderers find their faces by file name (mcp-host/src/workflow/
# fonts.ts: PDF_FAMILY_PREFIXES, SCRIPT_FALLBACK_PREFIXES, FALLBACK_PREFIXES
# and the CJK collections), and the packages that ship those files are listed
# separately in each Dockerfile. Nothing else ties the two: an image that
# drops a package still builds and starts, and the faces it carried fall
# through to the next prefix or to none, so Arabic, Hebrew or Han text comes
# out in the wrong face or not at all, with no error.
#
# The packages, per package manager, and the faces they ship:
#   DejaVu Sans and Sans Mono      apk font-dejavu       apt fonts-dejavu-core
#   Noto Sans and its script faces apk font-noto         apt fonts-noto-core
#   Noto Sans Arabic               apk font-noto-arabic  (in fonts-noto-core)
#   Noto Sans Hebrew               apk font-noto-hebrew  (in fonts-noto-core)
#   Noto Sans CJK collections      apk font-noto-cjk     apt fonts-noto-cjk
# The further script faces (Devanagari, Thai, Ethiopic and the rest of
# MORE_SCRIPTS) are in Debian's fonts-noto-core. Alpine ships them as one
# package per script (font-noto-devanagari, font-noto-thai, ...), which the
# Alpine image does not install yet, so they are not required here; the
# renderer logs the scripts it has no face for.
#
# Only the final stage of a Dockerfile counts: fonts installed in a builder
# stage do not reach the image. Exempt a deliberate, reviewed case with a
# `# FONTS-OK: <reason>` comment anywhere in the final stage.
#
# Usage: check-dockerfile-fonts.sh [--workflow FILE] [DOCKERFILE...]
# With no arguments it checks mcp-host/Dockerfile* and
# .github/workflows/ci-public.yml.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

APK_FONTS="font-dejavu font-noto font-noto-cjk font-noto-arabic font-noto-hebrew"
APT_FONTS="fonts-dejavu-core fonts-noto-core fonts-noto-cjk"

workflow=""
dockerfiles=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --workflow)
      workflow="$2"
      shift 2
      ;;
    *)
      dockerfiles+=("$1")
      shift
      ;;
  esac
done
if [ "${#dockerfiles[@]}" -eq 0 ] && [ -z "$workflow" ]; then
  while IFS= read -r f; do dockerfiles+=("$f"); done < <(find mcp-host -maxdepth 1 -type f -name 'Dockerfile*' | sort)
  workflow=".github/workflows/ci-public.yml"
fi

violations=0
report() {
  echo "VIOLATION: $1" >&2
  violations=$((violations + 1))
}

for dockerfile in ${dockerfiles[@]+"${dockerfiles[@]}"}; do
  output="$(awk -v file="$dockerfile" -v apk_fonts="$APK_FONTS" -v apt_fonts="$APT_FONTS" '
    # Packages each install command of `cmd` names, added to installed[] by manager.
    function collect(cmd,   rest, list, cut, n, tok, i, mgr) {
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
        cut = match(list, /(&&|\|\||[;|])/)
        if (cut > 0) list = substr(list, 1, cut - 1)
        managers[mgr] = 1
        n = split(list, tok, /[ \t]+/)
        for (i = 1; i <= n; i++) {
          if (tok[i] == "" || substr(tok[i], 1, 1) == "-") continue
          sub(/=.*$/, "", tok[i])
          installed[mgr, tok[i]] = 1
        }
      }
    }

    function missing(mgr, wanted,   n, pkg, i, out) {
      n = split(wanted, pkg, " ")
      out = ""
      for (i = 1; i <= n; i++) {
        if (!((mgr, pkg[i]) in installed)) out = (out == "" ? pkg[i] : out " " pkg[i])
      }
      return out
    }

    {
      line = $0
      sub(/\r$/, "", line)
      stripped = line
      gsub(/^[ \t]+|[ \t]+$/, "", stripped)

      if (stripped ~ /^FROM[ \t]/) {
        # A new stage: what earlier stages installed does not reach the image.
        delete installed
        delete managers
        exempt = 0
        stage = NR
        buf = ""
        next
      }
      if (substr(stripped, 1, 1) == "#") {
        if (stripped ~ /FONTS-OK:/) exempt = 1
        next
      }
      buf = buf " " line
      if (line ~ /\\[ \t]*$/) {
        sub(/\\[ \t]*$/, " ", buf)
        next
      }
      if (buf ~ /FONTS-OK:/) exempt = 1
      collect(buf)
      buf = ""
    }

    END {
      if (exempt) exit
      if (!("apk" in managers) && !("apt" in managers)) {
        printf "%s:%d: the final stage installs no packages, so no fonts\n", file, stage
        exit
      }
      if ("apk" in managers) {
        gone = missing("apk", apk_fonts)
        if (gone != "") printf "%s:%d: the final stage does not install %s\n", file, stage, gone
      }
      if ("apt" in managers) {
        gone = missing("apt", apt_fonts)
        if (gone != "") printf "%s:%d: the final stage does not install %s\n", file, stage, gone
      }
    }
  ' "$dockerfile")"
  if [ -n "$output" ]; then
    while IFS= read -r v; do report "$v"; done <<<"$output"
  fi
done

if [ -n "$workflow" ]; then
  # The apt install of the job that runs the mcp-host tests: the one naming fonts.
  lines="$(grep -n 'apt-get install' "$workflow" | grep 'fonts-' || true)"
  if [ -z "$lines" ]; then
    report "$workflow: no apt-get install of the mcp-host fonts"
  else
    while IFS= read -r entry; do
      lineno="${entry%%:*}"
      gone=""
      for pkg in $APT_FONTS; do
        if ! grep -qE "(^|[[:space:]])${pkg}([[:space:]]|$)" <<<"${entry#*:}"; then
          gone="${gone:+$gone }$pkg"
        fi
      done
      [ -z "$gone" ] || report "$workflow:$lineno: the font install does not name $gone"
    done <<<"$lines"
  fi
fi

if [ "$violations" -ne 0 ]; then
  echo "FAIL: $violations font package list(s) miss a package the renderers look for." >&2
  echo "      Install them in the final stage, or annotate it with '# FONTS-OK: <reason>'." >&2
  exit 1
fi
echo "PASS: every mcp-host image and the mcp-host CI job install the renderers' font packages."
