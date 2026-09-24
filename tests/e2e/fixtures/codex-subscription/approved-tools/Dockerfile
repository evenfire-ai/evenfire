FROM node:24-alpine
WORKDIR /app
COPY tests/e2e/fixtures/codex-subscription/approved-tools/server.mjs ./server.mjs
USER node
ENV BIND_ADDRESS=0.0.0.0 PORT=8080
EXPOSE 8080
CMD ["node", "server.mjs"]
