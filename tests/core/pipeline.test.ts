import { describe, expect, it, vi } from 'vitest';
import { DataError, TransientError } from '../../src/core/errors.js';
import type { ReconciledPayment } from '../../src/core/payment.js';
import { processNotification, type PipelineDeps } from '../../src/core/pipeline.js';
import type { HandlerContext, PaymentHandler } from '../../src/handlers/types.js';
import {
	MEMBERSHIP_SLUG,
	WEI_SLUG,
	makeAlerts,
	makeHelloAsso,
	makePayment,
	makeProcessedPayments,
	makeWeiOrder,
	makeWeiPayment,
	silentLogger,
	type FakeHelloAssoOptions
} from '../helpers.js';

/**
 * Le pipeline se teste sans réseau, sans serveur et sans handler réel : c'est
 * précisément ce que la séparation cœur / handlers achète.
 */

function fakeHandler(name: string, selector: PaymentHandler['selector']) {
	// Les paramètres sont annotés bien qu'inutilisés : c'est ce qui donne son
	// type à `handle.mock.calls`, et donc la possibilité d'inspecter le paiement
	// tel que le pipeline l'a composé.
	const handle = vi.fn((_payment: ReconciledPayment, _context: HandlerContext) =>
		Promise.resolve({ status: 'handled' as const, summary: { fait: name } })
	);
	return { handler: { name, selector, handle } satisfies PaymentHandler, handle };
}

function membershipHandler() {
	return fakeHandler('membership', { formType: 'Membership', formSlug: undefined });
}

function weiHandler() {
	return fakeHandler('wei', { formType: 'Event', formSlug: WEI_SLUG });
}

interface RunOptions extends FakeHelloAssoOptions {
	handlers?: readonly PaymentHandler[];
	processed?: Map<string, string>;
}

function build(options: RunOptions = {}) {
	const helloasso = makeHelloAsso(options);
	const processedPayments = makeProcessedPayments(options.processed);
	const alerts = makeAlerts();

	const deps: PipelineDeps = {
		helloasso: helloasso.port,
		processedPayments: processedPayments.port,
		alerts: alerts.port,
		handlers: options.handlers ?? [membershipHandler().handler],
		orgSlug: 'davincibot',
		acceptedStates: ['Authorized', 'Processed'],
		logger: silentLogger,
		signal: new AbortController().signal
	};

	return { deps, helloasso, processedPayments, alerts };
}

function notification(overrides: Record<string, unknown> = {}): unknown {
	return {
		eventType: 'Payment',
		data: {
			id: 12345,
			order: {
				id: 98765,
				formSlug: MEMBERSHIP_SLUG,
				formType: 'Membership',
				organizationSlug: 'davincibot'
			}
		},
		...overrides
	};
}

describe('processNotification — écartés avant tout appel sortant', () => {
	it('ignore un payload au format inattendu', async () => {
		const { deps, helloasso } = build();
		const outcome = await processNotification({ nimporte: 'quoi' }, deps);

		expect(outcome).toEqual({ status: 'ignored', reason: 'payload_invalide' });
		expect(helloasso.getPayment).not.toHaveBeenCalled();
	});

	it('ignore un évènement autre que Payment', async () => {
		const { deps, helloasso } = build();
		const outcome = await processNotification(notification({ eventType: 'Order' }), deps);

		expect(outcome).toEqual({ status: 'ignored', reason: 'event_Order' });
		expect(helloasso.getPayment).not.toHaveBeenCalled();
	});

	it('signale un évènement Payment sans identifiant exploitable', async () => {
		const { deps } = build();
		const outcome = await processNotification({ eventType: 'Payment', data: {} }, deps);

		expect(outcome).toEqual({
			status: 'data_error',
			paymentId: undefined,
			reason: 'paiement_illisible'
		});
	});

	it('ignore une autre organisation sans appeler HelloAsso', async () => {
		const { deps, helloasso } = build();
		const outcome = await processNotification(
			notification({
				data: { id: 1, order: { organizationSlug: 'autre-asso', formType: 'Membership' } }
			}),
			deps
		);

		expect(outcome.status).toBe('ignored');
		expect(helloasso.getPayment).not.toHaveBeenCalled();
	});

	it("ignore une campagne qu'aucun handler ne revendique, sans appeler HelloAsso", async () => {
		// Le pré-filtre est purement économique : il épargne un aller-retour OAuth.
		const { deps, helloasso } = build({ handlers: [weiHandler().handler] });
		const outcome = await processNotification(notification(), deps);

		expect(outcome.status).toBe('ignored');
		expect(helloasso.getPayment).not.toHaveBeenCalled();
	});

	it('répond « déjà traité » sans solliciter HelloAsso', async () => {
		const { deps, helloasso } = build({ processed: new Map([['12345', 'membership']]) });
		const outcome = await processNotification(notification(), deps);

		expect(outcome).toEqual({
			status: 'already_handled',
			paymentId: '12345',
			handler: 'membership'
		});
		expect(helloasso.getPayment).not.toHaveBeenCalled();
	});
});

describe('processNotification — après réconciliation', () => {
	it('appelle le handler de la campagne et marque le paiement', async () => {
		const membership = membershipHandler();
		const { deps, processedPayments } = build({ handlers: [membership.handler] });

		const outcome = await processNotification(notification(), deps);

		expect(membership.handle).toHaveBeenCalledOnce();
		expect(outcome).toEqual({
			status: 'handled',
			paymentId: '12345',
			handler: 'membership',
			summary: { fait: 'membership' }
		});
		expect(processedPayments.markProcessed).toHaveBeenCalledWith({
			paymentId: '12345',
			handler: 'membership',
			// L'email du payeur est normalisé : trace du règlement, pas critère.
			payerEmail: 'membre.test@example.org'
		});
	});

	it('route un paiement WEI vers le handler WEI', async () => {
		const membership = membershipHandler();
		const wei = weiHandler();
		const { deps } = build({
			handlers: [membership.handler, wei.handler],
			payment: makeWeiPayment(),
			order: makeWeiOrder()
		});

		const outcome = await processNotification(
			notification({
				data: { id: 70001, order: { formSlug: WEI_SLUG, formType: 'Event' } }
			}),
			deps
		);

		expect(wei.handle).toHaveBeenCalledOnce();
		expect(membership.handle).not.toHaveBeenCalled();
		expect(outcome.status).toBe('handled');
	});

	it("ne fait pas confiance au payload : c'est la réponse HelloAsso qui tranche", async () => {
		// Le payload annonce le WEI, HelloAsso répond une cotisation.
		const membership = membershipHandler();
		const wei = weiHandler();
		const { deps } = build({ handlers: [membership.handler, wei.handler] });

		await processNotification(
			notification({ data: { id: 12345, order: { formSlug: WEI_SLUG, formType: 'Event' } } }),
			deps
		);

		expect(membership.handle).toHaveBeenCalledOnce();
		expect(wei.handle).not.toHaveBeenCalled();
	});

	it("n'agit pas sur un statut non abouti", async () => {
		const membership = membershipHandler();
		const { deps, processedPayments } = build({
			handlers: [membership.handler],
			payment: makePayment({ state: 'Refused' })
		});

		const outcome = await processNotification(notification(), deps);

		expect(outcome).toEqual({ status: 'ignored', reason: 'statut_Refused' });
		expect(membership.handle).not.toHaveBeenCalled();
		expect(processedPayments.markProcessed).not.toHaveBeenCalled();
	});

	it('écarte un paiement hors périmètre après réconciliation', async () => {
		const { deps } = build({
			payment: makePayment({
				campaign: { organizationSlug: 'autre-asso', formSlug: undefined, formType: undefined }
			})
		});

		expect((await processNotification(notification(), deps)).status).toBe('ignored');
	});

	it('lit la commande seulement une fois les filtres passés', async () => {
		const { deps, helloasso } = build({ payment: makePayment({ state: 'Refused' }) });
		await processNotification(notification(), deps);

		expect(helloasso.getOrder).not.toHaveBeenCalled();
	});

	it('poursuit sans commande quand le paiement n’en référence aucune', async () => {
		const membership = membershipHandler();
		const { deps, helloasso } = build({
			handlers: [membership.handler],
			payment: makePayment({ orderId: undefined })
		});

		await processNotification(notification(), deps);

		expect(helloasso.getOrder).not.toHaveBeenCalled();
		expect(membership.handle).toHaveBeenCalledOnce();
		expect(membership.handle.mock.calls[0]?.[0].participants).toEqual([]);
	});
});

describe('processNotification — résultats du handler', () => {
	it('ne marque pas traité un paiement laissé non résolu', async () => {
		// Un rejeu manuel doit pouvoir aboutir une fois la donnée corrigée.
		const handle = vi.fn(() =>
			Promise.resolve({
				status: 'unresolved' as const,
				reason: 'aucune_ligne_notion',
				summary: {}
			})
		);
		const { deps, processedPayments } = build({
			handlers: [
				{ name: 'membership', selector: { formType: 'Membership', formSlug: undefined }, handle }
			]
		});

		const outcome = await processNotification(notification(), deps);

		expect(outcome).toEqual({
			status: 'unresolved',
			paymentId: '12345',
			handler: 'membership',
			reason: 'aucune_ligne_notion'
		});
		expect(processedPayments.markProcessed).not.toHaveBeenCalled();
	});

	it('convertit une DataError du handler en résultat, et alerte', async () => {
		const handle = vi.fn(() => Promise.reject(new DataError('commande sans participant')));
		const { deps, alerts, processedPayments } = build({
			handlers: [{ name: 'wei', selector: { formType: 'Membership', formSlug: undefined }, handle }]
		});

		const outcome = await processNotification(notification(), deps);

		expect(outcome).toEqual({
			status: 'data_error',
			paymentId: '12345',
			reason: 'commande sans participant'
		});
		expect(alerts.notify).toHaveBeenCalledOnce();
		expect(processedPayments.markProcessed).not.toHaveBeenCalled();
	});

	it('laisse remonter une TransientError pour provoquer le rejeu', async () => {
		const handle = vi.fn(() => Promise.reject(new TransientError('Supabase indisponible')));
		const { deps } = build({
			handlers: [{ name: 'wei', selector: { formType: 'Membership', formSlug: undefined }, handle }]
		});

		await expect(processNotification(notification(), deps)).rejects.toBeInstanceOf(TransientError);
	});
});
