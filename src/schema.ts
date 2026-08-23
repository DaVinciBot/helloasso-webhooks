import { z } from 'zod';

/**
 * Schémas Zod du payload de notification HelloAsso.
 *
 * Principe : on valide **au plus juste**. Le payload n'est utilisé que pour
 * trois choses — savoir de quel type d'évènement il s'agit, récupérer un id de
 * paiement, et écarter tôt les campagnes hors périmètre. Tout ce qui décide
 * d'une écriture dans Notion provient ensuite de la réconciliation via l'API
 * v5, jamais d'ici. Sur-spécifier ce schéma ne renforcerait donc rien, et
 * casserait le service au premier champ ajouté par HelloAsso.
 */

/** L'API HelloAsso renvoie les identifiants tantôt en nombre, tantôt en chaîne. */
const identifier = z.union([z.number().int(), z.string().min(1)]);

export const helloAssoPayerSchema = z.object({
	email: z.string().optional(),
	firstName: z.string().optional(),
	lastName: z.string().optional()
});

/**
 * Adhérent porté par une ligne de commande. HelloAsso ne lui connaît qu'un
 * prénom et un nom : l'email du formulaire est celui du payeur.
 */
export const helloAssoUserSchema = z.object({
	firstName: z.string().optional(),
	lastName: z.string().optional()
});

/**
 * Ligne d'une commande vue depuis le paiement. `shareAmount` est la part de
 * cette ligne effectivement couverte par le paiement, du point de vue de
 * l'asso ; `id` sert à retrouver la même ligne dans la commande.
 */
export const helloAssoPaymentItemSchema = z.object({
	id: identifier.optional(),
	shareAmount: z.number().optional()
});

/** Ligne d'une commande vue depuis la commande : elle, porte l'adhérent. */
export const helloAssoOrderItemSchema = z.object({
	id: identifier.optional(),
	user: helloAssoUserSchema.optional()
});

export const helloAssoOrderRefSchema = z.object({
	id: identifier.optional(),
	formSlug: z.string().optional(),
	formType: z.string().optional(),
	organizationSlug: z.string().optional()
});

/**
 * Commande relue auprès de l'API v5. Même en-tête que la référence portée par
 * le paiement, plus les lignes — la seule source d'identité des adhérents.
 */
export const helloAssoOrderSchema = helloAssoOrderRefSchema.extend({
	items: z.array(helloAssoOrderItemSchema).optional()
});

export const helloAssoPaymentSchema = z.object({
	id: identifier,
	state: z.string().optional(),
	amount: z.number().optional(),
	date: z.string().optional(),
	payer: helloAssoPayerSchema.optional(),
	order: helloAssoOrderRefSchema.optional(),
	items: z.array(helloAssoPaymentItemSchema).optional()
});

export const helloAssoWebhookSchema = z.object({
	eventType: z.string().min(1),
	data: z.unknown(),
	metadata: z.unknown().optional()
});

export type HelloAssoPayer = z.infer<typeof helloAssoPayerSchema>;
export type HelloAssoUser = z.infer<typeof helloAssoUserSchema>;
export type HelloAssoPaymentItem = z.infer<typeof helloAssoPaymentItemSchema>;
export type HelloAssoOrderItem = z.infer<typeof helloAssoOrderItemSchema>;
export type HelloAssoOrderRef = z.infer<typeof helloAssoOrderRefSchema>;
export type HelloAssoOrder = z.infer<typeof helloAssoOrderSchema>;
export type HelloAssoPayment = z.infer<typeof helloAssoPaymentSchema>;
export type HelloAssoWebhook = z.infer<typeof helloAssoWebhookSchema>;

/** Type d'évènement porté par les notifications de paiement. */
export const PAYMENT_EVENT_TYPE = 'Payment';

/**
 * Normalise un identifiant HelloAsso en chaîne : c'est la forme stockée en base
 * et la seule qui garantisse une comparaison stable entre un `42` du payload et
 * un `"42"` relu depuis Postgres.
 */
export function toPaymentId(id: number | string): string {
	return String(id);
}

/**
 * Normalisation d'email pour le matching Notion : minuscules et espaces
 * retirés. Renvoie `undefined` si la valeur ne peut pas servir de clé de
 * recherche — l'appelant décide alors quoi en faire.
 */
export function normalizeEmail(email: string | undefined): string | undefined {
	if (email === undefined) {
		return undefined;
	}
	const normalized = email.trim().toLowerCase();
	if (normalized === '' || !normalized.includes('@')) {
		return undefined;
	}
	return normalized;
}

/**
 * Normalisation d'un prénom ou d'un nom pour le matching Notion.
 *
 * Un membre saisit son nom chez HelloAsso, un autre humain l'a saisi dans
 * Notion : la casse, les accents, les traits d'union et les apostrophes ne
 * concordent qu'au hasard. On compare donc des formes réduites — « DUPONT »,
 * « Dupont » et « du-pont » deviennent la même clé. Renvoie `undefined` si la
 * valeur ne peut pas servir de critère.
 */
export function normalizeName(name: string | undefined): string | undefined {
	if (name === undefined) {
		return undefined;
	}
	const normalized = name
		.normalize('NFD')
		.replace(/[\u0300-\u036f]/g, '')
		.toLowerCase()
		.replace(/[\u2019'-]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
	return normalized === '' ? undefined : normalized;
}

/**
 * Montant revenant à l'association, en euros.
 *
 * HelloAsso compte en centimes et distingue ce que le payeur débourse
 * (`amount`, contribution volontaire au site comprise) de ce qui revient à
 * l'association (la somme des `items[].shareAmount`). C'est la seconde qui a sa
 * place dans la base des cotisations. Repli sur `amount` quand le détail
 * manque — mieux vaut un montant approché qu'une colonne vide —, `undefined` si
 * le paiement ne porte aucun montant exploitable.
 */
export function organizationAmount(payment: HelloAssoPayment): number | undefined {
	const shares = (payment.items ?? [])
		.map((item) => item.shareAmount)
		.filter((share): share is number => typeof share === 'number');
	const cents =
		shares.length > 0 ? shares.reduce((total, share) => total + share, 0) : payment.amount;

	if (cents === undefined || !Number.isFinite(cents)) {
		return undefined;
	}
	return Math.round(cents) / 100;
}

/**
 * Adhérent réglé par ce paiement.
 *
 * HelloAsso distingue le *payeur* — celui dont la carte est débitée — de
 * l'*adhérent*, porté par la ligne de commande (`items[].user`). Les deux
 * coïncident dans le cas courant, pas quand un tiers règle la cotisation ; or
 * c'est l'adhérent, et lui seul, qui a une ligne dans la base des adhésions.
 * La réponse `/payments/{id}` ne le porte pas : il faut la commande.
 *
 * Le paiement dit quelles lignes il couvre, la commande dit qui elles
 * concernent : on apparie par id de ligne, et on se rabat sur les lignes de la
 * commande quand le paiement n'en désigne aucune d'exploitable. Une identité
 * incomplète est ignorée — elle n'apparierait rien. Fonction pure.
 */
export function adherentOf(
	payment: HelloAssoPayment,
	order: HelloAssoOrder | undefined
): HelloAssoUser | undefined {
	const items = order?.items ?? [];
	const paidIds = new Set(
		(payment.items ?? [])
			.map((item) => item.id)
			.filter((id): id is number | string => id !== undefined)
			.map((id) => String(id))
	);

	const covered = items.filter((item) => item.id !== undefined && paidIds.has(String(item.id)));
	const candidates = covered.length > 0 ? covered : items;

	return candidates
		.map((item) => item.user)
		.find(
			(user) =>
				normalizeName(user?.firstName) !== undefined && normalizeName(user?.lastName) !== undefined
		);
}

/** Critères de recherche de la ligne Notion du membre. */
export interface MemberIdentity {
	readonly email: string | undefined;
	readonly firstName: string | undefined;
	readonly lastName: string | undefined;
}

/**
 * Critères d'appariement du membre, à partir du payeur et de l'adhérent.
 *
 * L'identité vient de l'adhérent dès qu'elle est exploitable, du payeur sinon
 * — mieux vaut un repli que pas de critère du tout.
 *
 * L'email, lui, n'existe que côté payeur. Le retenir sans réserve reviendrait,
 * quand un tiers règle la cotisation, à marquer payée la ligne *du payeur* :
 * l'erreur est silencieuse et touche deux membres à la fois. On ne le garde
 * donc que lorsqu'il désigne bien l'adhérent — noms concordants, ou aucune
 * identité d'adhérent connue. Fonction pure.
 */
export function memberIdentity(
	payer: HelloAssoPayer | undefined,
	adherent: HelloAssoUser | undefined
): MemberIdentity {
	const payerFirst = normalizeName(payer?.firstName);
	const payerLast = normalizeName(payer?.lastName);
	const adherentFirst = normalizeName(adherent?.firstName);
	const adherentLast = normalizeName(adherent?.lastName);

	const known = adherentFirst !== undefined && adherentLast !== undefined;
	const samePerson = !known || (adherentFirst === payerFirst && adherentLast === payerLast);

	return {
		email: samePerson ? normalizeEmail(payer?.email) : undefined,
		firstName: known ? adherent?.firstName : payer?.firstName,
		lastName: known ? adherent?.lastName : payer?.lastName
	};
}
