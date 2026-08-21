import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { SupabaseConfig } from './config.js';
import { TransientError } from './errors.js';
import type { Logger } from './logger.js';

/**
 * Idempotence : mémorise les paiements déjà traités pour que les rejeux
 * HelloAsso — et ils arrivent, c'est le mécanisme de fiabilité de leur webhook —
 * ne remarquent pas et ne réécrivent pas.
 *
 * La table vit dans le schéma dédié `helloasso` du projet Supabase, hors de
 * `public`, pour ne pas entrer dans `@davincibot/database-types` : aucune app du
 * monorepo ne la lit.
 */

export interface DedupPort {
	/** `true` si le paiement a déjà été traité avec succès. */
	isProcessed(paymentId: string): Promise<boolean>;
	/** Enregistre le paiement. Sans effet s'il y est déjà (`ON CONFLICT DO NOTHING`). */
	markProcessed(paymentId: string, payerEmail: string | undefined): Promise<void>;
}

/** Nom de la table, aligné sur la migration. */
export const TABLE = 'processed_payments';

/**
 * Le nom du schéma n'est pas configurable : il est fixé par la migration, et un
 * service qui pointerait vers un autre schéma que celui qu'il a créé n'aurait
 * pas de sens.
 */
export const DEDUP_SCHEMA = 'helloasso';

/* eslint-disable @typescript-eslint/consistent-type-definitions --
   `GenericSchema` de supabase-js attend des `Record<string, …>`. Une `interface`
   ne reçoit pas la signature d'index implicite qui rend cette affectation
   possible : le client résoudrait alors chaque ligne en `never`. Ces trois
   déclarations doivent rester des alias de type. */

export type ProcessedPaymentRow = {
	payment_id: string;
	payer_email: string | null;
	processed_at: string;
};

/**
 * Description minimale du schéma, à la main plutôt que via
 * `@davincibot/database-types` : ce schéma est privé au service et n'a aucune
 * raison de transiter par le paquet partagé.
 */
type ProcessedPaymentsSchema = {
	Tables: {
		processed_payments: {
			Row: ProcessedPaymentRow;
			Insert: {
				payment_id: string;
				payer_email?: string | null;
				processed_at?: string;
			};
			Update: {
				payment_id?: string;
				payer_email?: string | null;
				processed_at?: string;
			};
			Relationships: [];
		};
	};
	Views: Record<string, never>;
	Functions: Record<string, never>;
};

export type DedupDatabase = {
	helloasso: ProcessedPaymentsSchema;
};

/* eslint-enable @typescript-eslint/consistent-type-definitions */

export type DedupSupabaseClient = SupabaseClient<DedupDatabase, typeof DEDUP_SCHEMA>;

/** Erreur telle que remontée par PostgREST, réduite à ce dont on a besoin. */
export interface DbError {
	readonly code: string;
	readonly message: string;
}

/**
 * Surface de stockage réellement utilisée : deux opérations, aucun détail
 * PostgREST. La logique de classement des erreurs se teste ainsi sans base.
 */
export interface DedupApi {
	find(paymentId: string): Promise<{ found: boolean; error: DbError | null }>;
	insert(row: {
		payment_id: string;
		payer_email: string | null;
	}): Promise<{ error: DbError | null }>;
}

export function createSupabaseClient(config: SupabaseConfig): DedupSupabaseClient {
	return createClient<DedupDatabase, typeof DEDUP_SCHEMA>(config.url, config.serviceRoleKey, {
		db: { schema: DEDUP_SCHEMA },
		auth: {
			// Service côté serveur : aucune session à persister ni à rafraîchir.
			persistSession: false,
			autoRefreshToken: false,
			detectSessionInUrl: false
		}
	});
}

/** Adaptateur du client Supabase vers la surface étroite ci-dessus. */
export function toDedupApi(client: DedupSupabaseClient): DedupApi {
	return {
		async find(paymentId) {
			const { data, error } = await client
				.from(TABLE)
				.select('payment_id')
				.eq('payment_id', paymentId)
				.maybeSingle();

			return { found: data !== null, error };
		},

		async insert(row) {
			const { error } = await client.from(TABLE).upsert([row], {
				onConflict: 'payment_id',
				ignoreDuplicates: true
			});

			return { error };
		}
	};
}

export interface DedupStoreDeps {
	readonly logger: Logger;
	/** Injectable pour les tests. */
	readonly api?: DedupApi;
}

export function createDedupStore(config: SupabaseConfig, deps: DedupStoreDeps): DedupPort {
	const logger = deps.logger.child({ component: 'dedup' });
	const api = deps.api ?? toDedupApi(createSupabaseClient(config));

	return {
		async isProcessed(paymentId): Promise<boolean> {
			const { found, error } = await api.find(paymentId);

			if (error !== null) {
				// Toute erreur de lecture est traitée comme passagère : sans le
				// store, on ne peut plus garantir l'idempotence, donc on refuse
				// d'écrire dans Notion et on laisse HelloAsso rejouer.
				throw new TransientError(
					`Supabase : lecture de ${TABLE} en échec (${error.code}) — ${error.message}`,
					{ cause: error }
				);
			}

			return found;
		},

		async markProcessed(paymentId, payerEmail): Promise<void> {
			const { error } = await api.insert({
				payment_id: paymentId,
				payer_email: payerEmail ?? null
			});

			if (error !== null) {
				throw new TransientError(
					`Supabase : écriture dans ${TABLE} en échec (${error.code}) — ${error.message}`,
					{ cause: error }
				);
			}

			logger.debug({ paymentId }, 'paiement marqué comme traité');
		}
	};
}
