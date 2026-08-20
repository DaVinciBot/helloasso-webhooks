# Exploitation

Ce qu'il faut savoir quand le service tourne déjà. Pour la première mise en
ligne, voir [`runbook-production.md`](runbook-production.md).

Deux environnements, deux dossiers sur le VPS :

| Environnement | Dossier             | Conteneur      | Hôte                         |
| ------------- | ------------------- | -------------- | ---------------------------- |
| prod          | `/srv/hook/prod`    | `hook-prod`    | `hook.davincibot.fr`         |
| staging       | `/srv/hook/staging` | `hook-staging` | `hook.staging.davincibot.fr` |

Les commandes ci-dessous supposent qu'on est dans le dossier de l'environnement
visé, ou qu'on passe `-f /srv/hook/<env>/docker-compose.yml`.

## Lire ce qui se passe

```bash
cd /srv/hook/prod && sudo docker compose logs -f
```

Les logs sont du JSON structuré (pino) :

```bash
sudo docker compose logs --tail 200 | npx pino-pretty
```

Chaque requête porte un `requestId`, chaque paiement un `paymentId`. Pour
reconstituer l'histoire d'un paiement :

```bash
sudo docker compose logs --since 24h | grep '"paymentId":"12345"'
```

### Ce que disent les messages

| Message                                   | Sens                                                         |
| ----------------------------------------- | ------------------------------------------------------------ |
| `notification reçue`                      | payload accepté, traitement engagé                           |
| `paiement déjà traité, aucune écriture`   | rejeu — comportement normal, rien à faire                    |
| `paiement réconcilié auprès de HelloAsso` | l'API v5 a confirmé le paiement                              |
| `lignes Notion appariées`                 | au moins une ligne correspond à l'email                      |
| `cotisation cochée`                       | une page mise à jour                                         |
| `paiement traité`                         | fin nominale                                                 |
| `évènement hors périmètre, ignoré`        | pas un `Payment` — normal, HelloAsso notifie plusieurs types |
| `statut non éligible, aucune écriture`    | paiement non abouti (`Refused`, `Pending`…)                  |
| `aucune ligne Notion pour cet email`      | **à traiter** — voir plus bas                                |
| `plusieurs lignes Notion pour cet email`  | doublon dans la base — toutes ont été cochées                |
| `panne passagère, rejeu attendu`          | 503 renvoyé, HelloAsso rejouera                              |
| `secret de webhook invalide`              | 401 — sondage automatisé, ou secret mal recopié              |

---

## Incidents

### Un membre a payé, mais rien n'est coché

C'est l'incident le plus courant, et il n'est presque jamais technique.

**1. L'alerte Discord est-elle tombée ?** Si oui, elle contient l'email du
payeur : cette adresse n'existe dans aucune ligne de la base Notion.

Causes habituelles : le membre a payé avec une autre adresse que celle
renseignée, une faute de frappe, ou la ligne n'a jamais été créée.

Correction : mets à jour l'adresse dans Notion, **puis rejoue le paiement**
(section suivante). Un paiement non apparié n'est pas enregistré comme traité,
précisément pour que ce rejeu aboutisse.

**2. Pas d'alerte ?** Cherche le paiement dans les logs :

```bash
sudo docker compose logs --since 48h | grep -i '<email du membre>'
```

- Rien du tout → HelloAsso n'a pas notifié. Vérifie l'URL de notification dans
  l'espace d'administration HelloAsso, et que le paiement relève bien de la
  campagne configurée dans `HELLOASSO_FORM_SLUG`.
- `statut non éligible` → le paiement n'est pas abouti côté HelloAsso
  (échelonné, en attente, refusé). Vérifie son statut réel ; au besoin, ajoute
  le statut à `HELLOASSO_ACCEPTED_STATES`.
- `hors périmètre` → le filtre de campagne l'écarte. Vérifie
  `HELLOASSO_FORM_SLUG` et `HELLOASSO_ORG_SLUG`.

### Le service répond 503 en boucle

Le message d'erreur nomme le composant fautif.

```bash
sudo docker compose logs --tail 100 | grep -i 'rejeu attendu'
```

| Message contient                       | Cause probable                     | Correction                                                        |
| -------------------------------------- | ---------------------------------- | ----------------------------------------------------------------- |
| `Supabase : lecture`                   | schéma non exposé, ou clé invalide | Dashboard → Settings → API → Exposed schemas contient `helloasso` |
| `Notion : … (unauthorized)`            | jeton révoqué                      | régénérer le jeton, mettre à jour `NOTION_TOKEN`                  |
| `Notion : … (restricted_resource)`     | intégration retirée de la base     | Notion → base → `•••` → Connections → reconnecter                 |
| `HelloAsso : demande de jeton refusée` | identifiants API invalides         | recréer le client API HelloAsso                                   |
| `échec réseau`                         | sortie internet du VPS             | voir la commande de diagnostic ci-dessous                         |

```bash
sudo docker compose exec app \
  node -e "fetch('https://api.helloasso.com/v5').then(r=>console.log(r.status))"
```

Tant que le service répond 503, HelloAsso rejoue : **rien n'est perdu** dans la
fenêtre de rejeu. Corrige, redémarre, les notifications en attente aboutissent
d'elles-mêmes.

### Notion répond `validation_error` sur la recherche

Le filtre ne correspond pas au type réel de la propriété email. Vérifie dans
Notion le type de la colonne et aligne `NOTION_EMAIL_PROPERTY_TYPE`
(`email`, `rich_text` ou `title`), puis `sudo docker compose up -d`.

Même symptôme si `NOTION_EMAIL_PROPERTY` ou `NOTION_PAID_PROPERTY` ne reprend
pas **exactement** le nom affiché dans Notion — accents et espaces compris.

### Plusieurs lignes cochées pour un seul paiement

Comportement voulu : plusieurs lignes portent le même email. Le service les
coche toutes et journalise un `warn`. Dédoublonne la base Notion à l'occasion.

### Le conteneur ne redémarre pas après un déploiement

Le job **Deploy** échoue si `/health` ne répond pas 200 dans les cinq minutes.
Regarde les logs : neuf fois sur dix, c'est une variable d'environnement
manquante après un changement de configuration — le service refuse alors de
démarrer et liste les fautives.

```bash
sudo docker compose logs --tail 30
```

Reviens à la version précédente par Actions → **Deploy** en renseignant
`image_tag` (voir plus bas), le temps de corriger.

---

## Rejouer un paiement

Le service étant idempotent, un rejeu est sûr : au pire il ne fait rien.

**Si le paiement n'a jamais abouti** (`unmatched`, `data_error`, ou 503
définitif), il n'est pas dans `processed_payments` : il suffit de renvoyer la
notification.

**S'il a abouti et que tu veux vraiment le refaire** (case décochée par erreur),
supprime d'abord la trace, sinon le service répondra `already_handled` :

```sql
-- SQL Editor du Dashboard Supabase
DELETE FROM helloasso.processed_payments WHERE payment_id = '12345';
```

Puis rejoue. Le corps minimal suffit — le service ne se sert du payload que pour
identifier le paiement, tout le reste vient de la réconciliation :

```bash
curl -X POST "https://hook.davincibot.fr/webhook/$WEBHOOK_SECRET" \
  -H 'content-type: application/json' \
  -d '{"eventType":"Payment","data":{"id":12345}}'
```

| Réponse                           | Sens                                                           |
| --------------------------------- | -------------------------------------------------------------- |
| `{"status":"updated",…}`          | c'est fait                                                     |
| `{"status":"already_handled",…}`  | déjà traité — supprimer la ligne d'abord                       |
| `{"status":"unmatched",…}`        | l'email n'est toujours pas dans Notion                         |
| `{"status":"ignored","reason":…}` | statut ou campagne hors périmètre, la raison est dans `reason` |
| HTTP 503                          | panne en cours — voir la section précédente                    |

L'identifiant du paiement se lit dans l'espace HelloAsso, ou dans les logs.

## Rattraper une période d'arrêt

Si le service est resté indisponible au-delà de la fenêtre de rejeu de
HelloAsso, il faut retrouver les paiements manqués.

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

Le `sleep` ménage les quotas Notion (3 requêtes/seconde). Les paiements déjà
traités répondent `already_handled` : la boucle est sûre à relancer.

---

## Déployer, revenir en arrière

```
push sur staging  →  build + push :staging  →  Deploy Staging (automatique)
merge dans main   →  build + push :main
                  →  Actions → Deploy → prod (manuel, approbation requise)
```

Le workflow de déploiement déclenche l'API HTTP de Watchtower
(`POST deploy.davincibot.fr/v1/update`) puis sonde `/health` jusqu'à 200. Il
échoue si le conteneur ne revient pas — aucune mise à jour silencieusement
cassée.

**Retour arrière** — Actions → **Deploy** → environnement `prod`, et renseigne
`image_tag` avec un `sha-<commit>` connu bon (les tags sont dans l'onglet
Packages du dépôt). C'est la voie normale : mêmes contrôles, même sonde.

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

---

## Faire tourner les secrets

Chaque rotation suit le même schéma : nouvelle valeur → `.env` de
l'environnement → `docker compose up -d`. Le service redémarre en quelques
secondes ; les notifications reçues pendant la coupure sont rejouées par
HelloAsso.

| Secret                      | Où le régénérer                                  | Après                                                           |
| --------------------------- | ------------------------------------------------ | --------------------------------------------------------------- |
| `WEBHOOK_SECRET`            | `openssl rand -hex 32`                           | **mettre à jour l'URL de notification chez HelloAsso**          |
| `NOTION_TOKEN`              | notion.so/my-integrations → Secrets → Regenerate | vérifier que l'intégration est toujours connectée à la base     |
| `HELLOASSO_CLIENT_SECRET`   | espace HelloAsso → Intégrations → API            | —                                                               |
| `SUPABASE_SERVICE_ROLE_KEY` | Dashboard → Settings → API → Reset               | ⚠ cette clé sert peut-être à d'autres services de l'association |
| `ALERT_WEBHOOK_URL`         | Discord → Intégrations → Webhooks                | —                                                               |

Pour `WEBHOOK_SECRET`, l'ordre compte : mets à jour le `.env` et redémarre
**avant** de changer l'URL chez HelloAsso. Les notifications émises entre les
deux seraient refusées en 401 — et un 401 n'est pas rejoué.

---

## Surveillance

Le service n'expose pas de métriques : ce serait disproportionné pour quelques
dizaines de paiements par an. Trois signaux suffisent :

1. **Le canal Discord d'alerte.** Silence = tout va bien.
2. **La santé des conteneurs** :

```bash
sudo docker ps --filter name=hook- --format '{{.Names}}\t{{.Status}}'
# hook-prod      Up 2 days (healthy)
# hook-staging   Up 2 days (healthy)
```

3. **La table d'idempotence** comme journal des traitements réussis :

```sql
SELECT payment_id, payer_email, processed_at
FROM helloasso.processed_payments
ORDER BY processed_at DESC
LIMIT 20;
```

Un contrôle utile après chaque campagne : comparer le nombre de paiements
aboutis côté HelloAsso au nombre de lignes de cette table sur la même période.
Un écart signale des paiements non appariés passés inaperçus.
