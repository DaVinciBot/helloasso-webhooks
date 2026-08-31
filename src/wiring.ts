import type { Logger } from 'pino';
import { createAnnouncer, type AlertPort } from './adapters/discord.js';
import { createNotionClient } from './adapters/notion.js';
import { createWeiRegistry } from './adapters/supabase/weiRegistry.js';
import type { Config } from './core/config.js';
import { createMembershipHandler } from './handlers/membership.js';
import type { PaymentHandler } from './handlers/types.js';
import { createWeiHandler } from './handlers/wei.js';

/**
 * Le point où la configuration devient des handlers.
 *
 * C'est le seul endroit du service qui connaisse la liste des usages. Ajouter un
 * flux tient en trois lignes ici, plus le fichier du handler ; le pipeline, le
 * routeur et la couche HTTP n'en savent rien et n'ont pas à changer.
 *
 * Un bloc de configuration absent ne produit pas de handler : le service ne
 * câble que ce qu'on lui a demandé, et ne réclame donc pas les secrets d'un flux
 * qu'on n'utilise pas.
 */

export interface WiringDeps {
	readonly logger: Logger;
	readonly alerts: AlertPort;
}

export function buildHandlers(config: Config, deps: WiringDeps): readonly PaymentHandler[] {
	const handlers: PaymentHandler[] = [];

	if (config.membership !== undefined) {
		handlers.push(
			createMembershipHandler({
				selector: config.membership.selector,
				notion: createNotionClient(config.membership.notion, {
					logger: deps.logger,
					timeoutMs: config.httpTimeoutMs
				})
			})
		);
	}

	if (config.wei !== undefined) {
		handlers.push(
			createWeiHandler({
				selector: config.wei.campaign,
				capacity: config.wei.capacity,
				registry: createWeiRegistry(config.supabase, { logger: deps.logger }),
				announcer: createAnnouncer(config.wei.discordWebhookUrl, {
					logger: deps.logger,
					timeoutMs: config.httpTimeoutMs,
					alerts: deps.alerts
				})
			})
		);
	}

	return handlers;
}
