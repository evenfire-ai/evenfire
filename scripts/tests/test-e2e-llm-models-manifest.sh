#!/usr/bin/env bash
# Drift guard for scripts/e2e/e2e-llm-models.txt, the provider/model pairs the
# e2e seed profile enables (scripts/e2e/llm-model-ensure.sh). A pair an E2E
# spec, lane or fixture uses but the manifest omits gets a 403 on a fresh
# install, where the allowlist holds only what the catalog sync enabled.
#
# Hermetic: it reads files only.
#
# What it reads, in control-ui/e2e, desktop-app/test/e2e*, tests/e2e,
# scripts/e2e and scripts/minikube (no node_modules), and only these forms, so
# a prose mention or an import path never counts:
#   P1 one line   provider: 'zai', model: 'glm-4.7'   (also name:, and JSON
#                 "provider": "x", "name": "y")
#   P2 two lines  provider: zai   then within 2 lines   model: glm-4.7
#                 YAML, or a JS/TS/JSON object split over lines
#                 (provider: 'zai',  /  model: 'glm-4.7',). Literal values
#                 only; ${VAR} and expressions are skipped
#   P3 defaults   ${X_PROVIDER:-zai}  and  ${X_MODEL_NAME:-glm-4.7};
#                 xProvider ?? 'zai' / process.env.X_PROVIDER || 'zai'  and
#                 xModel ?? 'glm-4.7' / process.env.X_MODEL_NAME || 'glm-4.7'
# P1/P2 pairs must be in the manifest as written. A P3 model default must be in
# the manifest under one of the providers its file names (P1-P3), or under any
# provider when the file names none.
#
# Provider literals count only when they are a provider of
# mcp-host/src/llm/registryCore.ts and not a subscription provider (those are
# served from their own catalogs, not llm_allowed_models). Not read: models
# chosen by a ternary or spread over several lines of code; list those in the
# manifest by hand.
#
# Usage: test-e2e-llm-models-manifest.sh [--manifest <file>] [--root <dir>]
set -u

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SELF="${REPO_ROOT}/scripts/tests/test-e2e-llm-models-manifest.sh"
MANIFEST="${REPO_ROOT}/scripts/e2e/e2e-llm-models.txt"
SCAN_ROOT="$REPO_ROOT"
SELF_TEST=true
while [ "$#" -gt 0 ]; do
  case "$1" in
    --manifest) MANIFEST="$2"; SELF_TEST=false; shift 2 ;;
    --root) SCAN_ROOT="$2"; SELF_TEST=false; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
REGISTRY="${REPO_ROOT}/mcp-host/src/llm/registryCore.ts"
SCAN_DIRS=(control-ui/e2e desktop-app/test/e2e desktop-app/test/e2e-playwright tests/e2e scripts/e2e scripts/minikube)

# Literals that are not a dependency on the seeded allowlist, each with why.
# Format: <file relative to the repo> <provider/model>
IGNORED_PAIRS='
scripts/e2e/image-capabilities-fixture.mjs zai/glm-5.3-flash
scripts/e2e/e2e-hcc-readiness-bootstrap.sh openai/e2e-readiness
tests/e2e/fixtures/custom-workflow-coordinator/index.js openai/gpt-4o-mini
'
# - image-capabilities-fixture.mjs edits the discovered glm-5.3 rows through
#   the admin API and restores them afterwards, and refuses to run until the
#   catalog has discovered them; pre-seeding them would change what it
#   restores. Its run-scoped model is created and deleted, which leaves a
#   tombstone for a pair no catalog lists.
# - e2e-hcc-readiness-bootstrap.sh applies placeholder Hosts that only prove
#   controller readiness and never run a model turn.
# - custom-workflow-coordinator/index.js names gpt-4o-mini only inside
#   probeForbiddenWrcCapabilities, which expects WRC to refuse the request
#   (403/422) whether or not the model is allowlisted.

FAIL=0
pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1"; FAIL=1; }

known_providers() {
  grep -oE "^  '?[a-z0-9-]+'?: \{" "$REGISTRY" | tr -d " {:'" | grep -v -- '-subscription$'
}

# Prints one record per finding, tab-separated:
#   PAIR <file:line> <provider> <model>
#   PROV <file> <provider>
#   MODEL <file:line> <model>
extract() {
  local root="$1" providers files=()
  providers="$(known_providers | tr '\n' ' ')"
  local d
  for d in "${SCAN_DIRS[@]}"; do
    [ -d "$root/$d" ] || continue
    while IFS= read -r f; do files+=("$f"); done < <(
      find "$root/$d" -type d -name node_modules -prune -o -type f \
        \( -name '*.ts' -o -name '*.tsx' -o -name '*.js' -o -name '*.mjs' -o -name '*.cjs' \
           -o -name '*.sh' -o -name '*.yaml' -o -name '*.yml' -o -name '*.json' \) -print | sort)
  done
  [ "${#files[@]}" -gt 0 ] || return 0
  awk -v providers="$providers" -v root="$root/" '
    BEGIN { n = split(providers, list, " "); for (i = 1; i <= n; i++) known[list[i]] = 1 }
    FNR == 1 { pending_p = ""; pending_left = 0; file = FILENAME; sub("^" root, "", file) }
    function unq(v) { gsub(/^[ \t"\047]+|[ \t"\047,]+$/, "", v); return v }
    function emit_pair(p, m) { if (p in known) printf "PAIR\t%s:%d\t%s\t%s\n", file, FNR, p, m }
    function emit_prov(p)    { if (p in known) printf "PROV\t%s\t%s\n", file, p }
    function emit_model(m)   { printf "MODEL\t%s:%d\t%s\n", file, FNR, m }
    {
      line = $0
      # P1: provider and model on one line.
      rest = line
      while (match(rest, /["\047]?provider["\047]?[ \t]*:[ \t]*["\047][A-Za-z0-9._-]+["\047][ \t]*,[ \t]*["\047]?(model|name)["\047]?[ \t]*:[ \t]*["\047][A-Za-z0-9._:-]+["\047]/)) {
        seg = substr(rest, RSTART, RLENGTH); rest = substr(rest, RSTART + RLENGTH)
        split(seg, parts, ",")
        p = parts[1]; sub(/^[^:]*:/, "", p); p = unq(p)
        m = parts[2]; sub(/^[^:]*:/, "", m); m = unq(m)
        emit_pair(p, m); emit_prov(p)
      }
      # P2: a YAML provider line, then a model/name line within 2 lines.
      if (pending_left > 0) {
        if (match(line, /^[ \t]*["\047]?(model|name)["\047]?:[ \t]*["\047]?[A-Za-z0-9][A-Za-z0-9._:-]*["\047]?[ \t]*,?[ \t]*$/)) {
          m = line; sub(/^[^:]*:/, "", m); m = unq(m)
          emit_pair(pending_p, m); pending_left = 0
        } else pending_left--
      }
      if (match(line, /^[ \t]*-?[ \t]*["\047]?provider["\047]?:[ \t]*["\047]?[A-Za-z0-9][A-Za-z0-9._-]*["\047]?[ \t]*,?[ \t]*$/)) {
        p = line; sub(/^[^:]*:/, "", p); pending_p = unq(p); pending_left = 2; emit_prov(pending_p)
      }
      # P3: shell defaults.
      rest = line
      while (match(rest, /\$\{[A-Z0-9_]*:-[A-Za-z0-9][A-Za-z0-9._:-]*\}/)) {
        seg = substr(rest, RSTART + 2, RLENGTH - 3); rest = substr(rest, RSTART + RLENGTH)
        var = seg; sub(/:-.*/, "", var); val = seg; sub(/^[^:]*:-/, "", val)
        if (var ~ /PROVIDER/) emit_prov(val)
        else if (var ~ /MODEL/) emit_model(val)
      }
      # P3: JS/TS defaults.
      rest = line
      while (match(rest, /[A-Za-z0-9_.]*(PROVIDER|Provider|MODEL|Model)[A-Za-z0-9_]*[ \t]*(\|\||\?\?)[ \t]*["\047][A-Za-z0-9][A-Za-z0-9._:-]*["\047]/)) {
        seg = substr(rest, RSTART, RLENGTH); rest = substr(rest, RSTART + RLENGTH)
        val = seg; sub(/^.*(\|\||\?\?)[ \t]*/, "", val); val = unq(val)
        var = seg; sub(/[ \t]*(\|\||\?\?).*$/, "", var)
        if (var ~ /(PROVIDER|Provider)/) emit_prov(val)
        else emit_model(val)
      }
    }
  ' "${files[@]}"
}

# Prints one line per pair a scan needs that the manifest lacks.
missing_pairs() {
  local root="$1" manifest="$2" findings report
  # A guard whose scanner errors must not read as "nothing missing".
  if ! findings="$(extract "$root")"; then
    echo "GUARD_ERROR: the literal scan failed"
    return 0
  fi
  if ! report="$(printf '%s\n' "$findings" | awk -F '\t' -v manifest="$manifest" \
      -v ignored="$(printf '%s' "$IGNORED_PAIRS" | tr '\n' ';')" '
    BEGIN {
      while ((getline l < manifest) > 0) { sub(/#.*/, "", l); gsub(/[ \t\r]/, "", l); if (l != "") have[l] = 1 }
      for (k in have) { split(k, pm, "/"); any[pm[2]] = 1 }
      ni = split(ignored, il, ";"); for (i = 1; i <= ni; i++) if (il[i] != "") { split(il[i], iw, " "); skip[iw[1] " " iw[2]] = 1 }
    }
    $1 == "PAIR"  { f = $2; sub(/:[0-9]+$/, "", f); if ((f " " $3 "/" $4) in skip) next }
    $1 == "PAIR"  { if (!(($3 "/" $4) in have)) printf "%s/%s (%s, P1/P2)\n", $3, $4, $2; f = $2; sub(/:[0-9]+$/, "", f); provs[f] = provs[f] " " $3 }
    $1 == "PROV"  { provs[$2] = provs[$2] " " $3 }
    $1 == "MODEL" { models[++nm] = $2 "\t" $3 }
    END {
      for (i = 1; i <= nm; i++) {
        split(models[i], mf, "\t"); f = mf[1]; sub(/:[0-9]+$/, "", f); m = mf[2]
        np = split(provs[f], ps, " "); ok = 0
        if (np == 0) ok = (m in any)
        for (j = 1; j <= np; j++) if ((ps[j] "/" m) in have) ok = 1
        if (!ok) printf "%s with one of {%s} (%s, P3)\n", m, (np ? provs[f] : " any"), mf[1]
      }
    }')"; then
    echo "GUARD_ERROR: the manifest comparison failed"
    return 0
  fi
  [ -n "$report" ] && printf '%s\n' "$report" | sort -u
  return 0
}

assert_manifest_covers_every_e2e_model_literal() {
  local missing
  missing="$(missing_pairs "$SCAN_ROOT" "$MANIFEST")"
  if [ -z "$missing" ]; then
    pass "every provider/model an E2E spec, lane or fixture names is in $(basename "$MANIFEST")"
  else
    fail "add these to $(basename "$MANIFEST") (or change the literal):"
    printf '  %s\n' "$missing"
  fi
}

assert_manifest_entries_are_well_formed() {
  local bad
  bad="$(sed -e 's/#.*//' -e 's/[[:space:]]//g' "$MANIFEST" | sed '/^$/d' | grep -vE '^[a-z0-9][a-z0-9-]*/[A-Za-z0-9][A-Za-z0-9._:-]*$')"
  if [ -z "$bad" ]; then
    pass "manifest entries are provider/model"
  else
    # shellcheck disable=SC2086
    fail "malformed manifest entries: $(printf '%s ' $bad)"
  fi
}

# The guard is only worth something if it goes red: a fixture tree with one
# literal of each form, checked against manifests that each miss one pair.
assert_the_guard_catches_a_missing_pair() {
  local work form expected manifest missing problems=""
  work="$(mktemp -d)"
  mkdir -p "$work/control-ui/e2e" "$work/scripts/e2e" "$work/tests/e2e/fixtures" "$work/mcp-host/src/llm"
  cp "$REGISTRY" "$work/mcp-host/src/llm/registryCore.ts"
  cat >"$work/control-ui/e2e/a.spec.ts" <<'TS'
const agent = { provider: 'zai', model: 'glm-p1' }
const m = process.env.E2E_X_MODEL_NAME || 'glm-p3ts'
const multi = {
  provider: "openai",
  model: "gpt-p2js",
}
// prose mention zai/glm-prose and import 'openai/core' are not read
TS
  cat >"$work/tests/e2e/fixtures/r.yaml" <<'YAML'
agent:
  provider: zai
  model: glm-p2
other:
  provider: codex-subscription
  model: gpt-ignored
YAML
  cat >"$work/scripts/e2e/lane.sh" <<'SH'
PROVIDER="${CLERUM_MODEL_PROVIDER:-openai}"
MODEL="${CLERUM_MODEL_NAME:-gpt-p3sh}"
SH
  for form in "zai/glm-p1" "zai/glm-p2" "openai/gpt-p2js" "zai/glm-p3ts" "openai/gpt-p3sh"; do
    manifest="$work/manifest-without-${form//\//_}.txt"
    printf '%s\n' zai/glm-p1 zai/glm-p2 openai/gpt-p2js zai/glm-p3ts openai/gpt-p3sh | grep -vxF "$form" >"$manifest"
    expected="${form#*/}"
    missing="$(REGISTRY="$work/mcp-host/src/llm/registryCore.ts" missing_pairs "$work" "$manifest")"
    if ! printf '%s\n' "$missing" | grep -Fq "$expected"; then
      problems+="missing ${form} not reported; "
    elif [ "$(printf '%s\n' "$missing" | sed '/^$/d' | wc -l | tr -d ' ')" != 1 ]; then
      problems+="manifest without ${form} reported extra lines: $(printf '%s' "$missing" | tr '\n' '|'); "
    fi
  done
  # P3 pairs a model with its own file's provider: zai/gpt-p3sh does not cover it.
  manifest="$work/manifest-wrong-provider.txt"
  printf '%s\n' zai/glm-p1 zai/glm-p2 openai/gpt-p2js zai/glm-p3ts zai/gpt-p3sh >"$manifest"
  missing="$(missing_pairs "$work" "$manifest")"
  printf '%s\n' "$missing" | grep -Fq gpt-p3sh || problems+="a P3 model under another provider was accepted; "
  manifest="$work/manifest-complete.txt"
  printf '%s\n' zai/glm-p1 zai/glm-p2 openai/gpt-p2js zai/glm-p3ts openai/gpt-p3sh >"$manifest"
  missing="$(missing_pairs "$work" "$manifest")"
  [ -z "$missing" ] || problems+="complete manifest still reported: $(printf '%s' "$missing" | tr '\n' '|'); "
  rm -rf "$work"
  if [ -z "$problems" ]; then
    pass "the guard reports each missing form (P1, P2 YAML, P2 multi-line JS, P3 shell, P3 TS) and ignores prose, imports and subscription providers"
  else
    fail "$problems"
  fi
}

assert_every_defined_case_is_invoked() {
  local defined invoked missing
  defined="$(grep -oE '^assert_[a-z_0-9]+\(\) \{' "$SELF" | sed -E 's/\(\) \{$//' | sort -u)"
  invoked="$(grep -oE '^ *assert_[a-z_0-9]+$' "$SELF" | tr -d ' ' | sort -u)"
  missing="$(comm -23 <(printf '%s\n' "$defined") <(printf '%s\n' "$invoked"))"
  if [ -n "$defined" ] && [ -z "$missing" ]; then
    pass "every defined assert_ case is invoked in the call block"
  else
    # shellcheck disable=SC2086
    fail "defined but never invoked: $(printf '%s ' $missing)"
  fi
}

assert_manifest_covers_every_e2e_model_literal
assert_manifest_entries_are_well_formed
if [ "$SELF_TEST" = true ]; then
  assert_the_guard_catches_a_missing_pair
  assert_every_defined_case_is_invoked
fi

exit $FAIL
