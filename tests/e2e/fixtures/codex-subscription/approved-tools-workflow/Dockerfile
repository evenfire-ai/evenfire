# Harness supplies the exact branch-owned image with the real Workflow SDK.
ARG WORKFLOW_CUSTOM_SDK_IMAGE
FROM ${WORKFLOW_CUSTOM_SDK_IMAGE}
LABEL ai.evenfire.test-only="approved-tools-workflow"
WORKDIR /app
COPY tests/e2e/fixtures/codex-subscription/approved-tools-workflow/index.js ./index.js
CMD ["node", "index.js"]
