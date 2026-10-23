#!/usr/bin/env bash
# Contract for scripts/verify-nginx-image-digests.sh, offline: a fake docker
# first on PATH records every call and answers with an inline image config.
# Each case checks the exit code, the message and the recorded docker calls,
# so a rejection without a registry call is told apart from one that never
# ran (the error message is the witness for an empty call log).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
VERIFIER="$REPO_ROOT/scripts/verify-nginx-image-digests.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
OUT="$WORK/out"
export FAKE_DOCKER_LOG="$WORK/docker.log"
failures=0
cases=0

DIGEST="sha256:$(printf 'a%.0s' {1..64})"
# The release under test is the validator's fixed image, so a floor raise or a
# bump does not need edits here. OLD is a release below every floor.
FIXED_IMAGE="$(sed -n 's/^FIXED_NGINX_IMAGE="\(.*\)"$/\1/p' "$REPO_ROOT/scripts/validate-nginx-images.sh")"
TAG="${FIXED_IMAGE#nginx:}"
V="${TAG%%-*}"
if ! [[ "$V" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "FAIL: could not read FIXED_NGINX_IMAGE from the validator (got '$FIXED_IMAGE')" >&2
  exit 1
fi
OLD=1.30.1
REF="nginx:$TAG@$DIGEST"

mkdir -p "$WORK/bin"
cat >"$WORK/bin/docker" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$FAKE_DOCKER_LOG"
if [ -n "${FAKE_DOCKER_FAIL:-}" ]; then
  echo "fake docker: inspect failed" >&2
  exit 1
fi
printf '%s\n' "$FAKE_IMAGE_JSON"
EOF
chmod +x "$WORK/bin/docker"

fail() {
  echo "FAIL: $*" >&2
  failures=$((failures + 1))
}

# image_index AMD64_VERSION ARM64_VERSION: imagetools JSON for a two-platform index.
image_index() {
  printf '{"linux/amd64":{"config":{"Env":["PATH=/usr/bin","NGINX_VERSION=%s"]}},"linux/arm64":{"config":{"Env":["PATH=/usr/bin","NGINX_VERSION=%s"]}}}' "$1" "$2"
}

# run_case NAME WANT_EXIT WANT_CALLS IMAGE_JSON ARGS...: runs the verifier with
# the fake docker and checks the exit code and the number of docker calls.
run_case() {
  local name="$1" want_exit="$2" want_calls="$3" status=0 calls
  export FAKE_IMAGE_JSON="$4"
  shift 4
  cases=$((cases + 1))
  : >"$FAKE_DOCKER_LOG"
  PATH="$WORK/bin:$PATH" bash "$VERIFIER" "$@" >"$OUT" 2>&1 || status=$?
  calls="$(grep -c . "$FAKE_DOCKER_LOG" || true)"
  if [ "$status" -ne "$want_exit" ]; then
    fail "$name: exit $status, expected $want_exit: $(cat "$OUT")"
  fi
  if [ "$calls" -ne "$want_calls" ]; then
    fail "$name: $calls docker calls, expected $want_calls: $(cat "$FAKE_DOCKER_LOG")"
  fi
}

expect_out() {
  if ! grep -qF -- "$2" "$OUT"; then
    fail "$1 should print '$2': $(cat "$OUT")"
  fi
}

expect_call() {
  if ! grep -qxF -- "$2" "$FAKE_DOCKER_LOG"; then
    fail "$1 should call docker with '$2': $(cat "$FAKE_DOCKER_LOG")"
  fi
}

run_case "matching index" 0 1 "$(image_index "$V" "$V")" "$REF"
expect_out "matching index" "ok: nginx@$DIGEST linux/amd64 NGINX_VERSION=$V"
expect_out "matching index" "ok: nginx@$DIGEST linux/arm64 NGINX_VERSION=$V"
expect_call "matching index" "buildx imagetools inspect nginx@$DIGEST --format {{json .Image}}"
ok_lines="$(grep -c '^ok: ' "$OUT" || true)"
if [ "$ok_lines" -ne 2 ]; then
  fail "matching index printed $ok_lines ok: lines, expected 2: $(cat "$OUT")"
fi

run_case "mismatch on both platforms" 1 1 "$(image_index "$OLD" "$OLD")" "$REF"
expect_out "mismatch on both platforms" "linux/amd64 declares NGINX_VERSION=$OLD, tag says $V"
expect_out "mismatch on both platforms" "linux/arm64 declares NGINX_VERSION=$OLD, tag says $V"

run_case "arm64 mismatch" 1 1 "$(image_index "$V" "$OLD")" "$REF"
expect_out "arm64 mismatch" "linux/arm64 declares NGINX_VERSION=$OLD, tag says $V"

run_case "amd64 mismatch" 1 1 "$(image_index "$OLD" "$V")" "$REF"
expect_out "amd64 mismatch" "linux/amd64 declares NGINX_VERSION=$OLD, tag says $V"

run_case "value with trailing text" 1 1 "$(image_index "$V extra" "$V extra")" "$REF"
expect_out "value with trailing text" "linux/amd64 declares NGINX_VERSION=$V extra, tag says $V"
expect_out "value with trailing text" "linux/arm64 declares NGINX_VERSION=$V extra, tag says $V"

# A value carrying a newline must not stand in for the missing arm64 manifest.
run_case "embedded newline posing as arm64" 1 1 \
  "{\"linux/amd64\":{\"config\":{\"Env\":[\"NGINX_VERSION=$V\\nlinux/arm64 $V\"]}}}" "$REF"
expect_out "embedded newline posing as arm64" "has no linux/arm64 manifest"
expect_out "embedded newline posing as arm64" "linux/amd64 declares NGINX_VERSION=$V\\nlinux/arm64 $V, tag says $V"

run_case "index without arm64" 1 1 "{\"linux/amd64\":{\"config\":{\"Env\":[\"NGINX_VERSION=$V\"]}}}" "$REF"
expect_out "index without arm64" "has no linux/arm64 manifest"

run_case "single-platform manifest" 1 1 "{\"config\":{\"Env\":[\"NGINX_VERSION=$V\"]}}" "$REF"
expect_out "single-platform manifest" "has no linux/amd64 manifest"

FAKE_DOCKER_FAIL=1 run_case "inspect failure" 1 1 "" "$REF"
expect_out "inspect failure" "could not inspect nginx@$DIGEST"

run_case "malformed reference" 1 0 "$(image_index "$V" "$V")" "nginx@$DIGEST:$V"
expect_out "malformed reference" "ERROR: nginx@$DIGEST:$V: "

run_case "tag below the floor" 1 0 "$(image_index "$OLD" "$OLD")" "nginx:$OLD-alpine@$DIGEST"
expect_out "tag below the floor" "release $OLD is below"

run_case "reference without a digest" 1 0 "$(image_index "$V" "$V")" "nginx:$TAG"
expect_out "reference without a digest" "nginx:$TAG has no digest to verify"

# No arguments: the references come from the validator. A copy of the two
# scripts and the policy, with a validator that lists nothing, must fail.
mkdir -p "$WORK/empty/scripts"
cp "$VERIFIER" "$REPO_ROOT/scripts/nginx-image-policy.sh" "$WORK/empty/scripts/"
printf '#!/usr/bin/env bash\nexit 0\n' >"$WORK/empty/scripts/validate-nginx-images.sh"
cases=$((cases + 1))
: >"$FAKE_DOCKER_LOG"
status=0
PATH="$WORK/bin:$PATH" bash "$WORK/empty/scripts/verify-nginx-image-digests.sh" >"$OUT" 2>&1 || status=$?
if [ "$status" -ne 1 ] || ! grep -qF "no digest-pinned NGINX references to verify" "$OUT"; then
  fail "no references: exit $status, expected 1 and the no-references error: $(cat "$OUT")"
fi

NGINX_REGISTRY_MIRROR=mirror.gcr.io run_case "mirror" 0 1 "$(image_index "$V" "$V")" "$REF"
expect_call "mirror" "buildx imagetools inspect mirror.gcr.io/library/nginx@$DIGEST --format {{json .Image}}"
expect_out "mirror" "ok: mirror.gcr.io/library/nginx@$DIGEST linux/amd64 NGINX_VERSION=$V (for $REF)"

NGINX_REGISTRY_MIRROR=mirror.gcr.io run_case "mirror, unprivileged image" 0 1 "$(image_index "$V" "$V")" \
  "docker.io/nginxinc/nginx-unprivileged:$TAG@$DIGEST"
expect_call "mirror, unprivileged image" "buildx imagetools inspect mirror.gcr.io/nginxinc/nginx-unprivileged@$DIGEST --format {{json .Image}}"

NGINX_REGISTRY_MIRROR=mirror.gcr.io FAKE_DOCKER_FAIL=1 run_case "mirror inspect failure" 1 1 "" "$REF"
expect_call "mirror inspect failure" "buildx imagetools inspect mirror.gcr.io/library/nginx@$DIGEST --format {{json .Image}}"
expect_out "mirror inspect failure" "could not inspect mirror.gcr.io/library/nginx@$DIGEST"

NGINX_REGISTRY_MIRROR=mirror.gcr.io run_case "registry-qualified reference" 0 1 "$(image_index "$V" "$V")" \
  "registry.internal:5000/mirror/nginx:$TAG@$DIGEST"
expect_call "registry-qualified reference" "buildx imagetools inspect registry.internal:5000/mirror/nginx@$DIGEST --format {{json .Image}}"

echo "cases=$cases failures=$failures"
if [ "$cases" -eq 0 ]; then
  echo "FAIL: no cases ran" >&2
  exit 1
fi
if [ "$failures" -ne 0 ]; then
  exit 1
fi
echo "OK -- verify-nginx-image-digests contract ($cases cases)"
