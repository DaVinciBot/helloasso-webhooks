import type { Logger } from 'pino';
import type { SupabaseConfig } from '../../core/config.js';
import { TransientError } from '../../core/errors.js';
import {
	PROCESSED_PAYMENTS_TABLE as TABLE,
	createSupabaseClient,
	type DbError,
	type HelloAssoSupabaseClient
} from './client.js';

/**
 * Idempotence : la mémoire des paiements déjà traités.
 *
 * HelloAsso rejoue une notification tant qu'il n'a pas reçu de 2xx — et le
 * service répond volontairement 503 sur toute panne passagère, précisément pour
 * provoquer ce rejeu. Sans cette mémoire, chaque rejeu referait le tour complet.
 *
 * La clé est le paiement seul. Un paiement appartient à une campagne, donc à un
 * seul handler : savoir *qu'il* a été traité suffit à ne rien refaire. C'est
 * cette clé simple qui permet de répondre à un rejeu avant même de savoir quel
 * handler était concerné, donc sans aucun appel sortant. La colonne `handler`
 * enregistre qui a agi, pour le diagnostic.
 */

/** Ce qu'on sait d'un paiement déjà traité. */
export interface ProcessedPayment {
	readonly handler: string;
	readonly processedAt: string;
}

export interface ProcessedPaymentsPort {
	/** Le paiement s'il a déjà été traité, `undefined` sinon. */
	find(paymentId: string): Promise<ProcessedPayment | undefined>;
	/** Enregistre le paiement. Sans effet s'il y est déjà. */
	markProcessed(entry: {
		paymentId: string;
		handler: string;
		payerEmail: string | undefined;
	}): Promise<void>;
}

/**
 * Surface de stockage réellement utilisée : deux opérations, aucun détail
 * PostgREST. La logique de classement des erreurs se teste ainsi sans base.
 */
export interface ProcessedPaymentsApi {
	find(paymentId: string): Promise<{
		row: { handler: string; processed_at: string } | null;
		error: DbError | null;
	}>;
	insert(row: {
		payment_id: string;
		handler: string;
		payer_email: string | null;
	}): Promise<{ error: DbError | null }>;
}

/** Adaptateur du client Supabase vers la surface étroite ci-dessus. */
export function toProcessedPaymentsApi(client: HelloAssoSupabaseClient): ProcessedPaymentsApi {
	return {
		async find(paymentId) {
			const { data, error } = await client
				.from(TABLE)
				.select('handler, processed_at')
				.eq('payment_id', paymentId)
				.maybeSingle();

			return { row: data, error };
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

export interface ProcessedPaymentsDeps {
	readonly logger: Logger;
	/** Injectable pour les tests. */
	readonly api?: ProcessedPaymentsApi;
}

export function createProcessedPayments(
	config: SupabaseConfig,
	deps: ProcessedPaymentsDeps
): ProcessedPaymentsPort {
	const logger = deps.logger.child({ component: 'processed-payments' });
	const api = deps.api ?? toProcessedPaymentsApi(createSupabaseClient(config));

	return {
		async find(paymentId): Promise<ProcessedPayment | undefined> {
			const { row, error } = await api.find(paymentId);

			if (error !== null) {
				// Toute erreur de lecture est traitée comme passagère : sans ce
				// registre, l'idempotence n'est plus garantie, donc on refuse d'agir
				// et on laisse HelloAsso rejouer.
				throw new TransientError(
					`Supabase : lecture de ${TABLE} en échec (${error.code}) — ${error.message}`,
					{ cause: error }
				);
			}

			return row === null ? undefined : { handler: row.handler, processedAt: row.processed_at };
		},

		async markProcessed({ paymentId, handler, payerEmail }): Promise<void> {
			const { error } = await api.insert({
				payment_id: paymentId,
				handler,
				payer_email: payerEmail ?? null
			});

			if (error !== null) {
				throw new TransientError(
					`Supabase : écriture dans ${TABLE} en échec (${error.code}) — ${error.message}`,
					{ cause: error }
				);
			}

			logger.debug({ paymentId, handler }, 'paiement marqué comme traité');
		}
	};
}
