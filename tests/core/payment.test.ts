import { describe, expect, it } from 'vitest';
import { isAcceptedState, participantsOf, reconcile } from '../../src/core/payment.js';
import { makeOrder, makePayment, makeWeiOrder, makeWeiPayment } from '../helpers.js';

describe('participantsOf', () => {
	it('apparie les lignes couvertes par le paiement', () => {
		expect(participantsOf(makeWeiPayment(), makeWeiOrder())).toEqual([
			{ itemId: '901', firstName: 'Lucie', lastName: 'Martin' },
			{ itemId: '902', firstName: 'Tom', lastName: 'Durand' }
		]);
	});

	it('ne retient que les lignes que le paiement couvre', () => {
		// Une commande de trois places réglée par un paiement qui n'en couvre
		// qu'une : la troisième n'est pas inscrite par ce paiement.
		const order = makeWeiOrder({
			items: [
				{ id: '901', person: { firstName: 'Lucie', lastName: 'Martin' } },
				{ id: '902', person: { firstName: 'Tom', lastName: 'Durand' } },
				{ id: '903', person: { firstName: 'Inès', lastName: 'Roche' } }
			]
		});

		expect(participantsOf(makeWeiPayment({ paidItemIds: ['902'] }), order)).toEqual([
			{ itemId: '902', firstName: 'Tom', lastName: 'Durand' }
		]);
	});

	it("se rabat sur toutes les lignes quand le paiement n'en désigne aucune", () => {
		expect(participantsOf(makeWeiPayment({ paidItemIds: [] }), makeWeiOrder())).toHaveLength(2);
	});

	it("écarte les lignes sans identifiant ou à l'identité incomplète", () => {
		const order = makeWeiOrder({
			items: [
				{ id: undefined, person: { firstName: 'Sans', lastName: 'Id' } },
				{ id: '902', person: { firstName: 'Tom' } },
				{ id: '903', person: undefined },
				{ id: '904', person: { firstName: '  ', lastName: 'Vide' } },
				{ id: '905', person: { firstName: 'Inès', lastName: 'Roche' } }
			]
		});

		expect(participantsOf(makeWeiPayment({ paidItemIds: [] }), order)).toEqual([
			{ itemId: '905', firstName: 'Inès', lastName: 'Roche' }
		]);
	});

	it('rend une liste vide sans commande', () => {
		expect(participantsOf(makePayment(), undefined)).toEqual([]);
	});
});

describe('reconcile', () => {
	it('joint le paiement à sa commande sans exposer les lignes payées', () => {
		const reconciled = reconcile(makePayment(), makeOrder());

		expect(reconciled.participants).toEqual([
			{ itemId: '55501', firstName: 'Membre', lastName: 'Test' }
		]);
		expect(reconciled).not.toHaveProperty('paidItemIds');
		expect(reconciled.amountEuros).toBe(20);
	});
});

describe('isAcceptedState', () => {
	const accepted = ['Authorized', 'Processed'];

	it('accepte quel que soit la casse', () => {
		expect(isAcceptedState('authorized', accepted)).toBe(true);
		expect(isAcceptedState('PROCESSED', accepted)).toBe(true);
	});

	it('refuse un statut absent de la liste ou inconnu', () => {
		expect(isAcceptedState('Refused', accepted)).toBe(false);
		expect(isAcceptedState(undefined, accepted)).toBe(false);
	});
});
