import { describe, expect, it, vi } from 'vitest';
import {
	createProcessedPayments,
	type ProcessedPaymentsApi
} from '../../src/adapters/supabase/processedPayments.js';
import { createWeiRegistry, type WeiRegistryApi } from '../../src/adapters/supabase/weiRegistry.js';
import type { SupabaseConfig } from '../../src/core/config.js';
import { TransientError } from '../../src/core/errors.js';
import { makeConfig, silentLogger } from '../helpers.js';

const config: SupabaseConfig = makeConfig().supabase;
const dbError = { code: 'PGRST301', message: 'connexion perdue' };

describe('registre des paiements traités', () => {
	function build(api: Partial<ProcessedPaymentsApi>) {
		const full: ProcessedPaymentsApi = {
			find: vi.fn(() => Promise.resolve({ row: null, error: null })),
			insert: vi.fn(() => Promise.resolve({ error: null })),
			...api
		};
		return {
			port: createProcessedPayments(config, { logger: silentLogger, api: full }),
			api: full
		};
	}

	it('rend le handler qui a traité le paiement', async () => {
		const { port } = build({
			find: vi.fn(() =>
				Promise.resolve({
					row: { handler: 'wei', processed_at: '2026-08-26T10:00:00.000Z' },
					error: null
				})
			)
		});

		expect(await port.find('1')).toEqual({
			handler: 'wei',
			processedAt: '2026-08-26T10:00:00.000Z'
		});
	});

	it('rend undefined pour un paiement inconnu', async () => {
		expect(await build({}).port.find('1')).toBeUndefined();
	});

	it('enregistre le handler et l’email du payeur', async () => {
		const { port, api } = build({});
		await port.markProcessed({ paymentId: '1', handler: 'membership', payerEmail: 'a@b.fr' });

		expect(api.insert).toHaveBeenCalledWith({
			payment_id: '1',
			handler: 'membership',
			payer_email: 'a@b.fr'
		});
	});

	it('accepte un paiement sans email de payeur', async () => {
		const { port, api } = build({});
		await port.markProcessed({ paymentId: '1', handler: 'wei', payerEmail: undefined });

		expect(api.insert).toHaveBeenCalledWith({
			payment_id: '1',
			handler: 'wei',
			payer_email: null
		});
	});

	it('traite une lecture en échec comme passagère : sans registre, pas d’idempotence', async () => {
		const { port } = build({ find: vi.fn(() => Promise.resolve({ row: null, error: dbError })) });
		await expect(port.find('1')).rejects.toBeInstanceOf(TransientError);
	});

	it('traite une écriture en échec comme passagère', async () => {
		const { port } = build({ insert: vi.fn(() => Promise.resolve({ error: dbError })) });
		await expect(
			port.markProcessed({ paymentId: '1', handler: 'wei', payerEmail: undefined })
		).rejects.toBeInstanceOf(TransientError);
	});
});

describe('registre des places du WEI', () => {
	const row = {
		item_id: '901',
		first_name: 'Lucie',
		last_name: 'Martin',
		registered_at: '2026-08-26T10:00:00.000Z'
	};

	function build(api: Partial<WeiRegistryApi> = {}) {
		const full: WeiRegistryApi = {
			insert: vi.fn(() => Promise.resolve({ error: null })),
			selectByPayment: vi.fn(() => Promise.resolve({ rows: [], error: null })),
			selectAll: vi.fn(() => Promise.resolve({ rows: [row], error: null })),
			...api
		};
		return { port: createWeiRegistry(config, { logger: silentLogger, api: full }), api: full };
	}

	it('projette les places à inscrire vers les colonnes de la table', async () => {
		const { port, api } = build();
		await port.register([
			{
				itemId: '901',
				orderId: '80001',
				paymentId: '70001',
				firstName: 'Lucie',
				lastName: 'Martin'
			}
		]);

		expect(api.insert).toHaveBeenCalledWith([
			{
				item_id: '901',
				order_id: '80001',
				payment_id: '70001',
				first_name: 'Lucie',
				last_name: 'Martin'
			}
		]);
	});

	it('écrit un payment_id nul pour une place amorcée', async () => {
		const { port, api } = build();
		await port.register([
			{ itemId: '901', orderId: '80001', paymentId: undefined, firstName: 'A', lastName: 'B' }
		]);

		expect(api.insert).toHaveBeenCalledWith([expect.objectContaining({ payment_id: null })]);
	});

	it("n'appelle pas la base pour une liste vide", async () => {
		const { port, api } = build();
		await port.register([]);
		expect(api.insert).not.toHaveBeenCalled();
	});

	it('projette les lignes lues vers le domaine', async () => {
		const { port } = build();
		expect(await port.listAll()).toEqual([
			{
				itemId: '901',
				firstName: 'Lucie',
				lastName: 'Martin',
				registeredAt: '2026-08-26T10:00:00.000Z'
			}
		]);
	});

	it('retrouve les places par paiement', async () => {
		const { port, api } = build({
			selectByPayment: vi.fn(() => Promise.resolve({ rows: [row], error: null }))
		});

		expect(await port.findByPayment('70001')).toHaveLength(1);
		expect(api.selectByPayment).toHaveBeenCalledWith('70001');
	});

	it('traite toute erreur du registre comme passagère : une inscription ne se perd pas', async () => {
		await expect(
			build({ insert: vi.fn(() => Promise.resolve({ error: dbError })) }).port.register([
				{ itemId: '1', orderId: '2', paymentId: '3', firstName: 'A', lastName: 'B' }
			])
		).rejects.toBeInstanceOf(TransientError);

		await expect(
			build({
				selectAll: vi.fn(() => Promise.resolve({ rows: null, error: dbError }))
			}).port.listAll()
		).rejects.toBeInstanceOf(TransientError);

		await expect(
			build({
				selectByPayment: vi.fn(() => Promise.resolve({ rows: null, error: dbError }))
			}).port.findByPayment('1')
		).rejects.toBeInstanceOf(TransientError);
	});
});
