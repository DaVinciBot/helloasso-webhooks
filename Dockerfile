# syntax=docker/dockerfile:1

# Image du service helloasso-webhooks.
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

# Correctifs de sécurité de la base Debian : l'image node officielle traîne
# perl-base et consorts en version vulnérable. Puis retrait de npm/corepack,
# inutiles au runtime.
#
# Mise à jour ciblée plutôt qu'`apt-get upgrade` global : patcher un paquet
# depuis une couche dérivée y recopie l'original hérité de la couche de base,
# que dive compte en octets gaspillés. L'upgrade global en dupliquerait 92 Mo —
# libc6, tzdata et perl-base en tête — alors que libc6 et tzdata, les deux plus
# gros, n'ont aucune CVE corrigée. Cette liste est exactement ce que trivy
# signale en HIGH/CRITICAL avec un correctif disponible : l'étendre quand le
# scan d'image en signale un nouveau, et retirer ce que la base finit par
# embarquer d'elle-même.
#
# DL3008 : pas de version épinglée, le but est justement de prendre le dernier
# correctif publié ; un pin le figerait et casserait dès que Debian retire la
# version du miroir.
# hadolint ignore=DL3008
RUN apt-get update \
	&& apt-get install -y --no-install-recommends --only-upgrade \
		perl-base \
		libssl3t64 \
		openssl-provider-legacy \
		libsqlite3-0 \
		libpcre2-8-0 \
		gzip \
		util-linux \
		mount \
		login \
		bsdutils \
		libuuid1 \
		libblkid1 \
		libmount1 \
		libsmartcols1 \
		liblastlog2-2 \
	&& apt-get clean \
	&& rm -rf \
		/var/lib/apt/lists/* \
		/var/cache/apt/archives/* \
		/var/cache/debconf/*-old \
		/var/lib/dpkg/*-old \
		/var/log/apt/* \
		/var/log/dpkg.log \
		/var/log/alternatives.log \
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
