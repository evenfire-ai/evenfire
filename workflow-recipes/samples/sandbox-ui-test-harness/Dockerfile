# Tiny static + tiny dynamic surface for the sandbox-ui test harness.
# - Serves /public/* with the right content-types
# - /api/whoami echoes the request headers (so we can prove rpc-proxy
#   stamps X-Clerum-User / X-Clerum-Recipe and strips client X-Clerum-*)
# - /redirect-internal returns 302 to /landing.html (proxy must rewrite
#   into the recipe's view/* prefix per spec §9.4)
# - /redirect-external returns 302 to https://example.com/ (proxy must
#   strip the off-origin Location and coerce to 200 per Decision 5)
FROM node:20-alpine

# node:alpine ships a `node` user (UID 1000) — sandbox-ui ns enforces
# runAsNonRoot, this saves us a per-workload security override.
USER node
WORKDIR /home/node/app

COPY --chown=node:node server.js ./
COPY --chown=node:node public ./public

EXPOSE 8080
CMD ["node", "server.js"]
