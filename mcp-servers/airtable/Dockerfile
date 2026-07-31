# --- Build stage ---
FROM node:24-alpine AS builder

WORKDIR /app

# ca-certificates is what makes the HTTPS clone below verifiable. The alpine
# base happens to ship a bundle today; declare the dependency so a base bump
# cannot silently remove it. Guarded by scripts/check-dockerfile-ca-certificates.sh.
RUN apk add --no-cache ca-certificates git

# Clone the latest source which includes HTTP transport support
RUN git clone --depth 1 https://github.com/domdomegg/airtable-mcp-server.git .

# Install only production dependencies first, then all for build
RUN npm ci --ignore-scripts
RUN npm run build

# Prune dev dependencies so only production deps carry over
RUN npm prune --production

# --- Release stage ---
FROM node:24-alpine

# Security: run as non-root user
RUN addgroup -S mcp && adduser -S mcp -G mcp

WORKDIR /app

# Copy only what's needed to run
COPY --from=builder --chown=mcp:mcp /app/dist ./dist
COPY --from=builder --chown=mcp:mcp /app/package.json ./package.json
COPY --from=builder --chown=mcp:mcp /app/node_modules ./node_modules
COPY --chown=mcp:mcp runtime-bootstrap.cjs ./runtime-bootstrap.cjs

# Drop privileges
USER mcp

# Metadata
EXPOSE 3000
ENV NODE_ENV=production

ENTRYPOINT ["node", "--require", "./runtime-bootstrap.cjs", "dist/main.js"]
