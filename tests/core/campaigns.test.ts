import { describe, expect, it, vi } from 'vitest';
import {
	createCampaignSettings,
	toOverrides
} from '../../src/adapters/supabase/campaignSettings.js';
import { applyCampaignOverrides, overridesKey } from '../../src/core/campaigns.js';
import type { Config } from '../../src/core/config.js';

const base = {
	membership: {
		selector: { formType: 'Membership', formSlug: 'adhesion-2025-2026' },
		notion: {} as never
	},
	wei: {
		campaign: { formType: 'Event', formSlug: 'wei-2025' },
		discordWebhookUrl: 'https://discord.test/hook',
		capacity: 100
	}
} as unknown as Config;

describe('réglages de campagne (helloasso-webhooks#1)', () => {
	it("applique les réglages de l'administration par-dessus l'environnement", () => {
		const effective = applyCampaignOverrides(base, {
			membership: {
				enabled: true,
				formType: undefined,
				formSlug: 'adhesion-2026-2027',
				capacity: undefined
			},
			wei: { enabled: true, formType: 'Event', formSlug: 'wei-2026', capacity: 120 }
		});

		expect(effective.membership?.selector).toEqual({
			formType: 'Membership',
			formSlug: 'adhesion-2026-2027'
		});
		expect(effective.wei?.campaign).toEqual({ formType: 'Event', formSlug: 'wei-2026' });
		expect(effective.wei?.capacity).toBe(120);
		expect(effective.wei?.discordWebhookUrl).toBe('https://discord.test/hook');
	});

	it("éteint un handler désactivé depuis l'administration", () => {
		const effective = applyCampaignOverrides(base, {
			wei: { enabled: false, formType: undefined, formSlug: undefined, capacity: undefined }
		});
		expect(effective.wei).toBeUndefined();
		expect(effective.membership).toBe(base.membership);
	});

	it('ne câble pas un handler dont les secrets manquent', () => {
		const effective = applyCampaignOverrides(
			{ ...base, wei: undefined },
			{
				wei: { enabled: true, formType: 'Event', formSlug: 'wei-2026', capacity: 120 }
			}
		);
		expect(effective.wei).toBeUndefined();
	});

	it('lit les lignes de la table', () => {
		const overrides = toOverrides([
			{
				handler: 'wei',
				enabled: true,
				form_type: 'Event',
				form_slug: 'wei-2026',
				capacity: null,
				updated_at: '2026-11-09T00:00:00Z',
				updated_by: null
			}
		]);
		expect(overrides.wei).toEqual({
			enabled: true,
			formType: 'Event',
			formSlug: 'wei-2026',
			capacity: undefined
		});
		expect(overridesKey(overrides)).not.toBe(overridesKey({}));
	});

	it('garde les derniers réglages connus quand la base ne répond plus', async () => {
		const logger = { child: () => logger, warn: vi.fn() } as never;
		let now = 0;
		const list = vi
			.fn()
			.mockResolvedValueOnce({
				rows: [
					{
						handler: 'membership',
						enabled: false,
						form_type: null,
						form_slug: null,
						capacity: null,
						updated_at: '',
						updated_by: null
					}
				],
				error: null
			})
			.mockResolvedValueOnce({ rows: null, error: { code: '08006', message: 'connexion perdue' } });
		const settings = createCampaignSettings({} as never, {
			logger,
			ttlMs: 1000,
			api: { list },
			now: () => now
		});

		expect((await settings.current()).membership?.enabled).toBe(false);
		now = 500;
		await settings.current();
		expect(list).toHaveBeenCalledOnce();
		now = 2000;
		expect((await settings.current()).membership?.enabled).toBe(false);
		expect(list).toHaveBeenCalledTimes(2);
	});
});
