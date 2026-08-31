import { describe, expect, it } from 'vitest';
import type { Registration } from '../../src/adapters/supabase/weiRegistry.js';
import { DataError } from '../../src/core/errors.js';
import { reconcile } from '../../src/core/payment.js';
import type { HandlerContext } from '../../src/handlers/types.js';
import { buildAnnouncement, createWeiHandler, joinNames } from '../../src/handlers/wei.js';
import {
	WEI_SLUG,
	makeAlerts,
	makeAnnouncer,
	makeRegistration,
	makeRegistry,
	makeWeiOrder,
	makeWeiPayment,
	silentLogger
} from '../helpers.js';

function build(options: { seeded?: readonly Registration[]; capacity?: number } = {}) {
	const registry = makeRegistry(options.seeded ?? []);
	const announcer = makeAnnouncer();
	const alerts = makeAlerts();

	const handler = createWeiHandler({
		registry: registry.port,
		announcer: announcer.port,
		selector: { formType: 'Event', formSlug: WEI_SLUG },
		capacity: options.capacity
	});

	const context: HandlerContext = {
		logger: silentLogger,
		signal: new AbortController().signal,
		alerts: alerts.port
	};

	return { handler, context, registry, announcer, alerts };
}

const weiPayment = reconcile(makeWeiPayment(), makeWeiOrder());

describe('handler WEI', () => {
	it('inscrit toutes les places de la commande, pas seulement celle du payeur', async () => {
		const { handler, context, registry } = build();

		const result = await handler.handle(weiPayment, context);

		expect(registry.register).toHaveBeenCalledWith([
			{
				itemId: '901',
				orderId: '80001',
				paymentId: '70001',
				firstName: 'Lucie',
				lastName: 'Martin'
			},
			{
				itemId: '902',
				orderId: '80001',
				paymentId: '70001',
				firstName: 'Tom',
				lastName: 'Durand'
			}
		]);
		expect(result).toMatchObject({ status: 'handled' });
	});

	it('annonce les arrivants et la liste complète', async () => {
		const { handler, context, announcer } = build({
			seeded: [makeRegistration({ itemId: '800', firstName: 'Inès', lastName: 'Roche' })]
		});

		await handler.handle(weiPayment, context);

		const announcement = announcer.announce.mock.calls[0]?.[0];
		expect(announcement?.title).toContain('Lucie Martin et Tom Durand');
		expect(announcement?.title).toContain('viennent de prendre leur place');
		// La liste complète comprend l'inscrite antérieure.
		expect(announcement?.lines).toHaveLength(3);
		expect(announcement?.lines[0]).toBe('1. Inès Roche');
		expect(announcement?.lines[1]).toContain('Lucie Martin');
	});

	it("n'annonce rien sur une échéance suivante d'un paiement échelonné", async () => {
		// La 2e échéance porte un autre payment_id mais les mêmes lignes de
		// commande : elles sont déjà au registre, donc aucun arrivant.
		const { handler, context, announcer, registry } = build();

		await handler.handle(weiPayment, context);
		announcer.announce.mockClear();

		const echeance = reconcile(makeWeiPayment({ id: '70002' }), makeWeiOrder());
		const result = await handler.handle(echeance, context);

		expect(announcer.announce).not.toHaveBeenCalled();
		expect(result).toMatchObject({ status: 'handled', summary: { arrivants: 0 } });
		expect(registry.rows.size).toBe(2);
	});

	it("n'inscrit pas deux fois la même place sur un rejeu", async () => {
		const { handler, context, registry } = build();

		await handler.handle(weiPayment, context);
		await handler.handle(weiPayment, context);

		expect(registry.rows.size).toBe(2);
	});

	it('annonce quand même après une reprise : les arrivants sont relus du registre', async () => {
		// Process mort entre l'inscription et le marquage : au rejeu, le handler
		// retrouve ses propres lignes et annonce.
		const { handler, context, registry, announcer } = build();
		await registry.port.register(
			weiPayment.participants.map((participant) => ({
				itemId: participant.itemId,
				orderId: '80001',
				paymentId: '70001',
				firstName: participant.firstName,
				lastName: participant.lastName
			}))
		);

		await handler.handle(weiPayment, context);

		expect(announcer.announce).toHaveBeenCalledOnce();
	});

	it('refuse une commande sans participant identifiable', async () => {
		const { handler, context, registry } = build();
		const sansInscrit = reconcile(makeWeiPayment(), makeWeiOrder({ items: [] }));

		await expect(handler.handle(sansInscrit, context)).rejects.toBeInstanceOf(DataError);
		expect(registry.register).not.toHaveBeenCalled();
	});

	it('refuse un paiement sans référence de commande', async () => {
		const { handler, context } = build();
		const sansCommande = reconcile(makeWeiPayment({ orderId: undefined }), makeWeiOrder());

		await expect(handler.handle(sansCommande, context)).rejects.toBeInstanceOf(DataError);
	});
});

describe('joinNames', () => {
	it('énumère sans virgule avant le dernier', () => {
		expect(joinNames([])).toBe('');
		expect(joinNames(['Lucie'])).toBe('Lucie');
		expect(joinNames(['Lucie', 'Tom'])).toBe('Lucie et Tom');
		expect(joinNames(['Lucie', 'Tom', 'Inès'])).toBe('Lucie, Tom et Inès');
	});
});

describe('buildAnnouncement', () => {
	const lucie = makeRegistration();
	const tom = makeRegistration({ itemId: '902', firstName: 'Tom', lastName: 'Durand' });

	it('accorde le titre au singulier', () => {
		const announcement = buildAnnouncement([lucie], [lucie], undefined);
		expect(announcement.title).toContain('vient de prendre sa place');
	});

	it('accorde le titre au pluriel', () => {
		const announcement = buildAnnouncement([lucie, tom], [lucie, tom], undefined);
		expect(announcement.title).toContain('viennent de prendre leur place');
	});

	it('affiche le seul total quand la capacité est inconnue', () => {
		expect(buildAnnouncement([lucie], [lucie, tom], undefined).headline).toContain('2 inscrits');
	});

	it('affiche la jauge quand la capacité est connue', () => {
		const announcement = buildAnnouncement([lucie], [lucie, tom], 60);
		expect(announcement.headline).toContain('2 / 60 places');
		expect(announcement.footer).toBe('Il reste 58 places.');
	});

	it('annonce le complet', () => {
		expect(buildAnnouncement([lucie], [lucie, tom], 2).footer).toBe('Le WEI est complet.');
	});

	it('met les arrivants en gras dans la liste', () => {
		const announcement = buildAnnouncement([tom], [lucie, tom], undefined);
		expect(announcement.lines[0]).toBe('1. Lucie Martin');
		expect(announcement.lines[1]).toBe('**2. Tom Durand**');
	});
});
