FROM node:23.11-slim AS node_base
WORKDIR /app

FROM node_base AS builder
RUN npm install -g pnpm tsup typescript

COPY package.json pnpm-lock.yaml tsconfig.json ./
RUN --mount=type=cache,target=/root/.local/share/pnpm pnpm install --ignore-scripts

COPY . ./
RUN --mount=type=cache,target=/root/.local/share/pnpm pnpm run build

FROM node_base
RUN npm install -g pnpm
COPY package.json pnpm-lock.yaml ./
COPY --from=builder /app/dist ./dist
ENV NODE_ENV=production
RUN --mount=type=cache,target=/root/.local/share/pnpm pnpm install --prod --ignore-scripts
ENTRYPOINT ["node", "/app/dist/index.js"]