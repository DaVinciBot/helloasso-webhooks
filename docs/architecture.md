# Architecture

Ce document explique **pourquoi** le service est construit ainsi. Le « comment l'exploiter » est dans
[`operations.md`](operations.md), le « comment le mettre en ligne » dans
[`runbook-production.md`](runbook-production.md).

## Le problème

HelloAsso encaisse. Ce que l'association veut qu'il se passe ensuite dépend de ce qui a été encaissé :

- une **cotisation** doit apparaître cochée dans la base Notion des membres ;
- une **place de WEI** doit être enregistrée, et le bureau veut voir passer sur Discord qui vient de la prendre, avec la
  liste de ceux qui l'ont déjà fait.

Personne n'a envie de reporter tout cela à la main, et un report manuel se fait toujours en retard, parfois jamais.

HelloAsso sait notifier un serveur à chaque paiement. Trois contraintes en découlent :

1. **Les comptes association ne signent pas leurs notifications.** Pas de HMAC, pas de signature à vérifier. N'importe
   qui connaissant l'URL peut poster n'importe quoi.
2. **HelloAsso rejoue.** Tant qu'il n'obtient pas de 2xx, il relivre la notification. C'est sa garantie de fiabilité —
   et donc la nôtre, à condition de savoir encaisser les doublons.
3. **Le temps de réponse est borné** (~15 s). Au-delà, la livraison est comptée en échec et rejouée.

Le service est entièrement dessiné par ces trois contraintes, plus une quatrième qui vient du besoin : **ce qu'on fait
d'un paiement dépend de la campagne, et cette liste va s'allonger.**

## Le modèle : un routeur, pas deux services

La tentation, en ajoutant le WEI, était de greffer un `if` dans le tuyau existant. C'est exactement ce que le service ne
fait pas.

Tout ce qui précède l'action est **commun** : authentification, réconciliation, périmètre de l'association, idempotence,
sémantique de rejeu, alerte sur donnée fautive. Ce qui diffère est **l'action elle-même**. Le service coupe donc à cet
endroit précis : le cœur (`core/`) mène un paiement jusqu'à « authentique, dans le périmètre, abouti, et voici qui il
concerne », puis passe la main à un `PaymentHandler` choisi par la campagne.

Un handler ne sait pas comment il a été appelé, ne sait pas qu'un autre handler existe, et ne sait pas comment son
résultat deviendra une réponse HTTP. Ajouter un usage tient en un fichier dans `handlers/` et trois lignes dans
`wiring.ts`.

## Le flux

```
POST /webhook/:secret
  │
  ├─ secret comparé à temps constant ───────────────── ✗ → 401
  ├─ corps JSON valide, de taille sensée ───────────── ✗ → 400 / 413
  ├─ eventType = "Payment" ? ───────────────────────── ✗ → 200 ignored
  ├─ organisation + campagne plausibles ? (pré-filtre) ✗ → 200 ignored
  │
  ├─ 1. déjà dans processed_payments ? ─────────────── ✓ → 200 already_handled
  ├─ 2. GET /v5/payments/{id} ← fait autorité
  ├─ 3. organisation confirmée ? ───────────────────── ✗ → 200 ignored
  ├─ 4. quel handler a la charge de cette campagne ? ─ ✗ → 200 ignored
  ├─ 5. statut abouti ? ────────────────────────────── ✗ → 200 ignored
  ├─ 6. GET /v5/orders/{id} ← identité des inscrits
  ├─ 7. handler.handle(paiement réconcilié) ────────── unresolved → 200 + alerte
  ├─ 8. INSERT processed_payments ON CONFLICT DO NOTHING
  └─────────────────────────────────────────────────── → 200 handled
```

Toute panne passagère à n'importe quelle étape interrompt le flux et renvoie **503**.

## Décisions

### Ne jamais faire confiance au payload

Le payload n'a aucune authenticité : sans signature, il n'établit rien. Il sert uniquement à savoir **de quel paiement
on parle**. La décision d'agir se prend exclusivement sur la réponse de `GET /v5/payments/{id}`, authentifiée en OAuth2.

C'est traduit littéralement dans le code : `core/notification.ts` ne valide du payload que l'`eventType`, l'`id` et la
campagne annoncée. Il n'y a pas de champ à croire par accident, puisqu'il n'y en a pas. Le montant, le statut,
l'identité n'existent tout simplement pas dans ce schéma.

Conséquence pratique : un test vérifie qu'un payload annonçant le WEI alors que HelloAsso répond « cotisation » est
routé vers le handler cotisation, et qu'un payload annonçant `Authorized` alors que HelloAsso répond `Refused` n'écrit
rien.

### Le payeur n'est pas l'inscrit — et il peut y en avoir plusieurs

HelloAsso sépare les deux : le **payeur** est celui dont la carte est débitée, les **inscrits** sont portés par les
lignes de commande (`items[].user`). Ils coïncident dans le cas courant, pas quand un parent règle la cotisation de son
enfant, ni quand une seule commande achète trois places de WEI.

`GET /v5/payments/{id}` ne connaît que le payeur — ses `items` ne portent que des montants. L'identité demande donc une
seconde lecture, `GET /v5/orders/{id}`, faite après les filtres de campagne et de statut : un paiement écarté ne la
déclenche pas.

C'est ici qu'est l'unification qui porte tout le refactor. L'ancienne fonction rendait **un** adhérent — le premier dont
l'identité était complète. Le WEI a besoin de **tous** les inscrits. Ces deux besoins sont le même :
`participantsOf(payment, order)` rend la liste ordonnée, appariée par ligne de commande.

- le handler cotisation prend `participants[0]`, avec repli sur le payeur ;
- le handler WEI prend la liste entière.

Les deux usages ne partagent pas du code : ils lisent la même notion.

L'email, lui, n'existe **que** côté payeur : le formulaire ne demande à l'inscrit qu'un prénom et un nom. Le retenir
sans réserve reviendrait, sur un règlement par un tiers, à marquer payée la ligne _du payeur_ — une erreur silencieuse
qui touche deux membres à la fois. Il n'est donc gardé comme critère que lorsqu'il désigne bien l'inscrit : noms
concordants, ou aucune identité d'inscrit connue. Sinon l'appariement se fait sur le seul prénom + nom, et l'alerte «
aucune ligne Notion » nomme le payeur, pour retrouver le paiement côté HelloAsso.

### Le routage se décide sur la campagne, et sur la précision

Chaque handler déclare un `CampaignSelector` : un type de formulaire, un slug, ou les deux. Le slug d'organisation reste
global — c'est l'association, pas une campagne.

Les handlers sont essayés **du plus précis au moins précis** : un slug (2) bat un type (1), qui bat le vide (0), avec
l'ordre de déclaration pour départager à égalité. Sans cette règle, un handler « toutes les adhésions » déclaré en
premier attraperait les paiements du WEI le jour où celui-ci partagerait son type — un piège silencieux, découvert bien
plus tard. La règle rend le routage indépendant de l'ordre de déclaration, donc impossible à casser par inadvertance.

La comparaison des slugs est volontairement **permissive sur l'absence** et stricte sur le désaccord : si HelloAsso omet
`formSlug`, on ne conclut pas — sinon un changement de format de leur côté couperait le service en silence.

### Un handler non configuré n'existe pas

Le bloc `NOTION_*` absent ne câble pas le handler cotisation ; `WEI_DISCORD_WEBHOOK_URL` absent ne câble pas le WEI. Ce
n'est pas de la commodité : c'est ce qui permet d'éteindre le WEI hors saison sans toucher au code, et de ne pas exiger
d'un environnement de test les secrets d'un flux qu'il n'utilise pas.

Un **demi-bloc**, en revanche, est une faute de configuration et non une désactivation : `NOTION_TOKEN` défini rend tout
le reste du bloc obligatoire. Désactiver en silence donnerait un service qui ne fait pas ce qu'on croit.

`WEI_FORM_SLUG` est obligatoire dès que le WEI est activé. Sans lui, le sélecteur se réduirait à « tous les évènements »
et capterait la première billetterie venue — une place de WEI attribuée à un spectateur de gala n'est pas un incident
qu'on veut découvrir sur Discord.

### La clé d'idempotence reste le paiement seul

`processed_payments` aurait pu passer en clé composite `(payment_id, handler)`. Elle ne l'a pas fait, et c'est délibéré.

Un paiement appartient à une campagne, donc à un seul handler : la clé composite ne modéliserait aucune réalité. Elle
coûterait en revanche la propriété qui fait tout l'intérêt de cette table — pouvoir répondre à un rejeu **avant** de
savoir quel handler est concerné, donc avant tout appel sortant. Savoir _qu'un_ paiement a été traité suffit à ne rien
refaire ; savoir _par qui_ est du diagnostic, et c'est ce que fait la colonne `handler`.

### Idempotence avant réconciliation

La vérification d'idempotence passe avant la réconciliation, et c'est délibéré. Le rejeu est le mécanisme même de
fiabilité de HelloAsso ; consulter d'abord `processed_payments` permet de répondre `already_handled` sans aucun appel
sortant : ni jeton OAuth, ni lecture de paiement.

Cela n'affaiblit rien. L'identifiant du payload n'est utilisé ici que pour **ne rien faire**. Le pire scénario —
quelqu'un qui posterait l'identifiant d'un paiement déjà traité — obtient un 200 et aucun effet. Aucun chemin d'écriture
ne dépend d'une donnée non réconciliée.

### La place, et non le paiement, est la clé du registre WEI

`wei_registrations` est clé sur `item_id`, l'identifiant de la ligne de commande HelloAsso. La ligne de commande **est**
la place. Ce choix règle trois situations d'un seul geste :

- **règlement échelonné** — les échéances suivantes portent un autre `payment_id` mais les mêmes lignes de commande :
  elles n'insèrent rien ;
- **rejeu HelloAsso** — une notification relivrée ne duplique pas la place ;
- **amorçage** — le script de backfill se rejoue sans précaution.

### Les arrivants sont relus du registre, jamais déduits

Le handler WEI, après insertion, relit **les lignes du registre portant l'identifiant de ce paiement** — et non « celles
qu'il vient d'insérer ».

La nuance élimine le seul cas de message perdu. Si le process meurt entre l'insertion et le marquage du paiement, le
rejeu retrouve ses propres lignes et annonce quand même. Une échéance suivante, qui porte un autre identifiant, ne
retrouve rien et n'annonce donc rien. Aucun cas particulier à coder : la même requête donne la bonne réponse dans les
deux situations.

Les lignes amorcées par le backfill portent un `payment_id` nul : elles ne peuvent jamais être comptées parmi les
arrivants.

### Le fait durable prime sur le message

Une écriture au registre qui échoue lève une `TransientError` : 503, HelloAsso rejoue, on ne perd jamais une
inscription.

Un envoi Discord qui échoue, lui, **ne fait jamais échouer le traitement**. Un paiement encaissé et non répercuté serait
un incident ; un message Discord perdu est un désagrément. Mais le perdre en silence n'est pas acceptable non plus :
l'annonceur signale l'échec à l'alerteur, qui poste dans le salon des incidents. Le bureau sait alors qu'il doit
republier la nouvelle à la main.

### Trois classes d'erreur, trois comportements

Le choix du code HTTP n'est pas cosmétique : il décide si HelloAsso rejoue.

| Classe           | Réponse | Rejeu | Exemples                                                    |
| ---------------- | ------- | ----- | ----------------------------------------------------------- |
| `TransientError` | 503     | oui   | réseau coupé, 5xx amont, quota, timeout, Supabase HS        |
| `DataError`      | 200     | non   | commande WEI sans participant, propriété Notion inexistante |
| `ConfigError`    | —       | —     | jetée au démarrage, le process refuse de se lancer          |

La règle qui en découle est volontairement simple à tenir : `processNotification` ne lève **que** des
`TransientError`. Tout le reste devient un `Outcome`. Le handler HTTP applique donc : _ça revient → 200 ; ça lève →
503_.

Un cas mérite d'être signalé parce qu'il surprend : **une erreur d'autorisation Notion (`unauthorized`,
`restricted_resource`) est classée passagère.** Elle ne se réparera pourtant pas toute seule. Mais répondre 200
accuserait réception d'un paiement non traité, et il serait perdu sans trace ; répondre 503 fait rejouer HelloAsso
pendant qu'un humain reconnecte l'intégration. On préfère un rejeu inutile à un paiement perdu.

### `unresolved` : agir plus tard plutôt que mentir maintenant

Un handler peut rendre `unresolved` : la donnée est valide, il n'a simplement rien pu en faire — le membre a payé, mais
aucune ligne Notion ne le porte encore. Le paiement n'est alors **pas** marqué traité, et une alerte part.

C'est ce qui permet à un rejeu manuel d'aboutir une fois la ligne créée par un humain. Marquer traité aurait scellé
l'échec.

### L'ordre d'écriture : le handler, puis le marquage

Le paiement est marqué traité **après** l'action du handler. Si le process meurt entre les deux, le rejeu refera une
action idempotente — reposer un état déjà posé, réinsérer une place déjà inscrite — puis marquera. L'ordre inverse
risquerait au contraire de perdre l'action.

### Le secret d'URL

C'est la seule barrière disponible. Elle est traitée en conséquence :

- longueur minimale de 24 caractères, imposée par la validation de configuration ;
- comparaison à temps constant sur les empreintes SHA-256 des deux chaînes (comparer les longueurs d'abord, comme
  l'exige `timingSafeEqual`, divulguerait la longueur du secret) ;
- Caddy configuré pour ne pas journaliser le chemin des requêtes, qui contient ce secret.

### Budget de temps

`PROCESS_TIMEOUT_MS` (12 s par défaut) borne le traitement entier, `HTTP_TIMEOUT_MS` (8 s) chaque appel sortant. Les
deux restent sous la limite de HelloAsso.

Le SDK Notion n'expose pas d'`AbortSignal` : le budget y est tenu par deux moyens complémentaires — `timeoutMs` passé au
client, qui borne chaque appel HTTP, et un `throwIfAborted()` avant chaque appel, qui borne la boucle de pagination.

### La capacité du WEI vient d'une variable, pas de HelloAsso

`WEI_CAPACITY` est renseignée à la main. Ce n'est pas un raccourci : **l'API v5 n'expose pas cette information.** Ni le
modèle de formulaire ni `TierPublicModel` ne portent de quota ou de nombre de places restantes — ces valeurs n'existent
que dans l'interface web de HelloAsso. La question a été posée sur leur forum de développeurs sans recevoir de réponse.

Laissée vide, la variable fait afficher le seul total d'inscrits ; le service reste correct, il est simplement moins
bavard.

### Les limites de Discord sont l'affaire de l'adaptateur

La liste des inscrits grossit à chaque place vendue. Elle finira par dépasser la limite de description d'un embed, et
Discord refuserait alors le message entier — le jour précisément où la liste devient intéressante.

`adapters/discord.ts` tronque donc en annonçant ce qu'il tronque (« … et 12 autres »). Les mots viennent du handler, les
contraintes de la plateforme restent dans l'adaptateur.

### Le schéma `helloasso` reste privé

Les deux tables vivent hors de `public`, pour deux raisons :

1. `public` est régénéré dans `@davincibot/database-types` et diffusé aux quatre applications. Aucune n'a affaire à ces
   tables.
2. La convention du projet est déjà un schéma par domaine (`cash`, `formation`, `sso`).

La description TypeScript du schéma est écrite à la main dans `adapters/supabase/client.ts`, à côté de son unique
usage : la faire transiter par le paquet partagé coupleraient le service à son cycle de publication pour rien.
