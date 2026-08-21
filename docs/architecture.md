# Architecture

Ce document explique **pourquoi** le service est construit ainsi. Le « comment l'exploiter » est dans [
`operations.md`](operations.md), le « comment le mettre en ligne » dans [
`runbook-production.md`](runbook-production.md).

## Le problème

HelloAsso encaisse les cotisations. Notion tient la liste des membres. Personne n'a envie de reporter les paiements à la
main, et un report manuel se fait toujours en retard, parfois jamais.

HelloAsso sait notifier un serveur à chaque paiement. Trois contraintes en découlent :

1. **Les comptes association ne signent pas leurs notifications.** Pas de HMAC, pas de signature à vérifier. N'importe
   qui connaissant l'URL peut poster n'importe quoi.
2. **HelloAsso rejoue.** Tant qu'il n'obtient pas de 2xx, il relivre la notification. C'est sa garantie de fiabilité —
   et donc la nôtre, à condition de savoir encaisser les doublons.
3. **Le temps de réponse est borné** (~15 s). Au-delà, la livraison est comptée en échec et rejouée.

Le service est entièrement dessiné par ces trois contraintes.

## Le flux

```
POST /webhook/:secret
  │
  ├─ secret comparé à temps constant ─────────────── ✗ → 401
  ├─ corps JSON valide ? ─────────────────────────── ✗ → 400
  ├─ eventType = "Payment" ? ─────────────────────── ✗ → 200 ignored
  ├─ campagne dans le périmètre ? (pré-filtre) ───── ✗ → 200 ignored
  │
  ├─ 1. déjà dans processed_payments ? ───────────── ✓ → 200 already_handled
  ├─ 2. GET /v5/payments/{id} ← fait autorité
  ├─ 3. campagne + statut confirmés ? ────────────── ✗ → 200 ignored
  ├─ 4. email ou identité du payeur exploitable ? ── ✗ → 200 data_error + alerte
  ├─ 5. Notion : filtre email equals
  │     puis, si 0 ligne, balayage : email, sinon
  │     prénom + nom, comparés normalisés ───────── 0 → 200 unmatched + alerte
  ├─ 6. Notion : PATCH checkbox = true   (× n lignes)
  ├─ 7. INSERT processed_payments ON CONFLICT DO NOTHING
  └─────────────────────────────────────────────────── → 200 updated
```

Toute panne passagère à n'importe quelle étape interrompt le flux et renvoie **503**.

## Décisions

### Ne jamais faire confiance au payload

Le payload n'a aucune authenticité : sans signature, il n'établit rien. Il sert uniquement à savoir **de quel paiement
on parle**. La décision d'écrire dans Notion se prend exclusivement sur la réponse de `GET /v5/payments/{id}`,
authentifiée en OAuth2.

Conséquence pratique : un test vérifie explicitement qu'un payload annonçant
`Authorized` alors que HelloAsso répond `Refused` n'écrit rien.

### Le secret d'URL

C'est la seule barrière disponible. Elle est traitée en conséquence :

- longueur minimale de 24 caractères, imposée par la validation de configuration ;
- comparaison à temps constant sur les empreintes SHA-256 des deux chaînes (comparer les longueurs d'abord, comme
  l'exige `timingSafeEqual`, divulguerait la longueur du secret) ;
- Caddy configuré pour ne pas journaliser le chemin des requêtes, qui contient ce secret.

### Trois classes d'erreur, trois comportements

Le choix du code HTTP n'est pas cosmétique : il décide si HelloAsso rejoue.

| Classe           | Réponse | Rejeu | Exemples                                             |
| ---------------- | ------- | ----- | ---------------------------------------------------- |
| `TransientError` | 503     | oui   | réseau coupé, 5xx amont, quota, timeout, Supabase HS |
| `DataError`      | 200     | non   | email inconnu de Notion, propriété inexistante       |
| `ConfigError`    | —       | —     | jetée au démarrage, le process refuse de se lancer   |

La règle qui en découle est volontairement simple à tenir :
`processWebhook` ne lève **que** des `TransientError`. Tout le reste devient un
`ProcessOutcome`. Le handler HTTP applique donc : _ça revient → 200 ; ça lève → 503_.

Un cas mérite d'être signalé parce qu'il surprend : **une erreur d'autorisation Notion (`unauthorized`,
`restricted_resource`) est classée passagère.** Elle ne se réparera pourtant pas toute seule. Mais répondre 200
accuserait réception d'un paiement non traité, et il serait perdu sans trace ; répondre 503 fait rejouer HelloAsso
pendant qu'un humain reconnecte l'intégration. On préfère un rejeu inutile à un paiement perdu.

### Idempotence avant réconciliation

La vérification d'idempotence (4) passe avant la réconciliation (3), et c'est délibéré.

Le rejeu est le cas **le plus fréquent** en régime normal — c'est le mécanisme même de HelloAsso. Consulter d'abord
`processed_payments` permet de répondre
`already_handled` sans aucun appel sortant : ni jeton OAuth, ni lecture de paiement.

Cela n'affaiblit rien. L'identifiant du payload n'est utilisé ici que pour **ne rien faire**. Le pire scénario —
quelqu'un qui posterait l'identifiant d'un paiement déjà traité — obtient un 200 et aucun effet. Aucun chemin d'écriture
ne dépend d'une donnée non réconciliée.

### Ordre d'écriture : Notion puis Supabase

Le paiement est marqué comme traité **après** l'écriture dans Notion.

- Crash entre les deux → le rejeu recoche une case déjà cochée, opération idempotente et donc sans effet.
- L'ordre inverse perdrait l'écriture Notion pour de bon.

Le premier risque est bénin, le second ne l'est pas.

Corollaire : un paiement **non apparié** (`unmatched`) n'est pas enregistré. Si la ligne Notion du membre est créée plus
tard, un rejeu manuel aboutira. Voir
[`operations.md`](operations.md).

### Le pré-filtre de campagne

Deux passages sur la même fonction pure `matchesCampaign` :

- sur le payload, avant tout appel sortant — purement économique, il évite un aller-retour OAuth pour une notification
  hors périmètre ;
- sur le paiement réconcilié — celui-là fait foi.

La fonction est **permissive sur l'absence et stricte sur le désaccord** : si HelloAsso cesse de renvoyer `formSlug`, le
service continue de fonctionner plutôt que de rejeter silencieusement tous les paiements. S'il renvoie un slug qui ne
correspond pas, il rejette.

### Budget de temps

`PROCESS_TIMEOUT_MS` (12 s par défaut) borne le traitement complet d'une notification, sous la limite de ~15 s de
HelloAsso. `HTTP_TIMEOUT_MS` (8 s)
borne chaque appel sortant individuellement.

Le `AbortSignal` est créé dans le handler et traverse tous les ports.
`helloasso.ts` le combine avec `AbortSignal.timeout` via `AbortSignal.any`.

Le SDK Notion, lui, n'accepte pas de signal. Deux garde-fous le remplacent :
`timeoutMs` passé au constructeur du client borne chaque requête HTTP, et un
`signal.throwIfAborted()` précède chaque appel — ce qui borne la boucle de pagination et la série de mises à jour.

### Ports et adaptateurs

`processPayment.ts` ne connaît ni HTTP, ni Notion, ni Supabase. Il reçoit quatre ports (`HelloAssoPort`, `NotionPort`,
`DedupPort`, `AlertPort`) et rend un
`ProcessOutcome`.

Notion et Supabase vont plus loin : chacun expose une interface réduite à ce que le service utilise vraiment
(`NotionApi` : deux méthodes ; `DedupApi` : deux méthodes), plus un adaptateur qui traduit le SDK. Le SDK est ainsi
confiné à une douzaine de lignes, et la logique de classement des erreurs se teste sans réseau.

C'est ce découpage qui permet aux 83 tests de couvrir la totalité des chemins — ignoré, déjà traité, statut refusé, non
apparié, plusieurs lignes, panne passagère, ordre d'écriture — sans ouvrir un seul port ni une seule connexion.

### Le schéma Supabase dédié

`helloasso.processed_payments` plutôt que `public.processed_payments` :

- `public` est régénéré dans `@davincibot/database-types` et diffusé aux quatre applications, qui n'ont rien à faire de
  cette table ; l'y mettre imposerait un
  `types:gen` et un changeset à chaque fois ;
- la convention du projet est déjà un schéma par domaine (`cash`, `formation`,
  `sso`).

Le nom du schéma n'est volontairement **pas** configurable : il est fixé par la migration, et un service pointant vers
un autre schéma que celui qu'il a créé n'aurait pas de sens. Le rendre variable coûterait le typage exact du client
Supabase — `SupabaseClient` indexé par `string` résout chaque ligne en `never` — pour une flexibilité que personne
n'utiliserait.

### `NOTION_DATA_SOURCE_ID`

Le service interroge une **source de données**, pas une base et pas une vue.

Depuis l'API `2025-09-03`, une base Notion n'est plus qu'un contenant : ce sont ses sources de données qui portent les
propriétés et les lignes, et `POST /v1/data_sources/{id}/query` remplace l'ancien
`POST /v1/databases/{id}/query`. Une base peut en compter plusieurs ; désigner la base laissait Notion en choisir une —
la première — ce qui n'est un comportement acceptable que tant que personne n'en ajoute une seconde.

La configuration nomme donc directement la source à interroger. On aurait pu ne demander que l'id de la base et résoudre
la source au démarrage via `databases.retrieve`, mais cela ajouterait un appel réseau au boot, un mode de panne
supplémentaire, et rendrait arbitraire le choix parmi plusieurs sources — pour économiser une ligne de `.env` relevée
une fois.

L'id se relève dans le menu `•••` de la base → **Manage data sources** → **Copy data source ID** (voir
[`runbook-production.md`](runbook-production.md) § 1.3).

`NOTION_VERSION` est validée au démarrage : une version antérieure à `2025-09-03` ne connaît pas les sources de données
et est refusée, plutôt que de laisser chaque recherche échouer sur un `validation_error` opaque.

### `NOTION_EMAIL_PROPERTY_TYPE`

Le filtre de `dataSources.query` n'a pas la même forme selon le type de la propriété :

```json
{
  "property": "Email",
  "email": {
    "equals": "a@b.fr"
  }
}
{
  "property": "Email",
  "rich_text": {
    "equals": "a@b.fr"
  }
}
{
  "property": "Nom",
  "title": {
    "equals": "a@b.fr"
  }
}
```

Se tromper donne un `validation_error` opaque côté Notion. Comme la base existante peut parfaitement stocker les emails
dans une colonne texte, le type est une variable d'environnement plutôt qu'une supposition.

## Déploiement

Le service se conforme aux conventions d'infrastructure de DaVinciBot plutôt que d'y faire exception.

| Convention de la flotte                          | Application ici                                                  |
| ------------------------------------------------ | ---------------------------------------------------------------- |
| réseau Docker `web`, externe                     | `deploy/*/docker-compose.yml`                                    |
| `/srv/<service>/<env>/{.env,docker-compose.yml}` | `/srv/hook/staging`, `/srv/hook/prod`                            |
| `name:` et `container_name: <svc>-<env>`         | `hook-staging`, `hook-prod`                                      |
| image `ghcr.io/davincibot/<repo>:<branche>`      | `:staging`, `:main`, plus `:sha-<commit>` pour le retour arrière |
| Caddy en conteneur, `caddy:2`                    | blocs ajoutés à `/srv/proxy/Caddyfile`                           |
| Watchtower `--http-api-update --label-enable`    | label `com.centurylinklabs.watchtower.enable=true`               |
| `DaVinciBot/shared-workflows@v6.1.1`             | `ci.yml`, `container.yml`, `deploy.yml`, `security-scan.yml`     |

Deux conséquences méritent d'être explicites.

**Watchtower ne surveille rien.** Il n'y a pas de polling : CI appelle
`POST deploy.davincibot.fr/v1/update` avec le nom d'image à rafraîchir, puis sonde `/health` jusqu'à obtenir 200. Un
déploiement qui ne revient pas fait échouer le job — il ne passe pas inaperçu. Corollaire : un conteneur doit
**exister** pour être mis à jour, donc le tout premier démarrage de chaque environnement se fait à la main sur le VPS.

**`/health` est public.** C'est cette URL que sonde le workflow de déploiement, depuis les runners GitHub. Elle ne
divulgue rien : ni version, ni configuration, ni état des dépendances — seulement que le process répond.

En revanche, le chemin des requêtes est **expurgé des journaux Caddy** : il contient le secret du webhook. C'est la
seule différence de configuration entre ces hôtes et les autres du `Caddyfile`.

L'image reprend le `Dockerfile` de `auth` : même base `node:24.11.0-slim`, mêmes deux étages `pnpm install`, même
retrait de npm/npx/corepack et même
`apt-get upgrade` — sans lesquels le scan Trivy de `container.yml`, qui échoue sur toute CVE CRITICAL corrigeable,
bloquerait la publication. Elle y ajoute
`USER node` et un `HEALTHCHECK`.

### Autres choix d'implémentation

| Choix                                             | Pourquoi                                                                                                    |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `index.ts` = app + route, `server.ts` = démarrage | permet à Vitest d'instancier l'app sans ouvrir de port                                                      |
| migration dans `DaVinciBot/Supabased`             | choix d'exploitation : toutes les migrations de l'association au même endroit                               |
| étage `pnpm install --prod` dédié au `Dockerfile` | `pnpm deploy` suppose un workspace ; `--legacy` est en voie de retrait. C'est aussi ce que fait `auth`      |
| `node:24.11.0-slim`, utilisateur `node`           | le runbook a besoin d'un shell pour le diagnostic ; c'est aussi la base du reste de la flotte               |
| `deploy/staging/` et `deploy/prod/`               | la flotte range un compose par environnement sous `/srv/<service>/<env>/`                                   |
| `DaVinciBot/shared-workflows@v6.1.1`              | le déclenchement Watchtower, les tags et la sonde y sont déjà encodés ; les réécrire garantissait la dérive |
| schéma Supabase fixé à `helloasso`                | le rendre configurable serait une flexibilité factice, incompatible avec le typage du client Supabase       |

## Dépendances externes

| Service         | Rôle                       | Panne = ?                               |
| --------------- | -------------------------- | --------------------------------------- |
| API HelloAsso   | réconciliation du paiement | 503, rejeu                              |
| API Notion      | recherche et écriture      | 503, rejeu                              |
| Supabase        | idempotence                | 503, rejeu — sans elle, aucune garantie |
| Webhook Discord | alerte humaine             | ignorée, seulement journalisée          |

L'alerte est la seule dépendance dont l'échec n'interrompt rien : elle ne doit jamais faire échouer un paiement par
ailleurs correctement traité.
