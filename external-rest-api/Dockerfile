FROM node:24-alpine AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build
RUN npm prune --production

FROM node:24-alpine
RUN addgroup -S app && adduser -S app -G app
WORKDIR /app

ENV NODE_ENV=production
ENV EXTERNAL_REST_API_PORT=8091

COPY --from=builder --chown=app:app /app/package*.json ./
COPY --from=builder --chown=app:app /app/dist ./dist
COPY --from=builder --chown=app:app /app/node_modules ./node_modules

# The commit this image was built from, stamped by build-publish.yml with the
# same value it puts in the org.opencontainers.image.revision label. Baked into
# the image rather than injected at deploy time so it travels with the artifact:
# dev pins a moving `latest`, prod deploys from a separate repo, and only some
# services are rebuilt per push, so any deploy-time value would misreport the
# moment one image lagged behind.
#
# Declared last on purpose. It changes on every commit, so an earlier position
# would invalidate the COPY layers above it and defeat the build cache.
ARG BUILD_REVISION=""
ENV BUILD_REVISION=$BUILD_REVISION

USER app
EXPOSE 8091
CMD ["node", "dist/main.js"]
