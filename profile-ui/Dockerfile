FROM node:24-alpine AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

FROM node:24-alpine
RUN addgroup -S app && adduser -S app -G app
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3001

COPY --from=builder --chown=app:app /app/package*.json ./
COPY --from=builder --chown=app:app /app/.next ./.next
COPY --from=builder --chown=app:app /app/node_modules ./node_modules
COPY --from=builder --chown=app:app /app/next.config.js ./next.config.js
COPY --from=builder --chown=app:app /app/public ./public

USER app
EXPOSE 3001
CMD ["npm", "run", "start"]
