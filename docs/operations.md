# Exploitation

Ce qu'il faut savoir quand le service tourne déjà. Pour la première mise en ligne, voir
[`runbook-production.md`](runbook-production.md).

Deux environnements, deux dossiers sur le VPS :

| Environnement | Dossier             | Conteneur      | Hôte                         |
| ------------- | ------------------- | -------------- | ---------------------------- |
| prod          | `/srv/hook/prod`    | `hook-prod`    | `hook.davincibot.fr`         |
| staging       | `/srv/hook/staging` | `hook-staging` | `hook.staging.davincibot.fr` |

Les commandes ci-dessous supposent qu'on est dans le dossier de l'environnement visé, ou qu'on passe
`-f /srv/hook/<env>/docker-compose.yml`.

## Lire ce qui se passe

```bash
cd /srv/hook/prod && sudo docker compose logs -f
```

Les logs sont du JSON structuré (pino) :

```bash
sudo docker compose logs --tail 200 | npx pino-pretty
```

Chaque requête porte un `requestId`, chaque paiement un `paymentId`, et chaque action un `handler`
(`membership` ou `wei`). Pour reconstituer l'histoire d'un paiement :

```bash
sudo docker compose logs --since 24h | grep '"paymentId":"12345"'
```

Pour ne voir qu'un flux :

```bash
sudo docker compose logs --since 24h | grep '"handler":"wei"'
```

### Ce que disent les messages

**Communs aux deux flux :**

| Message                                      | Sens                                                         |
| -------------------------------------------- | ------------------------------------------------------------ |
| `notification reçue`                         | payload accepté, traitement engagé                           |
| `paiement déjà traité, aucune action`        | rejeu — comportement normal, rien à faire                    |
| `paiement réconcilié auprès de HelloAsso`    | l'API v5 a confirmé le paiement                              |
| `paiement traité`                            | fin nominale                                                 |
| `évènement hors périmètre, ignoré`           | pas un `Payment` — normal, HelloAsso notifie plusieurs types |
| `aucun handler pour cette campagne, ignorée` | campagne qu'aucun flux ne revendique — normal                |
| `statut non éligible, aucune action`         | paiement non abouti (`Refused`, `Pending`…)                  |
| `incohérence de données, pas de rejeu`       | **à traiter** — une alerte Discord est partie                |
| `paiement non résolu, pas de marquage`       | **à traiter** — voir plus bas                                |
| `panne passagère, rejeu attendu`             | 503 renvoyé, HelloAsso rejouera                              |
| `secret de webhook invalide`                 | 401 — sondage automatisé, ou secret mal recopié              |

**Flux cotisation :**

| Message                                  | Sens                                           |
| ---------------------------------------- | ---------------------------------------------- |
| `cotisation marquée payée`               | une page Notion mise à jour                    |
| `aucune ligne Notion pour ce membre`     | **à traiter** — voir plus bas                  |
| `plusieurs lignes Notion pour ce membre` | doublon dans la base — toutes ont été marquées |

**Flux WEI :**

| Message                                                           | Sens                                                     |
| ----------------------------------------------------------------- | -------------------------------------------------------- |
| `places inscrites et annoncées`                                   | fin nominale, avec `arrivants` et `inscrits`             |
| `places déjà inscrites par un paiement antérieur, aucune annonce` | échéance suivante d'un règlement échelonné — normal      |
| `envoi Discord refusé` / `envoi Discord en échec`                 | l'annonce n'est pas partie — une alerte a pris le relais |
| `registre tronqué à la lecture`                                   | plus de 2000 places : la liste annoncée est incomplète   |

### Voir les échanges bruts avec HelloAsso

Quand les messages ci-dessus ne suffisent pas — un paiement qui n'aboutit nulle part sans erreur visible, un doute sur
ce que HelloAsso envoie vraiment — passe le service en `LOG_LEVEL=debug` et rejoue la notification. Des traces
supplémentaires apparaissent :

| Message                                       | Contenu                                                                       |
| --------------------------------------------- | ----------------------------------------------------------------------------- |
| `appel HelloAsso reçu (brut)`                 | méthode, en-têtes et **corps exact** de la notification, avant interprétation |
| `lecture du paiement demandée à HelloAsso`    | URL appelée sur l'API v5 pour relire le paiement                              |
| `réponse de paiement HelloAsso (brut)`        | statut HTTP, en-têtes et **corps exact** renvoyé par l'API v5                 |
| `lecture de la commande demandée à HelloAsso` | URL appelée sur l'API v5 — la commande porte l'identité des inscrits          |
| `réponse de commande HelloAsso (brut)`        | statut HTTP, en-têtes et **corps exact** de la commande                       |

```bash
sudo docker compose logs --since 1h | grep '(brut)' | npx pino-pretty
```

Les corps sont journalisés tels quels, tronqués seulement au-delà de 32 Ko. Le chemin du webhook n'apparaît jamais (il
porte le secret), l'en-tête `authorization` et le jeton d'accès HelloAsso sont caviardés. En revanche ces lignes
contiennent l'identité des inscrits, celle du payeur et son adresse : `debug` est un mode de diagnostic, pas un réglage
permanent — remets `info` une fois l'incident compris.

---

## Incidents

### Un membre a payé, mais son état n'a pas changé

C'est l'incident le plus courant du flux cotisation, et il n'est presque jamais technique.

**1. L'alerte Discord est-elle tombée ?** Si oui, elle nomme le membre — et, quand un tiers a réglé pour lui, le
payeur : ni cette adresse ni ce nom n'existent dans la base Notion.

Causes habituelles : le membre a payé avec une autre adresse que celle renseignée, une faute de frappe, ou la ligne n'a
jamais été créée. Quand l'alerte porte un champ `payeur`, l'adhésion a été réglée par quelqu'un d'autre : c'est le nom
du membre, pas celui du payeur, qui doit exister dans Notion.

Correction : mets à jour l'adresse dans Notion, **puis rejoue le paiement** (section suivante). Un paiement laissé
`unresolved` n'est pas enregistré comme traité, précisément pour que ce rejeu aboutisse.

**2. Pas d'alerte ?** Cherche le paiement dans les logs :

```bash
sudo docker compose logs --since 48h | grep -i '<email du membre>'
```

- Rien du tout → HelloAsso n'a pas notifié. Vérifie l'URL de notification dans l'espace d'administration HelloAsso.
- `statut non éligible` → le paiement n'est pas abouti côté HelloAsso (échelonné, en attente, refusé). Vérifie son
  statut réel ; au besoin, ajoute le statut à `HELLOASSO_ACCEPTED_STATES`.
- `aucun handler pour cette campagne` → le routage l'écarte. Vérifie `MEMBERSHIP_FORM_TYPE`, `MEMBERSHIP_FORM_SLUG` et
  `HELLOASSO_ORG_SLUG`.

### Une place de WEI a été payée, mais rien n'a été annoncé

**1. Le paiement a-t-il été routé vers le bon handler ?**

```bash
sudo docker compose logs --since 48h | grep '"paymentId":"<id>"' | npx pino-pretty
```

- `aucun handler pour cette campagne` → `WEI_FORM_SLUG` ne correspond pas au slug réel du formulaire. Il se lit dans
  l'URL HelloAsso : `.../associations/<org>/evenements/<ce slug>`.
- `handler: membership` sur un paiement de WEI → le sélecteur du WEI ne matche pas et celui de la cotisation est trop
  large. Vérifie `WEI_FORM_TYPE` (`Event` en général).

**2. `places déjà inscrites par un paiement antérieur`** → comportement normal d'un règlement échelonné : les places ont
été annoncées à la première échéance. Vérifie dans le registre :

```sql
SELECT item_id, first_name, last_name, payment_id, registered_at
    FROM helloasso.wei_registrations
    WHERE order_id = '<id de la commande>';
```

**3. `envoi Discord refusé`** → l'inscription est bien enregistrée, seul le message n'est pas parti. Une alerte «
Annonce Discord non délivrée » a dû tomber dans le salon des incidents. Vérifie `WEI_DISCORD_WEBHOOK_URL` (un webhook
Discord supprimé renvoie 404), puis republie la nouvelle à la main — le registre, lui, est à jour.

**4. Une alerte « commande WEI sans participant identifiable »** → la commande ne porte aucune ligne exploitable :
identité incomplète, ou pas d'identifiant de ligne. Regarde la commande côté HelloAsso ; si l'inscrit a bien un nom, le
formulaire ne le collecte peut-être pas au niveau du participant. Les places manquantes s'ajoutent alors à la main :

```sql
INSERT
    INTO helloasso.wei_registrations (item_id, order_id, payment_id, first_name, last_name)
    VALUES ('<item>', '<commande>', NULL, 'Prénom', 'Nom')
ON CONFLICT (item_id) DO NOTHING;
```

`payment_id` à `NULL` : la place existe, mais elle ne sera pas comptée comme arrivante dans une annonce future.

### La liste annoncée est incomplète

Le registre ne contient que ce que le service a vu passer. Si des places ont été vendues avant sa mise en service,
amorce-le :

```bash
# depuis le dépôt, en local
pnpm backfill:wei --dry-run   # vérifie ce qui serait écrit
pnpm backfill:wei

# ou depuis le conteneur, où tsx n'est pas installé
sudo docker compose exec app node dist/scripts/backfillWei.js --dry-run
sudo docker compose exec app node dist/scripts/backfillWei.js
```

Le script se rejoue sans risque et n'annonce rien. Les articles qu'il écarte — annulés, identité incomplète — sont
listés dans sa sortie.

### Le service répond 503 en boucle

Le message d'erreur nomme le composant fautif.

```bash
sudo docker compose logs --tail 100 | grep -i 'rejeu attendu'
```

| Message contient                       | Cause probable                     | Correction                                                        |
| -------------------------------------- | ---------------------------------- | ----------------------------------------------------------------- |
| `Supabase : lecture de`                | schéma non exposé, ou clé invalide | Dashboard → Settings → API → Exposed schemas contient `helloasso` |
| `Supabase : inscription sur`           | migration WEI non appliquée        | `supabase db push` depuis le dépôt `Supabased`                    |
| `Notion : … (unauthorized)`            | jeton révoqué                      | régénérer le jeton, mettre à jour `NOTION_TOKEN`                  |
| `Notion : … (restricted_resource)`     | intégration retirée de la base     | Notion → base → `•••` → Connections → reconnecter                 |
| `HelloAsso : demande de jeton refusée` | identifiants API invalides         | recréer le client API HelloAsso                                   |
| `échec réseau`                         | sortie internet du VPS             | voir la commande de diagnostic ci-dessous                         |

```bash
sudo docker compose exec app \
  node -e "fetch('https://api.helloasso.com/v5').then(r=>console.log(r.status))"
```

Tant que le service répond 503, HelloAsso rejoue : **rien n'est perdu** dans la fenêtre de rejeu. Corrige, redémarre,
les notifications en attente aboutissent d'elles-mêmes.

### Notion répond `validation_error` sur la recherche

Le filtre ne correspond pas au type réel de la propriété email. Vérifie dans Notion le type de la colonne et aligne
`NOTION_EMAIL_PROPERTY_TYPE` (`email`, `rich_text` ou `title`), puis `sudo docker compose up -d`.

Même symptôme si `NOTION_EMAIL_PROPERTY`, `NOTION_PAID_PROPERTY`, `NOTION_PAID_STATUS` ou `NOTION_AMOUNT_PROPERTY` ne
reprend pas **exactement** le libellé affiché dans Notion — accents et espaces compris.

### Plusieurs lignes marquées pour un seul paiement

Comportement voulu : plusieurs lignes portent le même email — ou, en repli, le même prénom et le même nom. Le service
les marque toutes et journalise un `warn` portant `matchedBy`. Dédoublonne la base Notion à l'occasion.

### La ligne marquée n'est pas celle du membre

Regarde `matchedBy` dans les logs. `identité` : l'appariement s'est fait sur `NOTION_FIRST_NAME_PROPERTY` et
`NOTION_LAST_NAME_PROPERTY` — deux homonymes suffisent à se tromper de ligne. C'est le mode normal quand un tiers a
réglé la cotisation : l'email connu est le sien, il n'est alors pas retenu comme critère. Remets l'état d'origine,
corrige le prénom et le nom dans Notion, puis rejoue le paiement. Laisser les deux variables vides désactive ce repli —
et, avec lui, tout appariement des adhésions réglées par un tiers.

### Le service refuse de démarrer

Il liste d'un coup toutes les variables fautives. Deux causes propres au découpage en handlers :

- `au moins un handler doit être activé` → ni `NOTION_TOKEN` ni `WEI_DISCORD_WEBHOOK_URL` n'est renseigné. Le service
  n'aurait rien à faire.
- `requis dès que NOTION_TOKEN est défini` → bloc Notion incomplet. Un demi-bloc est une faute, pas une désactivation :
  pour désactiver le flux, vide `NOTION_TOKEN`.

### Le conteneur ne redémarre pas après un déploiement

Le job **Deploy** échoue si `/health` ne répond pas 200 dans les cinq minutes. Regarde les logs : neuf fois sur dix,
c'est une variable d'environnement manquante après un changement de configuration.

```bash
sudo docker compose logs --tail 30
```

Reviens à la version précédente par Actions → **Deploy** en renseignant `image_tag`, le temps de corriger.

---

## Rejouer un paiement

Le service étant idempotent, un rejeu est sûr : au pire il ne fait rien.

**Si le paiement n'a jamais abouti** (`unresolved`, `data_error`, ou 503 définitif), il n'est pas dans
`processed_payments` : il suffit de renvoyer la notification.

**S'il a abouti et que tu veux vraiment le refaire**, supprime d'abord la trace, sinon le service répondra
`already_handled` :

```sql
-- SQL Editor du Dashboard Supabase
DELETE
    FROM helloasso.processed_payments
    WHERE payment_id = '12345';
```

Pour un paiement WEI, il faut **aussi** retirer les places si l'on veut que l'annonce reparte — sinon le rejeu les
retrouvera déjà inscrites et n'annoncera rien :

```sql
DELETE
    FROM helloasso.wei_registrations
    WHERE payment_id = '12345';
```

Puis rejoue. Le corps minimal suffit — le service ne se sert du payload que pour identifier le paiement, tout le reste
vient de la réconciliation :

```bash
curl -X POST "https://hook.davincibot.fr/webhook/$WEBHOOK_SECRET" \
  -H 'content-type: application/json' \
  -d '{"eventType":"Payment","data":{"id":12345}}'
```

> Sans champ `order` dans le payload, le pré-filtre ne peut rien conclure et laisse passer : la réconciliation
> tranchera.
> C'est voulu — un rejeu manuel n'a pas à connaître la campagne.

| Réponse                                  | Sens                                                           |
| ---------------------------------------- | -------------------------------------------------------------- |
| `{"status":"handled","handler":"wei",…}` | c'est fait, et par quel flux                                   |
| `{"status":"already_handled",…}`         | déjà traité — supprimer la ligne d'abord                       |
| `{"status":"unresolved",…}`              | le handler n'a rien pu faire — la raison est dans `reason`     |
| `{"status":"data_error","reason":…}`     | donnée incohérente, une alerte est partie                      |
| `{"status":"ignored","reason":…}`        | statut ou campagne hors périmètre, la raison est dans `reason` |
| HTTP 503                                 | panne en cours — voir la section précédente                    |

L'identifiant du paiement se lit dans l'espace HelloAsso, ou dans les logs.

## Rattraper une période d'arrêt

Si le service est resté indisponible au-delà de la fenêtre de rejeu de HelloAsso, il faut retrouver les paiements
manqués.

**1.** Obtiens un jeton :

```bash
TOKEN=$(curl -s -X POST https://api.helloasso.com/oauth2/token \
  -d grant_type=client_credentials \
  -d client_id="$HELLOASSO_CLIENT_ID" \
  -d client_secret="$HELLOASSO_CLIENT_SECRET" | jq -r .access_token)
```

**2.** Liste les paiements de la période :

```bash
curl -s -H "authorization: Bearer $TOKEN" \
  "https://api.helloasso.com/v5/organizations/$HELLOASSO_ORG_SLUG/payments?from=2026-08-01&to=2026-08-17&states=Authorized" \
  | jq -r '.data[].id' > ids.txt
```

**3.** Rejoue chaque identifiant :

```bash
while read -r id; do
  curl -s -X POST "https://hook.davincibot.fr/webhook/$WEBHOOK_SECRET" \
    -H 'content-type: application/json' \
    -d "{\"eventType\":\"Payment\",\"data\":{\"id\":$id}}"
  echo
  sleep 1
done < ids.txt
```

Le `sleep` ménage les quotas Notion (3 requêtes/seconde). Les paiements déjà traités répondent `already_handled` : la
boucle est sûre à relancer.

> **Attention pour le WEI** : ce rattrapage annonce chaque commande retrouvée, une notification par message Discord. Si
> l'arrêt a duré, préfère `pnpm backfill:wei` — il remplit le registre en silence — puis ne rejoue que les paiements de
> cotisation.

---

## Déployer, revenir en arrière

```
push sur staging  →  build + push :staging  →  Deploy Staging (automatique)
merge dans main   →  build + push :main
                  →  Actions → Deploy → prod (manuel, approbation requise)
```

Le workflow de déploiement déclenche l'API HTTP de Watchtower (`POST deploy.davincibot.fr/v1/update`) puis sonde
`/health` jusqu'à 200. Il échoue si le conteneur ne revient pas — aucune mise à jour silencieusement cassée.

**Retour arrière** — Actions → **Deploy** → environnement `prod`, et renseigne `image_tag` avec un `sha-<commit>` connu
bon (les tags sont dans l'onglet Packages du dépôt). C'est la voie normale : mêmes contrôles, même sonde.

**Déploiement à la main sur le VPS**, si CI est indisponible :

```bash
cd /srv/hook/prod
sudo docker compose pull && sudo docker compose up -d
```

**Modifier une variable d'environnement** ne nécessite pas de nouvelle image :

```bash
sudo nano /srv/hook/prod/.env
cd /srv/hook/prod && sudo docker compose up -d
```

C'est ainsi qu'on **éteint le WEI hors saison** : vider `WEI_DISCORD_WEBHOOK_URL`, redémarrer. Le handler n'est plus
câblé, les paiements de la campagne tombent en `aucun handler pour cette campagne`. Le registre, lui, reste intact.

---

## Faire tourner les secrets

Chaque rotation suit le même schéma : nouvelle valeur → `.env` de l'environnement → `docker compose up -d`. Le service
redémarre en quelques secondes ; les notifications reçues pendant la coupure sont rejouées par HelloAsso.

| Secret                      | Où le régénérer                                  | Après                                                           |
| --------------------------- | ------------------------------------------------ | --------------------------------------------------------------- |
| `WEBHOOK_SECRET`            | `openssl rand -hex 32`                           | **mettre à jour l'URL de notification chez HelloAsso**          |
| `NOTION_TOKEN`              | notion.so/my-integrations → Secrets → Regenerate | vérifier que l'intégration est toujours connectée à la base     |
| `HELLOASSO_CLIENT_SECRET`   | espace HelloAsso → Intégrations → API            | —                                                               |
| `SUPABASE_SERVICE_ROLE_KEY` | Dashboard → Settings → API → Reset               | ⚠ cette clé sert peut-être à d'autres services de l'association |
| `ALERT_WEBHOOK_URL`         | Discord → Intégrations → Webhooks                | —                                                               |
| `WEI_DISCORD_WEBHOOK_URL`   | Discord → Intégrations → Webhooks                | —                                                               |

Pour `WEBHOOK_SECRET`, l'ordre compte : mets à jour le `.env` et redémarre **avant** de changer l'URL chez HelloAsso.
Les notifications émises entre les deux seraient refusées en 401 — et un 401 n'est pas rejoué.

---

## Surveillance

Le service n'expose pas de métriques : ce serait disproportionné pour quelques centaines de paiements par an. Quatre
signaux suffisent :

1. **Le canal Discord d'alerte.** Silence = tout va bien.
2. **Le salon interne de gestion du WEI.** Pendant la campagne, chaque place vendue s'y voit : une inscription connue
   sans message est le signal le plus rapide qu'un incident est en cours.
3. **La santé des conteneurs** :

```bash
sudo docker ps --filter name=hook- --format '{{.Names}}\t{{.Status}}'
# hook-prod      Up 2 days (healthy)
# hook-staging   Up 2 days (healthy)
```

4. **Les deux tables**, comme journal des traitements réussis :

```sql
-- Qui a traité quoi, et quand
SELECT payment_id, handler, payer_email, processed_at
    FROM helloasso.processed_payments
    ORDER BY processed_at DESC
    LIMIT 20;

-- Où en est le WEI
SELECT count(*)                                   AS inscrits,
       count(*) FILTER (WHERE payment_id IS NULL) AS amorces,
       max(registered_at)                         AS derniere_place
    FROM helloasso.wei_registrations;

-- La liste, dans l'ordre annoncé
SELECT row_number() OVER (ORDER BY registered_at, item_id) AS rang,
       first_name,
       last_name,
       registered_at
    FROM helloasso.wei_registrations
    ORDER BY registered_at, item_id;
```

Un contrôle utile après chaque campagne : comparer le nombre de paiements aboutis côté HelloAsso au nombre de lignes de
`processed_payments` sur la même période. Un écart signale des paiements non résolus passés inaperçus.

Pour le WEI, le contrôle équivalent est de comparer le nombre de places vendues dans l'espace HelloAsso au nombre de
lignes de `wei_registrations`. Un écart se rattrape avec `pnpm backfill:wei`.
