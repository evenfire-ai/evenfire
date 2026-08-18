FROM node:24-alpine AS builder
WORKDIR /app

COPY packages/workflow-recipe-capability-policy ./packages/workflow-recipe-capability-policy
COPY packages/image-policy ./packages/image-policy
# Shared prebuilt data-only providers package (no build step). Copied before
# both the workflow-runtime-core build (it depends on it) and control-api's
# npm ci (control-api validates the provider set from it, R4).
COPY packages/llm-providers ./packages/llm-providers
# Shared prebuilt display-field validation package (no build step). Copied
# before control-api's npm ci so its file: dependency resolves; resourceFieldValidation
# imports validateDisplayField from it.
COPY packages/display-field ./packages/display-field

# Build the shared @clerum/workflow-runtime-core package (TS → dist) BEFORE
# control-api's npm ci, so its file: dependency on it resolves with the compiled
# dist. Mirrors workflow-recipes' Dockerfile. The ownership predicate (Issue #637)
# lives in this package as the single source of truth shared by both services.
COPY packages/workflow-runtime-core/package.json packages/workflow-runtime-core/package-lock.json ./packages/workflow-runtime-core/
COPY packages/workflow-runtime-core/tsconfig.json ./packages/workflow-runtime-core/
COPY packages/workflow-runtime-core/src ./packages/workflow-runtime-core/src
WORKDIR /app/packages/workflow-runtime-core
RUN npm ci && npm run build

WORKDIR /app
COPY control-api/package*.json ./control-api/
WORKDIR /app/control-api
RUN npm ci

COPY control-api/tsconfig.json ./
COPY control-api/src ./src

RUN npm run build
RUN npm prune --production

FROM node:24-alpine
RUN addgroup -S app && adduser -S app -G app
WORKDIR /app

COPY --from=builder --chown=app:app /app/packages ./packages
COPY --from=builder --chown=app:app /app/control-api/package*.json ./control-api/
COPY --from=builder --chown=app:app /app/control-api/dist ./control-api/dist
COPY --from=builder --chown=app:app /app/control-api/node_modules ./control-api/node_modules

ENV NODE_ENV=production
EXPOSE 8090
USER app
WORKDIR /app/control-api

CMD ["node", "dist/main.js"]
