import { APIResponseError } from '@notionhq/client';
import { describe, expect, it, vi } from 'vitest';
import {
	buildEmailFilter,
	createNotionClient,
	mapNotionError,
	plainText,
	type NotionApi,
	type NotionRow
} from '../../src/adapters/notion.js';
import { DataError, TransientError } from '../../src/core/errors.js';
import { makeNotionConfig, silentLogger } from '../helpers.js';

const notionConfig = makeNotionConfig();

const signal = { signal: new AbortController().signal };

/** Membre dont on ne connaît que l'email : le repli par identité ne peut pas jouer. */
const emailOnly = { email: 'a@b.fr', firstName: undefined, lastName: undefined };

/** Ligne Notion telle que la rend l'API, avec ses propriétés lisibles. */
function row(id: string, values: { email?: string; firstName?: string; lastName?: string }) {
	return {
		id,
		properties: {
			Email: { email: values.email ?? null },
			Prénom: { rich_text: [{ plain_text: values.firstName ?? '' }] },
			Nom: { title: [{ plain_text: values.lastName ?? '' }] }
		}
	};
}

function notionApi(pages: { results: NotionRow[]; next_cursor: string | null }[]): NotionApi & {
	query: ReturnType<typeof vi.fn>;
	update: ReturnType<typeof vi.fn>;
} {
	let index = 0;
	const query = vi.fn(() => {
		const page = pages[index] ?? { results: [], next_cursor: null };
		index += 1;
		return Promise.resolve(page);
	});
	const update = vi.fn(() => Promise.resolve({}));

	return { dataSources: { query }, pages: { update }, query, update };
}

function client(pages: { results: NotionRow[]; next_cursor: string | null }[]) {
	const api = notionApi(pages);
	return {
		api,
		port: createNotionClient(notionConfig, {
			logger: silentLogger,
			timeoutMs: 5000,
			client: api
		})
	};
}

/** Fabrique une erreur du SDK sans passer par le réseau. */
function apiError(code: string): APIResponseError {
	return new APIResponseError({
		code: code as never,
		message: `erreur ${code}`,
		status: 400,
		headers: new Headers(),
		rawBodyText: '{}',
		additional_data: undefined,
		request_id: undefined
	});
}

describe('buildEmailFilter', () => {
	it('adapte la forme du filtre au type de la colonne', () => {
		expect(buildEmailFilter('Email', 'email', 'a@b.fr')).toEqual({
			property: 'Email',
			email: { equals: 'a@b.fr' }
		});
		expect(buildEmailFilter('Email', 'rich_text', 'a@b.fr')).toEqual({
			property: 'Email',
			rich_text: { equals: 'a@b.fr' }
		});
		expect(buildEmailFilter('Email', 'title', 'a@b.fr')).toEqual({
			property: 'Email',
			title: { equals: 'a@b.fr' }
		});
	});
});

describe('plainText', () => {
	it('lit un email, un titre et un texte riche', () => {
		expect(plainText({ email: 'a@b.fr' })).toBe('a@b.fr');
		expect(plainText({ title: [{ plain_text: 'Du' }, { plain_text: 'pont' }] })).toBe('Dupont');
		expect(plainText({ rich_text: [{ plain_text: 'Lucie' }] })).toBe('Lucie');
	});

	it("rend une chaîne vide sur toute autre forme, qui n'appariera rien", () => {
		expect(plainText(null)).toBe('');
		expect(plainText({ number: 3 })).toBe('');
		expect(plainText({ title: 'pas un tableau' })).toBe('');
	});
});

describe('mapNotionError', () => {
	it('classe quota et pannes amont en passagers', () => {
		expect(mapNotionError(apiError('rate_limited'), 'x')).toBeInstanceOf(TransientError);
		expect(mapNotionError(apiError('internal_server_error'), 'x')).toBeInstanceOf(TransientError);
	});

	it("classe l'autorisation en passager, pour ne pas perdre le paiement", () => {
		// Un 200 accuserait réception d'un paiement non traité ; un 503 laisse le
		// temps de reconnecter l'intégration.
		expect(mapNotionError(apiError('unauthorized'), 'x')).toBeInstanceOf(TransientError);
		expect(mapNotionError(apiError('restricted_resource'), 'x')).toBeInstanceOf(TransientError);
	});

	it('classe une requête mal formée en erreur de données', () => {
		expect(mapNotionError(apiError('validation_error'), 'x')).toBeInstanceOf(DataError);
		expect(mapNotionError(apiError('object_not_found'), 'x')).toBeInstanceOf(DataError);
	});

	it('classe une erreur inconnue en passager', () => {
		expect(mapNotionError(new Error('bizarre'), 'x')).toBeInstanceOf(TransientError);
	});
});

describe('findPages', () => {
	it('trouve par filtre email sans parcourir la base', async () => {
		const { port, api } = client([{ results: [row('page-1', {})], next_cursor: null }]);

		expect(await port.findPages(emailOnly, signal)).toEqual({
			pageIds: ['page-1'],
			matchedBy: 'email'
		});
		expect(api.query).toHaveBeenCalledOnce();
	});

	it('se rabat sur un balayage quand le filtre ne rend rien', async () => {
		const { port, api } = client([
			{ results: [], next_cursor: null },
			{ results: [row('page-2', { email: 'A@B.FR' })], next_cursor: null }
		]);

		// La casse diffère des deux côtés : seul le balayage normalisé la rattrape.
		expect(await port.findPages(emailOnly, signal)).toEqual({
			pageIds: ['page-2'],
			matchedBy: 'email'
		});
		expect(api.query).toHaveBeenCalledTimes(2);
	});

	it('apparie sur prénom + nom quand aucun email ne correspond', async () => {
		// Sans email, le chemin rapide filtré est sauté : le balayage est la
		// première et unique requête.
		const { port } = client([
			{ results: [row('page-3', { firstName: 'Éloïse', lastName: 'DUPONT' })], next_cursor: null }
		]);

		expect(
			await port.findPages({ email: undefined, firstName: 'eloise', lastName: 'dupont' }, signal)
		).toEqual({ pageIds: ['page-3'], matchedBy: 'identité' });
	});

	it("préfère l'email à l'identité quand les deux apparient", async () => {
		const { port } = client([
			{ results: [], next_cursor: null },
			{
				results: [
					row('par-identite', { firstName: 'Lucie', lastName: 'Martin' }),
					row('par-email', { email: 'a@b.fr' })
				],
				next_cursor: null
			}
		]);

		expect(
			await port.findPages({ email: 'a@b.fr', firstName: 'Lucie', lastName: 'Martin' }, signal)
		).toEqual({ pageIds: ['par-email'], matchedBy: 'email' });
	});

	it("ne rend rien quand aucun critère n'est exploitable", async () => {
		const { port, api } = client([]);
		expect(
			await port.findPages({ email: undefined, firstName: undefined, lastName: undefined }, signal)
		).toBeUndefined();
		expect(api.query).not.toHaveBeenCalled();
	});

	it('borne la pagination du balayage', async () => {
		// Cinq pages toujours suivies d'un curseur : on refuse de parcourir la
		// base entière, signe d'une propriété mal configurée.
		const pages = Array.from({ length: 8 }, () => ({ results: [], next_cursor: 'suite' }));
		const { port, api } = client(pages);

		await port.findPages({ email: undefined, firstName: 'Lucie', lastName: 'Martin' }, signal);

		expect(api.query).toHaveBeenCalledTimes(5);
	});
});

describe('markPaid', () => {
	it("pose l'état et le montant", async () => {
		const { port, api } = client([]);
		await port.markPaid('page-1', { amount: 20, signal: signal.signal });

		expect(api.update).toHaveBeenCalledWith({
			page_id: 'page-1',
			properties: {
				Cotisation: { status: { name: 'Payé' } },
				Montant: { number: 20 }
			}
		});
	});

	it('pose le seul état quand le montant est inconnu', async () => {
		const { port, api } = client([]);
		await port.markPaid('page-1', { amount: undefined, signal: signal.signal });

		expect(api.update).toHaveBeenCalledWith({
			page_id: 'page-1',
			properties: { Cotisation: { status: { name: 'Payé' } } }
		});
	});

	it('traduit une erreur du SDK', async () => {
		const api = notionApi([]);
		api.update.mockRejectedValueOnce(apiError('validation_error'));
		const port = createNotionClient(notionConfig, {
			logger: silentLogger,
			timeoutMs: 5000,
			client: api
		});

		await expect(
			port.markPaid('page-1', { amount: 20, signal: signal.signal })
		).rejects.toBeInstanceOf(DataError);
	});

	it('honore le budget de temps avant tout appel', async () => {
		const controller = new AbortController();
		controller.abort();
		const { port, api } = client([]);

		await expect(
			port.markPaid('page-1', { amount: 20, signal: controller.signal })
		).rejects.toThrow();
		expect(api.update).not.toHaveBeenCalled();
	});
});
