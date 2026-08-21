import { APIResponseError, UnknownHTTPResponseError } from '@notionhq/client';
import { describe, expect, it, vi } from 'vitest';
import { DataError, TransientError } from '../src/errors.js';
import {
	buildEmailFilter,
	createNotionClient,
	mapNotionError,
	plainText,
	type NotionApi,
	type NotionRow
} from '../src/notion.js';
import { makeConfig, silentLogger } from './helpers.js';

const notionConfig = makeConfig().notion;
const signal = { signal: new AbortController().signal };

/** Payeur dont on ne connaît que l'email : le repli par identité ne peut pas jouer. */
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

function client(pages: { results: NotionRow[]; next_cursor: string | null }[]) {
	const api = notionApi(pages);
	const port = createNotionClient(notionConfig, {
		logger: silentLogger,
		timeoutMs: 5000,
		client: api
	});
	return { api, port };
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
	it('produit le filtre correspondant au type de propriété', () => {
		expect(buildEmailFilter('Email', 'email', 'a@b.fr')).toEqual({
			property: 'Email',
			email: { equals: 'a@b.fr' }
		});
		expect(buildEmailFilter('Email', 'rich_text', 'a@b.fr')).toEqual({
			property: 'Email',
			rich_text: { equals: 'a@b.fr' }
		});
		expect(buildEmailFilter('Nom', 'title', 'a@b.fr')).toEqual({
			property: 'Nom',
			title: { equals: 'a@b.fr' }
		});
	});
});

describe('mapNotionError', () => {
	it('classe en passager ce qui peut se réparer tout seul', () => {
		for (const code of ['rate_limited', 'internal_server_error', 'service_unavailable']) {
			expect(mapNotionError(apiError(code), 'test')).toBeInstanceOf(TransientError);
		}
	});

	it("classe l'autorisation en passager pour ne pas perdre le paiement", () => {
		// Un jeton révoqué se répare côté humain ; en attendant, mieux vaut faire
		// rejouer HelloAsso que d'accuser réception d'un paiement non traité.
		expect(mapNotionError(apiError('unauthorized'), 'test')).toBeInstanceOf(TransientError);
		expect(mapNotionError(apiError('restricted_resource'), 'test')).toBeInstanceOf(TransientError);
	});

	it('classe en erreur de données ce que le rejeu ne réparera pas', () => {
		expect(mapNotionError(apiError('object_not_found'), 'test')).toBeInstanceOf(DataError);
		expect(mapNotionError(apiError('validation_error'), 'test')).toBeInstanceOf(DataError);
	});

	it('classe en passager une erreur étrangère au SDK', () => {
		expect(mapNotionError(new Error('boum'), 'test')).toBeInstanceOf(TransientError);
		expect(
			mapNotionError(
				new UnknownHTTPResponseError({
					status: 502,
					message: 'bad gateway',
					headers: new Headers(),
					rawBodyText: ''
				}),
				'test'
			)
		).toBeInstanceOf(TransientError);
	});
});

describe('plainText', () => {
	it('lit indifféremment un title, un rich_text et un email', () => {
		expect(plainText({ title: [{ plain_text: 'Dupont' }] })).toBe('Dupont');
		expect(plainText({ rich_text: [{ plain_text: 'Jean-' }, { plain_text: 'Michel' }] })).toBe(
			'Jean-Michel'
		);
		expect(plainText({ email: 'a@b.fr' })).toBe('a@b.fr');
	});

	it('rend une chaîne vide pour une colonne vide ou inconnue', () => {
		expect(plainText({ email: null })).toBe('');
		expect(plainText({ checkbox: true })).toBe('');
		expect(plainText(undefined)).toBe('');
	});
});

describe('createNotionClient', () => {
	it('interroge la source de données avec le filtre email et retourne les ids', async () => {
		const { api, port } = client([
			{ results: [row('page-1', { email: 'a@b.fr' })], next_cursor: null }
		]);

		expect(await port.findPages(emailOnly, signal)).toEqual({
			pageIds: ['page-1'],
			matchedBy: 'email'
		});
		expect(api.query).toHaveBeenCalledTimes(1);
		expect(api.query).toHaveBeenCalledWith({
			data_source_id: 'data-source-id',
			page_size: 100,
			filter: { property: 'Email', email: { equals: 'a@b.fr' } }
		});
	});

	it("suit la pagination jusqu'au bout", async () => {
		const { api, port } = client([
			{ results: [row('page-1', { email: 'a@b.fr' })], next_cursor: 'curseur-1' },
			{ results: [row('page-2', { email: 'a@b.fr' })], next_cursor: null }
		]);

		expect(await port.findPages(emailOnly, signal)).toMatchObject({
			pageIds: ['page-1', 'page-2']
		});
		expect(api.query).toHaveBeenCalledTimes(2);
	});

	it('interrompt une pagination qui ne finit pas', async () => {
		// Un curseur toujours renseigné signale une base mal configurée : on
		// s'arrête plutôt que de marquer la base entière.
		const { api, port } = client(
			Array.from({ length: 20 }, (_, index) => ({
				results: [row(`page-${String(index)}`, { email: 'a@b.fr' })],
				next_cursor: 'toujours-plus'
			}))
		);

		const match = await port.findPages(emailOnly, signal);

		expect(api.query).toHaveBeenCalledTimes(5);
		expect(match?.pageIds).toHaveLength(5);
	});

	it("apparie un email que le filtre Notion n'a pas rendu, quelle que soit la casse", async () => {
		// Notion ne garantit pas que son `equals` ignore la casse : le balayage
		// de repli rattrape une adresse saisie « Membre.Test@Example.Org ».
		const { api, port } = client([
			{ results: [], next_cursor: null },
			{
				results: [
					row('autre', { email: 'quelqun@ailleurs.fr' }),
					row('page-7', { email: 'A@B.FR' })
				],
				next_cursor: null
			}
		]);

		expect(await port.findPages(emailOnly, signal)).toEqual({
			pageIds: ['page-7'],
			matchedBy: 'email'
		});
		// Deuxième requête : le balayage, sans filtre.
		expect(api.query).toHaveBeenLastCalledWith({
			data_source_id: 'data-source-id',
			page_size: 100
		});
	});

	it("apparie sur l'identité quand l'email ne donne rien", async () => {
		const { port } = client([
			{ results: [], next_cursor: null },
			{
				results: [
					row('page-1', { firstName: 'Jean', lastName: 'Martin' }),
					row('page-2', { firstName: 'Jean-Michel', lastName: 'DUPONT' })
				],
				next_cursor: null
			}
		]);

		const match = await port.findPages(
			{ email: 'a@b.fr', firstName: 'jean michel', lastName: 'Dupont' },
			signal
		);

		expect(match).toEqual({ pageIds: ['page-2'], matchedBy: 'identité' });
	});

	it('ignore les accents et les apostrophes du nom', async () => {
		const { port } = client([
			{ results: [row('page-1', { firstName: 'Zoé', lastName: "D'Amico" })], next_cursor: null }
		]);

		const match = await port.findPages(
			{ email: undefined, firstName: 'ZOE', lastName: 'd amico' },
			signal
		);

		expect(match).toEqual({ pageIds: ['page-1'], matchedBy: 'identité' });
	});

	it("préfère l'email à l'identité dans un même balayage", async () => {
		// Une homonymie ne doit pas voler la place d'une adresse qui correspond.
		const { port } = client([
			{ results: [], next_cursor: null },
			{
				results: [
					row('homonyme', { firstName: 'Jean', lastName: 'Dupont' }),
					row('bonne-ligne', { email: 'A@B.FR', firstName: 'Autre', lastName: 'Personne' })
				],
				next_cursor: null
			}
		]);

		const match = await port.findPages(
			{ email: 'a@b.fr', firstName: 'Jean', lastName: 'Dupont' },
			signal
		);

		expect(match).toEqual({ pageIds: ['bonne-ligne'], matchedBy: 'email' });
	});

	it("n'apparie pas sur un demi-nom", async () => {
		const { port } = client([
			{ results: [row('page-1', { firstName: 'Paul', lastName: 'Dupont' })], next_cursor: null }
		]);

		expect(
			await port.findPages({ email: undefined, firstName: 'Jean', lastName: 'Dupont' }, signal)
		).toBeUndefined();
	});

	it('ne balaye pas la base quand il ne reste aucun critère', async () => {
		const { api, port } = client([]);

		expect(
			await port.findPages({ email: undefined, firstName: 'Jean', lastName: undefined }, signal)
		).toBeUndefined();
		expect(api.query).not.toHaveBeenCalled();
	});

	it('ne tente pas le repli par identité si les colonnes ne sont pas configurées', async () => {
		const api = notionApi([{ results: [], next_cursor: null }]);
		const port = createNotionClient(
			{ ...notionConfig, nameProperties: undefined },
			{ logger: silentLogger, timeoutMs: 5000, client: api }
		);

		expect(
			await port.findPages({ email: undefined, firstName: 'Jean', lastName: 'Dupont' }, signal)
		).toBeUndefined();
		expect(api.query).not.toHaveBeenCalled();
	});

	it("pose l'état configuré sur la propriété configurée", async () => {
		const { api, port } = client([]);

		await port.markPaid('page-1', signal);

		expect(api.update).toHaveBeenCalledWith({
			page_id: 'page-1',
			properties: { Cotisation: { status: { name: 'Payé' } } }
		});
	});

	it("n'émet aucun appel si le budget de temps est déjà épuisé", async () => {
		const { api, port } = client([]);
		const controller = new AbortController();
		controller.abort();

		await expect(port.markPaid('page-1', { signal: controller.signal })).rejects.toThrow();
		expect(api.update).not.toHaveBeenCalled();
	});

	it('traduit une erreur du SDK lors de la recherche', async () => {
		const api = notionApi([]);
		api.dataSources.query = vi.fn(() => Promise.reject(apiError('validation_error')));
		const port = createNotionClient(notionConfig, {
			logger: silentLogger,
			timeoutMs: 5000,
			client: api
		});

		await expect(port.findPages(emailOnly, signal)).rejects.toThrow(DataError);
	});
});
