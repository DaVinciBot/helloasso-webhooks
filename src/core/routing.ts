import type { Campaign } from './payment.js';

/**
 * Routage : quel handler a la charge de la campagne qui a encaissé ?
 *
 * Tout est pur. Le routage se décide sur la campagne et rien d'autre — jamais
 * sur le contenu du paiement, jamais sur ce qu'un handler « saurait » faire.
 */

/** Campagne(s) dont un handler a la charge. */
export interface CampaignSelector {
	readonly formType: string | undefined;
	readonly formSlug: string | undefined;
}

/** Ce qu'un routeur a besoin de savoir d'un handler. */
export interface Routable {
	readonly name: string;
	readonly selector: CampaignSelector;
}

/**
 * Comparaison de slugs, volontairement *permissive sur l'absence* et stricte sur
 * le désaccord : si HelloAsso omet `formSlug`, on ne conclut pas — sinon un
 * changement de format de leur côté couperait le service en silence. S'il en
 * renvoie un qui diffère, on écarte.
 */
function sameSlug(left: string | undefined, right: string | undefined): boolean {
	if (left === undefined || right === undefined) {
		return true;
	}
	return left.toLowerCase() === right.toLowerCase();
}

/** La campagne relève-t-elle bien de l'association ? */
export function matchesOrganization(
	campaign: Campaign,
	orgSlug: string
): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
	return sameSlug(campaign.organizationSlug, orgSlug)
		? { ok: true }
		: { ok: false, reason: `organisation_hors_perimetre:${campaign.organizationSlug ?? ''}` };
}

/** La campagne relève-t-elle de ce sélecteur ? */
export function matchesSelector(campaign: Campaign, selector: CampaignSelector): boolean {
	if (selector.formType !== undefined && !sameSlug(campaign.formType, selector.formType)) {
		return false;
	}
	if (selector.formSlug !== undefined && !sameSlug(campaign.formSlug, selector.formSlug)) {
		return false;
	}
	return true;
}

/**
 * Précision d'un sélecteur : un slug désigne une campagne, un type en désigne
 * une famille, l'absence des deux désigne tout.
 *
 * C'est ce qui rend le routage indépendant de l'ordre de déclaration. Sans lui,
 * un handler « tous les Membership » déclaré en premier attraperait les
 * paiements du WEI dès que celui-ci partagerait son type — un piège silencieux,
 * découvert le jour où quelqu'un ajoute un formulaire.
 */
export function specificity(selector: CampaignSelector): number {
	return (selector.formSlug === undefined ? 0 : 2) + (selector.formType === undefined ? 0 : 1);
}

/**
 * Classe les handlers du plus précis au moins précis. À précision égale, l'ordre
 * de déclaration tranche — `toSorted` est stable.
 */
export function byPrecedence<T extends Routable>(handlers: readonly T[]): readonly T[] {
	return handlers.toSorted(
		(left, right) => specificity(right.selector) - specificity(left.selector)
	);
}

/**
 * Le handler en charge de cette campagne, ou `undefined` si aucun ne la
 * revendique — auquel cas le paiement ne concerne pas le service.
 */
export function selectHandler<T extends Routable>(
	campaign: Campaign,
	handlers: readonly T[]
): T | undefined {
	return byPrecedence(handlers).find((handler) => matchesSelector(campaign, handler.selector));
}

/**
 * Un handler pourrait-il revendiquer cette campagne ?
 *
 * Sert le pré-filtre appliqué au payload, avant toute réconciliation : la
 * question est posée sur une campagne *annoncée*, donc non authentifiée. La
 * permissivité de `sameSlug` sur l'absence garantit qu'un payload incomplet
 * n'est jamais écarté à tort — il sera de toute façon re-routé sur la réponse
 * de l'API, seule à faire autorité.
 */
export function couldMatchAny(campaign: Campaign, handlers: readonly Routable[]): boolean {
	return handlers.some((handler) => matchesSelector(campaign, handler.selector));
}
