# Test-only derivative of the actual owned proxy and normal Alpine/musl Host.
# The coordinator verifies both base image IDs against the exact-head manifest
# before/after building. Production dist and its dependencies stay byte-identical.
ARG PROXY_BASE_IMAGE
ARG HOST_BASE_IMAGE
FROM ${HOST_BASE_IMAGE} AS pixels
FROM ${PROXY_BASE_IMAGE}
ARG SOURCE_HEAD
LABEL org.evenfire.qa.subscription-image-source=${SOURCE_HEAD}
USER 0:0
COPY scripts/e2e/fixtures/subscription-image-provider.mjs \
     scripts/e2e/fixtures/subscription-image-decoder.mjs \
     scripts/e2e/fixtures/subscription-image-challenge.cjs /app/scripts/e2e/fixtures/
COPY packages/grok-provider-attempt-contract/ /app/packages/grok-provider-attempt-contract/
COPY --from=pixels /app/mcp-host/package.json /app/mcp-host/package.json
# @napi-rs/canvas selects the Host's installed platform addon. No glibc Desktop
# binary, package installation, lifecycle script or new project dependency.
COPY --from=pixels /app/mcp-host/node_modules/@napi-rs/ /app/mcp-host/node_modules/@napi-rs/
RUN mkdir -p /tmp/evenfire-vendor \
    && chown 1001:1001 /tmp/evenfire-vendor && chmod 0700 /tmp/evenfire-vendor \
    && chmod -R a+rX /app/scripts/e2e/fixtures /app/packages/grok-provider-attempt-contract /app/mcp-host \
    && node -e "if(process.versions.node.split('.')[0]!=='24'||process.report.getReport().header.glibcVersionRuntime)process.exit(1);require('/app/scripts/e2e/fixtures/subscription-image-challenge.cjs').requirePixelRenderer()"
USER 1001:1001
