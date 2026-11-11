import type { Config } from './config.js';

/**
 * Réglages de campagne tenus depuis l'administration (helloasso-webhooks#1),
 * appliqués par-dessus la configuration d'environnement.
 *
 * Tout est pur : `applyCampaignOverrides` ne lit rien et n'écrit rien, il
 * compose une configuration effective à partir des deux sources.
 *
 * Règles :
 * - un handler désactivé depuis l'administration n'est pas câblé ;
 * - un champ renseigné en base l'emporte sur l'environnement, un champ vide le
 *   laisse tel quel ;
 * - l'administration ne peut pas câbler un handler dont les secrets manquent
 *   (jeton Notion, webhook Discord) : ceux-là restent dans l'environnement, et
 *   leur absence garde le handler éteint.
 */

export interface CampaignSetting {
	readonly enabled: boolean;
	readonly formType: string | undefined;
	readonly formSlug: string | undefined;
	readonly capacity: number | undefined;
}

export interface CampaignOverrides {
	readonly membership?: CampaignSetting;
	readonly wei?: CampaignSetting;
}

export function applyCampaignOverrides(config: Config, overrides: CampaignOverrides): Config {
	const membership = (() => {
		const setting = overrides.membership;
		if (config.membership === undefined || setting === undefined) {
			return config.membership;
		}
		if (!setting.enabled) {
			return undefined;
		}
		return {
			...config.membership,
			selector: {
				formType: setting.formType ?? config.membership.selector.formType,
				formSlug: setting.formSlug ?? config.membership.selector.formSlug
			}
		};
	})();

	const wei = (() => {
		const setting = overrides.wei;
		if (config.wei === undefined || setting === undefined) {
			return config.wei;
		}
		if (!setting.enabled) {
			return undefined;
		}
		return {
			...config.wei,
			campaign: {
				formType: setting.formType ?? config.wei.campaign.formType,
				formSlug: setting.formSlug ?? config.wei.campaign.formSlug
			},
			capacity: setting.capacity ?? config.wei.capacity
		};
	})();

	return { ...config, membership, wei };
}

/** Clé stable d'un jeu de réglages : les handlers ne se reconstruisent que s'il change. */
export function overridesKey(overrides: CampaignOverrides): string {
	return JSON.stringify([overrides.membership ?? null, overrides.wei ?? null]);
}
