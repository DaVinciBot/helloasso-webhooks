import { z } from 'zod';
import type { Campaign } from './payment.js';

/**
 * La notification telle qu'elle arrive sur le webhook.
 *
 * Elle n'a aucune authenticité : les comptes association HelloAsso ne signent
 * pas leurs notifications. Ce module en tire donc le strict minimum — de quel
 * évènement il s'agit, de quel paiement on parle, et de quelle campagne il se
 * réclame. Rien d'autre n'est lu, et surtout pas le montant ni le statut : tout
 * ce qui décide d'une action provient de la réconciliation auprès de l'API v5.
 *
 * Ce schéma volontairement étroit est la traduction en code du principe
 * « ne jamais faire confiance au payload » : il n'y a pas de champ à
 * accidentellement croire, puisqu'il n'y en a pas.
 */

/** L'API HelloAsso renvoie les identifiants tantôt en nombre, tantôt en chaîne. */
const identifier = z.union([z.number().int(), z.string().min(1)]);

const claimedCampaignSchema = z.object({
	formSlug: z.string().optional(),
	formType: z.string().optional(),
	organizationSlug: z.string().optional()
});

/**
 * Ce que le payload prétend. `id` est la seule donnée réellement utilisée :
 * elle sert à relire le paiement, et à répondre « déjà traité » — c'est-à-dire
 * à *ne rien faire*.
 */
export const claimedPaymentSchema = z.object({
	id: identifier,
	order: claimedCampaignSchema.optional()
});

/**
 * Ce que le payload prétend d'une commande, telle qu'annoncée par l'évènement
 * `Order` — forme distincte de celle de `Payment` : HelloAsso n'émet cet
 * évènement sans `Payment` que pour une commande entièrement gratuite (une
 * cotisation à 0€ après réduction, par exemple), et les champs de campagne y
 * sont à plat plutôt que nichés sous `order`.
 *
 * `amount.total` ne sert qu'au pré-filtre économique de `pipeline.ts` : comme
 * le reste de ce schéma, il n'est jamais la base d'une action — seule la
 * relecture authentifiée de la commande l'est.
 */
export const claimedOrderSchema = z.object({
	id: identifier,
	formSlug: z.string().optional(),
	formType: z.string().optional(),
	organizationSlug: z.string().optional(),
	amount: z.object({ total: z.number().optional() }).optional()
});

export const notificationSchema = z.object({
	eventType: z.string().min(1),
	data: z.unknown(),
	metadata: z.unknown().optional()
});

export type ClaimedPayment = z.infer<typeof claimedPaymentSchema>;
export type ClaimedOrder = z.infer<typeof claimedOrderSchema>;
export type Notification = z.infer<typeof notificationSchema>;

/** Type d'évènement porté par les notifications de paiement. */
export const PAYMENT_EVENT_TYPE = 'Payment';

/** Type d'évènement porté par les notifications de commande — seule la commande gratuite nous concerne. */
export const ORDER_EVENT_TYPE = 'Order';

/**
 * Normalise un identifiant HelloAsso en chaîne : c'est la forme stockée en base
 * et la seule qui garantisse une comparaison stable entre un `42` du payload et
 * un `"42"` relu depuis Postgres.
 */
export function toIdentifier(id: number | string): string {
	return String(id);
}

/** La campagne annoncée par le payload, telle que le pré-filtre la lit. */
export function claimedCampaign(claimed: ClaimedPayment): Campaign {
	return {
		organizationSlug: claimed.order?.organizationSlug,
		formSlug: claimed.order?.formSlug,
		formType: claimed.order?.formType
	};
}
