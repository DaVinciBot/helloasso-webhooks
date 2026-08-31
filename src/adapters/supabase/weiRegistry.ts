import type { Logger } from 'pino';
import type { SupabaseConfig } from '../../core/config.js';
import { TransientError } from '../../core/errors.js';
import {
	WEI_REGISTRATIONS_TABLE as TABLE,
	createSupabaseClient,
	type DbError,
	type HelloAssoSupabaseClient,
	type WeiRegistrationRow
} from './client.js';

/**
 * Le registre des places du WEI.
 *
 * Une ligne par place, clé sur l'identifiant de la ligne de commande HelloAsso.
 * Ce n'est pas un détail de stockage mais la garantie centrale du flux : la
 * place existe une fois et une seule, quel que soit le nombre de paiements
 * (règlement échelonné), de rejeux ou d'amorçages qui la traversent.
 *
 * Le registre n'est jamais modifié ni purgé par le service — il n'écrit qu'en
 * ajout, et la migration ne lui accorde que `SELECT` et `INSERT`.
 */

/** Place à inscrire. */
export interface NewRegistration {
	readonly itemId: string;
	readonly orderId: string;
	/** `undefined` pour l'amorçage : la place précède la mise en service du flux. */
	readonly paymentId: string | undefined;
	readonly firstName: string;
	readonly lastName: string;
}

/** Place inscrite. */
export interface Registration {
	readonly itemId: string;
	readonly firstName: string;
	readonly lastName: string;
	readonly registeredAt: string;
}

export interface WeiRegistryPort {
	/**
	 * Inscrit les places. Sans effet sur celles déjà présentes — c'est ce qui
	 * rend le flux insensible aux rejeux et aux échéances successives.
	 */
	register(registrations: readonly NewRegistration[]): Promise<void>;
	/**
	 * Les places portant cet identifiant de paiement.
	 *
	 * C'est la définition de « qui vient d'arriver ». La lire depuis le registre
	 * plutôt que de retenir ce qu'on vient d'insérer supprime un cas de message
	 * perdu : si le process meurt entre l'insertion et le marquage du paiement,
	 * le rejeu retrouve ses propres lignes et annonce quand même. Une échéance
	 * suivante, elle, porte un autre identifiant et ne retrouve rien.
	 */
	findByPayment(paymentId: string): Promise<readonly Registration[]>;
	/** Toutes les places, dans l'ordre où elles ont été prises. */
	listAll(): Promise<readonly Registration[]>;
}

/**
 * Au-delà, on cesse de tout charger en mémoire pour composer un message
 * Discord. Un WEI se compte en centaines de places : franchir ce seuil signale
 * un registre pollué, pas un succès d'inscription.
 */
const MAX_REGISTRATIONS = 2000;

const COLUMNS = 'item_id, first_name, last_name, registered_at';

/** Surface de stockage réellement utilisée : trois opérations, aucun détail PostgREST. */
export interface WeiRegistryApi {
	insert(rows: readonly WeiInsert[]): Promise<{ error: DbError | null }>;
	selectByPayment(
		paymentId: string
	): Promise<{ rows: RegistrationRow[] | null; error: DbError | null }>;
	selectAll(limit: number): Promise<{ rows: RegistrationRow[] | null; error: DbError | null }>;
}

interface WeiInsert {
	item_id: string;
	order_id: string;
	payment_id: string | null;
	first_name: string;
	last_name: string;
}

type RegistrationRow = Pick<
	WeiRegistrationRow,
	'item_id' | 'first_name' | 'last_name' | 'registered_at'
>;

/** Adaptateur du client Supabase vers la surface étroite ci-dessus. */
export function toWeiRegistryApi(client: HelloAssoSupabaseClient): WeiRegistryApi {
	return {
		async insert(rows) {
			const { error } = await client.from(TABLE).upsert([...rows], {
				onConflict: 'item_id',
				ignoreDuplicates: true
			});
			return { error };
		},

		async selectByPayment(paymentId) {
			const { data, error } = await client
				.from(TABLE)
				.select(COLUMNS)
				.eq('payment_id', paymentId)
				.order('registered_at', { ascending: true })
				.order('item_id', { ascending: true });
			return { rows: data, error };
		},

		async selectAll(limit) {
			const { data, error } = await client
				.from(TABLE)
				.select(COLUMNS)
				// `registered_at` seul ne suffit pas : les places d'une même commande
				// sont inscrites dans la même transaction et partagent l'horodatage.
				// `item_id` départage, pour que la liste ne se réordonne pas d'un
				// message à l'autre.
				.order('registered_at', { ascending: true })
				.order('item_id', { ascending: true })
				.limit(limit);
			return { rows: data, error };
		}
	};
}

export interface WeiRegistryDeps {
	readonly logger: Logger;
	/** Injectable pour les tests. */
	readonly api?: WeiRegistryApi;
}

function toRegistration(row: RegistrationRow): Registration {
	return {
		itemId: row.item_id,
		firstName: row.first_name,
		lastName: row.last_name,
		registeredAt: row.registered_at
	};
}

/** Toute erreur du registre est passagère : on refuse de perdre une inscription. */
function rejectOnError(error: DbError | null, operation: string): void {
	if (error !== null) {
		throw new TransientError(
			`Supabase : ${operation} sur ${TABLE} en échec (${error.code}) — ${error.message}`,
			{ cause: error }
		);
	}
}

export function createWeiRegistry(config: SupabaseConfig, deps: WeiRegistryDeps): WeiRegistryPort {
	const logger = deps.logger.child({ component: 'wei-registry' });
	const api = deps.api ?? toWeiRegistryApi(createSupabaseClient(config));

	return {
		async register(registrations): Promise<void> {
			if (registrations.length === 0) {
				return;
			}

			const { error } = await api.insert(
				registrations.map((registration) => ({
					item_id: registration.itemId,
					order_id: registration.orderId,
					payment_id: registration.paymentId ?? null,
					first_name: registration.firstName,
					last_name: registration.lastName
				}))
			);
			rejectOnError(error, 'inscription');

			logger.debug({ places: registrations.length }, 'places inscrites au registre');
		},

		async findByPayment(paymentId): Promise<readonly Registration[]> {
			const { rows, error } = await api.selectByPayment(paymentId);
			rejectOnError(error, 'lecture des places du paiement');
			return (rows ?? []).map(toRegistration);
		},

		async listAll(): Promise<readonly Registration[]> {
			const { rows, error } = await api.selectAll(MAX_REGISTRATIONS);
			rejectOnError(error, 'lecture du registre');

			const registrations = (rows ?? []).map(toRegistration);
			if (registrations.length === MAX_REGISTRATIONS) {
				logger.warn(
					{ limite: MAX_REGISTRATIONS },
					'registre tronqué à la lecture, la liste annoncée est incomplète'
				);
			}
			return registrations;
		}
	};
}
