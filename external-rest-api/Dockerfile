FROM node:24-alpine AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
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

COPY --from=builder --chown=app:app /app/package*.json ./
COPY --from=builder --chown=app:app /app/dist ./dist
COPY --from=builder --chown=app:app /app/node_modules ./node_modules

USER app
EXPOSE 8091
CMD ["node", "dist/main.js"]
