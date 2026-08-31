# helloasso-webhooks

Micro-service HTTP mono-endpoint : il reçoit les notifications de paiement de HelloAsso, relit chaque paiement auprès de
l'API pour en avoir le cœur net, puis — **selon la campagne qui a encaissé** — en fait ce que l'association attend.

```
HelloAsso ──notification──▶ POST /webhook/<secret>
                                 │
                                 ├─ 1. déjà traité ?            Supabase
                                 ├─ 2. réconciliation            API HelloAsso v5
                                 ├─ 3. quel handler ?            la campagne décide
                                 │
                                 ├──▶ cotisation ──▶ ligne du membre cochée payée      Notion
                                 └──▶ WEI ─────────▶ places inscrites                  Supabase
                                                     arrivants + liste annoncés        Discord
```

Le service n'agit **jamais** sur la seule foi du payload reçu : celui-ci n'est pas signé, il ne sert qu'à savoir de quel
paiement on parle. Tout ce qui décide d'une action vient de `GET /v5/payments/{id}`, authentifié en OAuth2.

## Les deux flux

| Handler      | Campagne                          | Ce qu'il fait                                                                                             |
| ------------ | --------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `membership` | `MEMBERSHIP_FORM_TYPE` / `_SLUG`  | Indique « cotisation payée » sur la ligne Notion du membre et y porte le montant revenu à l'association   |
| `wei`        | `WEI_FORM_TYPE` / `WEI_FORM_SLUG` | Inscrit au registre chaque place de la commande, annonce les arrivants sur Discord avec la liste complète |

**Un handler dont le bloc de configuration est absent n'est pas câblé.** Le WEI s'éteint hors saison sans toucher au
code ; staging peut n'en activer qu'un. Au moins un doit rester actif, sinon le service refuse de démarrer.

Le routage préfère toujours le handler **le plus précis** — un slug bat un type, un type bat le vide. Un handler «
toutes les adhésions » ne peut donc pas capter par accident les paiements du WEI, quel que soit l'ordre de déclaration.

### Ce qu'annonce le flux WEI

> 🎒 **Lucie Martin** et **Tom Durand** viennent de prendre leur place au WEI !
>
> **Les inscrits — 23 / 60 places**
>
> 1. Inès Roche
> 2. …
>    **22. Lucie Martin**
>    **23. Tom Durand**
>
> _Il reste 37 places._

Les arrivants sont en gras : dans une liste de soixante noms, c'est la seule façon de voir d'un coup d'oeil qui vient de
s'ajouter. La liste vient du registre Supabase, qui donne l'ordre d'inscription.

Un **règlement échelonné** n'annonce qu'une fois : les échéances suivantes portent un autre identifiant de paiement mais
les mêmes lignes de commande, déjà inscrites.

## Documentation

| Document                                                   | Contenu                                                          |
| ---------------------------------------------------------- | ---------------------------------------------------------------- |
| [`docs/architecture.md`](docs/architecture.md)             | Décisions de conception, modèle handler, sémantique de rejeu     |
| [`docs/runbook-production.md`](docs/runbook-production.md) | Mise en production, étape par étape                              |
| [`docs/operations.md`](docs/operations.md)                 | Incidents courants, rejeu manuel, amorçage, rotation des secrets |
| [`docs/testing-sandbox.md`](docs/testing-sandbox.md)       | Test de bout en bout via le bac à sable HelloAsso et un tunnel   |

## Pile technique

TypeScript strict · [Hono](https://hono.dev) · Node 24 · pnpm · Zod ·
`@notionhq/client` · `@supabase/supabase-js` · pino · Vitest · ESLint `strict-type-checked` + Prettier.

## Structure

```
src/
  server.ts              entrée du process : env, config, câblage, arrêt
  wiring.ts              la configuration devient des handlers
  http/app.ts            Hono : auth, bornes, traduction résultat → HTTP
  core/                  le cœur commun, sans dépendance externe
    pipeline.ts            enveloppe → pré-filtre → réconciliation → routage → handler
    routing.ts             sélecteurs de campagne, règle de précision
    payment.ts             modèle du domaine, participants d'une commande
    identity.ts            normalisations, payeur vs inscrit
    config.ts  errors.ts  logger.ts  notification.ts
  handlers/              un fichier par usage
    types.ts               le contrat PaymentHandler
    membership.ts          cotisation → Notion
    wei.ts                 registre + annonce
  adapters/              le monde extérieur, confiné
    helloasso.ts  notion.ts  discord.ts
    supabase/{client,processedPayments,weiRegistry}.ts
  scripts/backfillWei.ts amorçage du registre
```

Ajouter un usage au service, c'est écrire un fichier dans `handlers/` et le déclarer dans `wiring.ts`. Le pipeline, le
routeur et la couche HTTP n'en savent rien et ne changent pas.

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

Envoyer une notification factice — les fixtures de test font l'affaire :

```bash
curl -X POST "http://localhost:3000/webhook/$WEBHOOK_SECRET" \
  -H 'content-type: application/json' \
  --data @tests/fixtures/payment.json      # cotisation

curl -X POST "http://localhost:3000/webhook/$WEBHOOK_SECRET" \
  -H 'content-type: application/json' \
  --data @tests/fixtures/wei-payment.json  # place de WEI
```

### Commandes

| Commande            | Effet                                        |
| ------------------- | -------------------------------------------- |
| `pnpm dev`          | serveur en rechargement à chaud              |
| `pnpm dev:pretty`   | idem, logs mis en forme par `pino-pretty`    |
| `pnpm build`        | compilation TypeScript vers `dist/`          |
| `pnpm start`        | exécution du build                           |
| `pnpm backfill:wei` | amorce le registre du WEI depuis HelloAsso   |
| `pnpm check`        | typage (`tsc --noEmit`)                      |
| `pnpm lint`         | Prettier + ESLint, zéro avertissement toléré |
| `pnpm format`       | réécriture Prettier + `eslint --fix`         |
| `pnpm test`         | Vitest                                       |
| `pnpm test:unit`    | Vitest avec couverture (seuil 80 %)          |
| `pnpm run ci`       | enchaîne check + lint + tests + build        |

> `pnpm run ci`, pas `pnpm ci` : `ci` est aussi une commande intégrée à pnpm,
> qui réinstallerait les dépendances au lieu de lancer le script.

## Configuration

Toutes les variables sont documentées dans [`.env.example`](.env.example) et validées au démarrage par
[`src/core/config.ts`](src/core/config.ts). Si l'une manque ou est invalide, le process **refuse de démarrer** et liste
d'un coup toutes les variables fautives.

Rien n'est codé en dur : ni les noms de propriétés Notion, ni les slugs de campagne, ni la capacité du séjour, ni les
URL d'API — le bac à sable HelloAsso s'active en changeant deux variables.

## Base de données

Le service écrit dans deux tables du schéma `helloasso` :

| Table                | Rôle                                                                                           |
| -------------------- | ---------------------------------------------------------------------------------------------- |
| `processed_payments` | Idempotence. Une ligne ⇒ ne rien refaire. La colonne `handler` dit quel flux a agi.            |
| `wei_registrations`  | Registre des places du WEI, une ligne par participant, clé sur la ligne de commande HelloAsso. |

Les migrations ne vivent **pas dans ce dépôt** mais dans
[`DaVinciBot/Supabased`](https://github.com/DaVinciBot/Supabased) :

- `supabase/migrations/20260817090000_helloasso_processed_payments.sql`
- `supabase/migrations/20260826090000_helloasso_handlers_and_wei.sql`

Pour les appliquer, depuis le dépôt `Supabased` :

```bash
supabase link --project-ref <ref-du-projet>
supabase db push
```

Le schéma `helloasso` doit ensuite figurer dans les « Exposed schemas » du projet Supabase, sinon PostgREST renvoie 404
sur chaque requête. Le détail est dans le [runbook](docs/runbook-production.md).

### Amorcer le registre du WEI

Si des places ont déjà été vendues avant la mise en service du flux, le service ne les a jamais vues passer. Un script
les rattrape depuis l'API HelloAsso :

```bash
pnpm backfill:wei --dry-run   # montre ce qui serait écrit
pnpm backfill:wei             # écrit
```

Rejouable sans précaution, et il **n'annonce rien** sur Discord : les lignes qu'il écrit portent un `payment_id` nul,
donc aucune annonce future ne les comptera parmi les arrivants.

## Tester avec le bac à sable HelloAsso

Le bac à sable (`helloasso-sandbox.com`, carte de test `4242 4242 4242 4242`) permet de dérouler un vrai paiement sans
mouvement d'argent. La procédure complète — création des formulaires, tunnel vers la machine locale, déclenchement de la
notification — est dans [`docs/testing-sandbox.md`](docs/testing-sandbox.md).

## Déploiement

Conteneur Docker sur le VPS `davincibot.fr`, derrière le Caddy de la flotte, aux mêmes conventions que les quatre
applications : réseau `web`, `/srv/<service>/<env>/`, image taguée par la branche, Watchtower déclenché par CI via son
API HTTP.

| Environnement | Hôte                         | Conteneur      | Branche   | Déploiement             |
| ------------- | ---------------------------- | -------------- | --------- | ----------------------- |
| staging       | `hook.staging.davincibot.fr` | `hook-staging` | `staging` | automatique             |
| prod          | `hook.davincibot.fr`         | `hook-prod`    | `main`    | manuel, sur approbation |

`staging` pointe vers le bac à sable HelloAsso, une base Notion de test et des salons Discord de test.

- [`Dockerfile`](Dockerfile) — multi-étages, utilisateur non root, `HEALTHCHECK`
- [`deploy/prod/`](deploy/prod/docker-compose.yml) et [`deploy/staging/`](deploy/staging/docker-compose.yml) — à copier
  dans `/srv/hook/<env>/`
- [`deploy/Caddyfile.snippet`](deploy/Caddyfile.snippet) — blocs à ajouter à `/srv/proxy/Caddyfile`
- [`.github/workflows/`](.github/workflows) — appellent `DaVinciBot/shared-workflows@v7.2.0`

La marche à suivre complète est dans [`docs/runbook-production.md`](docs/runbook-production.md).

## Sécurité

- Le secret dans l'URL est la seule barrière d'authentification : les comptes association HelloAsso ne signent pas leurs
  notifications (pas de HMAC). Il est comparé à temps constant et doit faire au moins 24 caractères.
- Caddy est configuré pour ne pas journaliser le chemin des requêtes — il contient ce secret.
- Aucun secret dans l'image ni dans le dépôt : tout par variables d'environnement.
- La clé `service_role` de Supabase contourne la RLS ; elle ne quitte jamais le conteneur.
- Les messages Discord partent avec `allowed_mentions: { parse: [] }` : un `@everyone` glissé dans un nom saisi chez
  HelloAsso ne sonnera pas.

## Améliorations

- Setup les variables via https://davincibot.fr/admin
