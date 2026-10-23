# MCP Host Dockerfile
#
# BUILD CONTEXT = repo root (not mcp-host/). mcp-host consumes the shared
# @clerum/llm-providers package via `file:../packages/llm-providers`, so the
# build must COPY packages/ alongside mcp-host/. Mirrors control-api /
# workflow-recipes. Build invocations pass `-f mcp-host/Dockerfile .`.
#
# Pinned to Node 24.22.1 by digest for the October 2026 Node.js security
# release. The HTTP regression covers the SDK and native fetch separately;
# the CI runtime image gate also checks the effective version and native modules.
FROM node:24.22.1-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53 AS builder

WORKDIR /app

# Shared prebuilt data-only package (no build step — ships index.cjs + .d.ts).
COPY packages/llm-providers ./packages/llm-providers
COPY packages/llm-provider-attempt-contract ./packages/llm-provider-attempt-contract
COPY packages/grok-provider-attempt-contract ./packages/grok-provider-attempt-contract
COPY packages/codex-catalog-projection ./packages/codex-catalog-projection
COPY packages/gfs-interaction-policy ./packages/gfs-interaction-policy
COPY packages/host-locale ./packages/host-locale

# Install dependencies (file: deps resolve to ../packages/llm-providers and
# ../packages/llm-provider-attempt-contract)
COPY mcp-host/package*.json ./mcp-host/
WORKDIR /app/mcp-host
RUN npm ci

# Copy source code
COPY mcp-host/tsconfig.json mcp-host/tsconfig.build.json ./
COPY mcp-host/src ./src

# Build TypeScript, then drop devDependencies so the runtime stage does not
# run a second npm ci (better-sqlite3's prebuild timed out on that hop).
RUN npm run build && npm prune --omit=dev

# Production image
FROM node:24.22.1-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53

WORKDIR /app

# The chart and PDF renderers carry a face for Latin, Greek and Cyrillic; these
# fonts add the arrows, check marks, CJK, Arabic and Hebrew it lacks, and the
# other scripts host languages are written in (packages/host-locale). Alpine
# packages each script apart from font-noto, in every weight and width; only the
# regular and bold Noto Sans faces the renderers read are kept.
RUN apk add --no-cache font-dejavu font-noto font-noto-cjk font-noto-arabic font-noto-hebrew \
      font-noto-armenian font-noto-bengali font-noto-devanagari font-noto-ethiopic \
      font-noto-georgian font-noto-gujarati font-noto-gurmukhi font-noto-kannada font-noto-khmer \
      font-noto-lao font-noto-malayalam font-noto-myanmar font-noto-oriya font-noto-tamil \
      font-noto-telugu font-noto-thai \
  && find /usr/share/fonts -type f \( -name '*Armenian*' -o -name '*Bengali*' \
      -o -name '*Devanagari*' -o -name '*Ethiopic*' -o -name '*Georgian*' -o -name '*Gujarati*' \
      -o -name '*Gurmukhi*' -o -name '*Kannada*' -o -name '*Khmer*' -o -name '*Lao*' \
      -o -name '*Malayalam*' -o -name '*Myanmar*' -o -name '*Oriya*' -o -name '*Tamil*' \
      -o -name '*Telugu*' -o -name '*Thai*' \) \
      ! -name 'NotoSans*-Regular.ttf' ! -name 'NotoSans*-Bold.ttf' -delete

# Copy the shared package + package files + the already-pruned install
COPY packages/llm-providers ./packages/llm-providers
COPY packages/llm-provider-attempt-contract ./packages/llm-provider-attempt-contract
COPY packages/grok-provider-attempt-contract ./packages/grok-provider-attempt-contract
COPY packages/codex-catalog-projection ./packages/codex-catalog-projection
COPY packages/gfs-interaction-policy ./packages/gfs-interaction-policy
COPY packages/host-locale ./packages/host-locale
COPY mcp-host/package*.json ./mcp-host/
WORKDIR /app/mcp-host
COPY --from=builder /app/mcp-host/node_modules ./node_modules
COPY --from=builder /app/mcp-host/dist ./dist

# Run as non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

# Create writable workspace for native tools (file_read, file_write, shell_exec)
RUN mkdir -p /workspace && chown nodejs:nodejs /workspace

USER nodejs

CMD ["node", "dist/main.js"]
