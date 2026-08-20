import { describe, expect, it, vi } from 'vitest';
import { createAlerter, formatAlert } from '../src/alerts.js';
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

describe('formatAlert', () => {
	it('met en forme le titre et les champs renseignés', () => {
		const message = formatAlert(alert);

		expect(message).toContain('Cotisation payée sans ligne Notion correspondante');
		expect(message).toContain('paiement');
		expect(message).toContain('a@b.fr');
		expect(message).not.toContain('absent');
	});
});

describe('createAlerter', () => {
	it('n’émet aucun appel quand aucune URL n’est configurée', async () => {
		const fetchMock = vi.fn();
		await alerter(undefined, fetchMock).notify(alert);

		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('envoie le champ `content` attendu par Discord', async () => {
		const fetchMock = vi.fn((_url: string, _init: RequestInit) =>
			Promise.resolve(new Response('', { status: 204 }))
		);
		await alerter('https://discord.com/api/webhooks/1/abc', fetchMock).notify(alert);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(JSON.parse(String(sentBody(fetchMock)))).toHaveProperty('content');
	});

	it('envoie le champ `text` attendu par Slack', async () => {
		const fetchMock = vi.fn((_url: string, _init: RequestInit) =>
			Promise.resolve(new Response('', { status: 200 }))
		);
		await alerter('https://hooks.slack.com/services/T/B/X', fetchMock).notify(alert);

		expect(JSON.parse(String(sentBody(fetchMock)))).toHaveProperty('text');
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
