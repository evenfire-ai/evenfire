FROM node:24-alpine AS build

WORKDIR /app

COPY package.json package-lock.json tsconfig.json ./
RUN npm ci

COPY src ./src
RUN npm run build

FROM node:24-alpine AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY package.json ./
COPY --from=build /app/dist ./dist

USER node
EXPOSE 8098

CMD ["node", "dist/main.js"]
