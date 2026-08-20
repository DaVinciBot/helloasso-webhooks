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
