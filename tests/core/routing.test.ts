import { describe, expect, it } from 'vitest';
import type { Campaign } from '../../src/core/payment.js';
import {
	byPrecedence,
	couldMatchAny,
	matchesOrganization,
	matchesSelector,
	selectHandler,
	specificity,
	type Routable
} from '../../src/core/routing.js';

const membership: Routable = {
	name: 'membership',
	selector: { formType: 'Membership', formSlug: undefined }
};
const wei: Routable = { name: 'wei', selector: { formType: 'Event', formSlug: 'wei-2026' } };
const fourreTout: Routable = {
	name: 'fourre-tout',
	selector: { formType: undefined, formSlug: undefined }
};

function campaign(overrides: Partial<Campaign> = {}): Campaign {
	return {
		organizationSlug: 'davincibot',
		formSlug: 'adhesion-2026-2027',
		formType: 'Membership',
		...overrides
	};
}

describe('matchesOrganization', () => {
	it('accepte la bonne organisation, quelle que soit la casse', () => {
		expect(matchesOrganization(campaign({ organizationSlug: 'DaVinciBot' }), 'davincibot').ok).toBe(
			true
		);
	});

	it("n'écarte pas quand HelloAsso omet le slug", () => {
		// Permissif sur l'absence : sinon un changement de format côté HelloAsso
		// couperait le service en silence.
		expect(matchesOrganization(campaign({ organizationSlug: undefined }), 'davincibot').ok).toBe(
			true
		);
	});

	it('écarte une autre organisation', () => {
		const result = matchesOrganization(campaign({ organizationSlug: 'autre-asso' }), 'davincibot');
		expect(result.ok).toBe(false);
		expect(result.ok ? '' : result.reason).toContain('organisation_hors_perimetre');
	});
});

describe('matchesSelector', () => {
	it('accepte quand le type et le slug concordent', () => {
		expect(
			matchesSelector(campaign({ formSlug: 'wei-2026', formType: 'Event' }), wei.selector)
		).toBe(true);
	});

	it('refuse sur désaccord de slug', () => {
		expect(matchesSelector(campaign({ formSlug: 'gala', formType: 'Event' }), wei.selector)).toBe(
			false
		);
	});

	it('un sélecteur vide accepte tout', () => {
		expect(matchesSelector(campaign(), fourreTout.selector)).toBe(true);
	});
});

describe('specificity', () => {
	it('classe slug > type > rien', () => {
		expect(specificity(wei.selector)).toBeGreaterThan(specificity(membership.selector));
		expect(specificity(membership.selector)).toBeGreaterThan(specificity(fourreTout.selector));
	});
});

describe('byPrecedence', () => {
	it('remonte le plus précis en premier, quel que soit l’ordre de déclaration', () => {
		expect(byPrecedence([fourreTout, membership, wei]).map((handler) => handler.name)).toEqual([
			'wei',
			'membership',
			'fourre-tout'
		]);
	});

	it('conserve l’ordre de déclaration à précision égale', () => {
		const premier: Routable = { name: 'a', selector: { formType: 'Event', formSlug: undefined } };
		const second: Routable = { name: 'b', selector: { formType: 'Shop', formSlug: undefined } };
		expect(byPrecedence([premier, second]).map((handler) => handler.name)).toEqual(['a', 'b']);
	});
});

describe('selectHandler', () => {
	it('route la cotisation vers son handler', () => {
		expect(selectHandler(campaign(), [wei, membership])?.name).toBe('membership');
	});

	it('route le WEI vers son handler', () => {
		expect(
			selectHandler(campaign({ formSlug: 'wei-2026', formType: 'Event' }), [wei, membership])?.name
		).toBe('wei');
	});

	it('préfère le handler le plus précis même déclaré en dernier', () => {
		// Le piège que la règle de précision existe pour éviter : un handler
		// attrape-tout déclaré en premier masquerait le WEI.
		const attrapeTout: Routable = {
			name: 'attrape-tout',
			selector: { formType: 'Event', formSlug: undefined }
		};
		expect(
			selectHandler(campaign({ formSlug: 'wei-2026', formType: 'Event' }), [attrapeTout, wei])?.name
		).toBe('wei');
	});

	it('ne route rien quand aucun handler ne revendique la campagne', () => {
		expect(
			selectHandler(campaign({ formType: 'Shop', formSlug: 'boutique' }), [wei])
		).toBeUndefined();
	});
});

describe('couldMatchAny', () => {
	it('reste permissif sur un payload incomplet', () => {
		// Le pré-filtre ne doit jamais écarter à tort : la réconciliation tranchera.
		expect(
			couldMatchAny({ organizationSlug: undefined, formSlug: undefined, formType: undefined }, [
				wei
			])
		).toBe(true);
	});

	it('écarte une campagne qu’aucun handler ne revendique', () => {
		expect(couldMatchAny(campaign({ formType: 'Shop', formSlug: 'boutique' }), [wei])).toBe(false);
	});
});
