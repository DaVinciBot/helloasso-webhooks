import { describe, expect, it } from 'vitest';
import { helloAssoWebhookSchema, normalizeEmail, toPaymentId } from '../src/schema.js';

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
