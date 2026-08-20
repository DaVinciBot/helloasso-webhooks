# Tester de bout en bout avec le bac à sable HelloAsso

HelloAsso met à disposition un environnement de test complet sur
`helloasso-sandbox.com` : formulaires réels, paiement par carte fictive,
notifications identiques à la production. Rien n'est débité.

C'est le seul moyen de valider la chaîne entière — notification, réconciliation,
écriture Notion — avant d'exposer le service à de vrais paiements.

## Deux façons de s'y prendre

**Par l'environnement staging**, une fois celui-ci en place. C'est le cas
courant : `hook.staging.davincibot.fr` pointe déjà vers le bac à sable et une
base Notion de test. Il n'y a rien à configurer, aucun tunnel à ouvrir, et le
poste n'a pas besoin de rester allumé — il suffit de payer sur le formulaire du
bac à sable et de regarder les logs :

```bash
sudo docker compose -f /srv/hook/staging/docker-compose.yml logs -f
```

Passe directement à la section [Payer](#4--payer).

**Par un tunnel vers ta machine**, ce que décrit le reste de ce document. À
réserver au développement d'une modification : on veut alors les logs en direct,
un débogueur, et pouvoir recharger le code entre deux paiements.

## Ce dont tu as besoin

- Un compte sur <https://www.helloasso-sandbox.com> (indépendant du compte de
  production, à créer une fois).
- Une base Notion de test, ou la base de production avec une ligne dédiée
  portant une adresse email que tu contrôles.
- De quoi exposer ta machine sur internet : `cloudflared`, `ngrok` ou
  équivalent.

## 1 — Le formulaire de test

Sur le compte bac à sable, crée l'association puis une **campagne d'adhésion**.
Note les deux slugs de son URL :

```
https://www.helloasso-sandbox.com/associations/<org>/adhesions/<form>
```

Crée aussi un client API depuis l'espace d'administration du bac à sable :
**Intégrations** → **API**.

## 2 — La configuration locale

Copie `.env.example` vers `.env` et bascule les deux URL sur le bac à sable :

```bash
HELLOASSO_API_BASE=https://api.helloasso-sandbox.com/v5
HELLOASSO_TOKEN_URL=https://api.helloasso-sandbox.com/oauth2/token

HELLOASSO_CLIENT_ID=<client id du bac à sable>
HELLOASSO_CLIENT_SECRET=<secret du bac à sable>
HELLOASSO_ORG_SLUG=<org du bac à sable>
HELLOASSO_FORM_SLUG=<form du bac à sable>
```

Les identifiants de production **ne fonctionnent pas** sur le bac à sable, et
réciproquement.

Pour Notion et Supabase, deux approches :

- viser une base Notion de test et le projet Supabase de développement — le plus
  propre ;
- viser la production avec une ligne Notion dédiée. Dans ce cas, `LOG_LEVEL=debug`
  et relis la table `helloasso.processed_payments` après coup pour nettoyer.

Lance :

```bash
pnpm install
pnpm dev:pretty
```

## 3 — Exposer la machine locale

HelloAsso doit joindre ton poste depuis internet.

```bash
# Cloudflare Tunnel, sans compte requis
cloudflared tunnel --url http://localhost:3000
```

```bash
# ou ngrok
ngrok http 3000
```

L'outil affiche une URL publique en `https://`. L'URL de notification à déclarer
est :

```
https://<url-du-tunnel>/webhook/<WEBHOOK_SECRET>
```

Déclare-la dans l'espace d'administration **du bac à sable** :
**Intégrations** → **Notifications**.

> L'URL du tunnel change à chaque redémarrage sur les formules gratuites. Si les
> notifications cessent d'arriver, c'est presque toujours ça.

## 4 — Payer

Ouvre le formulaire d'adhésion du bac à sable et règle une cotisation en
saisissant **l'adresse email présente dans ta base Notion**.

Carte de test :

| Champ      | Valeur                       |
| ---------- | ---------------------------- |
| Numéro     | `4242 4242 4242 4242`        |
| Expiration | n'importe quelle date future |
| CVV        | n'importe quels 3 chiffres   |

## 5 — Observer

Dans le terminal de `pnpm dev:pretty`, cinq lignes doivent défiler en quelques
secondes :

```
notification reçue                          paymentId=…
paiement réconcilié auprès de HelloAsso     state=Authorized
lignes Notion appariées                     matches=1
cotisation cochée                           pageId=…
paiement traité
```

Puis, dans Notion, la case est cochée.

## 6 — Les cas à vérifier aussi

Le chemin nominal est le plus facile. Ceux-ci valent le détour, parce qu'ils
distinguent un service qui marche d'un service sur lequel on peut compter.

**Le rejeu.** Renvoie la même notification à la main :

```bash
curl -X POST "https://<url-du-tunnel>/webhook/$WEBHOOK_SECRET" \
  -H 'content-type: application/json' \
  -d '{"eventType":"Payment","data":{"id":<id du paiement>}}'
# {"status":"already_handled",…}  et aucune ligne de log d'écriture
```

**L'email inconnu.** Paie avec une adresse absente de Notion. Attendu :
`{"status":"unmatched",…}`, un `warn` dans les logs, et une alerte Discord si
`ALERT_WEBHOOK_URL` est renseignée.

**Le mauvais secret.** Doit répondre 401 sans rien lire du corps :

```bash
curl -s -o /dev/null -w '%{http_code}\n' \
  -X POST "https://<url-du-tunnel>/webhook/mauvais" \
  -H 'content-type: application/json' -d '{}'
# 401
```

**La campagne hors périmètre.** Crée un second formulaire dans le bac à sable et
paie dessus. Avec `HELLOASSO_FORM_SLUG` renseigné, attendu :
`{"status":"ignored","reason":"campagne_hors_perimetre:…"}`.

## Sans le bac à sable

Pour vérifier le parsing et le routage sans compte HelloAsso, la fixture des
tests fait l'affaire :

```bash
curl -X POST "http://localhost:3000/webhook/$WEBHOOK_SECRET" \
  -H 'content-type: application/json' \
  --data @tests/fixtures/payment.json
```

Le service ira réconcilier le paiement `12345` auprès de HelloAsso, qui ne le
connaît pas : la réponse sera `data_error`. C'est le comportement correct — et
la preuve que le service refuse d'écrire dans Notion sur la seule foi d'un
payload.

## Nettoyage

Une fois les essais terminés :

1. Retire l'URL de notification du bac à sable (le tunnel n'existera plus).
2. Rebascule `HELLOASSO_API_BASE` et `HELLOASSO_TOKEN_URL` sur la production.
3. Si tu as visé la base de production, décoche les lignes de test et purge les
   traces :

```sql
DELETE FROM helloasso.processed_payments WHERE payer_email = '<email de test>';
```
