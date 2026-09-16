ARG CONTROL_API_IMAGE
FROM ${CONTROL_API_IMAGE}
LABEL ai.evenfire.test-only="approved-tools-minikube"
COPY tests/e2e/fixtures/codex-subscription/approved-tools-oauth/provider.mjs tests/e2e/fixtures/codex-subscription/approved-tools-oauth/entrypoint.mjs /app/approved-tools-oauth/
COPY tests/e2e/fixtures/codex-subscription/approved-tools-setup/identity-lifecycle.mjs /app/approved-tools-setup/identity-lifecycle.mjs
CMD ["node", "/app/approved-tools-oauth/entrypoint.mjs"]
