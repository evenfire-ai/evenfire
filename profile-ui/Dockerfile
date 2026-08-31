FROM node:24-alpine AS builder
WORKDIR /app

COPY packages/desktop-app-links ./packages/desktop-app-links
COPY packages/frontend-table-system ./packages/frontend-table-system
COPY profile-ui/package*.json ./profile-ui/
WORKDIR /app/profile-ui
# Next's bundler does not follow file: symlinks reliably, so materialize the
# shared package as a real copy inside node_modules.
RUN npm ci \
  && rm -rf node_modules/@clerum/desktop-app-links \
  && mkdir -p node_modules/@clerum \
  && cp -R ../packages/desktop-app-links node_modules/@clerum/desktop-app-links \
  && rm -rf node_modules/@clerum/frontend-table-system \
  && cp -R ../packages/frontend-table-system node_modules/@clerum/frontend-table-system

COPY profile-ui ./
RUN npm run build

FROM node:24-alpine
RUN addgroup -S app && adduser -S app -G app
WORKDIR /app/profile-ui

ENV NODE_ENV=production
ENV PORT=3001

COPY --from=builder --chown=app:app /app/packages /app/packages
COPY --from=builder --chown=app:app /app/profile-ui/package*.json ./
COPY --from=builder --chown=app:app /app/profile-ui/.next ./.next
COPY --from=builder --chown=app:app /app/profile-ui/node_modules ./node_modules
COPY --from=builder --chown=app:app /app/profile-ui/next.config.js ./next.config.js
COPY --from=builder --chown=app:app /app/profile-ui/public ./public

USER app
EXPOSE 3001
CMD ["npm", "run", "start"]
