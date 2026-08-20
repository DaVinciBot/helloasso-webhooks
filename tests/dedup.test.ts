import { describe, expect, it, vi } from 'vitest';
import { createDedupStore, type DbError, type DedupApi } from '../src/dedup.js';
import { TransientError } from '../src/errors.js';
import { makeConfig, silentLogger } from './helpers.js';

const supabaseConfig = makeConfig().supabase;

function fakeApi() {
	const find = vi.fn((_paymentId: string) =>
		Promise.resolve({ found: false, error: null as DbError | null })
	);
	const insert = vi.fn((_row: { payment_id: string; payer_email: string | null }) =>
		Promise.resolve({ error: null as DbError | null })
	);
	const api: DedupApi = { find, insert };

	return {
		api,
		find,
		insert,
		store: createDedupStore(supabaseConfig, { logger: silentLogger, api })
	};
}

describe('createDedupStore', () => {
	it('signale un paiement absent du store', async () => {
		const { store, find } = fakeApi();

		expect(await store.isProcessed('12345')).toBe(false);
		expect(find).toHaveBeenCalledWith('12345');
	});

	it('signale un paiement déjà présent', async () => {
		const { store, find } = fakeApi();
		find.mockResolvedValueOnce({ found: true, error: null });

		expect(await store.isProcessed('12345')).toBe(true);
	});

	it("enregistre l'email en base, ou NULL s'il est absent", async () => {
		const { store, insert } = fakeApi();

		await store.markProcessed('12345', 'a@b.fr');
		await store.markProcessed('67890', undefined);

		expect(insert).toHaveBeenNthCalledWith(1, { payment_id: '12345', payer_email: 'a@b.fr' });
		expect(insert).toHaveBeenNthCalledWith(2, { payment_id: '67890', payer_email: null });
	});

	it('traite une lecture en échec comme une panne passagère', async () => {
		// Sans le store, l'idempotence n'est plus garantie : refuser d'écrire et
		// laisser HelloAsso rejouer est le seul comportement sûr.
		const { store, find } = fakeApi();
		find.mockResolvedValueOnce({
			found: false,
			error: { code: '42P01', message: 'relation inexistante' }
		});

		await expect(store.isProcessed('12345')).rejects.toThrow(TransientError);
	});

	it('traite une écriture en échec comme une panne passagère', async () => {
		const { store, insert } = fakeApi();
		insert.mockResolvedValueOnce({ error: { code: 'PGRST301', message: 'jeton expiré' } });

		await expect(store.markProcessed('12345', 'a@b.fr')).rejects.toThrow(TransientError);
	});

	it("reporte le code d'erreur dans le message, pour le diagnostic", async () => {
		const { store, find } = fakeApi();
		find.mockResolvedValueOnce({
			found: false,
			error: { code: '42501', message: 'permission denied' }
		});

		await expect(store.isProcessed('12345')).rejects.toThrow(/42501/);
	});
});
