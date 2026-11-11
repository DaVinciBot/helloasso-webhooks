import type { Logger } from 'pino';
import type { CampaignOverrides } from '../../core/campaigns.js';
import type { SupabaseConfig } from '../../core/config.js';
import { describeError } from '../../core/errors.js';
import {
	CAMPAIGN_SETTINGS_TABLE as TABLE,
	createSupabaseClient,
	type CampaignSettingsRow,
	type DbError
} from './client.js';

/**
 * Réglages des campagnes, tenus depuis l'administration (helloasso-webhooks#1).
 *
 * Chaque année la cagnotte de cotisation et le formulaire du WEI changent : ces
 * réglages vivent en base, dans `helloasso.campaign_settings`, et non plus dans
 * l'environnement. Le service les relit au plus toutes les `ttlMs`.
 *
 * Une lecture en échec n'arrête pas le service : il garde les derniers réglages
 * connus, et à défaut retombe sur ses variables d'environnement. Mieux vaut
 * router avec une configuration d'hier que refuser un paiement d'aujourd'hui.
 */

export interface CampaignSettingsPort {
	current(): Promise<CampaignOverrides>;
}

/** Surface de stockage réellement utilisée, injectable pour les tests. */
export interface CampaignSettingsApi {
	list(): Promise<{ rows: CampaignSettingsRow[] | null; error: DbError | null }>;
}

export interface CampaignSettingsDeps {
	readonly logger: Logger;
	readonly ttlMs?: number;
	readonly api?: CampaignSettingsApi;
	readonly now?: () => number;
}

export const DEFAULT_SETTINGS_TTL_MS = 60_000;

/** Lignes de la table vers les réglages qu'applique le service. */
export function toOverrides(rows: readonly CampaignSettingsRow[]): CampaignOverrides {
	const overrides: { -readonly [K in keyof CampaignOverrides]: CampaignOverrides[K] } = {};
	for (const row of rows) {
		const setting = {
			enabled: row.enabled,
			formType: row.form_type ?? undefined,
			formSlug: row.form_slug ?? undefined,
			capacity: row.capacity ?? undefined
		};
		if (row.handler === 'membership') {
			overrides.membership = setting;
		} else if (row.handler === 'wei') {
			overrides.wei = setting;
		}
	}
	return overrides;
}

export function createCampaignSettings(
	config: SupabaseConfig,
	deps: CampaignSettingsDeps
): CampaignSettingsPort {
	const logger = deps.logger.child({ component: 'campaign-settings' });
	const ttlMs = deps.ttlMs ?? DEFAULT_SETTINGS_TTL_MS;
	const now = deps.now ?? Date.now;
	const api: CampaignSettingsApi =
		deps.api ??
		(() => {
			const client = createSupabaseClient(config);
			return {
				async list() {
					const { data, error } = await client.from(TABLE).select('*');
					return { rows: data, error };
				}
			};
		})();

	let cached: { at: number; value: CampaignOverrides } | undefined;

	return {
		async current(): Promise<CampaignOverrides> {
			if (cached !== undefined && now() - cached.at < ttlMs) {
				return cached.value;
			}
			try {
				const { rows, error } = await api.list();
				if (error !== null) {
					throw new Error(`${error.code} — ${error.message}`);
				}
				cached = { at: now(), value: toOverrides(rows ?? []) };
			} catch (error) {
				logger.warn(
					{ err: describeError(error) },
					'réglages des campagnes illisibles : derniers réglages connus conservés'
				);
				// On retentera au prochain appel plutôt que d'attendre un TTL entier.
				return cached?.value ?? {};
			}
			return cached.value;
		}
	};
}
