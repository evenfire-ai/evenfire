# BUILD CONTEXT = repo root. The proxy consumes
# @clerum/grok-provider-attempt-contract via file:.
FROM node:24.22.3-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5 AS builder

WORKDIR /app
COPY packages/grok-provider-attempt-contract ./packages/grok-provider-attempt-contract
COPY grok-llm-proxy/package*.json ./grok-llm-proxy/
WORKDIR /app/grok-llm-proxy
RUN npm ci
COPY grok-llm-proxy/tsconfig.json grok-llm-proxy/tsconfig.build.json ./
COPY grok-llm-proxy/src ./src
RUN npm run build

FROM node:24.22.3-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5

WORKDIR /app
COPY packages/grok-provider-attempt-contract ./packages/grok-provider-attempt-contract
COPY grok-llm-proxy/package*.json ./grok-llm-proxy/
WORKDIR /app/grok-llm-proxy
RUN npm ci --only=production
COPY --from=builder /app/grok-llm-proxy/dist ./dist

RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001
USER nodejs

EXPOSE 8080 8081 9090
CMD ["node", "dist/main.js"]
