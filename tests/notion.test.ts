import { APIResponseError, UnknownHTTPResponseError } from '@notionhq/client';
import { describe, expect, it, vi } from 'vitest';
import { DataError, TransientError } from '../src/errors.js';
import {
	buildEmailFilter,
	createNotionClient,
	mapNotionError,
	type NotionApi
} from '../src/notion.js';
import { makeConfig, silentLogger } from './helpers.js';

const notionConfig = makeConfig().notion;
const signal = { signal: new AbortController().signal };

function notionApi(
	pages: { results: { id: string }[]; next_cursor: string | null }[]
): NotionApi & {
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

	it('classe l’autorisation en passager pour ne pas perdre le paiement', () => {
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

describe('createNotionClient', () => {
	it('interroge la source de données avec le filtre email et retourne les ids', async () => {
		const api = notionApi([{ results: [{ id: 'page-1' }], next_cursor: null }]);
		const port = createNotionClient(notionConfig, {
			logger: silentLogger,
			timeoutMs: 5000,
			client: api
		});

		const ids = await port.findPagesByEmail('a@b.fr', signal);

		expect(ids).toEqual(['page-1']);
		expect(api.query).toHaveBeenCalledWith({
			data_source_id: 'data-source-id',
			page_size: 100,
			filter: { property: 'Email', email: { equals: 'a@b.fr' } }
		});
	});

	it('suit la pagination jusqu’au bout', async () => {
		const api = notionApi([
			{ results: [{ id: 'page-1' }], next_cursor: 'curseur-1' },
			{ results: [{ id: 'page-2' }], next_cursor: null }
		]);
		const port = createNotionClient(notionConfig, {
			logger: silentLogger,
			timeoutMs: 5000,
			client: api
		});

		expect(await port.findPagesByEmail('a@b.fr', signal)).toEqual(['page-1', 'page-2']);
		expect(api.query).toHaveBeenCalledTimes(2);
	});

	it('interrompt une pagination qui ne finit pas', async () => {
		// Un curseur toujours renseigné signale une base mal configurée : on
		// s'arrête plutôt que de cocher la base entière.
		const api = notionApi(
			Array.from({ length: 20 }, (_, index) => ({
				results: [{ id: `page-${String(index)}` }],
				next_cursor: 'toujours-plus'
			}))
		);
		const port = createNotionClient(notionConfig, {
			logger: silentLogger,
			timeoutMs: 5000,
			client: api
		});

		const ids = await port.findPagesByEmail('a@b.fr', signal);

		expect(api.query).toHaveBeenCalledTimes(5);
		expect(ids).toHaveLength(5);
	});

	it('coche la propriété configurée', async () => {
		const api = notionApi([]);
		const port = createNotionClient(notionConfig, {
			logger: silentLogger,
			timeoutMs: 5000,
			client: api
		});

		await port.markPaid('page-1', signal);

		expect(api.update).toHaveBeenCalledWith({
			page_id: 'page-1',
			properties: { 'Cotisation payée': { checkbox: true } }
		});
	});

	it('n’émet aucun appel si le budget de temps est déjà épuisé', async () => {
		const api = notionApi([]);
		const port = createNotionClient(notionConfig, {
			logger: silentLogger,
			timeoutMs: 5000,
			client: api
		});
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

		await expect(port.findPagesByEmail('a@b.fr', signal)).rejects.toThrow(DataError);
	});
});
