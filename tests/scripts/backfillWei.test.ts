import { describe, expect, it } from 'vitest';
import { normalizeName } from '../../src/core/identity.js';
import { toRegistrations } from '../../src/scripts/backfillWei.js';
import { makeFormItem } from '../helpers.js';

const isUsableName = (name: string | undefined): boolean => normalizeName(name) !== undefined;

function convert(items: Parameters<typeof toRegistrations>[0]) {
	return toRegistrations(items, isUsableName);
}

describe('toRegistrations', () => {
	it('convertit un article vendu en place, sans identifiant de paiement', () => {
		// Le `payment_id` nul est ce qui empêche ces places d'être comptées parmi
		// les arrivants d'une annonce future.
		const { registrations } = convert([makeFormItem()]);

		expect(registrations).toEqual([
			{
				itemId: '901',
				orderId: '80001',
				paymentId: undefined,
				firstName: 'Lucie',
				lastName: 'Martin'
			}
		]);
	});

	it('accepte un article sans état renseigné', () => {
		expect(convert([makeFormItem({ state: undefined })]).registrations).toHaveLength(1);
	});

	it('écarte les articles annulés', () => {
		const { registrations, skipped } = convert([makeFormItem({ state: 'Canceled' })]);

		expect(registrations).toHaveLength(0);
		expect(skipped[0]).toContain('Canceled');
	});

	it("écarte les articles à l'identité ou à la commande incomplète", () => {
		const { registrations, skipped } = convert([
			makeFormItem({ id: '1', firstName: undefined }),
			makeFormItem({ id: '2', lastName: '   ' }),
			makeFormItem({ id: '3', orderId: undefined }),
			makeFormItem({ id: '4' })
		]);

		expect(registrations.map((row) => row.itemId)).toEqual(['4']);
		expect(skipped).toHaveLength(3);
	});
});
