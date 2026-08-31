import { describe, expect, it } from 'vitest';
import { buildHandlers } from '../src/wiring.js';
import { makeAlerts, makeConfig, silentLogger } from './helpers.js';

/**
 * Le câblage est le seul endroit qui connaisse la liste des usages : ce qu'on
 * vérifie ici, c'est qu'un bloc de configuration absent ne produit pas de
 * handler — donc que le service ne réclame pas les secrets d'un flux qu'on
 * n'utilise pas.
 */
function build(config: Parameters<typeof buildHandlers>[0]) {
	return buildHandlers(config, { logger: silentLogger, alerts: makeAlerts().port }).map(
		(handler) => handler.name
	);
}

describe('buildHandlers', () => {
	it('câble les deux handlers quand les deux blocs sont là', () => {
		expect(build(makeConfig())).toEqual(['membership', 'wei']);
	});

	it('ne câble que la cotisation sans bloc WEI', () => {
		expect(build(makeConfig({ wei: undefined }))).toEqual(['membership']);
	});

	it('ne câble que le WEI sans bloc Notion', () => {
		expect(build(makeConfig({ membership: undefined }))).toEqual(['wei']);
	});

	it('reporte le sélecteur de chaque bloc sur son handler', () => {
		const handlers = buildHandlers(makeConfig(), {
			logger: silentLogger,
			alerts: makeAlerts().port
		});

		expect(handlers.find((handler) => handler.name === 'wei')?.selector).toEqual({
			formType: 'Event',
			formSlug: 'wei-2026'
		});
	});
});
