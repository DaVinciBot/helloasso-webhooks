import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { TransientError } from '../src/errors.js';
import { createApp, secretMatches } from '../src/index.js';
import { makeConfig, makePorts, silentLogger, TEST_SECRET } from './helpers.js';

/**
 * Test de bout en bout de la route : fixture réelle → parsing → réconciliation
 * (mockée) → écriture Notion (mockée). Aucun réseau, aucun port ouvert.
 */

const fixturePath = fileURLToPath(new URL('./fixtures/payment.json', import.meta.url));
const fixture: unknown = JSON.parse(readFileSync(fixturePath, 'utf8'));

function clone(): Record<string, unknown> {
	return structuredClone(fixture) as Record<string, unknown>;
}

function buildApp(options: Parameters<typeof makePorts>[0] = {}) {
	const doubles = makePorts(options);
	const app = createApp({
		config: makeConfig(),
		logger: silentLogger,
		...doubles.ports
	});
	return { app, ...doubles };
}

async function post(
	app: ReturnType<typeof createApp>,
	body: unknown,
	secret = TEST_SECRET
): Promise<Response> {
	return app.request(`/webhook/${encodeURIComponent(secret)}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: typeof body === 'string' ? body : JSON.stringify(body)
	});
}

describe('secretMatches', () => {
	it('accepte le secret attendu', () => {
		expect(secretMatches(TEST_SECRET, TEST_SECRET)).toBe(true);
	});

	it('refuse un secret différent, y compris de longueur différente', () => {
		expect(secretMatches('court', TEST_SECRET)).toBe(false);
		expect(secretMatches(`${TEST_SECRET}x`, TEST_SECRET)).toBe(false);
	});
});

describe('POST /webhook/:secret', () => {
	let context: ReturnType<typeof buildApp>;

	beforeEach(() => {
		context = buildApp();
	});

	it('traite la notification de la fixture : réconcilie, marque, mémorise', async () => {
		const response = await post(context.app, clone());

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ status: 'updated', paymentId: '12345', pages: 1 });

		expect(context.getPayment).toHaveBeenCalledWith('12345', expect.anything());
		// L'email de la fixture est en casse mixte : la normalisation doit avoir eu lieu.
		expect(context.findPages).toHaveBeenCalledWith(
			{ email: 'membre.test@example.org', firstName: 'Membre', lastName: 'Test' },
			expect.anything()
		);
		expect(context.markPaid).toHaveBeenCalledWith('page-1', expect.anything());
		expect(context.markProcessed).toHaveBeenCalledWith('12345', 'membre.test@example.org');
	});

	it('refuse un secret invalide sans rien lire du corps', async () => {
		const response = await post(context.app, clone(), 'mauvais-secret');

		expect(response.status).toBe(401);
		expect(context.getPayment).not.toHaveBeenCalled();
		expect(context.isProcessed).not.toHaveBeenCalled();
	});

	it("répond 400 sur un corps qui n'est pas du JSON", async () => {
		const response = await post(context.app, 'ceci-n-est-pas-du-json');

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ status: 'invalid_json' });
	});

	it('répond 413 si le corps annoncé dépasse la taille admise', async () => {
		const response = await context.app.request(`/webhook/${TEST_SECRET}`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'content-length': '999999' },
			body: JSON.stringify(clone())
		});

		expect(response.status).toBe(413);
		expect(context.getPayment).not.toHaveBeenCalled();
	});

	it("ignore un évènement qui n'est pas un paiement", async () => {
		const body = clone();
		body.eventType = 'Form';

		const response = await post(context.app, body);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ status: 'ignored', reason: 'event_Form' });
		expect(context.getPayment).not.toHaveBeenCalled();
	});

	it('répond « déjà traité » sans solliciter HelloAsso ni Notion', async () => {
		const already = buildApp({ processedIds: new Set(['12345']) });

		const response = await post(already.app, clone());

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ status: 'already_handled', paymentId: '12345' });
		expect(already.getPayment).not.toHaveBeenCalled();
		expect(already.markPaid).not.toHaveBeenCalled();
	});

	it('répond 503 sur panne passagère, pour déclencher le rejeu HelloAsso', async () => {
		context.getPayment.mockRejectedValueOnce(new TransientError('API HelloAsso indisponible'));

		const response = await post(context.app, clone());

		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({ status: 'retry_later' });
		// Rien n'a été marqué : le rejeu doit pouvoir rejouer le traitement complet.
		expect(context.markProcessed).not.toHaveBeenCalled();
	});

	it("répond 503 sur une erreur non typée plutôt que d'avaler le paiement", async () => {
		context.findPages.mockRejectedValueOnce(new Error('boum'));

		const response = await post(context.app, clone());

		expect(response.status).toBe(503);
		expect(context.markProcessed).not.toHaveBeenCalled();
	});

	it('reste idempotent sur deux livraisons successives', async () => {
		await post(context.app, clone());
		const second = await post(context.app, clone());

		expect(await second.json()).toEqual({ status: 'already_handled', paymentId: '12345' });
		expect(context.markPaid).toHaveBeenCalledTimes(1);
	});
});

describe('routes annexes', () => {
	it('expose une sonde de santé', async () => {
		const { app } = buildApp();
		const response = await app.request('/health');

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ status: 'ok' });
	});

	it('renvoie 404 sur une route inconnue', async () => {
		const { app } = buildApp();
		const response = await app.request('/autre');

		expect(response.status).toBe(404);
	});
});
