ARG TARGETARCH

# Chrome for Testing 157.0.8103.78 includes the Chromium fix for CVE-2026-125350.
FROM scratch AS chromium-amd64
ADD --chmod=0644 --checksum=sha256:f90329720fb61e5a76da9b6b509b6ad12a484c9c5df0359403e935177c6d153a https://storage.googleapis.com/chrome-for-testing-public/157.0.8103.78/linux64/chrome-headless-shell-linux64.zip /chrome-headless-shell.zip

FROM scratch AS chromium-arm64
ADD --chmod=0644 --checksum=sha256:912fbf877e53de34d7b3cca5104f3b95607d41bd35412ccc6cd2a599ff0c0dbf https://storage.googleapis.com/chrome-for-testing-public/157.0.8103.78/linux-arm64/chrome-headless-shell-linux-arm64.zip /chrome-headless-shell.zip

FROM chromium-${TARGETARCH} AS chromium-archive

FROM node:24.22.3-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS node-runtime

FROM mcr.microsoft.com/playwright/mcp@sha256:a9d607e571d70954acc36de7a45e7f424a94cebdfba973b1f404435108c60f3f
# The pinned MCP image bundles Node 22.22.0. Keep its browser dependencies
# and application, but run them with the patched official glibc Node binary.
COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
ENV NODE_VERSION=24.22.3
RUN node -e "if (process.versions.node !== '24.22.3') throw new Error('Unexpected Node runtime')"

ENV PLAYWRIGHT_MCP_EXECUTABLE_PATH=/home/node/chrome-headless-shell/chrome-headless-shell
RUN --mount=type=bind,from=chromium-archive,source=/chrome-headless-shell.zip,target=/tmp/chrome-headless-shell.zip \
    node --unhandled-rejections=strict -e 'require("/app/node_modules/playwright-core/lib/zipBundle").extract("/tmp/chrome-headless-shell.zip", { dir: "/home/node" })' \
    && mv /home/node/chrome-headless-shell-linux* /home/node/chrome-headless-shell \
    && test -x "$PLAYWRIGHT_MCP_EXECUTABLE_PATH"
