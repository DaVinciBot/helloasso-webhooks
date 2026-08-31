import { describe, expect, it } from 'vitest';
import {
	describePayer,
	displayName,
	memberIdentity,
	normalizeEmail,
	normalizeName,
	sameName
} from '../../src/core/identity.js';

describe('normalizeEmail', () => {
	it('met en minuscules et retire les espaces', () => {
		expect(normalizeEmail('  Membre.Test@Example.ORG ')).toBe('membre.test@example.org');
	});

	it('rejette ce qui ne peut pas servir de clé', () => {
		expect(normalizeEmail(undefined)).toBeUndefined();
		expect(normalizeEmail('   ')).toBeUndefined();
		expect(normalizeEmail('pas-une-adresse')).toBeUndefined();
	});
});

describe('normalizeName', () => {
	it('ramène accents, casse et séparateurs à une forme commune', () => {
		expect(normalizeName('DUPONT')).toBe('dupont');
		expect(normalizeName('Dupont')).toBe('dupont');
		expect(normalizeName('du-pont')).toBe('du pont');
		expect(normalizeName('Éloïse')).toBe('eloise');
	});

	it('traite les deux apostrophes de la même façon', () => {
		const droite = normalizeName("D'Artagnan");
		expect(normalizeName('D’Artagnan')).toBe(droite);
		expect(droite).toBe('d artagnan');
	});

	it('rejette ce qui ne peut pas servir de critère', () => {
		expect(normalizeName(undefined)).toBeUndefined();
		expect(normalizeName('  ')).toBeUndefined();
	});
});

describe('displayName', () => {
	it('conserve accents et casse, normalise les espaces', () => {
		expect(displayName('  Éloïse ', ' Dupont-Martin ')).toBe('Éloïse Dupont-Martin');
	});
});

describe('sameName', () => {
	it('ignore casse et accents', () => {
		expect(
			sameName(
				{ firstName: 'Éloïse', lastName: 'DUPONT' },
				{ firstName: 'eloise', lastName: 'Dupont' }
			)
		).toBe(true);
	});

	it("est faux dès qu'une identité est incomplète", () => {
		expect(sameName({ firstName: 'Lucie' }, { firstName: 'Lucie' })).toBe(false);
		expect(sameName(undefined, undefined)).toBe(false);
	});
});

describe('memberIdentity', () => {
	const payer = { email: 'Payeur@Example.org', firstName: 'Jean', lastName: 'Payeur' };

	it("retient l'email quand payeur et inscrit sont la même personne", () => {
		expect(memberIdentity(payer, { firstName: 'jean', lastName: 'PAYEUR' })).toEqual({
			email: 'payeur@example.org',
			firstName: 'jean',
			lastName: 'PAYEUR'
		});
	});

	it("écarte l'email du payeur quand un tiers règle pour quelqu'un d'autre", () => {
		// Le garder marquerait la ligne du payeur : deux membres touchés d'un coup.
		expect(memberIdentity(payer, { firstName: 'Lucie', lastName: 'Martin' })).toEqual({
			email: undefined,
			firstName: 'Lucie',
			lastName: 'Martin'
		});
	});

	it("se rabat sur le payeur quand aucun inscrit n'est connu", () => {
		expect(memberIdentity(payer, undefined)).toEqual({
			email: 'payeur@example.org',
			firstName: 'Jean',
			lastName: 'Payeur'
		});
	});

	it("se rabat sur le payeur quand l'identité de l'inscrit est incomplète", () => {
		expect(memberIdentity(payer, { firstName: 'Lucie' })).toEqual({
			email: 'payeur@example.org',
			firstName: 'Jean',
			lastName: 'Payeur'
		});
	});
});

describe('describePayer', () => {
	it('ne mentionne pas le payeur quand il est le membre', () => {
		expect(
			describePayer(
				{ email: 'a@b.fr', firstName: 'Lucie', lastName: 'Martin' },
				{ firstName: 'lucie', lastName: 'MARTIN' }
			)
		).toBeUndefined();
	});

	it('le nomme quand il règle pour un tiers', () => {
		expect(
			describePayer(
				{ email: 'jean@example.org', firstName: 'Jean', lastName: 'Payeur' },
				{ firstName: 'Lucie', lastName: 'Martin' }
			)
		).toBe('Jean Payeur <jean@example.org>');
	});

	it("ne rend rien quand il n'y a rien à dire", () => {
		expect(describePayer(undefined, { firstName: 'Lucie', lastName: 'Martin' })).toBeUndefined();
	});
});
