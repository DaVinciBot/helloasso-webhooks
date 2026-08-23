import { describe, expect, it } from 'vitest';
import {
	adherentOf,
	helloAssoWebhookSchema,
	memberIdentity,
	normalizeEmail,
	normalizeName,
	organizationAmount,
	toPaymentId
} from '../src/schema.js';

describe('toPaymentId', () => {
	it('ramène les deux formes renvoyées par HelloAsso à une chaîne', () => {
		expect(toPaymentId(12345)).toBe('12345');
		expect(toPaymentId('12345')).toBe('12345');
	});
});

describe('normalizeEmail', () => {
	it('met en minuscules et retire les espaces', () => {
		expect(normalizeEmail('  Membre.Test@Example.ORG ')).toBe('membre.test@example.org');
	});

	it('rejette ce qui ne peut pas servir de clé de recherche', () => {
		expect(normalizeEmail(undefined)).toBeUndefined();
		expect(normalizeEmail('')).toBeUndefined();
		expect(normalizeEmail('   ')).toBeUndefined();
		expect(normalizeEmail('sans-arobase')).toBeUndefined();
	});
});

describe('normalizeName', () => {
	it('ramène à une même clé les graphies qui désignent la même personne', () => {
		const attendu = 'jean michel';
		expect(normalizeName('Jean-Michel')).toBe(attendu);
		expect(normalizeName('  JEAN   MICHEL ')).toBe(attendu);
		expect(normalizeName('Jean Michel')).toBe(attendu);
	});

	it('retire les accents et les apostrophes', () => {
		expect(normalizeName('Zoé')).toBe('zoe');
		expect(normalizeName("D'Amico")).toBe('d amico');
		expect(normalizeName('DUPONT')).toBe('dupont');
	});

	it('rejette ce qui ne peut pas servir de critère', () => {
		expect(normalizeName(undefined)).toBeUndefined();
		expect(normalizeName('   ')).toBeUndefined();
		expect(normalizeName('-')).toBeUndefined();
	});
});

describe('organizationAmount', () => {
	it("somme les parts revenant à l'asso et convertit les centimes en euros", () => {
		expect(
			organizationAmount({
				id: 1,
				amount: 2500,
				items: [{ shareAmount: 2000 }, { shareAmount: 500 }]
			})
		).toBe(25);
	});

	it('ignore la contribution volontaire versée à HelloAsso', () => {
		// `amount` porte 22 € débités, dont 2 € pour HelloAsso : l'asso touche 20 €.
		expect(organizationAmount({ id: 1, amount: 2200, items: [{ shareAmount: 2000 }] })).toBe(20);
	});

	it('se replie sur le montant débité quand le détail manque', () => {
		expect(organizationAmount({ id: 1, amount: 2000 })).toBe(20);
		expect(organizationAmount({ id: 1, amount: 2000, items: [] })).toBe(20);
		expect(organizationAmount({ id: 1, amount: 2000, items: [{}] })).toBe(20);
	});

	it('rend undefined quand le paiement ne porte aucun montant', () => {
		expect(organizationAmount({ id: 1 })).toBeUndefined();
	});
});

describe('helloAssoWebhookSchema', () => {
	it('accepte une enveloppe minimale', () => {
		const result = helloAssoWebhookSchema.safeParse({ eventType: 'Payment', data: { id: 1 } });
		expect(result.success).toBe(true);
	});

	it("refuse une enveloppe sans type d'évènement", () => {
		expect(helloAssoWebhookSchema.safeParse({ data: {} }).success).toBe(false);
		expect(helloAssoWebhookSchema.safeParse({ eventType: '', data: {} }).success).toBe(false);
	});

	it('tolère les champs inconnus, pour survivre aux évolutions de HelloAsso', () => {
		const result = helloAssoWebhookSchema.safeParse({
			eventType: 'Payment',
			data: { id: 1 },
			champInedit: true
		});
		expect(result.success).toBe(true);
	});
});

describe('adherentOf', () => {
	const eliott = { firstName: 'Eliott', lastName: 'Roussille' };
	const chloe = { firstName: 'Chloé', lastName: 'Bernard' };

	it("rend l'adhérent de la ligne couverte par le paiement", () => {
		const payment = { id: 1, items: [{ id: 102729, shareAmount: 2000 }] };
		const order = {
			id: 95457,
			items: [
				{ id: 999, user: chloe },
				{ id: 102729, user: eliott }
			]
		};

		expect(adherentOf(payment, order)).toEqual(eliott);
	});

	it("se rabat sur la ligne de la commande quand le paiement n'en désigne aucune", () => {
		// Le formulaire est limité à une adhésion par panier : sans id de ligne
		// exploitable, l'unique ligne de la commande est l'adhésion payée.
		const payment = { id: 1 };

		expect(adherentOf(payment, { id: 95457, items: [{ id: 102729, user: eliott }] })).toEqual(
			eliott
		);
	});

	it('rend undefined quand la commande ne porte aucune identité', () => {
		expect(adherentOf({ id: 1 }, { id: 95457, items: [{ id: 102729 }] })).toBeUndefined();
		expect(adherentOf({ id: 1 }, { id: 95457, items: [] })).toBeUndefined();
		expect(adherentOf({ id: 1 }, undefined)).toBeUndefined();
	});

	it("ignore une identité incomplète : elle n'apparie rien", () => {
		const order = { id: 95457, items: [{ id: 102729, user: { firstName: 'Eliott' } }] };

		expect(adherentOf({ id: 1 }, order)).toBeUndefined();
	});
});

describe('memberIdentity', () => {
	const payer = {
		email: 'Austin.Jonca@Example.org',
		firstName: 'Austin',
		lastName: 'Jonca'
	};

	it("retient l'identité de l'adhérent, pas celle du payeur", () => {
		const identity = memberIdentity(payer, { firstName: 'Eliott', lastName: 'Roussille' });

		expect(identity).toEqual({ email: undefined, firstName: 'Eliott', lastName: 'Roussille' });
	});

	it("garde l'email quand le payeur règle sa propre adhésion", () => {
		const identity = memberIdentity(payer, { firstName: 'austin', lastName: 'JONCA' });

		expect(identity).toEqual({
			email: 'austin.jonca@example.org',
			firstName: 'austin',
			lastName: 'JONCA'
		});
	});

	it("se rabat sur le payeur quand la commande ne dit rien de l'adhérent", () => {
		expect(memberIdentity(payer, undefined)).toEqual({
			email: 'austin.jonca@example.org',
			firstName: 'Austin',
			lastName: 'Jonca'
		});
	});

	it("écarte l'email quand le payeur est anonyme face à un adhérent nommé", () => {
		const identity = memberIdentity(
			{ email: 'tresorerie@example.org' },
			{ firstName: 'Eliott', lastName: 'Roussille' }
		);

		expect(identity.email).toBeUndefined();
	});

	it("ne rend aucun critère quand rien n'est exploitable", () => {
		expect(memberIdentity(undefined, undefined)).toEqual({
			email: undefined,
			firstName: undefined,
			lastName: undefined
		});
	});
});
