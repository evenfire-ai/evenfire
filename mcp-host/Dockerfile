# MCP Host Dockerfile
#
# BUILD CONTEXT = repo root (not mcp-host/). mcp-host consumes the shared
# @clerum/llm-providers package via `file:../packages/llm-providers`, so the
# build must COPY packages/ alongside mcp-host/. Mirrors control-api /
# workflow-recipes. Build invocations pass `-f mcp-host/Dockerfile .`.
#
# Pinned to Node 24.16.0 by digest: Node 24.17.0 ships an undici bump that
# regresses node-fetch@2 (ERR_STREAM_PREMATURE_CLOSE). Keep the runtime frozen
# so a floating `node:24-alpine` tag can't move the patch out from under us.
FROM node:24.16.0-alpine@sha256:21f403ab171f2dc89bad4dd69d7721bfd15f084ccb46cdd225f31f2bc59b5c9a AS builder

WORKDIR /app

# Shared prebuilt data-only package (no build step — ships index.cjs + .d.ts).
COPY packages/llm-providers ./packages/llm-providers
COPY packages/llm-provider-attempt-contract ./packages/llm-provider-attempt-contract

# Install dependencies (file: deps resolve to ../packages/llm-providers and
# ../packages/llm-provider-attempt-contract)
COPY mcp-host/package*.json ./mcp-host/
WORKDIR /app/mcp-host
RUN npm ci

# Copy source code
COPY mcp-host/tsconfig.json mcp-host/tsconfig.build.json ./
COPY mcp-host/src ./src

# Build TypeScript
RUN npm run build

# Production image
FROM node:24.16.0-alpine@sha256:21f403ab171f2dc89bad4dd69d7721bfd15f084ccb46cdd225f31f2bc59b5c9a

WORKDIR /app

# Copy the shared package + package files, install production dependencies only
COPY packages/llm-providers ./packages/llm-providers
COPY packages/llm-provider-attempt-contract ./packages/llm-provider-attempt-contract
COPY mcp-host/package*.json ./mcp-host/
WORKDIR /app/mcp-host
RUN npm ci --only=production

# Copy built code
COPY --from=builder /app/mcp-host/dist ./dist

# Run as non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

# Create writable workspace for native tools (file_read, file_write, shell_exec)
RUN mkdir -p /workspace && chown nodejs:nodejs /workspace

USER nodejs

CMD ["node", "dist/main.js"]
