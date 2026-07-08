FROM node:24-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:24-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist

RUN addgroup -g 1001 -S mcp && adduser -S mcp -u 1001
USER mcp

EXPOSE 3000 3001

CMD ["node", "dist/index.js"]
