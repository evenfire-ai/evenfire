# BUILD CONTEXT = repo root. The proxy consumes
# @clerum/llm-provider-attempt-contract via file:.
FROM node:24.22.1-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53 AS builder

WORKDIR /app
COPY packages/llm-provider-attempt-contract ./packages/llm-provider-attempt-contract
COPY codex-llm-proxy/package*.json ./codex-llm-proxy/
WORKDIR /app/codex-llm-proxy
RUN npm ci
COPY codex-llm-proxy/tsconfig.json codex-llm-proxy/tsconfig.build.json ./
COPY codex-llm-proxy/src ./src
RUN npm run build

FROM node:24.22.1-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53

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
