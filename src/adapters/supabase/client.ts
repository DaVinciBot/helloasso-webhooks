import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { SupabaseConfig } from '../../core/config.js';

/**
 * Le client Supabase et la description du schéma `helloasso`.
 *
 * Ce schéma est privé au service : il ne transite pas par
 * `@davincibot/database-types`, qui ne diffuse que `public` aux applications du
 * monorepo. Aucune d'elles n'a affaire à ces deux tables, et les y faire entrer
 * ne ferait que coupler le service au cycle de publication du paquet partagé.
 * La description est donc écrite à la main, ici, à côté de son unique usage.
 *
 * Le nom du schéma n'est pas configurable : il est fixé par la migration, et un
 * service qui pointerait vers un autre schéma que celui qu'il a créé n'aurait
 * pas de sens.
 */
export const SCHEMA = 'helloasso';

export const PROCESSED_PAYMENTS_TABLE = 'processed_payments';
export const WEI_REGISTRATIONS_TABLE = 'wei_registrations';

/* eslint-disable @typescript-eslint/consistent-type-definitions --
   `GenericSchema` de supabase-js attend des `Record<string, …>`. Une `interface`
   ne reçoit pas la signature d'index implicite qui rend cette affectation
   possible : le client résoudrait alors chaque ligne en `never`. Ces
   déclarations doivent rester des alias de type. */

export type ProcessedPaymentRow = {
	payment_id: string;
	handler: string;
	payer_email: string | null;
	processed_at: string;
};

export type WeiRegistrationRow = {
	item_id: string;
	order_id: string;
	payment_id: string | null;
	first_name: string;
	last_name: string;
	registered_at: string;
};

type HelloAssoSchema = {
	Tables: {
		processed_payments: {
			Row: ProcessedPaymentRow;
			Insert: {
				payment_id: string;
				handler: string;
				payer_email?: string | null;
				processed_at?: string;
			};
			Update: {
				payment_id?: string;
				handler?: string;
				payer_email?: string | null;
				processed_at?: string;
			};
			Relationships: [];
		};
		wei_registrations: {
			Row: WeiRegistrationRow;
			Insert: {
				item_id: string;
				order_id: string;
				payment_id?: string | null;
				first_name: string;
				last_name: string;
				registered_at?: string;
			};
			Update: {
				item_id?: string;
				order_id?: string;
				payment_id?: string | null;
				first_name?: string;
				last_name?: string;
				registered_at?: string;
			};
			Relationships: [];
		};
	};
	Views: Record<string, never>;
	Functions: Record<string, never>;
};

export type HelloAssoDatabase = {
	helloasso: HelloAssoSchema;
};

/* eslint-enable @typescript-eslint/consistent-type-definitions */

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
