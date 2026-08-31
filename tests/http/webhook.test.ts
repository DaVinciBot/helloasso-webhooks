import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createMembershipHandler } from '../../src/handlers/membership.js';
import { createWeiHandler } from '../../src/handlers/wei.js';
import { createApp, outcomeBody, secretMatches } from '../../src/http/app.js';
import {
	TEST_SECRET,
	WEI_SLUG,
	makeAlerts,
	makeAnnouncer,
	makeConfig,
	makeHelloAsso,
	makeNotion,
	makeProcessedPayments,
	makeRegistry,
	makeWeiOrder,
	makeWeiPayment,
	silentLogger
} from '../helpers.js';

/**
 * Bout en bout de la route : fixture réelle → parsing → routage → handler réel
 * → adaptateurs mockés. Aucun réseau, aucun port ouvert.
 */

function fixture(name: string): Record<string, unknown> {
	const path = fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
	return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

const membershipFixture = fixture('payment.json');
const weiFixture = fixture('wei-payment.json');

function buildApp(
	options: Parameters<typeof makeHelloAsso>[0] & {
		notionPages?: string[];
		processed?: Map<string, string>;
	} = {}
) {
	const helloasso = makeHelloAsso(options);
	const processedPayments = makeProcessedPayments(options.processed);
	const alerts = makeAlerts();
	const notion = makeNotion({ pages: options.notionPages ?? ['page-1'] });
	const registry = makeRegistry();
	const announcer = makeAnnouncer();

	const config = makeConfig();
	const handlers = [
		createMembershipHandler({
			notion: notion.port,
			// La fixture cotisation porte `formSlug: cotisations-dvb-25-26` : le
			// sélecteur ne retient que le type, comme en production.
			selector: { formType: 'Membership', formSlug: undefined }
		}),
		createWeiHandler({
			registry: registry.port,
			announcer: announcer.port,
			selector: { formType: 'Event', formSlug: WEI_SLUG },
			capacity: 60
		})
	];

	const app = createApp({
		config,
		logger: silentLogger,
		alerts: alerts.port,
		handlers,
		helloasso: helloasso.port,
		processedPayments: processedPayments.port
	});

	return { app, helloasso, processedPayments, alerts, notion, registry, announcer };
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
	it('accepte le bon secret et refuse les autres, quelle que soit leur longueur', () => {
		expect(secretMatches(TEST_SECRET, TEST_SECRET)).toBe(true);
		expect(secretMatches('court', TEST_SECRET)).toBe(false);
		expect(secretMatches(`${TEST_SECRET}x`, TEST_SECRET)).toBe(false);
	});
});

describe('GET /health', () => {
	it('répond ok', async () => {
		const { app } = buildApp();
		const response = await app.request('/health');

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({ status: 'ok' });
	});
});

describe('POST /webhook/:secret — authentification et forme', () => {
	it('refuse un secret invalide', async () => {
		const { app, helloasso } = buildApp();
		const response = await post(app, membershipFixture, 'mauvais-secret-mais-assez-long');

		expect(response.status).toBe(401);
		expect(helloasso.getPayment).not.toHaveBeenCalled();
	});

	it('refuse un corps illisible', async () => {
		const { app } = buildApp();
		expect((await post(app, '{pas du json')).status).toBe(400);
	});

	it('refuse un corps aberrant', async () => {
		const { app } = buildApp();
		const response = await app.request(`/webhook/${TEST_SECRET}`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'content-length': String(300 * 1024) },
			body: JSON.stringify(membershipFixture)
		});

		expect(response.status).toBe(413);
	});

	it('répond 404 sur une route inconnue', async () => {
		const { app } = buildApp();
		expect((await app.request('/inconnue')).status).toBe(404);
	});
});

describe('POST /webhook/:secret — cotisation', () => {
	it('marque la cotisation et répond 200', async () => {
		const { app, notion, processedPayments } = buildApp();
		const response = await post(app, membershipFixture);

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toMatchObject({
			status: 'handled',
			handler: 'membership'
		});
		expect(notion.markPaid).toHaveBeenCalledOnce();
		expect(processedPayments.markProcessed).toHaveBeenCalledOnce();
	});

	it("n'écrit rien quand HelloAsso dément le statut annoncé", async () => {
		// Le payload annonce Authorized, la réconciliation répond Refused.
		const { app, notion } = buildApp({
			payment: {
				...makeWeiPayment(),
				state: 'Refused',
				campaign: {
					organizationSlug: 'davincibot',
					formSlug: 'cotisations-dvb-25-26',
					formType: 'Membership'
				}
			}
		});

		const response = await post(app, membershipFixture);

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toMatchObject({ status: 'ignored' });
		expect(notion.markPaid).not.toHaveBeenCalled();
	});

	it('répond 200 sans rien réécrire sur un rejeu', async () => {
		const { app, notion } = buildApp({ processed: new Map([['12345', 'membership']]) });
		const response = await post(app, membershipFixture);

		await expect(response.json()).resolves.toMatchObject({ status: 'already_handled' });
		expect(notion.markPaid).not.toHaveBeenCalled();
	});

	it('répond 200 et alerte quand aucune ligne Notion ne correspond', async () => {
		const { app, alerts, processedPayments } = buildApp({ notionPages: [] });
		const response = await post(app, membershipFixture);

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toMatchObject({ status: 'unresolved' });
		expect(alerts.notify).toHaveBeenCalledOnce();
		expect(processedPayments.markProcessed).not.toHaveBeenCalled();
	});
});

describe('POST /webhook/:secret — WEI', () => {
	it('inscrit les places et annonce, sans toucher à Notion', async () => {
		const { app, registry, announcer, notion } = buildApp({
			payment: makeWeiPayment(),
			order: makeWeiOrder()
		});

		const response = await post(app, weiFixture);

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toMatchObject({ status: 'handled', handler: 'wei' });
		expect(registry.rows.size).toBe(2);
		expect(announcer.announce).toHaveBeenCalledOnce();
		expect(notion.markPaid).not.toHaveBeenCalled();
	});

	it('annonce la liste complète avec la jauge', async () => {
		const { app, announcer } = buildApp({ payment: makeWeiPayment(), order: makeWeiOrder() });
		await post(app, weiFixture);

		const announcement = announcer.announce.mock.calls[0]?.[0];
		expect(announcement?.headline).toContain('2 / 60 places');
		expect(announcement?.lines).toHaveLength(2);
	});
});

describe('POST /webhook/:secret — pannes', () => {
	it('répond 503 sur une panne passagère pour provoquer le rejeu', async () => {
		const { app, helloasso } = buildApp();
		helloasso.getPayment.mockRejectedValueOnce(
			Object.assign(new Error('réseau coupé'), { name: 'TransientError' })
		);

		expect((await post(app, membershipFixture)).status).toBe(503);
	});
});

describe('outcomeBody', () => {
	it('traduit chaque résultat sans jamais changer le code HTTP', () => {
		expect(outcomeBody({ status: 'ignored', reason: 'event_Order' })).toEqual({
			status: 'ignored',
			reason: 'event_Order'
		});
		expect(outcomeBody({ status: 'data_error', paymentId: '1', reason: 'x' })).toMatchObject({
			status: 'data_error'
		});
		expect(outcomeBody({ status: 'handled', paymentId: '1', handler: 'wei', summary: {} })).toEqual(
			{ status: 'handled', paymentId: '1', handler: 'wei' }
		);
	});
});
