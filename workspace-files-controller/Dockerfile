# workspace-files-controller — per-SharedFileSystem HTTP IO service.
# Built from the repository root: src/auth/actionAuthority.ts imports
# ../../../packages/action-context-contracts by relative path. That path resolves
# to /app/packages/action-context-contracts from src/auth (build stage) and from
# dist/auth (runtime stage), so both stages copy the package.
FROM node:24.22.1-alpine AS builder
WORKDIR /app
COPY packages/action-context-contracts ./packages/action-context-contracts
COPY workspace-files-controller/package*.json ./workspace-files-controller/
WORKDIR /app/workspace-files-controller
RUN npm ci
COPY workspace-files-controller/tsconfig.json ./
COPY workspace-files-controller/src ./src
RUN npm run build

FROM node:24.22.1-alpine
ARG EVENFIRE_SOURCE_REVISION
ARG EVENFIRE_SERVICE_VERSION
WORKDIR /app
ENV EVENFIRE_SOURCE_REVISION=$EVENFIRE_SOURCE_REVISION
ENV EVENFIRE_IMAGE_REVISION=$EVENFIRE_SOURCE_REVISION
ENV EVENFIRE_SERVICE_VERSION=$EVENFIRE_SERVICE_VERSION
COPY packages/action-context-contracts ./packages/action-context-contracts
COPY workspace-files-controller/package*.json ./workspace-files-controller/
WORKDIR /app/workspace-files-controller
RUN npm ci --only=production
COPY --from=builder /app/workspace-files-controller/dist ./dist

# wfc runs as the security UID configured on the SharedFileSystem (default 1000).
# node:24.22.1-alpine already ships a `node` user at UID 1000 / GID 1000 — reuse it
# rather than recreating, which conflicts on UID.
USER 1000:1000

CMD ["node", "dist/main.js"]
