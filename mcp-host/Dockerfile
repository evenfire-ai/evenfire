# MCP Host Dockerfile
# Pinned to Node 24.16.0 by digest: Node 24.17.0 ships an undici bump that
# regresses node-fetch@2 (ERR_STREAM_PREMATURE_CLOSE). Keep the runtime frozen
# so a floating `node:24-alpine` tag can't move the patch out from under us.
FROM node:24.16.0-alpine@sha256:21f403ab171f2dc89bad4dd69d7721bfd15f084ccb46cdd225f31f2bc59b5c9a AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci

# Copy source code
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src

# Build TypeScript
RUN npm run build

# Production image
FROM node:24.16.0-alpine@sha256:21f403ab171f2dc89bad4dd69d7721bfd15f084ccb46cdd225f31f2bc59b5c9a

WORKDIR /app

# Copy package files and install production dependencies only
COPY package*.json ./
RUN npm ci --only=production

# Copy built code
COPY --from=builder /app/dist ./dist

# Run as non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

# Create writable workspace for native tools (file_read, file_write, shell_exec)
RUN mkdir -p /workspace && chown nodejs:nodejs /workspace

USER nodejs

CMD ["node", "dist/main.js"]
