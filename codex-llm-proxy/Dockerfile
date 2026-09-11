# BUILD CONTEXT = repo root. The proxy consumes
# @clerum/llm-provider-attempt-contract via file:.
FROM node:24.16.0-alpine@sha256:21f403ab171f2dc89bad4dd69d7721bfd15f084ccb46cdd225f31f2bc59b5c9a AS builder

WORKDIR /app
COPY packages/llm-provider-attempt-contract ./packages/llm-provider-attempt-contract
COPY codex-llm-proxy/package*.json ./codex-llm-proxy/
WORKDIR /app/codex-llm-proxy
RUN npm ci
COPY codex-llm-proxy/tsconfig.json codex-llm-proxy/tsconfig.build.json ./
COPY codex-llm-proxy/src ./src
RUN npm run build

FROM node:24.16.0-alpine@sha256:21f403ab171f2dc89bad4dd69d7721bfd15f084ccb46cdd225f31f2bc59b5c9a

WORKDIR /app
COPY packages/llm-provider-attempt-contract ./packages/llm-provider-attempt-contract
COPY codex-llm-proxy/package*.json ./codex-llm-proxy/
WORKDIR /app/codex-llm-proxy
RUN npm ci --only=production
COPY --from=builder /app/codex-llm-proxy/dist ./dist

RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001
USER nodejs

EXPOSE 8080 8081 9090
CMD ["node", "dist/main.js"]
