# Runbook — mise en production

De zéro à la première cotisation marquée payée automatiquement, sur le VPS
`davincibot.fr` et selon les conventions de la flotte : réseau Docker `web`, Caddy en conteneur,
`/srv/<service>/<env>/`, Watchtower déclenché par CI.

Deux environnements :

| Environnement | Hôte                         | Conteneur      | Branche   | HelloAsso   |
|---------------|------------------------------|----------------|-----------|-------------|
| staging       | `hook.staging.davincibot.fr` | `hook-staging` | `staging` | bac à sable |
| prod          | `hook.davincibot.fr`         | `hook-prod`    | `main`    | production  |

Compter **une heure et demie**, dont beaucoup d'attente (DNS, première image). Déroule staging en entier d'abord : c'est
le brouillon de la production.

> Les valeurs à récupérer sont notées `<À_REMPLIR>`. Certaines ne s'affichent
> **qu'une fois** (secret client HelloAsso, clé service_role) — note-les au
> moment où elles apparaissent.

## Ce qu'il faut avant de commencer

| Accès                                                   | Pour quoi faire                           |
|---------------------------------------------------------|-------------------------------------------|
| Administrateur de l'espace Notion                       | créer l'intégration, lire l'id de base    |
| Administrateur du compte association HelloAsso          | créer le client API, déclarer l'URL       |
| Compte sur `helloasso-sandbox.com`                      | l'équivalent pour staging                 |
| Accès au projet Supabase de production                  | appliquer la migration                    |
| Administrateur de `DaVinciBot/helloasso-notion-webhook` | créer les environnements GitHub           |
| Accès en écriture à `DaVinciBot/Supabased`              | committer la migration                    |
| SSH sur le VPS `ubuntu-4gb-hel1-1`                      | créer les conteneurs, éditer le Caddyfile |
| Gestion DNS de `davincibot.fr`                          | créer les deux sous-domaines              |

---

## 1 — Notion : intégration, base, propriétés

**1.1** <https://www.notion.so/my-integrations> → **New integration**.

- Nom : `Cotisations HelloAsso`
- Type : **Internal**, espace de travail DaVinciBot
- Capacités : **Read content** et **Update content**. _Insert content_ est inutile — le service ne crée jamais de page.

Copie le **Internal Integration Secret** (commence par `ntn_`).

→ `NOTION_TOKEN` = `<À_REMPLIR>`

**1.2** Ouvre la base des membres en pleine page. Menu `•••` → **Connections** → **Connect to** →
`Cotisations HelloAsso`.

> Sans cette étape, l'API répond `object_not_found` sur une base qui existe
> pourtant. C'est l'oubli le plus fréquent.

**1.3** Relève l'id de la **source de données** : menu `•••` → **Manage data sources** → `•••` de la source → **Copy
data source ID**.

> Ce n'est **pas** l'id visible dans l'URL : celui-là désigne la base (le contenant), et le `?v=` une vue. Le service
> interroge la source de données, qui seule porte les lignes. Voir
> [`architecture.md`](architecture.md) § `NOTION_DATA_SOURCE_ID`.

→ `NOTION_DATA_SOURCE_ID` = `<À_REMPLIR>`

**1.4** Relève le **nom exact** de la propriété contenant l'email — casse, accents et espaces compris — et son **type**.

→ `NOTION_EMAIL_PROPERTY` = `<À_REMPLIR>`
→ `NOTION_EMAIL_PROPERTY_TYPE` = `email` \| `rich_text` \| `title`

**1.5** Vérifie qu'une propriété **Status** existe pour la cotisation, et relève le libellé exact de l'option à poser
quand elle est payée — accents et majuscules compris, elle est transmise telle quelle.

→ `NOTION_PAID_PROPERTY` = `<À_REMPLIR>`
→ `NOTION_PAID_STATUS` = `Payé`

**1.5 ter** Vérifie qu'une propriété **Number** existe pour le montant. Le service y écrit la part revenant à
l'association, en euros, à chaque paiement traité.

→ `NOTION_AMOUNT_PROPERTY` = `<À_REMPLIR>`

**1.5 bis — facultatif.** Relève les noms exacts des colonnes **prénom** et **nom**. Elles servent de repli quand aucune
ligne ne porte l'adresse du payeur ; leur type n'a pas à être déclaré. Les deux ou aucune : n'en renseigner qu'une est
refusé au démarrage.

→ `NOTION_FIRST_NAME_PROPERTY` = `<À_REMPLIR>` \| vide → `NOTION_LAST_NAME_PROPERTY` = `<À_REMPLIR>` \| vide

**1.6 — pour staging.** Duplique la base (`•••` → **Duplicate**), renomme-la
`Membres — test`, connecte-lui la même intégration, et garde-y deux ou trois lignes avec des adresses que tu contrôles.
Relève l'id de **sa** source de données comme en 1.3 — la copie a la sienne.

→ `NOTION_DATA_SOURCE_ID` (staging) = `<À_REMPLIR>`

---

## 2 — HelloAsso : clients API

**2.1 — production.** Espace d'administration de l'association → **Intégrations** → **API** → créer un client API. Le
secret n'est plus affiché ensuite.

→ `HELLOASSO_CLIENT_ID` = `<À_REMPLIR>`
→ `HELLOASSO_CLIENT_SECRET` = `<À_REMPLIR>`

**2.2** Slug de l'organisation, dans l'URL publique :

```
https://www.helloasso.com/associations/davincibot
                                       └── slug ──┘
```

→ `HELLOASSO_ORG_SLUG` = `<À_REMPLIR>`

**2.3** _(recommandé)_ Slug du formulaire de cotisation, pour restreindre le service à cette seule campagne :

```
https://www.helloasso.com/associations/davincibot/adhesions/adhesion-2026-2027
                                                            └────── slug ──────┘
```

→ `HELLOASSO_FORM_SLUG` = `<À_REMPLIR>` (vide = toutes les campagnes)

**2.4 — staging.** Même chose sur <https://www.helloasso-sandbox.com> : compte, association, formulaire d'adhésion,
client API. Les identifiants de production ne fonctionnent pas sur le bac à sable, et réciproquement.

→ jeu complet de variables `HELLOASSO_*` pour staging, avec :

```
HELLOASSO_API_BASE=https://api.helloasso-sandbox.com/v5
HELLOASSO_TOKEN_URL=https://api.helloasso-sandbox.com/oauth2/token
```

**Ne déclare pas encore les URL de notification.** Étape 11, quand elles existeront.

---

## 3 — Supabase : la migration

La table d'idempotence vit dans le projet Supabase de **production**, schéma
`helloasso`. La migration est versionnée dans `DaVinciBot/Supabased`.

**3.1** Depuis une copie à jour de ce dépôt :

```bash
cd Supabased
git pull
ls supabase/migrations/20260817090000_helloasso_processed_payments.sql
```

Si le fichier n'est pas sur `main`, committe-le et pousse-le avant de continuer.

**3.2** Applique-la :

```bash
supabase link --project-ref <ref-du-projet-prod>
supabase db push
```

`supabase db push` n'applique que les migrations absentes de l'historique distant : le relancer est sans risque.

**3.3 — Étape à ne pas sauter.** Dashboard Supabase → **Project Settings** → **API** → **Exposed schemas** → ajouter
`helloasso` → **Save**.

> Sans elle, chaque requête du service reçoit un 404, il classe la panne comme
> passagère et répond 503 en boucle. Aucune cotisation ne sera marquée.

**3.4** Vérifie depuis le SQL Editor :

```sql
SELECT *
    FROM helloasso.processed_payments;
-- 0 ligne, aucune erreur.
```

**3.5** Relève les identifiants — Dashboard → **Project Settings** → **API** :

→ `SUPABASE_URL` = `https://<ref-du-projet>.supabase.co`
→ `SUPABASE_SERVICE_ROLE_KEY` = `<À_REMPLIR>` (clé `service_role`, **pas** `anon`)

**3.6 — staging.** Deux options, au choix :

- **Le projet Supabase de développement** (`tlqaurcfisqkzhdzkdrk`) : applique-lui la même migration, et utilise ses
  identifiants. Isolation complète.
- **Le projet de production** : la table est partagée entre les deux environnements. Acceptable — les identifiants de
  paiement du bac à sable et de la production ne se recoupent pas — mais moins propre.

---

## 4 — Discord : le canal d'alerte

Quand un membre paie et qu'aucune ligne Notion ne porte son adresse, le service n'a rien à marquer. Ce n'est pas une
panne, c'est une donnée à corriger.

Serveur Discord → canal (`#tresorerie-alertes`) → **Modifier le canal** → **Intégrations** → **Créer un webhook** →
copier l'URL.

→ `ALERT_WEBHOOK_URL` = `<À_REMPLIR>` (vide pour désactiver ; l'évènement reste journalisé)

Un second webhook vers un canal technique pour staging évite de faire sonner la trésorerie à chaque test.

---

## 5 — Les secrets de webhook

**Un par environnement**, jamais le même :

```bash
openssl rand -hex 32   # prod
openssl rand -hex 32   # staging
```

→ `WEBHOOK_SECRET` = `<À_REMPLIR>` × 2

Ces secrets apparaissent dans les URL communiquées à HelloAsso. Ni ticket, ni message de commit, ni canal public.

---

## 6 — DNS

```
hook.davincibot.fr.           A   77.42.38.240
hook.staging.davincibot.fr.   A   77.42.38.240
```

Vérifie la propagation avant de toucher à Caddy — il lui faut un nom qui résout pour obtenir son certificat :

```bash
dig +short hook.davincibot.fr hook.staging.davincibot.fr
```

---

## 7 — GitHub : environnements et secrets

Les workflows `container.yml` et `deploy.yml` appellent
`DaVinciBot/shared-workflows@v6.2.0`, qui déclenche Watchtower puis sonde
`/health`. Deux prérequis côté dépôt.

**7.1** Settings → **Environments** → créer `staging` et `prod`.

Sur `prod`, coche **Required reviewers** et ajoute au moins une personne : c'est ce qui rend le déploiement de
production délibéré plutôt qu'accidentel.

**7.2** Vérifie que ces secrets se résolvent (organisation ou environnement) :

| Secret                | Valeur                                      |
|-----------------------|---------------------------------------------|
| `WATCHTOWER_URL`      | `https://deploy.davincibot.fr`              |
| `WATCHTOWER_TOKEN`    | `WATCHTOWER_HTTP_API_TOKEN` du VPS          |
| `PACKAGES_READ_TOKEN` | PAT `read:packages` (secret d'organisation) |

`PACKAGES_READ_TOKEN` est exigé par la signature du workflow partagé mais n'est pas utilisé ici : ce service n'a aucune
dépendance `@davincibot/*`.

---

## 8 — La première image

**8.1** Crée la branche `staging` et pousse-la :

```bash
git switch -c staging
git push -u origin staging
```

Le workflow **Container** enchaîne : CI (typage, lint, 83 tests, build), construction de l'image, scan Trivy, SBOM,
signature cosign, publication sous
`ghcr.io/davincibot/helloasso-notion-webhook:staging` et
`:sha-<commit>`.

**8.2** Le job **Deploy Staging** qui suit va **échouer ou avertir** — c'est normal : aucun conteneur `hook-staging`
n'existe encore, Watchtower n'a rien à mettre à jour. Le conteneur se crée à l'étape 9 ; les déploiements suivants
seront automatiques.

**8.3** Vérifie que l'image est publiée : onglet **Packages** du dépôt.

**8.4** Fusionne ensuite `staging` dans `main` pour publier le tag `:main`
attendu par la production.

---

## 9 — Les conteneurs sur le VPS

Connecte-toi en SSH. Le réseau `web` et Watchtower existent déjà.

**9.1** Crée l'arborescence, conforme à celle des autres services :

```bash
sudo mkdir -p /srv/hook/staging /srv/hook/prod
```

**9.2** Dépose les fichiers compose depuis le dépôt ([`deploy/staging/`](../deploy/staging/docker-compose.yml) et
[`deploy/prod/`](../deploy/prod/docker-compose.yml)) :

```bash
cd /srv/hook/staging
sudo curl -fsSL -o docker-compose.yml \
  https://raw.githubusercontent.com/DaVinciBot/helloasso-notion-webhook/main/deploy/staging/docker-compose.yml

cd /srv/hook/prod
sudo curl -fsSL -o docker-compose.yml \
  https://raw.githubusercontent.com/DaVinciBot/helloasso-notion-webhook/main/deploy/prod/docker-compose.yml
```

**9.3** Crée les deux `.env` à partir de [`.env.example`](../.env.example), en reportant les valeurs des étapes 1 à 5 —
**les valeurs bac à sable dans
`staging`, les valeurs de production dans `prod`** :

```bash
sudo nano /srv/hook/staging/.env
sudo nano /srv/hook/prod/.env
sudo chmod 600 /srv/hook/*/.env
```

**9.4** Démarre :

```bash
cd /srv/hook/staging && sudo docker compose up -d
cd /srv/hook/prod    && sudo docker compose up -d
```

Le premier `pull` fonctionne sans `docker login` : Watchtower monte déjà
`/config.json` avec les identifiants GHCR, mais le démon Docker, lui, a besoin des siens si le paquet est privé. Si le
`pull` échoue en `denied` :

```bash
echo "$GHCR_TOKEN" | sudo docker login ghcr.io -u "$GHCR_USER" --password-stdin
```

**9.5** Vérifie :

```bash
sudo docker compose -f /srv/hook/prod/docker-compose.yml logs -f
```

Attendu : une ligne `"msg":"service démarré"` récapitulant la configuration. Aucun secret n'y figure — la ligne est
faite pour être copiée dans un ticket.

Si le process s'arrête aussitôt sur `démarrage impossible`, le message liste **toutes** les variables fautives d'un
coup. Corrige et relance `up -d`.

```bash
sudo docker ps --filter name=hook- --format '{{.Names}}\t{{.Status}}'
# hook-prod      Up 30 seconds (healthy)
# hook-staging   Up 40 seconds (healthy)
```

---

## 10 — Caddy

**10.1** Ajoute les deux blocs de
[`deploy/Caddyfile.snippet`](../deploy/Caddyfile.snippet) à
`/srv/proxy/Caddyfile`.

Ils diffèrent des autres hôtes du fichier sur deux points, tous deux intentionnels :

- `/health` est exposé publiquement — `shared-workflows/deploy.yml` le sonde après chaque déploiement ;
- le chemin des requêtes est expurgé des journaux, puisqu'il contient le secret du webhook.

**10.2** Valide **avant** de recharger :

```bash
cd /srv/proxy
sudo docker compose exec caddy caddy validate --config /etc/caddy/Caddyfile
```

**10.3** Recharge sans couper les autres sites :

```bash
sudo docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile
```

**10.4** Vérifie. La sonde doit répondre, et un mauvais secret doit donner 401 — preuve que la requête traverse Caddy
jusqu'au service :

```bash
curl -s https://hook.davincibot.fr/health
# {"status":"ok"}

curl -s -o /dev/null -w '%{http_code}\n' \
  -X POST https://hook.davincibot.fr/webhook/mauvais-secret \
  -H 'content-type: application/json' -d '{}'
# 401
```

Un 502 signifie que Caddy ne joint pas le conteneur : vérifie qu'ils partagent bien le réseau `web`
(`sudo docker network inspect web | grep hook-`).

---

## 11 — Déclarer les URL chez HelloAsso

Maintenant seulement — les URL existent et répondent.

| Espace                       | URL de notification                                           |
|------------------------------|---------------------------------------------------------------|
| `helloasso-sandbox.com`      | `https://hook.staging.davincibot.fr/webhook/<secret staging>` |
| `helloasso.com` (production) | `https://hook.davincibot.fr/webhook/<secret prod>`            |

**Intégrations** → **Notifications** dans chaque espace.

Si l'interface propose un bouton de test, utilise-le et regarde les logs. Une notification de test produit typiquement
un `ignored` — son `eventType` n'est pas `Payment` — et c'est la preuve que la chaîne complète fonctionne.

---

## 12 — Vérification de bout en bout

D'abord sur staging, avec le bac à sable : c'est exactement à ça qu'il sert.

**12.1** Ouvre le formulaire d'adhésion du bac à sable et paie en saisissant une adresse email présente dans la base
Notion de test. Carte `4242 4242 4242 4242`, date future, CVV quelconque.

**12.2** Dans les secondes qui suivent :

```bash
sudo docker compose -f /srv/hook/staging/docker-compose.yml logs --tail 40
```

Cinq lignes portant le même `paymentId`, dans l'ordre :

```
notification reçue
paiement réconcilié auprès de HelloAsso
lignes Notion appariées
cotisation marquée payée
paiement traité
```

**12.3** L'état est posé dans Notion, et la colonne montant porte la part de l'asso.

**12.4** La trace d'idempotence existe :

```sql
SELECT *
    FROM helloasso.processed_payments
    ORDER BY processed_at DESC
    LIMIT 5;
```

**12.5** Le rejeu est sans effet :

```bash
curl -X POST "https://hook.staging.davincibot.fr/webhook/<secret staging>" \
  -H 'content-type: application/json' \
  -d '{"eventType":"Payment","data":{"id":<id du paiement>}}'
# {"status":"already_handled",…}
```

**12.6** Répète en production avec une vraie cotisation — idéalement la tienne.

---

## 13 — Après la mise en production

- [ ] Les quatre secrets (`WEBHOOK_SECRET`, `HELLOASSO_CLIENT_SECRET`,
  `NOTION_TOKEN`, `SUPABASE_SERVICE_ROLE_KEY`) sont dans le gestionnaire de secrets de l'association, pas seulement dans
  les `.env` du VPS.
- [ ] `/srv/hook/*/.env` sont en `chmod 600`.
- [ ] L'environnement GitHub `prod` exige une approbation.
- [ ] Le canal Discord d'alerte est surveillé par quelqu'un de la trésorerie.
- [ ] Un push sur `staging` déploie bien tout seul (le vérifier une fois).
- [ ] Lire [`operations.md`](operations.md) — au moins « un membre a payé, mais son état n'a pas changé ».

---

## Cycle de vie ordinaire

Une fois en place, plus rien de manuel sur le VPS :

```
push sur staging  →  Container : build + push :staging  →  Deploy Staging (auto)
merge dans main   →  Container : build + push :main
                  →  Actions → Deploy → prod (manuel, approbation requise)
```

Le workflow de déploiement déclenche l'API HTTP de Watchtower puis sonde
`/health` jusqu'à obtenir un 200 : il échoue si le conteneur ne revient pas.

---

## Retour arrière

**Revenir à une version antérieure** — Actions → **Deploy** → environnement
`prod`, et renseigne `image_tag` avec un `sha-<commit>` connu bon (les tags sont visibles dans l'onglet Packages). C'est
la voie normale : elle passe par les mêmes contrôles et la même sonde de santé.

**Arrêter le service** :

```bash
cd /srv/hook/prod && sudo docker compose down
```

Les notifications HelloAsso échoueront alors, seront rejouées un temps, puis abandonnées. Les cotisations reçues pendant
l'arrêt devront être rattrapées — voir [`operations.md`](operations.md) § rattrapage.

Le service ne fait rien d'irréversible : ni côté HelloAsso, qu'il se contente de lire, ni côté Supabase, dont la table
ne sert qu'à ne pas se répéter.
