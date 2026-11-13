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

## Le pipeline

Chaque notification traverse [`src/core/pipeline.ts`](src/core/pipeline.ts), dans cet ordre :

1. **Enveloppe** — le corps est validé par Zod. Seuls les évènements `Payment` sont traités, plus les `Order` sans
   paiement (commande entièrement gratuite, une cotisation à 0 € après réduction par exemple) ; le reste est ignoré.
2. **Pré-filtre** sur le payload : organisation (`HELLOASSO_ORG_SLUG`) et campagne annoncées. Purement économique — il
   épargne un aller-retour OAuth aux paiements étrangers au service — et ne déclenche jamais d'action.
3. **Dédoublonnage** — `helloasso.processed_payments` est consulté avant toute relecture : un rejeu répond sans
   solliciter HelloAsso. La clé est le paiement seul (ou la commande, pour une commande gratuite).
4. **Réconciliation** — `GET /v5/payments/{id}` en OAuth2. À partir d'ici plus rien ne vient du payload :
   organisation, statut (`HELLOASSO_ACCEPTED_STATES`) et campagne sont revérifiés sur la réponse authentifiée.
5. **Routage** par campagne vers le handler le plus précis (voir ci-dessous), puis lecture de la commande, seule à
   porter l'identité des inscrits.
6. **Handler** — `membership` (Notion) ou `wei` (Supabase + Discord). Le paiement n'est marqué dans
   `processed_payments` qu'**après** l'action, et pas du tout si le handler n'a pas pu conclure : un rejeu refait
   alors une action idempotente plutôt que d'en perdre une.

Côté HTTP ([`src/http/app.ts`](src/http/app.ts)) la règle est unique : tout résultat, même « ignoré » ou « donnée
fautive », répond **200** ; une panne passagère répond **503** pour que HelloAsso rejoue, l'idempotence rendant le
rejeu sûr. Restent `401` (secret d'URL invalide), `400` (JSON illisible) et `413` (corps aberrant). Une donnée fautive
(cotisation sans ligne Notion, commande WEI sans participant identifiable…) part en alerte sur `ALERT_WEBHOOK_URL`.

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

| Bloc                                        | Variables                                                                                                                                                                                                                                                                                           |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Service                                     | `PORT`, `LOG_LEVEL`, `WEBHOOK_SECRET`                                                                                                                                                                                                                                                               |
| HelloAsso                                   | `HELLOASSO_CLIENT_ID`, `HELLOASSO_CLIENT_SECRET`, `HELLOASSO_ORG_SLUG`, `HELLOASSO_API_BASE`, `HELLOASSO_TOKEN_URL`, `HELLOASSO_ACCEPTED_STATES`                                                                                                                                                    |
| Supabase                                    | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`                                                                                                                                                                                                                                                         |
| Alertes                                     | `ALERT_WEBHOOK_URL` (vide = alertes seulement loggées)                                                                                                                                                                                                                                              |
| `membership`, activé par `NOTION_TOKEN`     | `MEMBERSHIP_FORM_TYPE`, `MEMBERSHIP_FORM_SLUG`, `NOTION_TOKEN`, `NOTION_DATA_SOURCE_ID`, `NOTION_VERSION`, `NOTION_EMAIL_PROPERTY`, `NOTION_EMAIL_PROPERTY_TYPE`, `NOTION_PAID_PROPERTY`, `NOTION_PAID_STATUS`, `NOTION_AMOUNT_PROPERTY`, `NOTION_FIRST_NAME_PROPERTY`, `NOTION_LAST_NAME_PROPERTY` |
| `wei`, activé par `WEI_DISCORD_WEBHOOK_URL` | `WEI_FORM_TYPE`, `WEI_FORM_SLUG` (obligatoire), `WEI_DISCORD_WEBHOOK_URL`, `WEI_CAPACITY`                                                                                                                                                                                                           |
| Délais                                      | `HTTP_TIMEOUT_MS` (8 s par défaut), `PROCESS_TIMEOUT_MS` (12 s, à garder sous la limite d'environ 15 s de HelloAsso)                                                                                                                                                                                |

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

## Tests

Vitest, environnement `node`. `tests/` reprend l'arborescence de `src/` (`adapters/`, `core/`, `handlers/`, `http/`,
`scripts/`, `wiring.test.ts`) ; le pipeline est testé de bout en bout sans réseau ni serveur, les adaptateurs étant des
ports. Les fixtures `tests/fixtures/payment.json` et `wei-payment.json` servent aussi aux `curl` du développement local.

`pnpm test:unit` mesure la couverture (v8) sur `src/**/*.ts`, hors `src/server.ts`, et échoue sous **80 %** en
instructions, branches, fonctions ou lignes.

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
- [`.github/workflows/`](.github/workflows) — appellent `DaVinciBot/shared-workflows@v7.2.0` (voir [CI](#ci))

Les déploiements sont **poussés**, pas sondés : le conteneur porte le label `com.centurylinklabs.watchtower.enable=true`
et ne publie aucun port (Caddy le joint par le réseau `web`). Après la publication de l'image, `deploy.yml` appelle
l'API HTTP de Watchtower (`POST /v1/update?image=ghcr.io/davincibot/helloasso-webhooks:<tag>`, secrets
`WATCHTOWER_URL` / `WATCHTOWER_TOKEN`), qui tire l'image et recrée le conteneur, puis attend que
`https://<hôte>/health` réponde 200. Le snippet Caddy expose `/health` et `/webhook/*` (corps limité à 256 Ko, 20 s de
délai de réponse), répond 404 au reste et expurge le chemin des journaux.

La marche à suivre complète est dans [`docs/runbook-production.md`](docs/runbook-production.md).

## CI

Tous les workflows appellent `DaVinciBot/shared-workflows@v7.2.0` et tournent sur `ubuntu-latest`, sur les branches
`staging`, `main`, `release/**` et `hotfix/**` :

| Workflow            | Déclencheur                                     | Rôle                                                                                                        |
| ------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `ci.yml`            | push et PR (changements Markdown seuls ignorés) | `pnpm check`, `pnpm lint`, `pnpm test:unit`, `pnpm build`                                                   |
| `container.yml`     | push, PR, tags `v*.*.*`                         | hadolint, build, dive, dockle, Trivy ; publication sur GHCR au push ; déploie staging au push sur `staging` |
| `deploy.yml`        | manuel (`workflow_dispatch`)                    | déploie `staging` ou `prod`, avec `image_tag` optionnel (`sha-<commit>` pour un rollback)                   |
| `security-scan.yml` | push, PR, chaque lundi, manuel                  | dependency review, Trivy sur le dépôt, checkov                                                              |

Les seuils des outils conteneur vivent à la racine : `.hadolint.yaml`, `.dive-ci`, `.dockleignore`, `.checkov.yaml`.
Dependabot propose chaque lundi les mises à jour des actions GitHub et des dépendances npm.

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
