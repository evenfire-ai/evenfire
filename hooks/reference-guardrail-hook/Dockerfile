# Reference guardrail hook — real `/v1` LLM-lane hook for E2E testing.
FROM node:24.22.1-alpine
WORKDIR /app
COPY server.js ./
ENV PORT=8080
EXPOSE 8080
USER node
CMD ["node", "server.js"]
