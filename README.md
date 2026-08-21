# helloasso-notion-webhook

Micro-service HTTP mono-endpoint : à chaque cotisation payée sur HelloAsso, il pose l'état « cotisation payée » sur la
ligne du membre dans une base Notion, appariée par adresse email.

```
HelloAsso ──notification──▶ POST /webhook/<secret>
                                 │
                                 ├─ 1. déjà traité ?          Supabase
                                 ├─ 2. réconciliation          API HelloAsso v5
                                 ├─ 3. recherche du membre     API Notion
                                 ├─ 4. état posé               API Notion
                                 └─ 5. mémorisé                Supabase
```

Le service n'écrit **jamais** dans Notion sur la seule foi du payload reçu : il relit systématiquement le paiement
auprès de l'API HelloAsso avant d'agir.

## Documentation

| Document                                                   | Contenu                                                               |
| ---------------------------------------------------------- | --------------------------------------------------------------------- |
| [`docs/architecture.md`](docs/architecture.md)             | Décisions de conception, sémantique de rejeu, budget de temps         |
| [`docs/runbook-production.md`](docs/runbook-production.md) | Mise en production, étape par étape, de zéro à la première cotisation |
| [`docs/operations.md`](docs/operations.md)                 | Incidents courants, rejeu manuel, rotation des secrets                |
| [`docs/testing-sandbox.md`](docs/testing-sandbox.md)       | Test de bout en bout via le bac à sable HelloAsso et un tunnel        |

## Pile technique

TypeScript strict · [Hono](https://hono.dev) · Node 24 · pnpm · Zod ·
`@notionhq/client` · `@supabase/supabase-js` · pino · Vitest · ESLint `strict-type-checked` + Prettier.

## Développement local

Prérequis : Node 24 (`.nvmrc`) et pnpm 11.

```bash
pnpm install
cp .env.example .env    # puis remplir les valeurs <À_REMPLIR>
pnpm dev                # http://localhost:3000
```

`pnpm dev` charge `.env` automatiquement (via `process.loadEnvFile`, aucune dépendance `dotenv`). En production,
`NODE_ENV=production` désactive ce chargement : les variables viennent de l'environnement du conteneur.

Vérifier que le service répond :

```bash
curl http://localhost:3000/health
# {"status":"ok"}
```

Envoyer une notification factice — la fixture de test fait l'affaire :

```bash
curl -X POST "http://localhost:3000/webhook/$WEBHOOK_SECRET" \
  -H 'content-type: application/json' \
  --data @tests/fixtures/payment.json
```

### Commandes

| Commande          | Effet                                        |
| ----------------- | -------------------------------------------- |
| `pnpm dev`        | serveur en rechargement à chaud              |
| `pnpm dev:pretty` | idem, logs mis en forme par `pino-pretty`    |
| `pnpm build`      | compilation TypeScript vers `dist/`          |
| `pnpm start`      | exécution du build                           |
| `pnpm check`      | typage (`tsc --noEmit`)                      |
| `pnpm lint`       | Prettier + ESLint, zéro avertissement toléré |
| `pnpm format`     | réécriture Prettier + `eslint --fix`         |
| `pnpm test`       | Vitest                                       |
| `pnpm test:unit`  | Vitest avec couverture (seuil 80 %)          |
| `pnpm run ci`     | enchaîne check + lint + tests + build        |

> `pnpm run ci`, pas `pnpm ci` : `ci` est aussi une commande intégrée à pnpm,
> qui réinstallerait les dépendances au lieu de lancer le script.

## Configuration

Toutes les variables sont documentées dans [`.env.example`](.env.example) et validées au démarrage par [
`src/config.ts`](src/config.ts). Si l'une manque ou est invalide, le process **refuse de démarrer** et liste d'un coup
toutes les variables fautives.

Rien n'est codé en dur : ni les noms de propriétés Notion, ni le slug de l'organisation, ni les URL d'API — le bac à
sable HelloAsso s'active en changeant deux variables.

## Base de données

Le service mémorise les paiements déjà traités dans
`helloasso.processed_payments`, une table du projet Supabase de production.

La migration ne vit **pas dans ce dépôt** mais dans
[`DaVinciBot/Supabased`](https://github.com/DaVinciBot/Supabased) :
`supabase/migrations/20260817090000_helloasso_processed_payments.sql`, avec toutes les autres migrations de
l'association.

Pour l'appliquer, depuis le dépôt `Supabased` :

```bash
supabase link --project-ref <ref-du-projet>
supabase db push
```

Le schéma `helloasso` doit ensuite être ajouté aux « Exposed schemas » du projet Supabase, sinon PostgREST renvoie 404
sur chaque requête. Le détail est dans le [runbook](docs/runbook-production.md).

## Tester avec le bac à sable HelloAsso

Le bac à sable (`helloasso-sandbox.com`, carte de test `4242 4242 4242 4242`)
permet de dérouler un vrai paiement sans mouvement d'argent. La procédure complète — création du formulaire, tunnel vers
la machine locale, déclenchement de la notification — est dans
[`docs/testing-sandbox.md`](docs/testing-sandbox.md).

## Déploiement

Conteneur Docker sur le VPS `davincibot.fr`, derrière le Caddy de la flotte, aux mêmes conventions que les quatre
applications : réseau `web`,
`/srv/<service>/<env>/`, image taguée par la branche, Watchtower déclenché par CI via son API HTTP.

| Environnement | Hôte                         | Conteneur      | Branche   | Déploiement             |
| ------------- | ---------------------------- | -------------- | --------- | ----------------------- |
| staging       | `hook.staging.davincibot.fr` | `hook-staging` | `staging` | automatique             |
| prod          | `hook.davincibot.fr`         | `hook-prod`    | `main`    | manuel, sur approbation |

`staging` pointe vers le bac à sable HelloAsso et une base Notion de test : on y déroule un vrai paiement sans mouvement
d'argent.

- [`Dockerfile`](Dockerfile) — multi-étages, utilisateur non root, `HEALTHCHECK`
- [`deploy/prod/`](deploy/prod/docker-compose.yml) et [`deploy/staging/`](deploy/staging/docker-compose.yml) — à copier
  dans `/srv/hook/<env>/`
- [`deploy/Caddyfile.snippet`](deploy/Caddyfile.snippet) — blocs à ajouter à `/srv/proxy/Caddyfile`
- [`.github/workflows/`](.github/workflows) — appellent `DaVinciBot/shared-workflows@v6.1.2`

La marche à suivre complète est dans
[`docs/runbook-production.md`](docs/runbook-production.md).

## Sécurité

- Le secret dans l'URL est la seule barrière d'authentification : les comptes association HelloAsso ne signent pas leurs
  notifications (pas de HMAC). Il est comparé à temps constant et doit faire au moins 24 caractères.
- Caddy est configuré pour ne pas journaliser le chemin des requêtes — il contient ce secret.
- Aucun secret dans l'image ni dans le dépôt : tout par variables d'environnement.
- La clé `service_role` de Supabase contourne la RLS ; elle ne quitte jamais le conteneur.
