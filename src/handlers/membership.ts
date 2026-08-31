import type { NotionPort } from '../adapters/notion.js';
import { DataError } from '../core/errors.js';
import { describePayer, memberIdentity, normalizeName } from '../core/identity.js';
import type { ReconciledPayment } from '../core/payment.js';
import type { CampaignSelector } from '../core/routing.js';
import type { HandlerContext, HandlerResult, PaymentHandler } from './types.js';

/**
 * Cotisation : coche « payée » sur la ligne du membre dans Notion, et y porte le
 * montant revenu à l'association.
 *
 * Ce handler ne connaît qu'une chose du service : un paiement réconcilié. Il
 * ignore comment il est arrivé là, qui d'autre traite des paiements, et
 * comment son résultat sera rendu en HTTP.
 */

export const MEMBERSHIP_HANDLER = 'membership';

export interface MembershipDeps {
	readonly notion: NotionPort;
	readonly selector: CampaignSelector;
}

export function createMembershipHandler(deps: MembershipDeps): PaymentHandler {
	return {
		name: MEMBERSHIP_HANDLER,
		selector: deps.selector,

		async handle(payment, context): Promise<HandlerResult> {
			// Un seul membre par cotisation. Quand la commande n'en désigne aucun —
			// pas de référence de commande, identité incomplète — on se rabat sur le
			// payeur : dans le cas courant, c'est la même personne.
			const registrant = payment.participants[0];
			const { email, firstName, lastName } = memberIdentity(payment.payer, registrant);

			if (
				email === undefined &&
				(normalizeName(firstName) === undefined || normalizeName(lastName) === undefined)
			) {
				throw new DataError('le paiement ne porte ni adresse email exploitable ni nom complet');
			}

			const match = await deps.notion.findPages(
				{ email, firstName, lastName },
				{ signal: context.signal }
			);

			if (match === undefined) {
				return await unmatched(payment, { email, firstName, lastName }, context);
			}

			const { pageIds, matchedBy } = match;

			if (pageIds.length > 1) {
				context.logger.warn(
					{ email, matchedBy, matches: pageIds.length },
					'plusieurs lignes Notion pour ce membre, toutes seront marquées'
				);
			}

			if (payment.amountEuros === undefined) {
				// Sans montant, l'état est quand même posé : la cotisation reste visible.
				context.logger.warn(
					'paiement sans montant exploitable, colonne montant laissée telle quelle'
				);
			}

			for (const pageId of pageIds) {
				await deps.notion.markPaid(pageId, {
					amount: payment.amountEuros,
					signal: context.signal
				});
				context.logger.info({ pageId, montant: payment.amountEuros }, 'cotisation marquée payée');
			}

			return {
				status: 'handled',
				summary: { email, matchedBy, pages: pageIds.length, montant: payment.amountEuros }
			};
		}
	};
}

/**
 * Le membre a payé mais aucune ligne Notion ne le porte.
 *
 * Le paiement n'est délibérément pas marqué traité : la correction est humaine —
 * ajouter la ligne, corriger une adresse — et un rejeu manuel doit pouvoir
 * aboutir une fois la base à jour.
 */
async function unmatched(
	payment: ReconciledPayment,
	member: {
		readonly email: string | undefined;
		readonly firstName: string | undefined;
		readonly lastName: string | undefined;
	},
	context: HandlerContext
): Promise<HandlerResult> {
	context.logger.warn(member, 'aucune ligne Notion pour ce membre');

	await context.alerts.notify({
		title: 'Cotisation payée sans ligne Notion correspondante',
		fields: {
			paiement: payment.id,
			email: member.email,
			prénom: member.firstName,
			nom: member.lastName,
			montant:
				payment.amountEuros === undefined ? undefined : `${payment.amountEuros.toFixed(2)} €`,
			payeur: describePayer(payment.payer, member),
			action: "vérifier l'adresse et le nom du membre dans la base Notion"
		}
	});

	return {
		status: 'unresolved',
		reason: 'aucune_ligne_notion',
		summary: { email: member.email, prénom: member.firstName, nom: member.lastName }
	};
}
