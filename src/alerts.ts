import { describeError } from './errors.js';
import type { FetchLike } from './helloasso.js';
import type { Logger } from './logger.js';

/**
 * Alerte humaine sur webhook Discord.
 *
 * Sert les cas où le service a fait son travail mais où la *donnée* est
 * fautive : un membre a payé et aucune ligne Notion ne porte son email. Le
 * service ne peut rien y faire ; un humain, si.
 *
 * Règle absolue : une alerte qui échoue ne doit jamais faire échouer le
 * traitement du paiement. Toutes les erreurs sont avalées et loguées.
 */

export interface Alert {
	readonly title: string;
	readonly fields: Readonly<Record<string, string | number | undefined>>;
}

export interface AlertPort {
	notify(alert: Alert): Promise<void>;
}

export interface AlerterDeps {
	readonly logger: Logger;
	readonly timeoutMs: number;
	readonly fetch?: FetchLike;
}

// Rouge des signalements « bug » de cash (edge function report-to-discord) :
// les alertes se lisent dans le même Discord, elles en gardent la couleur.
const ALERT_COLOR = 0xef4444;

/**
 * Embed Discord. Les valeurs viennent de messages d'erreur et de données
 * membres : troncature défensive aux limites de l'API, et aucune mention
 * déclenchable depuis leur contenu.
 */
export function formatEmbed(alert: Alert): Record<string, unknown> {
	return {
		title: `⚠️ ${alert.title}`.slice(0, 256),
		color: ALERT_COLOR,
		timestamp: new Date().toISOString(),
		// Un champ `undefined` n'apprend rien à un humain : il n'est pas rendu.
		fields: Object.entries(alert.fields)
			.filter((entry): entry is [string, string | number] => entry[1] !== undefined)
			.slice(0, 25)
			.map(([key, value]) => ({
				name: key.slice(0, 256),
				value: String(value).slice(0, 1024),
				inline: false
			}))
	};
}

/**
 * Alerteur no-op : utilisé quand `ALERT_WEBHOOK_URL` n'est pas défini. Le reste
 * du code n'a ainsi jamais à tester la présence d'un alerteur.
 */
export function createNoopAlerter(logger: Logger): AlertPort {
	return {
		notify(alert): Promise<void> {
			logger.warn({ alert: alert.title, ...alert.fields }, 'alerte (webhook non configuré)');
			return Promise.resolve();
		}
	};
}

export function createAlerter(webhookUrl: string | undefined, deps: AlerterDeps): AlertPort {
	const logger = deps.logger.child({ component: 'alerts' });

	if (webhookUrl === undefined) {
		return createNoopAlerter(logger);
	}

	const doFetch: FetchLike = deps.fetch ?? globalThis.fetch;

	return {
		async notify(alert): Promise<void> {
			try {
				const response = await doFetch(webhookUrl, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({
						embeds: [formatEmbed(alert)],
						allowed_mentions: { parse: [] }
					}),
					signal: AbortSignal.timeout(deps.timeoutMs)
				});

				if (!response.ok) {
					logger.error({ status: response.status, alert: alert.title }, "envoi de l'alerte refusé");
					return;
				}

				logger.info({ alert: alert.title, ...alert.fields }, 'alerte envoyée');
			} catch (error) {
				logger.error(
					{ err: describeError(error), alert: alert.title },
					"envoi de l'alerte en échec"
				);
			}
		}
	};
}
