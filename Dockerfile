# syntax=docker/dockerfile:1

# Image du service webhook HelloAsso -> Notion.
#
# Structure multi-stage :
# - base      : environnement Node + pnpm
# - deps-prod : dépendances nécessaires au runtime uniquement
# - build     : dépendances complètes et compilation TypeScript
# - runtime   : image finale minimale
#
# Aucun secret n'est intégré à l'image. Les secrets applicatifs sont fournis
# au conteneur via ses variables d'environnement.

ARG NODE_VERSION=24.19.0

FROM node:${NODE_VERSION}-trixie-slim AS base

ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"

RUN corepack enable

WORKDIR /app

# --- Dépendances de production ------------------------------------------
FROM base AS deps-prod

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
	pnpm install --frozen-lockfile --prod --ignore-scripts

# --- Compilation --------------------------------------------------------
FROM base AS build

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
	pnpm install --frozen-lockfile

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src

RUN pnpm run build

# --- Image finale -------------------------------------------------------
FROM node:${NODE_VERSION}-trixie-slim AS runtime

ENV NODE_ENV=production
ENV PORT=3000

WORKDIR /app

RUN rm -rf \
	/usr/local/lib/node_modules/npm \
	/usr/local/lib/node_modules/corepack \
	/usr/local/bin/npm \
	/usr/local/bin/npx \
	/usr/local/bin/corepack

COPY --from=deps-prod --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./

# Utilisateur node : non privilégié fourni par l'image officielle.
USER 1000

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
	CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]

CMD ["node", "dist/server.js"]
