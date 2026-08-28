# syntax=docker/dockerfile:1
FROM node:24-alpine AS builder

WORKDIR /app

# Shared prebuilt data-only package (no build step). Copied first because
# @clerum/workflow-runtime-core depends on it (file:../llm-providers) and
# workflow-recipes consumes it directly.
COPY packages/llm-providers ./packages/llm-providers
COPY packages/codex-catalog-projection ./packages/codex-catalog-projection
COPY packages/network-policy-core ./packages/network-policy-core
COPY packages/workflow-runtime-core/package.json packages/workflow-runtime-core/package-lock.json ./packages/workflow-runtime-core/
COPY packages/workflow-runtime-core/tsconfig.json ./packages/workflow-runtime-core/
COPY packages/workflow-runtime-core/src ./packages/workflow-runtime-core/src
WORKDIR /app/packages/workflow-runtime-core
RUN npm ci && npm run build

WORKDIR /app
COPY packages/workflow-recipe-capability-policy ./packages/workflow-recipe-capability-policy
COPY packages/image-policy ./packages/image-policy
COPY workflow-recipes/package.json workflow-recipes/package-lock.json ./workflow-recipes/
WORKDIR /app/workflow-recipes
RUN npm ci

COPY workflow-recipes/tsconfig.json workflow-recipes/tsconfig.build.json ./
COPY workflow-recipes/src ./src
RUN npm run build:docker

FROM node:24-alpine

WORKDIR /app

COPY packages/llm-providers ./packages/llm-providers
COPY packages/codex-catalog-projection ./packages/codex-catalog-projection
COPY packages/network-policy-core ./packages/network-policy-core
COPY packages/workflow-runtime-core/package.json packages/workflow-runtime-core/package-lock.json ./packages/workflow-runtime-core/
COPY --from=builder /app/packages/workflow-runtime-core/dist ./packages/workflow-runtime-core/dist
COPY packages/workflow-recipe-capability-policy ./packages/workflow-recipe-capability-policy
COPY packages/image-policy ./packages/image-policy

COPY workflow-recipes/package.json workflow-recipes/package-lock.json ./workflow-recipes/
WORKDIR /app/workflow-recipes
RUN npm ci --omit=dev

COPY --from=builder /app/workflow-recipes/dist ./dist

USER node

EXPOSE 8082

CMD ["node", "dist/main.js"]
