FROM node:24.22.1-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS node-runtime

FROM mcr.microsoft.com/playwright/mcp@sha256:a9d607e571d70954acc36de7a45e7f424a94cebdfba973b1f404435108c60f3f
# The pinned MCP image bundles Node 22.22.0. Keep its browser dependencies
# and application, but run them with the patched official glibc Node binary.
COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
ENV NODE_VERSION=24.22.1
RUN node -e "if (process.versions.node !== '24.22.1') throw new Error('Unexpected Node runtime')"
RUN node /app/node_modules/playwright/cli.js install chromium
