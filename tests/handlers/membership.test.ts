import { describe, expect, it } from 'vitest';
import { DataError } from '../../src/core/errors.js';
import { reconcile } from '../../src/core/payment.js';
import { createMembershipHandler } from '../../src/handlers/membership.js';
import type { HandlerContext } from '../../src/handlers/types.js';
import { makeAlerts, makeNotion, makeOrder, makePayment, silentLogger } from '../helpers.js';

function build(notionOptions: Parameters<typeof makeNotion>[0] = {}) {
	const notion = makeNotion(notionOptions);
	const alerts = makeAlerts();
	const handler = createMembershipHandler({
		notion: notion.port,
		selector: { formType: 'Membership', formSlug: undefined }
	});
	const context: HandlerContext = {
		logger: silentLogger,
		signal: new AbortController().signal,
		alerts: alerts.port
	};
	return { handler, context, notion, alerts };
}

const payment = reconcile(makePayment(), makeOrder());

describe('handler cotisation', () => {
	it("marque la ligne du membre et y porte le montant revenu à l'asso", async () => {
		const { handler, context, notion } = build();

		const result = await handler.handle(payment, context);

		expect(notion.markPaid).toHaveBeenCalledWith('page-1', {
			amount: 20,
			signal: context.signal
		});
		expect(result.status).toBe('handled');
	});

	it('marque toutes les lignes quand plusieurs correspondent', async () => {
		const { handler, context, notion } = build({ pages: ['page-1', 'page-2'] });

		await handler.handle(payment, context);

		expect(notion.markPaid).toHaveBeenCalledTimes(2);
	});

	it("pose l'état même sans montant exploitable", async () => {
		const { handler, context, notion } = build();

		await handler.handle(reconcile(makePayment({ amountEuros: undefined }), makeOrder()), context);

		expect(notion.markPaid).toHaveBeenCalledWith('page-1', {
			amount: undefined,
			signal: context.signal
		});
	});

	it('apparie sur le seul inscrit quand un tiers a réglé la cotisation', async () => {
		const { handler, context, notion } = build();
		const tiers = reconcile(
			makePayment({ payer: { email: 'jean@example.org', firstName: 'Jean', lastName: 'Payeur' } }),
			makeOrder()
		);

		await handler.handle(tiers, context);

		// L'email est celui du payeur : le retenir marquerait *sa* ligne.
		expect(notion.findPages).toHaveBeenCalledWith(
			{ email: undefined, firstName: 'Membre', lastName: 'Test' },
			{ signal: context.signal }
		);
	});

	it('se rabat sur le payeur quand la commande ne désigne personne', async () => {
		const { handler, context, notion } = build();

		await handler.handle(reconcile(makePayment(), undefined), context);

		expect(notion.findPages).toHaveBeenCalledWith(
			{ email: 'membre.test@example.org', firstName: 'Membre', lastName: 'Test' },
			{ signal: context.signal }
		);
	});

	it('alerte et laisse le paiement non résolu quand aucune ligne ne correspond', async () => {
		const { handler, context, alerts, notion } = build({ pages: [] });

		const result = await handler.handle(payment, context);

		expect(result).toMatchObject({ status: 'unresolved', reason: 'aucune_ligne_notion' });
		expect(alerts.notify).toHaveBeenCalledOnce();
		expect(notion.markPaid).not.toHaveBeenCalled();
	});

	it("refuse un paiement sans aucun critère d'appariement", async () => {
		const { handler, context } = build();
		const anonyme = reconcile(makePayment({ payer: undefined }), undefined);

		await expect(handler.handle(anonyme, context)).rejects.toBeInstanceOf(DataError);
	});
});
