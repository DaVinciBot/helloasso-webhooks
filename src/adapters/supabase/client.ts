import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { SupabaseConfig } from '../../core/config.js';

import type { Database } from '@davincibot/database-types';

/**
 * Le client Supabase du schéma `helloasso`.
 *
 * Les types viennent de `@davincibot/database-types`, générés depuis la base
 * comme pour les applications du monorepo (helloasso-webhooks#8) : une colonne
 * ajoutée par migration se voit ici sans recopie à la main. Le paquet n'est
 * qu'une dépendance de développement — il ne porte que des types.
 *
 * Le nom du schéma n'est pas configurable : il est fixé par la migration, et un
 * service qui pointerait vers un autre schéma que celui qu'il a créé n'aurait
 * pas de sens.
 */
export const SCHEMA = 'helloasso';

export const PROCESSED_PAYMENTS_TABLE = 'processed_payments';
export const WEI_REGISTRATIONS_TABLE = 'wei_registrations';
export const CAMPAIGN_SETTINGS_TABLE = 'campaign_settings';

type HelloAssoTables = Database['helloasso']['Tables'];

export type ProcessedPaymentRow = HelloAssoTables['processed_payments']['Row'];
export type WeiRegistrationRow = HelloAssoTables['wei_registrations']['Row'];
export type CampaignSettingsRow = HelloAssoTables['campaign_settings']['Row'];

export type HelloAssoDatabase = Pick<Database, 'helloasso'>;

export type HelloAssoSupabaseClient = SupabaseClient<HelloAssoDatabase, typeof SCHEMA>;

/** Erreur telle que remontée par PostgREST, réduite à ce dont on a besoin. */
export interface DbError {
	readonly code: string;
	readonly message: string;
}

export function createSupabaseClient(config: SupabaseConfig): HelloAssoSupabaseClient {
	return createClient<HelloAssoDatabase, typeof SCHEMA>(config.url, config.serviceRoleKey, {
		db: { schema: SCHEMA },
		auth: {
			// Service côté serveur : aucune session à persister ni à rafraîchir.
			persistSession: false,
			autoRefreshToken: false,
			detectSessionInUrl: false
		}
	});
}
