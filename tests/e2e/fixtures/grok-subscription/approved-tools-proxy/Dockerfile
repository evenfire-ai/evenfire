# Build context: repository root. The mutation-leased target supplies the base.
ARG GROK_PROXY_IMAGE
FROM ${GROK_PROXY_IMAGE}
LABEL ai.evenfire.test-only="approved-tools-minikube"
WORKDIR /app/grok-llm-proxy
COPY codex-llm-proxy/test/approvedToolsUpstream.ts ./test/approvedToolsUpstream.ts
COPY tests/e2e/fixtures/grok-subscription/approved-tools-proxy/entrypoint.mjs ./approved-tools-entrypoint.mjs
CMD ["node", "approved-tools-entrypoint.mjs"]
