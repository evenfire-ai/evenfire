ARG MCP_HOST_IMAGE
FROM ${MCP_HOST_IMAGE}
LABEL ai.evenfire.test-only="image-capabilities-minikube"
COPY tests/e2e/fixtures/image-capabilities/provider.mjs tests/e2e/fixtures/image-capabilities/entrypoint.mjs /app/image-capabilities/
CMD ["node", "/app/image-capabilities/entrypoint.mjs"]
