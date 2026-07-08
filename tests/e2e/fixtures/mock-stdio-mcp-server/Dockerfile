FROM node:24-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:24-alpine
RUN addgroup -S mcp && adduser -S mcp -G mcp
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
# Create launcher script in /app so init container copies it with the app
RUN echo '#!/bin/sh' > /app/mcp-server && \
    echo 'SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"' >> /app/mcp-server && \
    echo 'exec node "${SCRIPT_DIR}/dist/index.js"' >> /app/mcp-server && \
    chmod +x /app/mcp-server
USER mcp
ENTRYPOINT ["node", "dist/index.js"]
