import type { Logger } from 'pino';
import { describeError } from '../core/errors.js';
import type { FetchLike } from './helloasso.js';

/**
 * Adaptateur Discord.
 *
 * Deux natures de message y passent, et une seule mécanique d'envoi :
 *
 * - l'**alerte**, quand le service a fait son travail mais que la *donnée* est
 *   fautive — un membre a payé et aucune ligne Notion ne porte son nom. Le
 *   service ne peut rien y faire ; un humain, si.
 * - l'**annonce**, quand l'état d'une campagne vient de changer et que l'équipe
 *   qui la gère doit le voir — une place de WEI prise.
 *
 * Règle absolue, commune aux deux : un message qui échoue ne doit jamais faire
 * échouer le traitement du paiement. Toutes les erreurs sont avalées et loguées.
 * Un paiement encaissé et non répercuté serait un incident ; un message Discord
 * perdu est un désagrément.
 *
 * L'adaptateur porte les contraintes de Discord — limites de taille, absence de
 * mention déclenchable, couleurs — et rien du métier. Les mots viennent des
 * handlers.
 */

/** Signalement d'incident : rouge, champs nommés. */
export interface Alert {
	readonly title: string;
	readonly fields: Readonly<Record<string, string | number | undefined>>;
}

export interface AlertPort {
	notify(alert: Alert): Promise<void>;
}

/** Nouvelle réjouissante : vert, un titre et un corps en lignes. */
export interface Announcement {
	readonly title: string;
	/** En-tête du corps, avant la liste. */
	readonly headline: string;
	/** Lignes de la liste. Tronquées par l'adaptateur si l'embed déborde. */
	readonly lines: readonly string[];
	readonly footer: string | undefined;
}

export interface AnnouncePort {
	announce(announcement: Announcement): Promise<void>;
}

// Rouge des signalements « bug » de cash (edge function report-to-discord) :
// les alertes se lisent dans le même Discord, elles en gardent la couleur.
const ALERT_COLOR = 0xef4444;

/** Vert : ce qui va bien ne doit pas ressembler à ce qui va mal. */
const ANNOUNCE_COLOR = 0x22c55e;

/**
 * Limites de l'API Discord, avec une marge. Un embed refusé pour dépassement
 * serait perdu en silence, et c'est précisément ce qu'on ne veut pas d'une liste
 * qui grossit à chaque inscription.
 */
const MAX_TITLE_CHARS = 256;
const MAX_FIELD_NAME_CHARS = 256;
const MAX_FIELD_VALUE_CHARS = 1024;
const MAX_FIELDS = 25;
const MAX_DESCRIPTION_CHARS = 3900;

/**
 * Embed d'alerte. Les valeurs viennent de messages d'erreur et de données
 * membres : troncature défensive, et aucune mention déclenchable depuis leur
 * contenu. Fonction pure.
 */
export function formatAlertEmbed(alert: Alert): Record<string, unknown> {
	return {
		title: `⚠️ ${alert.title}`.slice(0, MAX_TITLE_CHARS),
		color: ALERT_COLOR,
		timestamp: new Date().toISOString(),
		// Un champ `undefined` n'apprend rien à un humain : il n'est pas rendu.
		fields: Object.entries(alert.fields)
			.filter((entry): entry is [string, string | number] => entry[1] !== undefined)
			.slice(0, MAX_FIELDS)
			.map(([key, value]) => ({
				name: key.slice(0, MAX_FIELD_NAME_CHARS),
				value: String(value).slice(0, MAX_FIELD_VALUE_CHARS),
				inline: false
			}))
	};
}

/**
 * Assemble le corps d'une annonce sans dépasser la limite de Discord.
 *
 * La liste des inscrits grossit à chaque place vendue : elle finira par ne plus
 * tenir. Plutôt que de laisser Discord refuser l'embed — donc de perdre
 * l'annonce entière le jour où elle devient intéressante — on tronque en
 * annonçant ce qu'on tronque. Fonction pure.
 */
export function formatBody(headline: string, lines: readonly string[]): string {
	const parts: string[] = [];
	let used = headline.length + 1;

	for (const [index, line] of lines.entries()) {
		const remaining = lines.length - index;
		// Ce qu'il faudrait pour annoncer la troncature si on s'arrêtait ici.
		const ellipsis = `… et ${String(remaining)} autres`;

		if (used + line.length + 1 + ellipsis.length > MAX_DESCRIPTION_CHARS) {
			parts.push(ellipsis);
			break;
		}

		parts.push(line);
		used += line.length + 1;
	}

	return [headline, '', ...parts].join('\n');
}

/** Embed d'annonce. Fonction pure. */
export function formatAnnouncementEmbed(announcement: Announcement): Record<string, unknown> {
	return {
		title: announcement.title.slice(0, MAX_TITLE_CHARS),
		description: formatBody(announcement.headline, announcement.lines),
		color: ANNOUNCE_COLOR,
		timestamp: new Date().toISOString(),
		...(announcement.footer === undefined
			? {}
			: { footer: { text: announcement.footer.slice(0, MAX_FIELD_VALUE_CHARS) } })
	};
}

export interface DiscordDeps {
	readonly logger: Logger;
	readonly timeoutMs: number;
	readonly fetch?: FetchLike;
}

/**
 * Poste un embed. Ne lève jamais : c'est le contrat de tout ce module.
 *
 * @returns `true` si Discord a accepté le message.
 */
async function postEmbed(
	webhookUrl: string,
	embed: Record<string, unknown>,
	label: string,
	deps: DiscordDeps & { readonly logger: Logger }
): Promise<boolean> {
	const doFetch: FetchLike = deps.fetch ?? globalThis.fetch;

	try {
		const response = await doFetch(webhookUrl, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				embeds: [embed],
				// Aucune mention déclenchable : le contenu vient de données saisies
				// par des tiers, un « @everyone » dans un nom ne doit pas sonner.
				allowed_mentions: { parse: [] }
			}),
			signal: AbortSignal.timeout(deps.timeoutMs)
		});

		if (!response.ok) {
			deps.logger.error({ status: response.status, message: label }, 'envoi Discord refusé');
			return false;
		}

		return true;
	} catch (error) {
		deps.logger.error({ err: describeError(error), message: label }, 'envoi Discord en échec');
		return false;
	}
}

/**
 * Alerteur no-op : utilisé quand aucun webhook d'alerte n'est configuré. Le
 * reste du code n'a ainsi jamais à tester la présence d'un alerteur.
 */
export function createNoopAlerter(logger: Logger): AlertPort {
	return {
		notify(alert): Promise<void> {
			logger.warn({ alert: alert.title, ...alert.fields }, 'alerte (webhook non configuré)');
			return Promise.resolve();
		}
	};
}

export function createAlerter(webhookUrl: string | undefined, deps: DiscordDeps): AlertPort {
	const logger = deps.logger.child({ component: 'discord', canal: 'alertes' });

	if (webhookUrl === undefined) {
		return createNoopAlerter(logger);
	}

	return {
		async notify(alert): Promise<void> {
			const sent = await postEmbed(webhookUrl, formatAlertEmbed(alert), alert.title, {
				...deps,
				logger
			});
			if (sent) {
				logger.info({ alert: alert.title, ...alert.fields }, 'alerte envoyée');
			}
		}
	};
}

/**
 * Annonceur.
 *
 * Contrairement à l'alerteur, il n'a pas de variante no-op : un handler qui
 * annonce n'existe que si son webhook est configuré, la configuration le
 * garantit. Un échec d'envoi est signalé à l'alerteur — perdre une annonce est
 * acceptable, ne pas savoir qu'on l'a perdue ne l'est pas.
 */
export function createAnnouncer(
	webhookUrl: string,
	deps: DiscordDeps & { readonly alerts: AlertPort }
): AnnouncePort {
	const logger = deps.logger.child({ component: 'discord', canal: 'annonces' });

	return {
		async announce(announcement): Promise<void> {
			const sent = await postEmbed(
				webhookUrl,
				formatAnnouncementEmbed(announcement),
				announcement.title,
				{ ...deps, logger }
			);

			if (sent) {
				logger.info({ annonce: announcement.title }, 'annonce envoyée');
				return;
			}

			await deps.alerts.notify({
				title: 'Annonce Discord non délivrée',
				fields: {
					annonce: announcement.title,
					détail: announcement.headline,
					action: "vérifier le webhook d'annonce et republier la nouvelle à la main"
				}
			});
		}
	};
}
