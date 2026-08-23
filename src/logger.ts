import { pino, type Logger } from 'pino';

export type { Logger };

/**
 * Le logger est construit avant `config.ts` : si la validation de
 * `process.env` échoue, il faut pouvoir logger l'échec proprement. Il lit donc
 * `LOG_LEVEL` directement, avec une valeur de repli sûre.
 */
const level = process.env.LOG_LEVEL ?? 'info';

export const logger: Logger = pino({
	level,
	base: { service: 'helloasso-notion-webhook' },
	timestamp: pino.stdTimeFunctions.isoTime,
	formatters: {
		level: (label) => ({ level: label })
	},
	// Ceinture et bretelles : même si un secret finissait dans un objet loggé,
	// il ne sortirait pas en clair.
	redact: {
		paths: [
			'clientSecret',
			'client_secret',
			'access_token',
			'token',
			'authorization',
			'*.authorization',
			'headers.authorization',
			'webhookSecret',
			'serviceRoleKey',
			'notionToken'
		],
		censor: '[redacted]'
	}
});

/** Au-delà, un corps brut rendrait la ligne de journal illisible. */
const MAX_LOGGED_BODY_CHARS = 32 * 1024;

/**
 * Prépare un corps brut pour les journaux de debug : rendu tel quel, tronqué
 * seulement s'il est aberrant. Ces traces servent à comparer octet pour octet ce
 * que HelloAsso envoie et ce que le service en comprend, donc on ne reformate
 * rien ; la troncature annonce explicitement la taille réelle.
 */
export function forLog(raw: string, maxChars: number = MAX_LOGGED_BODY_CHARS): string {
	if (raw.length <= maxChars) {
		return raw;
	}
	return `${raw.slice(0, maxChars)}... [tronqué, ${String(raw.length)} caractères au total]`;
}
