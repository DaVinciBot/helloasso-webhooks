import { normalizeName, type Person } from './identity.js';

/**
 * Le modèle du domaine.
 *
 * Ces types sont ce que le cœur du service et les handlers manipulent. Aucun ne
 * ressemble à une réponse HelloAsso : la traduction depuis le format v5 est le
 * travail de l'adaptateur, et elle s'arrête ici. Un handler ne voit jamais un
 * `shareAmount` en centimes ni un identifiant tantôt nombre tantôt chaîne.
 */

/** La campagne qui a encaissé : c'est elle qui décide du handler. */
export interface Campaign {
	readonly organizationSlug: string | undefined;
	readonly formSlug: string | undefined;
	readonly formType: string | undefined;
}

/** Paiement relu auprès de HelloAsso, avant jonction avec sa commande. */
export interface Payment {
	readonly id: string;
	readonly state: string | undefined;
	readonly campaign: Campaign;
	readonly orderId: string | undefined;
	/** Part revenant à l'association, en euros. */
	readonly amountEuros: number | undefined;
	readonly payer: Person | undefined;
	/** Lignes de commande que ce paiement couvre. */
	readonly paidItemIds: readonly string[];
}

/** Ligne d'une commande : une place, une adhésion, un article. */
export interface OrderItem {
	readonly id: string | undefined;
	readonly person: Person | undefined;
}

/** Commande relue auprès de HelloAsso : elle seule porte l'identité des inscrits. */
export interface Order {
	readonly id: string;
	readonly campaign: Campaign;
	readonly items: readonly OrderItem[];
}

/**
 * Personne inscrite par une ligne de commande, dont l'identité est complète.
 *
 * `itemId` n'est pas décoratif : c'est l'identifiant de la ligne de commande,
 * donc de la place elle-même. Le registre du WEI s'en sert comme clé, ce qui
 * rend une inscription unique quel que soit le nombre de paiements ou de rejeux
 * qui la traversent.
 */
export interface Participant {
	readonly itemId: string;
	readonly firstName: string;
	readonly lastName: string;
}

/** Paiement réconcilié, joint à sa commande : ce que reçoit un handler. */
export interface ReconciledPayment {
	readonly id: string;
	readonly state: string | undefined;
	readonly campaign: Campaign;
	readonly orderId: string | undefined;
	readonly amountEuros: number | undefined;
	readonly payer: Person | undefined;
	/** Dans l'ordre des lignes de la commande. Peut être vide. */
	readonly participants: readonly Participant[];
}

/**
 * Les personnes inscrites par ce paiement.
 *
 * HelloAsso distingue le *payeur* — celui dont la carte est débitée — des
 * *inscrits*, portés par les lignes de commande. Les deux coïncident dans le cas
 * courant, pas quand un parent règle la cotisation de son enfant ni quand une
 * seule commande achète trois places de WEI.
 *
 * Le paiement dit quelles lignes il couvre, la commande dit qui elles
 * concernent : on apparie par identifiant de ligne, et on se rabat sur toutes
 * les lignes de la commande quand le paiement n'en désigne aucune d'exploitable.
 *
 * Une ligne sans identifiant ou à l'identité incomplète est écartée : elle
 * n'apparierait rien dans Notion et n'aurait pas sa place dans une liste lue par
 * des humains. Fonction pure.
 */
export function participantsOf(payment: Payment, order: Order | undefined): readonly Participant[] {
	const items = order?.items ?? [];
	const paid = new Set(payment.paidItemIds);
	const covered = items.filter((item) => item.id !== undefined && paid.has(item.id));
	const candidates = covered.length > 0 ? covered : items;

	return candidates.flatMap((item): Participant[] => {
		const firstName = item.person?.firstName;
		const lastName = item.person?.lastName;

		if (item.id === undefined || firstName === undefined || lastName === undefined) {
			return [];
		}
		if (normalizeName(firstName) === undefined || normalizeName(lastName) === undefined) {
			return [];
		}
		return [{ itemId: item.id, firstName, lastName }];
	});
}

/** Joint un paiement à sa commande. Fonction pure. */
export function reconcile(payment: Payment, order: Order | undefined): ReconciledPayment {
	return {
		id: payment.id,
		state: payment.state,
		campaign: payment.campaign,
		orderId: payment.orderId,
		amountEuros: payment.amountEuros,
		payer: payment.payer,
		participants: participantsOf(payment, order)
	};
}

/**
 * Le statut du paiement autorise-t-il à agir ? Comparaison insensible à la
 * casse : HelloAsso n'est pas constant. Fonction pure.
 */
export function isAcceptedState(
	state: string | undefined,
	acceptedStates: readonly string[]
): boolean {
	if (state === undefined) {
		return false;
	}
	const normalized = state.toLowerCase();
	return acceptedStates.some((accepted) => accepted.toLowerCase() === normalized);
}
