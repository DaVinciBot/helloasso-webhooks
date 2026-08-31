import type { AnnouncePort } from '../adapters/discord.js';
import type { Registration, WeiRegistryPort } from '../adapters/supabase/weiRegistry.js';
import { DataError } from '../core/errors.js';
import { displayName } from '../core/identity.js';
import type { CampaignSelector } from '../core/routing.js';
import type { HandlerResult, PaymentHandler } from './types.js';

/**
 * WEI : inscrit au registre les places que ce paiement vient de prendre, puis
 * annonce sur Discord qui vient d'arriver — et rappelle la liste complète des
 * inscrits.
 *
 * Le fait durable est l'inscription au registre ; l'annonce est au mieux. Cette
 * hiérarchie décide de tout le reste : une écriture au registre qui échoue lève
 * et fait rejouer HelloAsso, un envoi Discord qui échoue est signalé mais laisse
 * le paiement pour traité.
 */

export const WEI_HANDLER = 'wei';

export interface WeiDeps {
	readonly registry: WeiRegistryPort;
	readonly announcer: AnnouncePort;
	readonly selector: CampaignSelector;
	/** Nombre de places du séjour, quand il est connu. */
	readonly capacity: number | undefined;
}

export function createWeiHandler(deps: WeiDeps): PaymentHandler {
	return {
		name: WEI_HANDLER,
		selector: deps.selector,

		async handle(payment, context): Promise<HandlerResult> {
			const participants = payment.participants;

			if (participants.length === 0) {
				// Contrairement à la cotisation, se rabattre sur le payeur n'aurait
				// pas de sens : le payeur n'est pas nécessairement du voyage, et une
				// place attribuée à la mauvaise personne est pire que pas de place.
				throw new DataError(
					'commande WEI sans participant identifiable : ni ligne de commande ni identité exploitable'
				);
			}

			const orderId = payment.orderId;
			if (orderId === undefined) {
				throw new DataError('paiement WEI sans référence de commande');
			}

			context.signal.throwIfAborted();
			await deps.registry.register(
				participants.map((participant) => ({
					itemId: participant.itemId,
					orderId,
					paymentId: payment.id,
					firstName: participant.firstName,
					lastName: participant.lastName
				}))
			);

			// Les arrivants sont relus depuis le registre, et non déduits de ce
			// qu'on vient d'insérer : voir `WeiRegistryPort.findByPayment`.
			const arrivals = await deps.registry.findByPayment(payment.id);

			if (arrivals.length === 0) {
				// Échéance suivante d'un règlement échelonné : les places de cette
				// commande sont déjà au registre, sous l'identifiant du premier
				// paiement. Rien de neuf à annoncer.
				context.logger.info(
					{ commande: orderId },
					'places déjà inscrites par un paiement antérieur, aucune annonce'
				);
				return {
					status: 'handled',
					summary: { places: participants.length, arrivants: 0, commande: orderId }
				};
			}

			const everyone = await deps.registry.listAll();
			await deps.announcer.announce(buildAnnouncement(arrivals, everyone, deps.capacity));

			context.logger.info(
				{ arrivants: arrivals.length, inscrits: everyone.length },
				'places inscrites et annoncées'
			);

			return {
				status: 'handled',
				summary: {
					places: participants.length,
					arrivants: arrivals.length,
					inscrits: everyone.length,
					commande: orderId
				}
			};
		}
	};
}

/** Nom affichable d'une place inscrite. */
function nameOf(registration: Registration): string {
	return displayName(registration.firstName, registration.lastName);
}

/**
 * Accorde l'annonce au nombre d'arrivants, et énumère les noms sans virgule
 * avant le dernier : « Lucie, Tom et Inès ». Fonction pure.
 */
export function joinNames(names: readonly string[]): string {
	if (names.length <= 1) {
		return names[0] ?? '';
	}
	return `${names.slice(0, -1).join(', ')} et ${names[names.length - 1] ?? ''}`;
}

/**
 * Compose l'annonce. Fonction pure : c'est ici que vivent les mots, et
 * l'adaptateur Discord n'a plus qu'à les mettre en forme et à les tronquer s'ils
 * débordent.
 */
export function buildAnnouncement(
	arrivals: readonly Registration[],
	everyone: readonly Registration[],
	capacity: number | undefined
): {
	title: string;
	headline: string;
	lines: readonly string[];
	footer: string | undefined;
} {
	const names = arrivals.map(nameOf);
	const plural = arrivals.length > 1;

	const total = everyone.length;
	const gauge =
		capacity === undefined
			? `${String(total)} inscrit${total > 1 ? 's' : ''}`
			: `${String(total)} / ${String(capacity)} places`;

	return {
		title: `🎒 ${joinNames(names)} ${plural ? 'viennent' : 'vient'} de prendre ${plural ? 'leur place' : 'sa place'} au WEI !`,
		headline: `**Les inscrits — ${gauge}**`,
		lines: everyone.map((registration, index) => {
			const line = `${String(index + 1)}. ${nameOf(registration)}`;
			// Les arrivants sont mis en gras : dans une liste de soixante noms,
			// c'est la seule façon de voir d'un coup d'oeil qui vient de s'ajouter.
			return arrivals.some((arrival) => arrival.itemId === registration.itemId)
				? `**${line}**`
				: line;
		}),
		footer:
			capacity !== undefined && total >= capacity
				? 'Le WEI est complet.'
				: capacity === undefined
					? undefined
					: `Il reste ${String(capacity - total)} place${capacity - total > 1 ? 's' : ''}.`
	};
}
