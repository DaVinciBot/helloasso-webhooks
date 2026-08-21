import { z } from 'zod';
import { ConfigError } from './errors.js';

/**
 * Validation de `process.env` au démarrage, fail-fast.
 *
 * Aucune valeur métier n'est codée en dur : noms de propriétés Notion, slug
 * HelloAsso, sous-domaine et secrets viennent tous de l'environnement.
 */

/** Accepte une URL http(s) absolue, sans dépendre d'une API spécifique à une version de Zod. */
const httpUrl = (): z.ZodString =>
	z.string().refine(
		(value) => {
			try {
				const url = new URL(value);
				return url.protocol === 'http:' || url.protocol === 'https:';
			} catch {
				return false;
			}
		},
		{ message: 'doit être une URL http(s) absolue' }
	);

const logLevels = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

/**
 * Types de propriété Notion utilisables comme colonne email. Le filtre de
 * `dataSources.query` n'a pas la même forme selon le type, d'où le besoin de le
 * connaître explicitement plutôt que de le deviner.
 */
export const emailPropertyTypes = ['email', 'rich_text', 'title'] as const;
export type EmailPropertyType = (typeof emailPropertyTypes)[number];

/**
 * Première version de l'API Notion où une base est un contenant de *sources de
 * données*, seules interrogeables. Le service ne connaît que ce modèle : une
 * version antérieure ferait échouer chaque recherche sur un `validation_error`,
 * autant la refuser au démarrage. Les versions sont des dates ISO, l'ordre
 * lexicographique est donc l'ordre chronologique.
 */
const MIN_NOTION_VERSION = '2025-09-03';

const envSchema = z.object({
	NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
	PORT: z.coerce.number().int().min(1).max(65535).default(3000),
	LOG_LEVEL: z.enum(logLevels).default('info'),

	// Seule barrière d'authentification du webhook : les comptes association
	// HelloAsso ne signent pas leurs notifications (pas de HMAC). On impose donc
	// une longueur qui rend l'URL non devinable.
	WEBHOOK_SECRET: z.string().min(24, "doit faire au moins 24 caractères (secret dans l'URL)"),

	HELLOASSO_CLIENT_ID: z.string().min(1),
	HELLOASSO_CLIENT_SECRET: z.string().min(1),
	HELLOASSO_ORG_SLUG: z.string().min(1),
	HELLOASSO_API_BASE: httpUrl().default('https://api.helloasso.com/v5'),
	HELLOASSO_TOKEN_URL: httpUrl().default('https://api.helloasso.com/oauth2/token'),
	HELLOASSO_ACCEPTED_STATES: z.string().min(1).default('Authorized,Processed'),
	HELLOASSO_FORM_SLUG: z.string().min(1).optional(),
	HELLOASSO_FORM_TYPE: z.string().min(1).optional(),

	NOTION_TOKEN: z.string().min(1),
	NOTION_DATA_SOURCE_ID: z.string().min(1),
	NOTION_VERSION: z
		.string()
		.min(1)
		.refine((value) => value >= MIN_NOTION_VERSION, {
			message: `doit valoir au moins ${MIN_NOTION_VERSION} : les sources de données n'existent pas avant`
		})
		.default(MIN_NOTION_VERSION),
	NOTION_EMAIL_PROPERTY: z.string().min(1),
	NOTION_EMAIL_PROPERTY_TYPE: z.enum(emailPropertyTypes).default('email'),
	NOTION_PAID_PROPERTY: z.string().min(1),
	NOTION_PAID_STATUS: z.string().min(1),

	NOTION_FIRST_NAME_PROPERTY: z.string().min(1).optional(),
	NOTION_LAST_NAME_PROPERTY: z.string().min(1).optional(),

	SUPABASE_URL: httpUrl(),
	SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),

	ALERT_WEBHOOK_URL: httpUrl().optional(),

	HTTP_TIMEOUT_MS: z.coerce.number().int().min(1000).max(30_000).default(8_000),
	PROCESS_TIMEOUT_MS: z.coerce.number().int().min(1000).max(30_000).default(12_000)
});

export interface HelloAssoConfig {
	readonly clientId: string;
	readonly clientSecret: string;
	readonly orgSlug: string;
	readonly apiBase: string;
	readonly tokenUrl: string;
	readonly acceptedStates: readonly string[];
	readonly formSlug: string | undefined;
	readonly formType: string | undefined;
}

/**
 * Colonnes d'identité du repli. Les deux ensemble ou aucune : apparier sur le
 * seul nom de famille marquerait la mauvaise ligne dans une fratrie.
 */
export interface NameProperties {
	readonly firstName: string;
	readonly lastName: string;
}

export interface NotionConfig {
	readonly token: string;
	readonly dataSourceId: string;
	readonly version: string;
	readonly emailProperty: string;
	readonly emailPropertyType: EmailPropertyType;
	readonly paidProperty: string;
	/** Option de l'état, à l'identique du libellé Notion. */
	readonly paidStatus: string;
	readonly nameProperties: NameProperties | undefined;
}

export interface SupabaseConfig {
	readonly url: string;
	readonly serviceRoleKey: string;
}

export interface Config {
	readonly nodeEnv: 'development' | 'test' | 'production';
	readonly port: number;
	readonly logLevel: (typeof logLevels)[number];
	readonly webhookSecret: string;
	readonly helloasso: HelloAssoConfig;
	readonly notion: NotionConfig;
	readonly supabase: SupabaseConfig;
	readonly alertWebhookUrl: string | undefined;
	readonly httpTimeoutMs: number;
	readonly processTimeoutMs: number;
}

/**
 * Dans un fichier `.env`, une variable laissée vide (`FOO=`) arrive comme
 * chaîne vide et non comme `undefined` : sans ce nettoyage, elle écraserait la
 * valeur par défaut du schéma au lieu de l'activer.
 */
function withoutEmptyValues(source: NodeJS.ProcessEnv): Record<string, string> {
	const cleaned: Record<string, string> = {};
	for (const [key, value] of Object.entries(source)) {
		if (typeof value === 'string' && value.trim() !== '') {
			cleaned[key] = value;
		}
	}
	return cleaned;
}

function stripTrailingSlash(value: string): string {
	return value.endsWith('/') ? value.slice(0, -1) : value;
}

/**
 * Une seule des deux colonnes d'identité renseignée est une erreur de
 * configuration : le repli ne peut pas apparier sur un demi-critère, et le
 * désactiver en silence donnerait un service qui ne fait pas ce qu'on croit.
 */
function readNameProperties(env: {
	NOTION_FIRST_NAME_PROPERTY?: string | undefined;
	NOTION_LAST_NAME_PROPERTY?: string | undefined;
}): NameProperties | undefined {
	const firstName = env.NOTION_FIRST_NAME_PROPERTY;
	const lastName = env.NOTION_LAST_NAME_PROPERTY;

	if (firstName === undefined && lastName === undefined) {
		return undefined;
	}
	if (firstName === undefined || lastName === undefined) {
		throw new ConfigError(
			'Configuration invalide :\n  - NOTION_FIRST_NAME_PROPERTY et NOTION_LAST_NAME_PROPERTY : les deux ou aucune'
		);
	}
	return { firstName, lastName };
}

function parseAcceptedStates(value: string): readonly string[] {
	return value
		.split(',')
		.map((state) => state.trim())
		.filter((state) => state !== '');
}

/**
 * Valide l'environnement et le projette en configuration structurée.
 *
 * @throws {ConfigError} si une variable manque ou est invalide — le message
 * liste *toutes* les variables fautives, pour éviter le cycle
 * « corriger, redémarrer, découvrir la suivante ».
 */
export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
	const result = envSchema.safeParse(withoutEmptyValues(source));

	if (!result.success) {
		const details = result.error.issues
			.map((issue) => `  - ${issue.path.join('.') || '(racine)'} : ${issue.message}`)
			.join('\n');
		throw new ConfigError(`Configuration invalide :\n${details}`);
	}

	const env = result.data;
	const acceptedStates = parseAcceptedStates(env.HELLOASSO_ACCEPTED_STATES);

	if (acceptedStates.length === 0) {
		throw new ConfigError(
			'Configuration invalide :\n  - HELLOASSO_ACCEPTED_STATES : au moins un statut est requis'
		);
	}

	const nameProperties = readNameProperties(env);

	return {
		nodeEnv: env.NODE_ENV,
		port: env.PORT,
		logLevel: env.LOG_LEVEL,
		webhookSecret: env.WEBHOOK_SECRET,
		helloasso: {
			clientId: env.HELLOASSO_CLIENT_ID,
			clientSecret: env.HELLOASSO_CLIENT_SECRET,
			orgSlug: env.HELLOASSO_ORG_SLUG,
			apiBase: stripTrailingSlash(env.HELLOASSO_API_BASE),
			tokenUrl: env.HELLOASSO_TOKEN_URL,
			acceptedStates,
			formSlug: env.HELLOASSO_FORM_SLUG,
			formType: env.HELLOASSO_FORM_TYPE
		},
		notion: {
			token: env.NOTION_TOKEN,
			dataSourceId: env.NOTION_DATA_SOURCE_ID,
			version: env.NOTION_VERSION,
			emailProperty: env.NOTION_EMAIL_PROPERTY,
			emailPropertyType: env.NOTION_EMAIL_PROPERTY_TYPE,
			paidProperty: env.NOTION_PAID_PROPERTY,
			paidStatus: env.NOTION_PAID_STATUS,
			nameProperties
		},
		supabase: {
			url: env.SUPABASE_URL,
			serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY
		},
		alertWebhookUrl: env.ALERT_WEBHOOK_URL,
		httpTimeoutMs: env.HTTP_TIMEOUT_MS,
		processTimeoutMs: env.PROCESS_TIMEOUT_MS
	};
}

/** Résumé loggable au boot : uniquement des valeurs non sensibles. */
export function describeConfig(config: Config): Record<string, unknown> {
	return {
		nodeEnv: config.nodeEnv,
		port: config.port,
		logLevel: config.logLevel,
		helloasso: {
			orgSlug: config.helloasso.orgSlug,
			apiBase: config.helloasso.apiBase,
			acceptedStates: config.helloasso.acceptedStates,
			formSlug: config.helloasso.formSlug ?? '(tous)',
			formType: config.helloasso.formType ?? '(tous)'
		},
		notion: {
			version: config.notion.version,
			emailProperty: config.notion.emailProperty,
			emailPropertyType: config.notion.emailPropertyType,
			paidProperty: config.notion.paidProperty,
			paidStatus: config.notion.paidStatus,
			repliParIdentite:
				config.notion.nameProperties === undefined
					? 'désactivé'
					: `${config.notion.nameProperties.firstName} + ${config.notion.nameProperties.lastName}`
		},
		alerting: config.alertWebhookUrl === undefined ? 'désactivé' : 'activé',
		httpTimeoutMs: config.httpTimeoutMs,
		processTimeoutMs: config.processTimeoutMs
	};
}
