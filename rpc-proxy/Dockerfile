FROM node:24-alpine AS builder
WORKDIR /app

COPY packages/action-context-contracts ./packages/action-context-contracts
COPY rpc-proxy/package*.json ./rpc-proxy/
WORKDIR /app/rpc-proxy
RUN npm ci

COPY rpc-proxy/tsconfig.json ./
COPY rpc-proxy/src ./src
RUN npm run build
RUN npm prune --production

FROM node:24-alpine
ARG EVENFIRE_SOURCE_REVISION
ARG EVENFIRE_SERVICE_VERSION
RUN addgroup -S app && adduser -S app -G app
WORKDIR /app

ENV NODE_ENV=production
ENV EVENFIRE_SOURCE_REVISION=$EVENFIRE_SOURCE_REVISION
ENV EVENFIRE_IMAGE_REVISION=$EVENFIRE_SOURCE_REVISION
ENV EVENFIRE_SERVICE_VERSION=$EVENFIRE_SERVICE_VERSION
ENV RPC_PROXY_PORT=8094

COPY packages/action-context-contracts ./packages/action-context-contracts
COPY --from=builder --chown=app:app /app/rpc-proxy/package*.json ./rpc-proxy/
COPY --from=builder --chown=app:app /app/rpc-proxy/dist ./rpc-proxy/dist
COPY --from=builder --chown=app:app /app/rpc-proxy/node_modules ./rpc-proxy/node_modules

USER app
EXPOSE 8094
WORKDIR /app/rpc-proxy
CMD ["node", "dist/main.js"]
