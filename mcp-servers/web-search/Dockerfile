ARG NODE_IMAGE=node:24-alpine
FROM ${NODE_IMAGE} AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

FROM ${NODE_IMAGE}
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./
ENV PORT=3000
EXPOSE 3000
CMD ["node", "dist/index.js"]
