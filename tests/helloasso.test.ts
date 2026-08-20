import { describe, expect, it, vi } from 'vitest';
import type { HelloAssoConfig } from '../src/config.js';
import { DataError, TransientError } from '../src/errors.js';
import { createHelloAssoClient, type FetchLike } from '../src/helloasso.js';
import { makeConfig, silentLogger } from './helpers.js';

const config: HelloAssoConfig = makeConfig().helloasso;

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' }
	});
}

const tokenBody = { access_token: 'jeton-1', token_type: 'bearer', expires_in: 1800 };
const paymentBody = { id: 12345, state: 'Authorized', payer: { email: 'a@b.fr' } };

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

describe('createHelloAssoClient', () => {
	it('obtient un jeton puis lit le paiement', async () => {
		const { port, calls } = client([jsonResponse(tokenBody), jsonResponse(paymentBody)]);

		const payment = await port.getPayment('12345', signal);

		expect(payment.id).toBe(12345);
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
		clock = 130_000; // au-delà de la durée de vie annoncée
		await port.getPayment('12345', signal);

		expect(calls.filter((url) => url === config.tokenUrl)).toHaveLength(2);
	});

	it("ne demande qu'un seul jeton pour des appels concurrents", async () => {
		const { port, calls } = client([
			jsonResponse(tokenBody),
			jsonResponse(paymentBody),
			jsonResponse(paymentBody)
		]);

		await Promise.all([port.getPayment('1', signal), port.getPayment('2', signal)]);

		expect(calls.filter((url) => url === config.tokenUrl)).toHaveLength(1);
	});

	it('renouvelle le jeton et réessaie une fois sur 401', async () => {
		const { port, calls } = client([
			jsonResponse(tokenBody),
			new Response('', { status: 401 }),
			jsonResponse({ ...tokenBody, access_token: 'jeton-2' }),
			jsonResponse(paymentBody)
		]);

		const payment = await port.getPayment('12345', signal);

		expect(payment.id).toBe(12345);
		expect(calls.filter((url) => url === config.tokenUrl)).toHaveLength(2);
	});

	it('abandonne après un second 401 en signalant une panne passagère', async () => {
		const { port } = client([
			jsonResponse(tokenBody),
			new Response('', { status: 401 }),
			jsonResponse(tokenBody),
			new Response('', { status: 401 })
		]);

		await expect(port.getPayment('12345', signal)).rejects.toThrow(TransientError);
	});

	it('classe un paiement inconnu en erreur de données', async () => {
		const { port } = client([jsonResponse(tokenBody), new Response('', { status: 404 })]);

		await expect(port.getPayment('12345', signal)).rejects.toThrow(DataError);
	});

	it('classe un 500 en panne passagère', async () => {
		const { port } = client([jsonResponse(tokenBody), new Response('', { status: 500 })]);

		await expect(port.getPayment('12345', signal)).rejects.toThrow(TransientError);
	});

	it('classe un 429 en panne passagère', async () => {
		const { port } = client([jsonResponse(tokenBody), new Response('', { status: 429 })]);

		await expect(port.getPayment('12345', signal)).rejects.toThrow(TransientError);
	});

	it('traite un échec réseau comme passager', async () => {
		const fetchMock = vi.fn(() => Promise.reject(new Error('ECONNRESET')));
		const port = createHelloAssoClient(config, {
			logger: silentLogger,
			timeoutMs: 5000,
			fetch: fetchMock
		});

		await expect(port.getPayment('12345', signal)).rejects.toThrow(TransientError);
	});

	it('refuse une réponse de paiement au format inattendu', async () => {
		const { port } = client([jsonResponse(tokenBody), jsonResponse({ pas: 'un paiement' })]);

		await expect(port.getPayment('12345', signal)).rejects.toThrow(DataError);
	});

	it('signale un refus du endpoint de jeton comme passager', async () => {
		const { port } = client([new Response('', { status: 401 })]);

		await expect(port.getPayment('12345', signal)).rejects.toThrow(TransientError);
	});
});
