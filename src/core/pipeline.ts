import type { Logger } from 'pino';
import type { AlertPort } from '../adapters/discord.js';
import type { HelloAssoPort } from '../adapters/helloasso.js';
import type { ProcessedPaymentsPort } from '../adapters/supabase/processedPayments.js';
import type { PaymentHandler } from '../handlers/types.js';
import { describeError, isDataError } from './errors.js';
import { normalizeEmail } from './identity.js';
import {
	ORDER_EVENT_TYPE,
	PAYMENT_EVENT_TYPE,
	claimedCampaign,
	claimedOrderSchema,
	claimedPaymentSchema,
	notificationSchema,
	toIdentifier
} from './notification.js';
import {
	isAcceptedState,
	reconcile,
	type Campaign,
	type Order,
	type ReconciledPayment
} from './payment.js';
import { couldMatchAny, matchesOrganization, selectHandler } from './routing.js';

/**
 * Le traitement d'une notification, de bout en bout.
 *
 * Ce module ne connaît ni HTTP, ni Notion, ni Discord, ni Supabase : il reçoit
 * des *ports* et des *handlers*, et rend un *résultat*. C'est ce qui permet de
 * tester la totalité du flux — ignoré, déjà traité, hors périmètre, non résolu,
 * traité, panne — sans réseau ni serveur.
 *
 * Il ne lève que des {@link TransientError} : tout le reste devient un
 * {@link Outcome}. L'appelant HTTP applique donc une règle unique — ça revient,
 * c'est 200 ; ça lève, c'est 503.
 */

export type Outcome =
	/** Hors périmètre : autre évènement, autre campagne, paiement non abouti. */
	| { readonly status: 'ignored'; readonly reason: string }
	/** Déjà traité lors d'une livraison précédente. */
	| { readonly status: 'already_handled'; readonly paymentId: string; readonly handler: string }
	/** Donnée incohérente : rejouer n'y changerait rien, un humain a été alerté. */
	| {
			readonly status: 'data_error';
			readonly paymentId: string | undefined;
			readonly reason: string;
	  }
	/** Le handler n'a pas pu conclure sur une donnée pourtant valide. */
	| {
			readonly status: 'unresolved';
			readonly paymentId: string;
			readonly handler: string;
			readonly reason: string;
	  }
	/** Cas nominal. */
	| {
			readonly status: 'handled';
			readonly paymentId: string;
			readonly handler: string;
			readonly summary: Readonly<Record<string, unknown>>;
	  };

export interface PipelineDeps {
	readonly helloasso: HelloAssoPort;
	readonly processedPayments: ProcessedPaymentsPort;
	readonly alerts: AlertPort;
	readonly handlers: readonly PaymentHandler[];
	readonly orgSlug: string;
	readonly acceptedStates: readonly string[];
	readonly logger: Logger;
	readonly signal: AbortSignal;
}

export async function processNotification(body: unknown, deps: PipelineDeps): Promise<Outcome> {
	const envelope = notificationSchema.safeParse(body);
	if (!envelope.success) {
		deps.logger.warn('notification au format inattendu, ignorée');
		return { status: 'ignored', reason: 'payload_invalide' };
	}

	const { eventType } = envelope.data;

	if (eventType === PAYMENT_EVENT_TYPE) {
		return await processPaymentNotification(envelope.data.data, deps);
	}

	// HelloAsso n'émet un `Order` sans `Payment` que pour une commande
	// entièrement gratuite — une cotisation à 0€ après réduction, par exemple.
	if (eventType === ORDER_EVENT_TYPE) {
		return await processOrderNotification(envelope.data.data, deps);
	}

	deps.logger.info({ eventType }, 'évènement hors périmètre, ignoré');
	return { status: 'ignored', reason: `event_${eventType}` };
}

async function processPaymentNotification(data: unknown, deps: PipelineDeps): Promise<Outcome> {
	const claimed = claimedPaymentSchema.safeParse(data);
	if (!claimed.success) {
		deps.logger.warn('évènement Payment sans identifiant exploitable, ignoré');
		return { status: 'data_error', paymentId: undefined, reason: 'paiement_illisible' };
	}

	const paymentId = toIdentifier(claimed.data.id);
	const logger = deps.logger.child({ paymentId });
	logger.info({ eventType: PAYMENT_EVENT_TYPE }, 'notification reçue');

	// Pré-filtre sur le payload : purement économique. Il épargne un aller-retour
	// OAuth + API aux notifications manifestement étrangères au service — un
	// paiement de la boutique quand seuls l'adhésion et le WEI sont câblés. Il ne
	// donne jamais lieu à une action, donc lui faire confiance ne coûte rien.
	const announced = claimedCampaign(claimed.data);
	const organization = matchesOrganization(announced, deps.orgSlug);
	if (!organization.ok) {
		logger.info({ reason: organization.reason }, 'notification hors périmètre, ignorée');
		return { status: 'ignored', reason: organization.reason };
	}
	if (!couldMatchAny(announced, deps.handlers)) {
		logger.info({ campagne: announced.formSlug }, 'aucun handler pour cette campagne, ignorée');
		return { status: 'ignored', reason: `campagne_sans_handler:${announced.formSlug ?? ''}` };
	}

	try {
		return await handlePayment(paymentId, logger, deps);
	} catch (error) {
		if (isDataError(error)) {
			logger.warn({ err: describeError(error) }, 'incohérence de données, pas de rejeu');
			await deps.alerts.notify({
				title: 'Paiement HelloAsso : incohérence de données',
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
	deps: PipelineDeps
): Promise<Outcome> {
	// Idempotence avant réconciliation : sur un rejeu, on répond sans solliciter
	// HelloAsso. Possible précisément parce que la clé est le paiement seul, et
	// non le couple paiement + handler — savoir *qu'il* a été traité suffit à ne
	// rien refaire, sans avoir à savoir *par qui*.
	const previous = await deps.processedPayments.find(paymentId);
	if (previous !== undefined) {
		logger.info({ handler: previous.handler }, 'paiement déjà traité, aucune action');
		return { status: 'already_handled', paymentId, handler: previous.handler };
	}

	const payment = await deps.helloasso.getPayment(paymentId, { signal: deps.signal });
	logger.info({ state: payment.state }, 'paiement réconcilié auprès de HelloAsso');

	// À partir d'ici, plus rien ne vient du payload : la campagne, le statut et
	// l'identité sortent tous de réponses authentifiées.
	const organization = matchesOrganization(payment.campaign, deps.orgSlug);
	if (!organization.ok) {
		logger.info({ reason: organization.reason }, 'paiement hors périmètre après réconciliation');
		return { status: 'ignored', reason: organization.reason };
	}

	const handler = selectHandler(payment.campaign, deps.handlers);
	if (handler === undefined) {
		logger.info(
			{ campagne: payment.campaign.formSlug, type: payment.campaign.formType },
			'aucun handler pour cette campagne après réconciliation'
		);
		return {
			status: 'ignored',
			reason: `campagne_sans_handler:${payment.campaign.formSlug ?? ''}`
		};
	}

	if (!isAcceptedState(payment.state, deps.acceptedStates)) {
		logger.info({ state: payment.state }, 'statut non éligible, aucune action');
		return { status: 'ignored', reason: `statut_${payment.state ?? 'inconnu'}` };
	}

	// La commande n'est lue qu'ici : elle seule porte l'identité des inscrits, et
	// un paiement écarté plus haut ne la déclenche pas.
	const order = await fetchOrder(payment.orderId, logger, deps);
	const reconciled = reconcile(payment, order);

	return await finalizeHandling(paymentId, reconciled, handler, logger, deps);
}

/** Préfixe de la clé d'idempotence des commandes gratuites, pour ne jamais collisionner avec un vrai `paymentId`. */
const ORDER_DEDUPE_PREFIX = 'order:';

function orderDedupeId(orderId: string): string {
	return `${ORDER_DEDUPE_PREFIX}${orderId}`;
}

async function processOrderNotification(data: unknown, deps: PipelineDeps): Promise<Outcome> {
	const claimed = claimedOrderSchema.safeParse(data);
	if (!claimed.success) {
		deps.logger.warn('évènement Order sans identifiant exploitable, ignoré');
		return { status: 'data_error', paymentId: undefined, reason: 'commande_illisible' };
	}

	// Pré-filtre purement économique, au même titre que celui du flux `Payment` :
	// une commande annoncée payante aura de toute façon son propre évènement
	// `Payment`, inutile d'aller la relire ici. Jamais utilisé pour agir — seule
	// la relecture authentifiée plus bas peut conclure qu'une commande est
	// effectivement gratuite.
	if (claimed.data.amount?.total !== 0) {
		deps.logger.info({ eventType: ORDER_EVENT_TYPE }, 'évènement hors périmètre, ignoré');
		return { status: 'ignored', reason: `event_${ORDER_EVENT_TYPE}` };
	}

	const orderId = toIdentifier(claimed.data.id);
	const dedupeId = orderDedupeId(orderId);
	const logger = deps.logger.child({ orderId });
	logger.info({ eventType: ORDER_EVENT_TYPE }, 'notification reçue (commande gratuite annoncée)');

	const announced: Campaign = {
		organizationSlug: claimed.data.organizationSlug,
		formSlug: claimed.data.formSlug,
		formType: claimed.data.formType
	};
	const organization = matchesOrganization(announced, deps.orgSlug);
	if (!organization.ok) {
		logger.info({ reason: organization.reason }, 'notification hors périmètre, ignorée');
		return { status: 'ignored', reason: organization.reason };
	}
	if (!couldMatchAny(announced, deps.handlers)) {
		logger.info({ campagne: announced.formSlug }, 'aucun handler pour cette campagne, ignorée');
		return { status: 'ignored', reason: `campagne_sans_handler:${announced.formSlug ?? ''}` };
	}

	try {
		return await handleFreeOrder(orderId, dedupeId, logger, deps);
	} catch (error) {
		if (isDataError(error)) {
			logger.warn({ err: describeError(error) }, 'incohérence de données, pas de rejeu');
			await deps.alerts.notify({
				title: 'Commande HelloAsso gratuite : incohérence de données',
				fields: { commande: orderId, détail: error.message }
			});
			return { status: 'data_error', paymentId: dedupeId, reason: error.message };
		}
		throw error;
	}
}

async function handleFreeOrder(
	orderId: string,
	dedupeId: string,
	logger: Logger,
	deps: PipelineDeps
): Promise<Outcome> {
	const previous = await deps.processedPayments.find(dedupeId);
	if (previous !== undefined) {
		logger.info({ handler: previous.handler }, 'commande déjà traitée, aucune action');
		return { status: 'already_handled', paymentId: dedupeId, handler: previous.handler };
	}

	const order = await deps.helloasso.getOrder(orderId, { signal: deps.signal });
	logger.info({ montant: order.amountEuros }, 'commande réconciliée auprès de HelloAsso');

	const organization = matchesOrganization(order.campaign, deps.orgSlug);
	if (!organization.ok) {
		logger.info({ reason: organization.reason }, 'commande hors périmètre après réconciliation');
		return { status: 'ignored', reason: organization.reason };
	}

	const handler = selectHandler(order.campaign, deps.handlers);
	if (handler === undefined) {
		logger.info(
			{ campagne: order.campaign.formSlug, type: order.campaign.formType },
			'aucun handler pour cette campagne après réconciliation'
		);
		return {
			status: 'ignored',
			reason: `campagne_sans_handler:${order.campaign.formSlug ?? ''}`
		};
	}

	// Re-vérification authoritative : le payload pouvait annoncer une commande
	// gratuite à tort (course avec une réduction retirée, format inattendu...).
	// Dans ce cas on ignore silencieusement — le vrai paiement à venir aura son
	// propre évènement `Payment`, qui couvrira la commande normalement.
	if (order.amountEuros !== 0) {
		logger.info(
			{ montant: order.amountEuros },
			'commande finalement non gratuite, ignorée (le paiement suivra son propre évènement)'
		);
		return { status: 'ignored', reason: 'commande_non_gratuite' };
	}

	// Paiement synthétique : `paidItemIds` vide fait retomber `participantsOf`
	// sur toutes les lignes de la commande, exactement le comportement voulu
	// puisqu'aucun paiement réel ne désigne les lignes couvertes.
	const reconciled = reconcile(
		{
			id: dedupeId,
			state: undefined,
			campaign: order.campaign,
			orderId: order.id,
			amountEuros: 0,
			payer: order.payer,
			paidItemIds: []
		},
		order
	);

	return await finalizeHandling(dedupeId, reconciled, handler, logger, deps);
}

/**
 * Fin commune aux deux flux, une fois le paiement (réel ou synthétique)
 * réconcilié et le handler choisi : agir, puis marquer.
 */
async function finalizeHandling(
	id: string,
	reconciled: ReconciledPayment,
	handler: PaymentHandler,
	logger: Logger,
	deps: PipelineDeps
): Promise<Outcome> {
	const handlerLogger = logger.child({ handler: handler.name });
	const result = await handler.handle(reconciled, {
		logger: handlerLogger,
		signal: deps.signal,
		alerts: deps.alerts
	});

	if (result.status === 'unresolved') {
		handlerLogger.warn(
			{ reason: result.reason, ...result.summary },
			'paiement non résolu, pas de marquage'
		);
		return { status: 'unresolved', paymentId: id, handler: handler.name, reason: result.reason };
	}

	// Marquage en dernier : si le process meurt entre l'action du handler et ce
	// point, le rejeu refera une action idempotente — reposer un état déjà posé,
	// réinsérer une place déjà inscrite — puis marquera. L'ordre inverse
	// risquerait au contraire de perdre l'action.
	// La colonne garde l'email du *payeur*, normalisé : c'est la trace du
	// règlement, jamais un critère d'appariement.
	await deps.processedPayments.markProcessed({
		paymentId: id,
		handler: handler.name,
		payerEmail: normalizeEmail(reconciled.payer?.email)
	});

	handlerLogger.info(result.summary, 'paiement traité');
	return { status: 'handled', paymentId: id, handler: handler.name, summary: result.summary };
}

/**
 * Relit la commande du paiement.
 *
 * Sans référence de commande il n'y a rien à lire : on continue avec une
 * commande absente plutôt que d'abandonner un paiement valide. Aux handlers de
 * décider si l'absence d'inscrit leur est fatale — elle l'est pour le WEI, pas
 * pour la cotisation, qui sait se rabattre sur le payeur.
 */
async function fetchOrder(
	orderId: string | undefined,
	logger: Logger,
	deps: PipelineDeps
): Promise<Order | undefined> {
	if (orderId === undefined) {
		logger.warn('paiement sans référence de commande, aucun inscrit identifiable');
		return undefined;
	}
	return await deps.helloasso.getOrder(orderId, { signal: deps.signal });
}
