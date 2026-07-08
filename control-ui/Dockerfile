FROM node:24-alpine AS builder
WORKDIR /app

ARG CONTROL_API_INTERNAL_URL=http://control-api.control-plane.svc.cluster.local:8090
ARG NEXT_PUBLIC_CLERUM_ENABLE_LOCAL_TEMPLATES=false
ENV CONTROL_API_INTERNAL_URL=${CONTROL_API_INTERNAL_URL}
ENV NEXT_PUBLIC_CLERUM_ENABLE_LOCAL_TEMPLATES=${NEXT_PUBLIC_CLERUM_ENABLE_LOCAL_TEMPLATES}

COPY packages/workflow-recipe-capability-policy ./packages/workflow-recipe-capability-policy
COPY control-ui/package*.json ./control-ui/
WORKDIR /app/control-ui
RUN npm ci \
  && rm -rf node_modules/@clerum/workflow-recipe-capability-policy \
  && mkdir -p node_modules/@clerum \
  && cp -R ../packages/workflow-recipe-capability-policy node_modules/@clerum/workflow-recipe-capability-policy

COPY control-ui ./
RUN npm run build

FROM node:24-alpine
RUN addgroup -S app && adduser -S app -G app
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

COPY --from=builder --chown=app:app /app/packages ./packages
COPY --from=builder --chown=app:app /app/control-ui/package*.json ./control-ui/
COPY --from=builder --chown=app:app /app/control-ui/.next ./control-ui/.next
COPY --from=builder --chown=app:app /app/control-ui/public ./control-ui/public
COPY --from=builder --chown=app:app /app/control-ui/node_modules ./control-ui/node_modules
COPY --from=builder --chown=app:app /app/control-ui/next.config.js ./control-ui/next.config.js

EXPOSE 3000
USER app
WORKDIR /app/control-ui

CMD ["npm", "run", "start"]
