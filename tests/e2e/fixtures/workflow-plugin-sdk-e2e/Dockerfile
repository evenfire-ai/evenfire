FROM node:24-alpine

WORKDIR /app

COPY package.json ./
COPY src ./src

RUN addgroup -g 1001 -S sdk && adduser -S sdk -u 1001
USER sdk

# Zero runtime dependencies — Node 24 provides a global fetch.
CMD ["node", "src/index.js"]
