#!/usr/bin/env bash
# Contract for scripts/check-dockerfile-fonts.sh: it passes the font package
# lists the renderers need and names the package a list misses, in the final
# stage of a Dockerfile and in the CI job's install.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CHECK="$REPO_ROOT/scripts/check-dockerfile-fonts.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
failures=0

fail() {
  echo "FAIL: $*" >&2
  failures=$((failures + 1))
}

passes() {
  local name="$1"
  shift
  if ! bash "$CHECK" "$@" >"$WORK/out" 2>&1; then
    fail "$name should pass: $(cat "$WORK/out")"
  fi
}

fails_naming() {
  local name="$1" expected="$2"
  shift 2
  if bash "$CHECK" "$@" >"$WORK/out" 2>&1; then
    fail "$name should fail"
  elif ! grep -q -- "$expected" "$WORK/out"; then
    fail "$name should name '$expected': $(cat "$WORK/out")"
  fi
}

cat >"$WORK/alpine.Dockerfile" <<'EOF'
FROM node:24-alpine AS builder
RUN npm ci
FROM node:24-alpine
RUN apk add --no-cache font-dejavu font-noto font-noto-cjk font-noto-arabic font-noto-hebrew
EOF
passes "an Alpine image with every font package" "$WORK/alpine.Dockerfile"

cat >"$WORK/debian.Dockerfile" <<'EOF'
FROM node:24-alpine AS builder
FROM node:24-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    # The fonts the renderers look for.
    fonts-dejavu-core fonts-noto-core fonts-noto-cjk \
  && rm -rf /var/lib/apt/lists/*
EOF
passes "a Debian image installing them over continuation lines" "$WORK/debian.Dockerfile"

cat >"$WORK/no-hebrew.Dockerfile" <<'EOF'
FROM node:24-alpine
RUN apk add --no-cache font-dejavu font-noto font-noto-cjk font-noto-arabic
EOF
fails_naming "an Alpine image without the Hebrew faces" "font-noto-hebrew" "$WORK/no-hebrew.Dockerfile"

cat >"$WORK/builder-only.Dockerfile" <<'EOF'
FROM node:24-alpine AS builder
RUN apk add --no-cache font-dejavu font-noto font-noto-cjk font-noto-arabic font-noto-hebrew
FROM node:24-alpine
COPY --from=builder /app /app
EOF
fails_naming "fonts installed only in a builder stage" "installs no packages" "$WORK/builder-only.Dockerfile"

cat >"$WORK/no-cjk.Dockerfile" <<'EOF'
FROM node:24-slim
RUN apt-get install -y fonts-dejavu-core fonts-noto-core && apt-get clean
EOF
fails_naming "a Debian image without the CJK collections" "fonts-noto-cjk" "$WORK/no-cjk.Dockerfile"

cat >"$WORK/exempt.Dockerfile" <<'EOF'
FROM node:24-alpine
# FONTS-OK: this image renders no documents
RUN apk add --no-cache git
EOF
passes "an exempt final stage" "$WORK/exempt.Dockerfile"

cat >"$WORK/workflow.yml" <<'EOF'
      - name: Install the mcp-host image fonts
        run: |
          sudo apt-get install -y --no-install-recommends fonts-dejavu-core fonts-noto-core
EOF
fails_naming "a CI install without the CJK collections" "fonts-noto-cjk" --workflow "$WORK/workflow.yml"

passes "the repository's own images and CI job"

if [ "$failures" -ne 0 ]; then
  echo "FAIL: $failures check-dockerfile-fonts case(s)." >&2
  exit 1
fi
echo "PASS: check-dockerfile-fonts passes complete lists and names what a list misses."
