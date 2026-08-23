import type { AlertPort } from './alerts.js';
import type { DedupPort } from './dedup.js';
import { DataError, describeError, isDataError } from './errors.js';
import type { HelloAssoPort } from './helloasso.js';
import type { Logger } from './logger.js';
import type { NotionPort } from './notion.js';
import {
	PAYMENT_EVENT_TYPE,
	adherentOf,
	helloAssoPaymentSchema,
	helloAssoWebhookSchema,
	memberIdentity,
	normalizeEmail,
	normalizeName,
	organizationAmount,
	toPaymentId,
	type HelloAssoOrder,
	type HelloAssoOrderRef,
	type HelloAssoPayer,
	type HelloAssoPayment
} from './schema.js';

/**
 * Orchestration du traitement d'une notification.
 *
 * Ce module ne connaît ni HTTP, ni Notion, ni Supabase : il reçoit des *ports*
 * et rend un *résultat*. C'est ce qui permet de tester la totalité du flux —
 * ignoré, déjà traité, non apparié, écrit, panne — sans réseau ni serveur.
 */

export interface CampaignFilter {
	readonly orgSlug: string;
	readonly formSlug: string | undefined;
	readonly formType: string | undefined;
}

export type ProcessOutcome =
	/** Hors périmètre : autre évènement, autre campagne, paiement non abouti. */
	| { readonly status: 'ignored'; readonly reason: string }
	/** Déjà traité lors d'une livraison précédente. */
	| { readonly status: 'already_handled'; readonly paymentId: string }
	/** Paiement valide, mais aucune ligne Notion ne correspond. */
	| {
			readonly status: 'unmatched';
			readonly paymentId: string;
			readonly email: string | undefined;
	  }
	/** Donnée incohérente côté HelloAsso ou Notion : rejouer n'y changerait rien. */
	| {
			readonly status: 'data_error';
			readonly paymentId: string | undefined;
			readonly reason: string;
	  }
	/** Cas nominal : au moins une ligne marquée payée. */
	| {
			readonly status: 'updated';
			readonly paymentId: string;
			readonly email: string | undefined;
			readonly matchedBy: 'email' | 'identité';
			readonly pageIds: readonly string[];
	  };

export interface ProcessDeps {
	readonly helloasso: HelloAssoPort;
	readonly notion: NotionPort;
	readonly dedup: DedupPort;
	readonly alerts: AlertPort;
	readonly logger: Logger;
	readonly campaign: CampaignFilter;
	readonly acceptedStates: readonly string[];
	readonly signal: AbortSignal;
}

/** Comparaison de slugs : HelloAsso n'est pas constant sur la casse. */
function sameSlug(left: string | undefined, right: string | undefined): boolean {
	if (left === undefined || right === undefined) {
		return true; // information absente : on ne peut rien conclure, on n'écarte pas.
	}
	return left.toLowerCase() === right.toLowerCase();
}

/**
 * Le paiement relève-t-il de la campagne visée ?
 *
 * Volontairement *permissif sur l'absence* et strict sur le désaccord : si
 * HelloAsso omet `formSlug`, on ne rejette pas (sinon un changement de format
 * de leur côté coupe le service en silence) ; s'il en renvoie un qui diffère,
 * on rejette. Fonction pure.
 */
export function matchesCampaign(
	order: HelloAssoOrderRef | undefined,
	filter: CampaignFilter
): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
	if (!sameSlug(order?.organizationSlug, filter.orgSlug)) {
		return { ok: false, reason: `organisation_hors_perimetre:${order?.organizationSlug ?? ''}` };
	}
	if (filter.formSlug !== undefined && !sameSlug(order?.formSlug, filter.formSlug)) {
		return { ok: false, reason: `campagne_hors_perimetre:${order?.formSlug ?? ''}` };
	}
	if (filter.formType !== undefined && !sameSlug(order?.formType, filter.formType)) {
		return { ok: false, reason: `type_de_formulaire_hors_perimetre:${order?.formType ?? ''}` };
	}
	return { ok: true };
}

/** Le statut du paiement autorise-t-il l'écriture ? Fonction pure. */
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

/**
 * Traite une notification HelloAsso de bout en bout.
 *
 * Ne lève que des {@link TransientError} : tout le reste est converti en
 * {@link ProcessOutcome}, ce qui laisse à l'appelant une règle simple —
 * ça revient, c'est 200 ; ça lève, c'est 503.
 */
export async function processWebhook(body: unknown, deps: ProcessDeps): Promise<ProcessOutcome> {
	const envelope = helloAssoWebhookSchema.safeParse(body);
	if (!envelope.success) {
		deps.logger.warn('notification au format inattendu, ignorée');
		return { status: 'ignored', reason: 'payload_invalide' };
	}

	const { eventType } = envelope.data;
	if (eventType !== PAYMENT_EVENT_TYPE) {
		deps.logger.info({ eventType }, 'évènement hors périmètre, ignoré');
		return { status: 'ignored', reason: `event_${eventType}` };
	}

	const claimed = helloAssoPaymentSchema.safeParse(envelope.data.data);
	if (!claimed.success) {
		deps.logger.warn('évènement Payment sans identifiant exploitable, ignoré');
		return { status: 'data_error', paymentId: undefined, reason: 'paiement_illisible' };
	}

	const paymentId = toPaymentId(claimed.data.id);
	const logger = deps.logger.child({ paymentId });
	logger.info({ eventType }, 'notification reçue');

	// Pré-filtre sur le payload : purement économique. Il évite un aller-retour
	// OAuth + API pour les notifications manifestement hors périmètre. Il ne
	// donne jamais lieu à une écriture, donc lui faire confiance ne coûte rien.
	const preFilter = matchesCampaign(claimed.data.order, deps.campaign);
	if (!preFilter.ok) {
		logger.info({ reason: preFilter.reason }, 'notification hors périmètre, ignorée');
		return { status: 'ignored', reason: preFilter.reason };
	}

	try {
		return await handlePayment(paymentId, logger, deps);
	} catch (error) {
		if (isDataError(error)) {
			logger.warn({ err: describeError(error) }, 'incohérence de données, pas de rejeu');
			await deps.alerts.notify({
				title: 'Cotisation HelloAsso : incohérence de données',
				fields: { paiement: paymentId, détail: error.message }
			});
			return { status: 'data_error', paymentId, reason: error.message };
		}
		throw error;
	}
}

async function handlePayment(
	paymentId: string,
	logger: Logger,
	deps: ProcessDeps
): Promise<ProcessOutcome> {
	// Idempotence avant réconciliation : sur un rejeu — le cas le plus fréquent —
	// on répond sans solliciter HelloAsso. L'id ne sert ici qu'à *ne rien faire*.
	if (await deps.dedup.isProcessed(paymentId)) {
		logger.info('paiement déjà traité, aucune écriture');
		return { status: 'already_handled', paymentId };
	}

	const payment = await deps.helloasso.getPayment(paymentId, { signal: deps.signal });
	logger.info({ state: payment.state }, 'paiement réconcilié auprès de HelloAsso');

	const filter = matchesCampaign(payment.order, deps.campaign);
	if (!filter.ok) {
		logger.info({ reason: filter.reason }, 'paiement hors périmètre après réconciliation');
		return { status: 'ignored', reason: filter.reason };
	}

	if (!isAcceptedState(payment.state, deps.acceptedStates)) {
		logger.info({ state: payment.state }, 'statut non éligible, aucune écriture');
		return { status: 'ignored', reason: `statut_${payment.state ?? 'inconnu'}` };
	}

	const amount = organizationAmount(payment);

	// Le paiement ne connaît que le payeur ; l'adhésion, elle, est portée par la
	// commande. Tant qu'un tiers peut régler la cotisation d'un membre, c'est
	// cette seconde lecture qui dit *qui* marquer payé.
	const order = await fetchOrder(payment, logger, deps);
	const { email, firstName, lastName } = memberIdentity(payment.payer, adherentOf(payment, order));

	if (
		email === undefined &&
		(normalizeName(firstName) === undefined || normalizeName(lastName) === undefined)
	) {
		throw new DataError('le paiement ne porte ni adresse email exploitable ni nom complet');
	}

	const match = await deps.notion.findPages(
		{ email, firstName, lastName },
		{ signal: deps.signal }
	);

	if (match === undefined) {
		logger.warn({ email, firstName, lastName }, 'aucune ligne Notion pour ce membre');
		await deps.alerts.notify({
			title: 'Cotisation payée sans ligne Notion correspondante',
			fields: {
				paiement: paymentId,
				email,
				prénom: firstName,
				nom: lastName,
				montant: amount === undefined ? undefined : `${amount.toFixed(2)} €`,
				payeur: describePayer(payment.payer, firstName, lastName),
				action: "vérifier l'adresse et le nom du membre dans la base Notion"
			}
		});
		return { status: 'unmatched', paymentId, email };
	}

	const { pageIds, matchedBy } = match;

	if (pageIds.length > 1) {
		logger.warn(
			{ email, matchedBy, matches: pageIds.length },
			'plusieurs lignes Notion pour ce membre, toutes seront marquées'
		);
	}

	logger.info({ email, matchedBy, matches: pageIds.length }, 'lignes Notion appariées');

	if (amount === undefined) {
		// Sans montant, l'état est quand même posé : la cotisation reste visible.
		logger.warn('paiement sans montant exploitable, colonne montant laissée telle quelle');
	}

	for (const pageId of pageIds) {
		await deps.notion.markPaid(pageId, { amount, signal: deps.signal });
		logger.info({ pageId, amount }, 'cotisation marquée payée');
	}

	// Marquage en dernier : si le process meurt entre l'écriture Notion et ce
	// point, le rejeu reposera un état déjà posé — opération sans effet —
	// puis marquera. L'ordre inverse risquerait au contraire de perdre l'écriture.
	// La colonne garde l'email du *payeur* : trace du règlement, pas critère.
	await deps.dedup.markProcessed(paymentId, normalizeEmail(payment.payer?.email));

	logger.info({ email, matchedBy, pages: pageIds.length }, 'paiement traité');
	return { status: 'updated', paymentId, email, matchedBy, pageIds };
}

/**
 * Relit la commande du paiement, seule porteuse de l'identité de l'adhérent.
 *
 * Sans référence de commande exploitable il n'y a rien à lire : on continue
 * avec le payeur pour seul repère plutôt que d'abandonner un paiement valide —
 * dans le cas courant, payeur et adhérent sont la même personne.
 */
async function fetchOrder(
	payment: HelloAssoPayment,
	logger: Logger,
	deps: ProcessDeps
): Promise<HelloAssoOrder | undefined> {
	const orderId = payment.order?.id;
	if (orderId === undefined) {
		logger.warn('paiement sans référence de commande, appariement sur le payeur');
		return undefined;
	}

	return await deps.helloasso.getOrder(String(orderId), { signal: deps.signal });
}

/**
 * Mention du payeur dans l'alerte, quand il n'est pas l'adhérent : sans elle,
 * une alerte « aucune ligne Notion » sur un règlement par un tiers ne donne
 * aucune prise pour retrouver le paiement côté HelloAsso.
 */
function describePayer(
	payer: HelloAssoPayer | undefined,
	firstName: string | undefined,
	lastName: string | undefined
): string | undefined {
	const identity = [payer?.firstName, payer?.lastName].filter((part) => part !== undefined);
	// Comparaison normalisée : « austin » et « Austin » sont la même personne,
	// et la mentionner deux fois dans l'alerte ne ferait qu'égarer.
	const isAdherent =
		normalizeName(payer?.firstName) === normalizeName(firstName) &&
		normalizeName(payer?.lastName) === normalizeName(lastName);
	if (isAdherent || (identity.length === 0 && payer?.email === undefined)) {
		return undefined;
	}

	const email = payer?.email === undefined ? undefined : `<${payer.email}>`;
	return [...identity, email].filter((part) => part !== undefined).join(' ');
}
