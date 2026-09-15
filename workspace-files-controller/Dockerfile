# workspace-files-controller — per-SharedFileSystem HTTP IO service.
FROM node:24-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:24-alpine
ARG EVENFIRE_SOURCE_REVISION
ARG EVENFIRE_SERVICE_VERSION
WORKDIR /app
ENV EVENFIRE_SOURCE_REVISION=$EVENFIRE_SOURCE_REVISION
ENV EVENFIRE_IMAGE_REVISION=$EVENFIRE_SOURCE_REVISION
ENV EVENFIRE_SERVICE_VERSION=$EVENFIRE_SERVICE_VERSION
COPY package*.json ./
RUN npm ci --only=production
COPY --from=builder /app/dist ./dist

# wfc runs as the security UID configured on the SharedFileSystem (default 1000).
# node:24-alpine already ships a `node` user at UID 1000 / GID 1000 — reuse it
# rather than recreating, which conflicts on UID.
USER 1000:1000

CMD ["node", "dist/main.js"]
