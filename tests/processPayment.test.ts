import { describe, expect, it } from 'vitest';
import { DataError, TransientError } from '../src/errors.js';
import {
	isAcceptedState,
	matchesCampaign,
	processWebhook,
	type CampaignFilter,
	type ProcessDeps
} from '../src/processPayment.js';
import { makePayment, makePorts, silentLogger } from './helpers.js';

const campaign: CampaignFilter = {
	orgSlug: 'davincibot',
	formSlug: undefined,
	formType: undefined
};

function makeDeps(
	doubles: ReturnType<typeof makePorts>,
	overrides: Partial<ProcessDeps> = {}
): ProcessDeps {
	return {
		...doubles.ports,
		logger: silentLogger,
		campaign,
		acceptedStates: ['Authorized', 'Processed'],
		signal: new AbortController().signal,
		...overrides
	};
}

function notification(data: unknown, eventType = 'Payment'): unknown {
	return { eventType, data, metadata: {} };
}

describe('matchesCampaign', () => {
	it('accepte un paiement de la bonne organisation', () => {
		expect(matchesCampaign({ organizationSlug: 'davincibot' }, campaign)).toEqual({ ok: true });
	});

	it("écarte un paiement d'une autre organisation", () => {
		const result = matchesCampaign({ organizationSlug: 'autre-asso' }, campaign);
		expect(result.ok).toBe(false);
	});

	it('ignore la casse des slugs', () => {
		expect(matchesCampaign({ organizationSlug: 'DaVinciBot' }, campaign)).toEqual({ ok: true });
	});

	it("n'écarte pas quand l'information est absente", () => {
		// Permissif sur l'absence : un champ retiré par HelloAsso ne doit pas
		// couper le service en silence.
		expect(matchesCampaign(undefined, campaign)).toEqual({ ok: true });
		expect(matchesCampaign({}, { ...campaign, formSlug: 'adhesion-2026' })).toEqual({
			ok: true
		});
	});

	it('écarte une campagne qui ne correspond pas au filtre', () => {
		const result = matchesCampaign(
			{ organizationSlug: 'davincibot', formSlug: 'don-libre' },
			{ ...campaign, formSlug: 'adhesion-2026' }
		);
		expect(result.ok).toBe(false);
	});

	it('écarte un type de formulaire qui ne correspond pas au filtre', () => {
		const result = matchesCampaign(
			{ organizationSlug: 'davincibot', formType: 'Donation' },
			{ ...campaign, formType: 'Membership' }
		);
		expect(result.ok).toBe(false);
	});
});

describe('isAcceptedState', () => {
	it('accepte les statuts configurés, quelle que soit la casse', () => {
		expect(isAcceptedState('Authorized', ['Authorized'])).toBe(true);
		expect(isAcceptedState('authorized', ['Authorized'])).toBe(true);
	});

	it('refuse un statut absent de la liste ou manquant', () => {
		expect(isAcceptedState('Refused', ['Authorized'])).toBe(false);
		expect(isAcceptedState(undefined, ['Authorized'])).toBe(false);
	});
});

describe('processWebhook', () => {
	it("ignore un payload qui n'a pas la forme d'une notification", async () => {
		const doubles = makePorts();
		const outcome = await processWebhook({ nimporte: 'quoi' }, makeDeps(doubles));

		expect(outcome).toEqual({ status: 'ignored', reason: 'payload_invalide' });
		expect(doubles.isProcessed).not.toHaveBeenCalled();
	});

	it('signale un évènement Payment sans identifiant exploitable', async () => {
		const doubles = makePorts();
		const outcome = await processWebhook(notification({ payer: {} }), makeDeps(doubles));

		expect(outcome).toEqual({
			status: 'data_error',
			paymentId: undefined,
			reason: 'paiement_illisible'
		});
	});

	it('écarte une notification hors périmètre avant tout appel sortant', async () => {
		const doubles = makePorts();
		const outcome = await processWebhook(
			notification({ id: 1, order: { organizationSlug: 'autre-asso' } }),
			makeDeps(doubles)
		);

		expect(outcome.status).toBe('ignored');
		expect(doubles.isProcessed).not.toHaveBeenCalled();
		expect(doubles.getPayment).not.toHaveBeenCalled();
	});

	it("n'écrit pas si le statut réconcilié n'est pas éligible", async () => {
		// Le payload annonce « Authorized », HelloAsso dit « Refused » :
		// c'est la réconciliation qui fait foi.
		const doubles = makePorts({ payment: makePayment({ state: 'Refused' }) });
		const outcome = await processWebhook(
			notification({ id: 12345, state: 'Authorized' }),
			makeDeps(doubles)
		);

		expect(outcome).toEqual({ status: 'ignored', reason: 'statut_Refused' });
		expect(doubles.findPagesByEmail).not.toHaveBeenCalled();
		expect(doubles.markPaid).not.toHaveBeenCalled();
		expect(doubles.markProcessed).not.toHaveBeenCalled();
	});

	it("écarte après réconciliation un paiement d'une autre campagne", async () => {
		const doubles = makePorts({
			payment: makePayment({
				order: { organizationSlug: 'davincibot', formSlug: 'don-libre' }
			})
		});
		const outcome = await processWebhook(
			notification({ id: 12345 }),
			makeDeps(doubles, { campaign: { ...campaign, formSlug: 'adhesion-2026-2027' } })
		);

		expect(outcome.status).toBe('ignored');
		expect(doubles.markPaid).not.toHaveBeenCalled();
	});

	it("alerte et n'enregistre rien quand aucune ligne Notion ne correspond", async () => {
		const doubles = makePorts({ notionPages: [] });
		const outcome = await processWebhook(notification({ id: 12345 }), makeDeps(doubles));

		expect(outcome).toEqual({
			status: 'unmatched',
			paymentId: '12345',
			email: 'membre.test@example.org'
		});
		expect(doubles.notify).toHaveBeenCalledTimes(1);
		// Non enregistré : si la ligne Notion est créée plus tard, un rejeu manuel
		// doit pouvoir aboutir.
		expect(doubles.markProcessed).not.toHaveBeenCalled();
	});

	it('coche toutes les lignes quand plusieurs partagent le même email', async () => {
		const doubles = makePorts({ notionPages: ['page-1', 'page-2'] });
		const outcome = await processWebhook(notification({ id: 12345 }), makeDeps(doubles));

		expect(outcome).toMatchObject({ status: 'updated', pageIds: ['page-1', 'page-2'] });
		expect(doubles.markPaid).toHaveBeenCalledTimes(2);
		expect(doubles.markProcessed).toHaveBeenCalledTimes(1);
	});

	it('signale un paiement sans email exploitable et alerte', async () => {
		const doubles = makePorts({ payment: makePayment({ payer: { email: 'pas-un-email' } }) });
		const outcome = await processWebhook(notification({ id: 12345 }), makeDeps(doubles));

		expect(outcome.status).toBe('data_error');
		expect(doubles.notify).toHaveBeenCalledTimes(1);
		expect(doubles.markPaid).not.toHaveBeenCalled();
	});

	it('convertit une erreur de données en résultat, pas en exception', async () => {
		const doubles = makePorts();
		doubles.getPayment.mockRejectedValueOnce(new DataError('paiement introuvable'));

		const outcome = await processWebhook(notification({ id: 12345 }), makeDeps(doubles));

		expect(outcome).toEqual({
			status: 'data_error',
			paymentId: '12345',
			reason: 'paiement introuvable'
		});
		expect(doubles.notify).toHaveBeenCalledTimes(1);
	});

	it("laisse remonter une panne passagère pour que l'appelant réponde 5xx", async () => {
		const doubles = makePorts();
		doubles.markPaid.mockRejectedValueOnce(new TransientError('Notion indisponible'));

		await expect(processWebhook(notification({ id: 12345 }), makeDeps(doubles))).rejects.toThrow(
			TransientError
		);
		expect(doubles.markProcessed).not.toHaveBeenCalled();
	});

	it("marque le paiement seulement après l'écriture Notion", async () => {
		const order: string[] = [];
		const doubles = makePorts();
		doubles.markPaid.mockImplementation(() => {
			order.push('notion');
			return Promise.resolve();
		});
		doubles.markProcessed.mockImplementation(() => {
			order.push('dedup');
			return Promise.resolve();
		});

		await processWebhook(notification({ id: 12345 }), makeDeps(doubles));

		expect(order).toEqual(['notion', 'dedup']);
	});
});
