FROM node:24.22.1-alpine AS builder

WORKDIR /app

# Built from the repository root: @clerum/action-context-contracts resolves
# through file:../packages/action-context-contracts, so the package must be in
# the build context before npm ci.
COPY packages/action-context-contracts ./packages/action-context-contracts
COPY gfs-controller/package*.json ./gfs-controller/

WORKDIR /app/gfs-controller
RUN npm ci

COPY gfs-controller/tsconfig.json ./
COPY gfs-controller/src ./src

RUN npm run build

FROM node:24.22.1-alpine
ARG EVENFIRE_SOURCE_REVISION
ARG EVENFIRE_SERVICE_VERSION

WORKDIR /app
ENV EVENFIRE_SOURCE_REVISION=$EVENFIRE_SOURCE_REVISION
ENV EVENFIRE_IMAGE_REVISION=$EVENFIRE_SOURCE_REVISION
ENV EVENFIRE_SERVICE_VERSION=$EVENFIRE_SERVICE_VERSION

COPY packages/action-context-contracts ./packages/action-context-contracts
COPY gfs-controller/package*.json ./gfs-controller/

WORKDIR /app/gfs-controller
RUN npm ci --only=production

COPY --from=builder /app/gfs-controller/dist ./dist

RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

USER nodejs

EXPOSE 8087

CMD ["node", "dist/index.js"]
