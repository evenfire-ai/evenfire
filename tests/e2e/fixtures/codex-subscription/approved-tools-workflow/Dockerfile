# Harness supplies the exact branch-owned image with the real Workflow SDK.
ARG WORKFLOW_CUSTOM_SDK_IMAGE
FROM ${WORKFLOW_CUSTOM_SDK_IMAGE}
LABEL ai.evenfire.test-only="approved-tools-workflow"
WORKDIR /app
COPY tests/e2e/fixtures/codex-subscription/approved-tools-workflow/index.js ./index.js
# index.js requires the shared receipt contract as its repository sibling
# (../approved-tools/business-receipt.mjs), which resolves to this path.
COPY tests/e2e/fixtures/codex-subscription/approved-tools/business-receipt.mjs /approved-tools/business-receipt.mjs
CMD ["node", "index.js"]
