FROM node:24-alpine AS sdk-builder

WORKDIR /app

COPY packages/workflow-runtime-core/package.json packages/workflow-runtime-core/package-lock.json ./packages/workflow-runtime-core/
COPY packages/workflow-runtime-core/tsconfig.json ./packages/workflow-runtime-core/
COPY packages/workflow-runtime-core/src ./packages/workflow-runtime-core/src
WORKDIR /app/packages/workflow-runtime-core
RUN npm ci && npm run build

WORKDIR /app
COPY packages/workflow-sdk/package.json packages/workflow-sdk/package-lock.json ./packages/workflow-sdk/
COPY packages/workflow-sdk/tsconfig.json ./packages/workflow-sdk/
COPY packages/workflow-sdk/src ./packages/workflow-sdk/src
WORKDIR /app/packages/workflow-sdk
RUN npm ci && npm run build:docker

FROM node:24-alpine

WORKDIR /app

COPY packages/workflow-runtime-core/package.json ./node_modules/@clerum/workflow-runtime-core/package.json
COPY --from=sdk-builder /app/packages/workflow-runtime-core/dist ./node_modules/@clerum/workflow-runtime-core/dist
COPY packages/workflow-sdk/package.json ./node_modules/@clerum/workflow-sdk/package.json
COPY --from=sdk-builder /app/packages/workflow-sdk/dist ./node_modules/@clerum/workflow-sdk/dist
COPY tests/e2e/fixtures/custom-workflow-coordinator/index.js ./index.js

RUN mkdir -p /output /tmp && \
    chown -R 1000:1000 /app /output /tmp

USER 1000:1000

EXPOSE 8090

CMD ["node", "index.js"]
