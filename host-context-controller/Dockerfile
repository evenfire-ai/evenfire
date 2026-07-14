FROM node:24-alpine AS builder

WORKDIR /app

# Copy package files
COPY packages/workflow-recipe-capability-policy ./packages/workflow-recipe-capability-policy
COPY packages/image-policy ./packages/image-policy
COPY host-context-controller/package*.json ./host-context-controller/
WORKDIR /app/host-context-controller

# Install dependencies
RUN npm ci

# Copy source
COPY host-context-controller/tsconfig.json host-context-controller/tsconfig.build.json ./
COPY host-context-controller/src ./src

# Build
RUN npm run build

# Production stage
FROM node:24-alpine

WORKDIR /app

# Copy package files and install production deps only
COPY packages/workflow-recipe-capability-policy ./packages/workflow-recipe-capability-policy
COPY packages/image-policy ./packages/image-policy
COPY host-context-controller/package*.json ./host-context-controller/
WORKDIR /app/host-context-controller
RUN npm ci --omit=dev

# Copy built files
COPY --from=builder /app/host-context-controller/dist ./dist

# Set non-root user
USER node

# Default port
EXPOSE 8081

CMD ["node", "dist/main.js"]
