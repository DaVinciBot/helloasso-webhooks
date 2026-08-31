import { describe, expect, it, vi } from 'vitest';
import {
	createAlerter,
	createAnnouncer,
	createNoopAlerter,
	formatAlertEmbed,
	formatAnnouncementEmbed,
	formatBody,
	type Announcement
} from '../../src/adapters/discord.js';
import type { FetchLike } from '../../src/adapters/helloasso.js';
import { makeAlerts, silentLogger } from '../helpers.js';

const WEBHOOK = 'https://discord.test/webhook';

function fetchMock(response: Response | Error) {
	const spy = vi.fn(() =>
		response instanceof Error ? Promise.reject(response) : Promise.resolve(response)
	);
	return { fetch: spy as unknown as FetchLike, spy };
}

function bodyOf(spy: ReturnType<typeof vi.fn>): Record<string, unknown> {
	const init = spy.mock.calls[0]?.[1] as { body: string };
	return JSON.parse(init.body) as Record<string, unknown>;
}

const announcement: Announcement = {
	title: 'Lucie vient de prendre sa place',
	headline: '**Les inscrits — 1 inscrit**',
	lines: ['1. Lucie Martin'],
	footer: 'Il reste 59 places.'
};

describe('formatAlertEmbed', () => {
	it('rend les champs renseignés et tait les autres', () => {
		const embed = formatAlertEmbed({
			title: 'Incident',
			fields: { paiement: '1', email: undefined, montant: 20 }
		});

		expect(embed.title).toBe('⚠️ Incident');
		expect(embed.fields).toEqual([
			{ name: 'paiement', value: '1', inline: false },
			{ name: 'montant', value: '20', inline: false }
		]);
	});

	it('tronque un champ trop long plutôt que de faire refuser l’embed', () => {
		const embed = formatAlertEmbed({ title: 'x', fields: { détail: 'a'.repeat(4000) } });
		const fields = embed.fields as { value: string }[];
		expect(fields[0]?.value.length).toBe(1024);
	});
});

describe('formatBody', () => {
	it('rend la liste entière quand elle tient', () => {
		expect(formatBody('En-tête', ['1. Lucie', '2. Tom'])).toBe('En-tête\n\n1. Lucie\n2. Tom');
	});

	it('tronque en annonçant ce qui manque', () => {
		// Une liste qui grossit finirait par faire refuser l'embed entier : mieux
		// vaut une liste écourtée qu'une annonce perdue.
		const lines = Array.from({ length: 500 }, (_, index) => `${String(index)}. ${'x'.repeat(40)}`);
		const body = formatBody('En-tête', lines);

		expect(body.length).toBeLessThanOrEqual(3900);
		expect(body).toContain('… et ');
		expect(body).toContain('autres');
	});
});

describe('formatAnnouncementEmbed', () => {
	it('compose titre, corps et pied', () => {
		const embed = formatAnnouncementEmbed(announcement);
		expect(embed.title).toBe(announcement.title);
		expect(embed.description).toContain('1. Lucie Martin');
		expect(embed.footer).toEqual({ text: 'Il reste 59 places.' });
	});

	it('omet le pied quand il n’y en a pas', () => {
		expect(formatAnnouncementEmbed({ ...announcement, footer: undefined })).not.toHaveProperty(
			'footer'
		);
	});
});

describe('createAlerter', () => {
	it('poste un embed sans mention déclenchable', async () => {
		const { fetch, spy } = fetchMock(new Response(null, { status: 204 }));
		const alerter = createAlerter(WEBHOOK, { logger: silentLogger, timeoutMs: 1000, fetch });

		await alerter.notify({ title: 'Incident', fields: {} });

		expect(bodyOf(spy).allowed_mentions).toEqual({ parse: [] });
	});

	it("n'échoue jamais quand Discord refuse", async () => {
		const { fetch } = fetchMock(new Response('', { status: 500 }));
		const alerter = createAlerter(WEBHOOK, { logger: silentLogger, timeoutMs: 1000, fetch });

		await expect(alerter.notify({ title: 'Incident', fields: {} })).resolves.toBeUndefined();
	});

	it("n'échoue jamais quand le réseau tombe", async () => {
		const { fetch } = fetchMock(new Error('ECONNRESET'));
		const alerter = createAlerter(WEBHOOK, { logger: silentLogger, timeoutMs: 1000, fetch });

		await expect(alerter.notify({ title: 'Incident', fields: {} })).resolves.toBeUndefined();
	});

	it('se dégrade en no-op sans webhook configuré', async () => {
		const alerter = createAlerter(undefined, { logger: silentLogger, timeoutMs: 1000 });
		await expect(alerter.notify({ title: 'Incident', fields: {} })).resolves.toBeUndefined();
	});

	it('le no-op journalise au lieu de poster', async () => {
		await expect(
			createNoopAlerter(silentLogger).notify({ title: 'Incident', fields: {} })
		).resolves.toBeUndefined();
	});
});

describe('createAnnouncer', () => {
	it('poste l’annonce', async () => {
		const { fetch, spy } = fetchMock(new Response(null, { status: 204 }));
		const alerts = makeAlerts();
		const announcer = createAnnouncer(WEBHOOK, {
			logger: silentLogger,
			timeoutMs: 1000,
			fetch,
			alerts: alerts.port
		});

		await announcer.announce(announcement);

		expect(spy).toHaveBeenCalledOnce();
		expect(alerts.notify).not.toHaveBeenCalled();
	});

	it('alerte quand une annonce ne part pas — perdre un message sans le savoir serait pire', async () => {
		const { fetch } = fetchMock(new Response('', { status: 500 }));
		const alerts = makeAlerts();
		const announcer = createAnnouncer(WEBHOOK, {
			logger: silentLogger,
			timeoutMs: 1000,
			fetch,
			alerts: alerts.port
		});

		await expect(announcer.announce(announcement)).resolves.toBeUndefined();
		expect(alerts.notify).toHaveBeenCalledOnce();
	});
});
