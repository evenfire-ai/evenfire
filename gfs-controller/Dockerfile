FROM node:24-alpine AS builder

WORKDIR /app

COPY package*.json ./

RUN npm ci

COPY tsconfig.json ./
COPY src ./src

RUN npm run build

FROM node:24-alpine
ARG EVENFIRE_SOURCE_REVISION
ARG EVENFIRE_SERVICE_VERSION

WORKDIR /app
ENV EVENFIRE_SOURCE_REVISION=$EVENFIRE_SOURCE_REVISION
ENV EVENFIRE_IMAGE_REVISION=$EVENFIRE_SOURCE_REVISION
ENV EVENFIRE_SERVICE_VERSION=$EVENFIRE_SERVICE_VERSION

COPY package*.json ./
RUN npm ci --only=production

COPY --from=builder /app/dist ./dist

RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

USER nodejs

EXPOSE 8087

CMD ["node", "dist/index.js"]
