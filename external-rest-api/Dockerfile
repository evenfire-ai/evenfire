FROM node:24-alpine AS builder
WORKDIR /app

COPY packages/jwt-key-policy/package.json packages/jwt-key-policy/index.cjs packages/jwt-key-policy/index.d.ts packages/jwt-key-policy/dev-store.cjs packages/jwt-key-policy/dev-store.d.ts ./packages/jwt-key-policy/
COPY external-rest-api/package*.json ./external-rest-api/
WORKDIR /app/external-rest-api
RUN npm ci

COPY external-rest-api/tsconfig.json ./
COPY external-rest-api/src ./src
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
ENV EXTERNAL_REST_API_PORT=8091

COPY --from=builder --chown=app:app /app/packages/jwt-key-policy ./packages/jwt-key-policy
COPY --from=builder --chown=app:app /app/external-rest-api/package*.json ./external-rest-api/
COPY --from=builder --chown=app:app /app/external-rest-api/dist ./external-rest-api/dist
COPY --from=builder --chown=app:app /app/external-rest-api/node_modules ./external-rest-api/node_modules

USER app
EXPOSE 8091
WORKDIR /app/external-rest-api
CMD ["node", "dist/main.js"]
