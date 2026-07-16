FROM oven/bun:1.3.14 AS dependencies

WORKDIR /app

COPY . .

RUN bun install --frozen-lockfile

FROM dependencies AS build

RUN bun run build

FROM oven/bun:1.3.14 AS production-dependencies

WORKDIR /app

COPY . .

RUN bun install --production --frozen-lockfile

FROM node:24.18.0-bookworm-slim AS runtime

ENV NODE_ENV=production

RUN apt-get update \
    && apt-get install -y --no-install-recommends dumb-init \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=build --chown=node:node /app/package.json /app/bun.lock ./
COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/apps ./apps
COPY --from=build --chown=node:node /app/packages ./packages
COPY --from=build --chown=node:node /app/scripts ./scripts

USER node

EXPOSE 3000

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "scripts/aiflow-engine.cjs", "api"]
