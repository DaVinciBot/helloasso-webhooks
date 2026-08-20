import { describe, expect, it, vi } from 'vitest';
import { createAlerter, formatEmbed } from '../src/alerts.js';
import { silentLogger } from './helpers.js';

const alert = {
	title: 'Cotisation payée sans ligne Notion correspondante',
	fields: { paiement: '12345', email: 'a@b.fr', absent: undefined }
};

/**
 * Les doubles déclarent des signatures plus étroites que `fetch` (une `string`
 * d'URL plutôt que `string | Request | URL`) : c'est tout ce que le service leur
 * passe, et l'élargir n'apprendrait rien de plus au test. D'où la conversion.
 */
function alerter(url: string | undefined, fetchImpl: ReturnType<typeof vi.fn>) {
	return createAlerter(url, {
		logger: silentLogger,
		timeoutMs: 5000,
		fetch: fetchImpl as unknown as typeof globalThis.fetch
	});
}

/** Corps effectivement transmis au webhook lors du premier appel. */
function sentBody(fetchMock: ReturnType<typeof vi.fn>): unknown {
	const call: unknown = fetchMock.mock.calls[0];
	if (!Array.isArray(call)) {
		return undefined;
	}
	return (call[1] as RequestInit | undefined)?.body;
}

describe('formatEmbed', () => {
	it('met en forme le titre et les champs renseignés', () => {
		const embed = formatEmbed(alert);

		expect(embed.title).toContain('Cotisation payée sans ligne Notion correspondante');
		expect(embed.fields).toEqual([
			{ name: 'paiement', value: '12345', inline: false },
			{ name: 'email', value: 'a@b.fr', inline: false }
		]);
	});

	it("tronque aux limites de l'API Discord", () => {
		const embed = formatEmbed({ title: 'x'.repeat(400), fields: { long: 'y'.repeat(2000) } });

		expect(String(embed.title)).toHaveLength(256);
		expect(embed.fields).toEqual([{ name: 'long', value: 'y'.repeat(1024), inline: false }]);
	});
});

describe('createAlerter', () => {
	it("n'émet aucun appel quand aucune URL n'est configurée", async () => {
		const fetchMock = vi.fn();
		await alerter(undefined, fetchMock).notify(alert);

		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('envoie un embed rouge à Discord', async () => {
		const fetchMock = vi.fn((_url: string, _init: RequestInit) =>
			Promise.resolve(new Response('', { status: 204 }))
		);
		await alerter('https://discord.com/api/webhooks/1/abc', fetchMock).notify(alert);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const body: unknown = JSON.parse(String(sentBody(fetchMock)));
		expect(body).not.toHaveProperty('content');
		expect(body).toMatchObject({
			embeds: [
				{
					title: expect.stringContaining(
						'Cotisation payée sans ligne Notion correspondante'
					) as unknown,
					color: 0xef4444,
					fields: [
						{ name: 'paiement', value: '12345' },
						{ name: 'email', value: 'a@b.fr' }
					]
				}
			],
			allowed_mentions: { parse: [] }
		});
	});

	it('avale une panne du webhook plutôt que de faire échouer le paiement', async () => {
		const fetchMock = vi.fn(() => Promise.reject(new Error('réseau coupé')));

		await expect(
			alerter('https://discord.com/api/webhooks/1/abc', fetchMock).notify(alert)
		).resolves.toBeUndefined();
	});

	it('avale aussi un refus du webhook', async () => {
		const fetchMock = vi.fn(() => Promise.resolve(new Response('', { status: 429 })));

		await expect(
			alerter('https://discord.com/api/webhooks/1/abc', fetchMock).notify(alert)
		).resolves.toBeUndefined();
	});
});
