# Build context: repository root. The harness must provide its exact freshly
# built branch-owned production proxy image, which remains unchanged.
ARG CODEX_PROXY_IMAGE
FROM ${CODEX_PROXY_IMAGE}
LABEL ai.evenfire.test-only="approved-tools-minikube"
WORKDIR /app/codex-llm-proxy
COPY codex-llm-proxy/test/approvedToolsUpstream.ts ./test/approvedToolsUpstream.ts
COPY tests/e2e/fixtures/codex-subscription/approved-tools-proxy/entrypoint.mjs ./approved-tools-entrypoint.mjs
CMD ["node", "approved-tools-entrypoint.mjs"]
