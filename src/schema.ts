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
 * Ligne d'une commande. Seule `shareAmount` est lue : c'est la part de cette
 * ligne effectivement couverte par le paiement, du point de vue de l'asso.
 */
export const helloAssoPaymentItemSchema = z.object({
	shareAmount: z.number().optional()
});

export const helloAssoOrderRefSchema = z.object({
	id: identifier.optional(),
	formSlug: z.string().optional(),
	formType: z.string().optional(),
	organizationSlug: z.string().optional()
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
export type HelloAssoPaymentItem = z.infer<typeof helloAssoPaymentItemSchema>;
export type HelloAssoOrderRef = z.infer<typeof helloAssoOrderRefSchema>;
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
