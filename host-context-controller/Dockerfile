FROM node:24-alpine AS builder

WORKDIR /app

# Copy package files
COPY packages/workflow-recipe-capability-policy ./packages/workflow-recipe-capability-policy
COPY packages/image-policy ./packages/image-policy
# Shared pure sliding-window egress core (issue #299). It is a local `file:`
# dependency of host-context-controller and must be present before npm ci.
COPY packages/network-policy-core ./packages/network-policy-core
# Shared prebuilt data-only providers package (no build step). Copied before
# host-context-controller's npm ci because it resolves the provider set from it
# (R4).
COPY packages/llm-providers ./packages/llm-providers
COPY packages/codex-catalog-projection ./packages/codex-catalog-projection
COPY host-context-controller/package*.json ./host-context-controller/
WORKDIR /app/host-context-controller

# Install dependencies
RUN npm ci

# Copy source
COPY host-context-controller/tsconfig.json host-context-controller/tsconfig.build.json ./
COPY host-context-controller/src ./src

# Build
RUN npm run build

# Production stage
FROM node:24-alpine

WORKDIR /app

# Copy package files and install production deps only
COPY packages/workflow-recipe-capability-policy ./packages/workflow-recipe-capability-policy
COPY packages/image-policy ./packages/image-policy
# Keep the local sliding-window core available to the production install too;
# npm ci resolves the same `file:` dependency in this stage.
COPY packages/network-policy-core ./packages/network-policy-core
# Shared prebuilt data-only providers package (no build step) — same file:
# dependency the production npm ci below resolves against (R4).
COPY packages/llm-providers ./packages/llm-providers
COPY packages/codex-catalog-projection ./packages/codex-catalog-projection
COPY host-context-controller/package*.json ./host-context-controller/
WORKDIR /app/host-context-controller
RUN npm ci --omit=dev

# Copy built files
COPY --from=builder /app/host-context-controller/dist ./dist

# Set non-root user
USER node

# Default port
EXPOSE 8081

CMD ["node", "dist/main.js"]
