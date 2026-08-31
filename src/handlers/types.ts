import type { Logger } from 'pino';
import type { AlertPort } from '../adapters/discord.js';
import type { ReconciledPayment } from '../core/payment.js';
import type { CampaignSelector } from '../core/routing.js';

/**
 * Le contrat d'un handler : ce que l'association fait d'un paiement.
 *
 * Tout ce qui précède est commun et vit dans `core/` — authentification,
 * réconciliation, périmètre, idempotence, sémantique de rejeu. Un handler
 * n'hérite d'aucun de ces soucis : il reçoit un paiement dont il est garanti
 * qu'il est authentique, dans le périmètre de l'association, abouti, et qu'il
 * relève bien de sa campagne. Il dit ce qu'il en a fait.
 *
 * Ajouter un usage au service, c'est écrire un fichier dans ce dossier et le
 * déclarer. Rien d'autre.
 */

/** Ce qu'un handler reçoit en plus du paiement. */
export interface HandlerContext {
	readonly logger: Logger;
	/** Budget de temps global du traitement. À honorer avant chaque appel sortant. */
	readonly signal: AbortSignal;
	/** Alerte humaine. Ne fait jamais échouer le traitement. */
	readonly alerts: AlertPort;
}

/**
 * Ce qu'un handler rend.
 *
 * La distinction n'est pas cosmétique : elle décide si le paiement est inscrit
 * au registre des paiements traités. `unresolved` laisse la porte ouverte à un
 * rejeu manuel une fois la donnée corrigée par un humain — c'est le cas du
 * membre dont la ligne Notion n'existe pas encore.
 */
export type HandlerResult =
	/** Le handler a agi. Le paiement sera marqué traité. */
	| { readonly status: 'handled'; readonly summary: Readonly<Record<string, unknown>> }
	/**
	 * Le handler n'a rien pu faire d'une donnée pourtant valide, et a alerté.
	 * Le paiement n'est pas marqué traité.
	 */
	| {
			readonly status: 'unresolved';
			readonly reason: string;
			readonly summary: Readonly<Record<string, unknown>>;
	  };

export interface PaymentHandler {
	/** Court, stable, journalisé et stocké dans `processed_payments.handler`. */
	readonly name: string;
	/** La campagne dont ce handler a la charge. */
	readonly selector: CampaignSelector;
	/**
	 * Agit sur le paiement.
	 *
	 * @throws {DataError} donnée incohérente : le rejeu est inutile, un humain
	 * doit intervenir. Le pipeline alerte et répond 200.
	 * @throws {TransientError} panne passagère : le pipeline répond 503 pour que
	 * HelloAsso rejoue.
	 */
	handle(payment: ReconciledPayment, context: HandlerContext): Promise<HandlerResult>;
}
