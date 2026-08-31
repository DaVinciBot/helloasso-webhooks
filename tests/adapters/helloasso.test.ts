import { describe, expect, it, vi } from 'vitest';
import {
	createHelloAssoClient,
	organizationAmountEuros,
	toOrder,
	toPayment,
	type FetchLike
} from '../../src/adapters/helloasso.js';
import type { HelloAssoConfig } from '../../src/core/config.js';
import { DataError, TransientError } from '../../src/core/errors.js';
import { makeConfig, silentLogger } from '../helpers.js';

const config: HelloAssoConfig = makeConfig().helloasso;

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' }
	});
}

const tokenBody = { access_token: 'jeton-1', token_type: 'bearer', expires_in: 1800 };
const paymentBody = {
	id: 12345,
	state: 'Authorized',
	amount: 2000,
	payer: { email: 'a@b.fr' },
	order: {
		id: 98765,
		formSlug: 'adhesion',
		formType: 'Membership',
		organizationSlug: 'davincibot'
	},
	items: [{ id: 55501, shareAmount: 2000 }]
};

/** Enchaîne les réponses dans l'ordre où elles seront consommées. */
function fetchSequence(responses: Response[]): { fetch: FetchLike; calls: string[] } {
	const calls: string[] = [];
	let index = 0;

	const fetchMock = vi.fn((input: string) => {
		calls.push(input);
		const response = responses[index];
		index += 1;
		if (response === undefined) {
			throw new Error(`appel fetch inattendu (${String(index)})`);
		}
		return Promise.resolve(response);
	});

	return { fetch: fetchMock as unknown as FetchLike, calls };
}

function client(responses: Response[], now?: () => number) {
	const sequence = fetchSequence(responses);
	return {
		...sequence,
		port: createHelloAssoClient(config, {
			logger: silentLogger,
			timeoutMs: 5000,
			fetch: sequence.fetch,
			...(now === undefined ? {} : { now })
		})
	};
}

const signal = { signal: new AbortController().signal };

describe('projection du format v5 vers le domaine', () => {
	it('normalise les identifiants en chaîne', () => {
		const payment = toPayment(paymentBody);
		expect(payment.id).toBe('12345');
		expect(payment.orderId).toBe('98765');
		expect(payment.paidItemIds).toEqual(['55501']);
	});

	it('expose la campagne séparément du reste', () => {
		expect(toPayment(paymentBody).campaign).toEqual({
			organizationSlug: 'davincibot',
			formSlug: 'adhesion',
			formType: 'Membership'
		});
	});

	it('projette les inscrits portés par la commande', () => {
		const order = toOrder(
			{ id: 98765, items: [{ id: 55501, user: { firstName: 'Lucie', lastName: 'Martin' } }] },
			'98765'
		);
		expect(order.items).toEqual([
			{ id: '55501', person: { firstName: 'Lucie', lastName: 'Martin' } }
		]);
	});

	it("retombe sur l'identifiant demandé quand la réponse ne le porte pas", () => {
		expect(toOrder({}, '98765').id).toBe('98765');
	});
});

describe('organizationAmountEuros', () => {
	it("somme les parts revenant à l'association", () => {
		expect(
			organizationAmountEuros({
				id: 1,
				amount: 2300,
				items: [{ shareAmount: 1000 }, { shareAmount: 1000 }]
			})
		).toBe(20);
	});

	it('se rabat sur le montant total quand le détail manque', () => {
		// La contribution volontaire au site est alors incluse : mieux vaut un
		// montant approché qu'une colonne vide.
		expect(organizationAmountEuros({ id: 1, amount: 2300 })).toBe(23);
	});

	it("ne rend rien quand aucun montant n'est exploitable", () => {
		expect(organizationAmountEuros({ id: 1 })).toBeUndefined();
	});
});

describe('createHelloAssoClient', () => {
	it('obtient un jeton puis lit le paiement, projeté dans le domaine', async () => {
		const { port, calls } = client([jsonResponse(tokenBody), jsonResponse(paymentBody)]);

		const payment = await port.getPayment('12345', signal);

		expect(payment.id).toBe('12345');
		expect(payment.amountEuros).toBe(20);
		expect(calls[0]).toBe(config.tokenUrl);
		expect(calls[1]).toBe(`${config.apiBase}/payments/12345`);
	});

	it('réutilise le jeton en cache sur un second appel', async () => {
		const { port, calls } = client([
			jsonResponse(tokenBody),
			jsonResponse(paymentBody),
			jsonResponse(paymentBody)
		]);

		await port.getPayment('12345', signal);
		await port.getPayment('12345', signal);

		expect(calls.filter((url) => url === config.tokenUrl)).toHaveLength(1);
	});

	it('redemande un jeton une fois celui-ci expiré', async () => {
		let clock = 0;
		const { port, calls } = client(
			[
				jsonResponse({ ...tokenBody, expires_in: 120 }),
				jsonResponse(paymentBody),
				jsonResponse({ ...tokenBody, access_token: 'jeton-2', expires_in: 120 }),
				jsonResponse(paymentBody)
			],
			() => clock
		);

		await port.getPayment('12345', signal);
		clock = 130_000;
		await port.getPayment('12345', signal);

		expect(calls.filter((url) => url === config.tokenUrl)).toHaveLength(2);
	});

	it('renouvelle le jeton une fois sur un 401 puis réessaie', async () => {
		const { port, calls } = client([
			jsonResponse(tokenBody),
			jsonResponse({}, 401),
			jsonResponse({ ...tokenBody, access_token: 'jeton-2' }),
			jsonResponse(paymentBody)
		]);

		await port.getPayment('12345', signal);

		expect(calls.filter((url) => url === config.tokenUrl)).toHaveLength(2);
	});

	it('classe un 404 en erreur de données : rejouer ne changerait rien', async () => {
		const { port } = client([jsonResponse(tokenBody), jsonResponse({}, 404)]);
		await expect(port.getPayment('12345', signal)).rejects.toBeInstanceOf(DataError);
	});

	it('classe un 500 en panne passagère : le rejeu a une chance', async () => {
		const { port } = client([jsonResponse(tokenBody), jsonResponse({}, 503)]);
		await expect(port.getPayment('12345', signal)).rejects.toBeInstanceOf(TransientError);
	});

	it('classe un 429 en panne passagère', async () => {
		const { port } = client([jsonResponse(tokenBody), jsonResponse({}, 429)]);
		await expect(port.getPayment('12345', signal)).rejects.toBeInstanceOf(TransientError);
	});

	it('traite un jeton refusé comme passager plutôt que de perdre la notification', async () => {
		const { port } = client([jsonResponse({}, 401)]);
		await expect(port.getPayment('12345', signal)).rejects.toBeInstanceOf(TransientError);
	});

	it('refuse un paiement au format inattendu', async () => {
		const { port } = client([jsonResponse(tokenBody), jsonResponse({ pas: 'un paiement' })]);
		await expect(port.getPayment('12345', signal)).rejects.toBeInstanceOf(DataError);
	});

	it('lit la commande', async () => {
		const { port, calls } = client([
			jsonResponse(tokenBody),
			jsonResponse({ id: 98765, items: [{ id: 1, user: { firstName: 'A', lastName: 'B' } }] })
		]);

		const order = await port.getOrder('98765', signal);

		expect(order.items).toHaveLength(1);
		expect(calls[1]).toBe(`${config.apiBase}/orders/98765`);
	});

	it("parcourt toutes les pages d'articles d'un formulaire", async () => {
		const { port, calls } = client([
			jsonResponse(tokenBody),
			jsonResponse({
				data: [{ id: 1, order: { id: 10 }, user: { firstName: 'Lucie', lastName: 'Martin' } }],
				pagination: { continuationToken: 'page-2' }
			}),
			jsonResponse({
				data: [{ id: 2, order: { id: 11 }, user: { firstName: 'Tom', lastName: 'Durand' } }],
				pagination: {}
			})
		]);

		const items = await port.listFormItems({ formType: 'Event', formSlug: 'wei-2026' }, signal);

		expect(items).toHaveLength(2);
		expect(items[0]).toMatchObject({ id: '1', orderId: '10', firstName: 'Lucie' });
		expect(calls[2]).toContain('continuationToken=page-2');
	});
});
