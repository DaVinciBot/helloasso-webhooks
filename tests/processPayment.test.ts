import { describe, expect, it } from 'vitest';
import { DataError, TransientError } from '../src/errors.js';
import {
	isAcceptedState,
	matchesCampaign,
	processWebhook,
	type CampaignFilter,
	type ProcessDeps
} from '../src/processPayment.js';
import { makeOrder, makePayment, makePorts, silentLogger } from './helpers.js';

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
		expect(doubles.findPages).not.toHaveBeenCalled();
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
		expect(doubles.notify.mock.calls[0]?.[0]).toMatchObject({
			fields: {
				paiement: '12345',
				montant: '20.00 €',
				email: 'membre.test@example.org',
				prénom: 'Membre',
				nom: 'Test'
			}
		});
		// Non enregistré : si la ligne Notion est créée plus tard, un rejeu manuel
		// doit pouvoir aboutir.
		expect(doubles.markProcessed).not.toHaveBeenCalled();
	});

	it("écrit le montant revenant à l'asso sur chaque ligne", async () => {
		const doubles = makePorts({
			payment: makePayment({ amount: 2200, items: [{ shareAmount: 2000 }] })
		});

		await processWebhook(notification({ id: 12345 }), makeDeps(doubles));

		expect(doubles.markPaid).toHaveBeenCalledWith(
			'page-1',
			expect.objectContaining({ amount: 20 })
		);
	});

	it("marque la ligne sans montant quand le paiement n'en porte aucun", async () => {
		const doubles = makePorts({ payment: makePayment({ amount: undefined, items: undefined }) });

		await processWebhook(notification({ id: 12345 }), makeDeps(doubles));

		expect(doubles.markPaid).toHaveBeenCalledWith(
			'page-1',
			expect.objectContaining({ amount: undefined })
		);
	});

	it('marque toutes les lignes quand plusieurs partagent le même email', async () => {
		const doubles = makePorts({ notionPages: ['page-1', 'page-2'] });
		const outcome = await processWebhook(notification({ id: 12345 }), makeDeps(doubles));

		expect(outcome).toMatchObject({ status: 'updated', pageIds: ['page-1', 'page-2'] });
		expect(doubles.markPaid).toHaveBeenCalledTimes(2);
		expect(doubles.markProcessed).toHaveBeenCalledTimes(1);
	});

	it('signale un paiement sans aucun critère de recherche et alerte', async () => {
		const doubles = makePorts({
			payment: makePayment({ payer: { email: 'pas-un-email' } }),
			order: makeOrder({ items: [] })
		});
		const outcome = await processWebhook(notification({ id: 12345 }), makeDeps(doubles));

		expect(outcome.status).toBe('data_error');
		expect(doubles.notify).toHaveBeenCalledTimes(1);
		expect(doubles.findPages).not.toHaveBeenCalled();
		expect(doubles.markPaid).not.toHaveBeenCalled();
	});

	it("cherche sur l'identité quand le paiement n'a pas d'email exploitable", async () => {
		const doubles = makePorts({
			payment: makePayment({ payer: { firstName: 'Membre', lastName: 'Test' } }),
			matchedBy: 'identité'
		});
		const outcome = await processWebhook(notification({ id: 12345 }), makeDeps(doubles));

		expect(outcome).toMatchObject({ status: 'updated', email: undefined, matchedBy: 'identité' });
		expect(doubles.findPages).toHaveBeenCalledWith(
			{ email: undefined, firstName: 'Membre', lastName: 'Test' },
			expect.anything()
		);
		expect(doubles.markPaid).toHaveBeenCalledTimes(1);
		expect(doubles.markProcessed).toHaveBeenCalledWith('12345', undefined);
	});

	it("transmet à Notion l'email normalisé et l'identité de l'adhérent", async () => {
		const doubles = makePorts();
		await processWebhook(notification({ id: 12345 }), makeDeps(doubles));

		expect(doubles.findPages).toHaveBeenCalledWith(
			{ email: 'membre.test@example.org', firstName: 'Membre', lastName: 'Test' },
			expect.anything()
		);
	});

	it("apparie sur l'adhérent de la commande, pas sur le payeur", async () => {
		// Un tiers règle la cotisation : c'est l'adhérent porté par la ligne de
		// commande qui doit être marqué payé, et son nom seul — l'email est
		// celui du payeur, il ne le désigne pas.
		const doubles = makePorts({
			payment: makePayment({
				payer: { email: 'austin.jonca@example.org', firstName: 'Austin', lastName: 'Jonca' }
			}),
			order: makeOrder({
				items: [{ id: 55501, user: { firstName: 'Eliott', lastName: 'Roussille' } }]
			}),
			matchedBy: 'identité'
		});

		const outcome = await processWebhook(notification({ id: 12345 }), makeDeps(doubles));

		expect(doubles.getOrder).toHaveBeenCalledWith('98765', expect.anything());
		expect(doubles.findPages).toHaveBeenCalledWith(
			{ email: undefined, firstName: 'Eliott', lastName: 'Roussille' },
			expect.anything()
		);
		expect(outcome).toMatchObject({ status: 'updated', matchedBy: 'identité' });
		// La colonne garde l'email du payeur : c'est la trace du règlement.
		expect(doubles.markProcessed).toHaveBeenCalledWith('12345', 'austin.jonca@example.org');
	});

	it("nomme le payeur dans l'alerte quand il n'est pas l'adhérent", async () => {
		const doubles = makePorts({
			payment: makePayment({
				payer: { email: 'austin.jonca@example.org', firstName: 'Austin', lastName: 'Jonca' }
			}),
			order: makeOrder({
				items: [{ id: 55501, user: { firstName: 'Eliott', lastName: 'Roussille' } }]
			}),
			notionPages: []
		});

		await processWebhook(notification({ id: 12345 }), makeDeps(doubles));

		expect(doubles.notify.mock.calls[0]?.[0]).toMatchObject({
			fields: {
				prénom: 'Eliott',
				nom: 'Roussille',
				payeur: 'Austin Jonca <austin.jonca@example.org>'
			}
		});
	});

	it("ne mentionne pas le payeur dans l'alerte quand il est l'adhérent", async () => {
		// Le membre a réglé sa propre cotisation : la casse diffère d'un formulaire
		// à l'autre, la personne est la même.
		const doubles = makePorts({
			order: makeOrder({
				items: [{ id: 55501, user: { firstName: 'MEMBRE', lastName: 'test' } }]
			}),
			notionPages: []
		});

		await processWebhook(notification({ id: 12345 }), makeDeps(doubles));

		const alert = doubles.notify.mock.calls[0]?.[0];
		expect(alert?.fields).toMatchObject({ email: 'membre.test@example.org' });
		expect(alert?.fields.payeur).toBeUndefined();
	});

	it('se rabat sur le payeur quand la commande ne porte aucun adhérent', async () => {
		const doubles = makePorts({ order: makeOrder({ items: [] }) });

		await processWebhook(notification({ id: 12345 }), makeDeps(doubles));

		expect(doubles.findPages).toHaveBeenCalledWith(
			{ email: 'membre.test@example.org', firstName: 'Membre', lastName: 'Test' },
			expect.anything()
		);
	});

	it("n'appelle pas la commande quand le paiement n'est pas éligible", async () => {
		const doubles = makePorts({ payment: makePayment({ state: 'Refused' }) });

		await processWebhook(notification({ id: 12345 }), makeDeps(doubles));

		expect(doubles.getOrder).not.toHaveBeenCalled();
	});

	it("se passe de la commande quand le paiement n'en désigne aucune", async () => {
		const doubles = makePorts({
			payment: makePayment({ order: { organizationSlug: 'davincibot' } })
		});

		await processWebhook(notification({ id: 12345 }), makeDeps(doubles));

		expect(doubles.getOrder).not.toHaveBeenCalled();
		expect(doubles.findPages).toHaveBeenCalledWith(
			{ email: 'membre.test@example.org', firstName: 'Membre', lastName: 'Test' },
			expect.anything()
		);
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
