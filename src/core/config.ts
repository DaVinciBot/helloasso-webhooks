import { z } from 'zod';
import { ConfigError } from './errors.js';
import type { CampaignSelector } from './routing.js';

/**
 * Validation de `process.env` au démarrage, fail-fast.
 *
 * Aucune valeur métier n'est codée en dur : noms de propriétés Notion, slugs de
 * campagne, capacité du séjour, URL d'API et secrets viennent tous de
 * l'environnement.
 *
 * L'environnement est organisé comme le code : un socle commun (service,
 * HelloAsso, Supabase, alerte) puis un bloc par handler. **Un bloc absent
 * désactive son handler** — le WEI s'éteint hors saison sans toucher au code, et
 * un environnement de test peut n'en câbler qu'un seul. Au moins un handler doit
 * rester activé, faute de quoi le service n'aurait rien à faire.
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

	SUPABASE_URL: httpUrl(),
	SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),

	ALERT_WEBHOOK_URL: httpUrl().optional(),

	// ----------------------------------------------------------- Cotisation ---
	MEMBERSHIP_FORM_TYPE: z.string().min(1).optional(),
	MEMBERSHIP_FORM_SLUG: z.string().min(1).optional(),

	NOTION_TOKEN: z.string().min(1).optional(),
	NOTION_DATA_SOURCE_ID: z.string().min(1).optional(),
	NOTION_VERSION: z
		.string()
		.min(1)
		.refine((value) => value >= MIN_NOTION_VERSION, {
			message: `doit valoir au moins ${MIN_NOTION_VERSION} : les sources de données n'existent pas avant`
		})
		.default(MIN_NOTION_VERSION),
	NOTION_EMAIL_PROPERTY: z.string().min(1).optional(),
	NOTION_EMAIL_PROPERTY_TYPE: z.enum(emailPropertyTypes).default('email'),
	NOTION_PAID_PROPERTY: z.string().min(1).optional(),
	NOTION_PAID_STATUS: z.string().min(1).optional(),
	NOTION_AMOUNT_PROPERTY: z.string().min(1).optional(),
	NOTION_FIRST_NAME_PROPERTY: z.string().min(1).optional(),
	NOTION_LAST_NAME_PROPERTY: z.string().min(1).optional(),

	// ------------------------------------------------------------------ WEI ---
	WEI_FORM_TYPE: z.string().min(1).default('Event'),
	WEI_FORM_SLUG: z.string().min(1).optional(),
	WEI_DISCORD_WEBHOOK_URL: httpUrl().optional(),
	WEI_CAPACITY: z.coerce.number().int().positive().optional(),

	HTTP_TIMEOUT_MS: z.coerce.number().int().min(1000).max(30_000).default(8_000),
	PROCESS_TIMEOUT_MS: z.coerce.number().int().min(1000).max(30_000).default(12_000)
});

type Env = z.infer<typeof envSchema>;

export interface HelloAssoConfig {
	readonly clientId: string;
	readonly clientSecret: string;
	readonly orgSlug: string;
	readonly apiBase: string;
	readonly tokenUrl: string;
	readonly acceptedStates: readonly string[];
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
	/** Colonne nombre recevant le montant revenant à l'asso, en euros. */
	readonly amountProperty: string;
	readonly nameProperties: NameProperties | undefined;
}

export interface MembershipConfig {
	readonly selector: CampaignSelector;
	readonly notion: NotionConfig;
}

/**
 * Le WEI, contrairement à la cotisation, exige une campagne entièrement
 * désignée — d'où un couple `campaign` aux deux champs obligatoires plutôt qu'un
 * {@link CampaignSelector} dont tout est facultatif. L'invariant est ainsi porté
 * par le type, et l'amorçage du registre n'a pas à le revérifier.
 */
export interface WeiConfig {
	readonly campaign: { readonly formType: string; readonly formSlug: string };
	readonly discordWebhookUrl: string;
	readonly capacity: number | undefined;
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
	readonly supabase: SupabaseConfig;
	readonly alertWebhookUrl: string | undefined;
	/** `undefined` si le bloc Notion est absent : le handler n'est pas câblé. */
	readonly membership: MembershipConfig | undefined;
	/** `undefined` si le webhook d'annonce est absent : le handler n'est pas câblé. */
	readonly wei: WeiConfig | undefined;
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
 * Collecte les manques d'un bloc plutôt que d'échouer au premier.
 *
 * C'est la raison d'être de ce petit objet : un démarrage raté doit lister
 * *toutes* les variables fautives d'un coup, pour éviter le cycle « corriger,
 * redémarrer, découvrir la suivante ». Zod le fait pour les types ; il reste à
 * le faire pour les règles qui portent sur plusieurs variables à la fois.
 */
class Issues {
	private readonly messages: string[] = [];

	public add(variable: string, message: string): void {
		this.messages.push(`  - ${variable} : ${message}`);
	}

	/** Exige une variable, la renvoie, et note son absence le cas échéant. */
	public require(variable: string, value: string | undefined, because: string): string {
		if (value === undefined) {
			this.add(variable, because);
			return '';
		}
		return value;
	}

	public get isEmpty(): boolean {
		return this.messages.length === 0;
	}

	public throwIfAny(): void {
		if (!this.isEmpty) {
			throw new ConfigError(`Configuration invalide :\n${this.messages.join('\n')}`);
		}
	}
}

/**
 * Une seule des deux colonnes d'identité renseignée est une erreur de
 * configuration : le repli ne peut pas apparier sur un demi-critère, et le
 * désactiver en silence donnerait un service qui ne fait pas ce qu'on croit.
 */
function readNameProperties(env: Env, issues: Issues): NameProperties | undefined {
	const firstName = env.NOTION_FIRST_NAME_PROPERTY;
	const lastName = env.NOTION_LAST_NAME_PROPERTY;

	if (firstName === undefined && lastName === undefined) {
		return undefined;
	}
	if (firstName === undefined || lastName === undefined) {
		issues.add('NOTION_FIRST_NAME_PROPERTY et NOTION_LAST_NAME_PROPERTY', 'les deux ou aucune');
		return undefined;
	}
	return { firstName, lastName };
}

/**
 * Le bloc cotisation. `NOTION_TOKEN` fait office d'interrupteur : sa présence
 * déclare l'intention de câbler le handler, et rend alors le reste du bloc
 * obligatoire. Un demi-bloc est une faute de configuration, pas une désactivation.
 */
function readMembership(env: Env, issues: Issues): MembershipConfig | undefined {
	if (env.NOTION_TOKEN === undefined) {
		return undefined;
	}

	const because = 'requis dès que NOTION_TOKEN est défini';
	const notion: NotionConfig = {
		token: env.NOTION_TOKEN,
		dataSourceId: issues.require('NOTION_DATA_SOURCE_ID', env.NOTION_DATA_SOURCE_ID, because),
		version: env.NOTION_VERSION,
		emailProperty: issues.require('NOTION_EMAIL_PROPERTY', env.NOTION_EMAIL_PROPERTY, because),
		emailPropertyType: env.NOTION_EMAIL_PROPERTY_TYPE,
		paidProperty: issues.require('NOTION_PAID_PROPERTY', env.NOTION_PAID_PROPERTY, because),
		paidStatus: issues.require('NOTION_PAID_STATUS', env.NOTION_PAID_STATUS, because),
		amountProperty: issues.require('NOTION_AMOUNT_PROPERTY', env.NOTION_AMOUNT_PROPERTY, because),
		nameProperties: readNameProperties(env, issues)
	};

	return {
		selector: { formType: env.MEMBERSHIP_FORM_TYPE, formSlug: env.MEMBERSHIP_FORM_SLUG },
		notion
	};
}

/**
 * Le bloc WEI. Le webhook d'annonce fait office d'interrupteur : un handler qui
 * ne peut pas annoncer n'a aucun intérêt.
 *
 * `WEI_FORM_SLUG` devient alors obligatoire, et c'est délibéré : sans slug, le
 * sélecteur du WEI se réduirait à « tous les évènements » et attraperait la
 * première billetterie venue. Une place de WEI attribuée à un spectateur de
 * gala n'est pas un incident qu'on veut découvrir sur Discord.
 */
function readWei(env: Env, issues: Issues): WeiConfig | undefined {
	if (env.WEI_DISCORD_WEBHOOK_URL === undefined) {
		return undefined;
	}

	return {
		campaign: {
			formType: env.WEI_FORM_TYPE,
			formSlug: issues.require(
				'WEI_FORM_SLUG',
				env.WEI_FORM_SLUG,
				'requis dès que WEI_DISCORD_WEBHOOK_URL est défini : sans slug, le handler attraperait tous les évènements'
			)
		},
		discordWebhookUrl: env.WEI_DISCORD_WEBHOOK_URL,
		capacity: env.WEI_CAPACITY
	};
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
 * liste *toutes* les variables fautives.
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
	const issues = new Issues();

	const acceptedStates = parseAcceptedStates(env.HELLOASSO_ACCEPTED_STATES);
	if (acceptedStates.length === 0) {
		issues.add('HELLOASSO_ACCEPTED_STATES', 'au moins un statut est requis');
	}

	const membership = readMembership(env, issues);
	const wei = readWei(env, issues);

	if (membership === undefined && wei === undefined) {
		issues.add(
			'NOTION_TOKEN ou WEI_DISCORD_WEBHOOK_URL',
			"au moins un handler doit être activé, sinon le service n'a rien à faire"
		);
	}

	issues.throwIfAny();

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
			acceptedStates
		},
		supabase: {
			url: env.SUPABASE_URL,
			serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY
		},
		alertWebhookUrl: env.ALERT_WEBHOOK_URL,
		membership,
		wei,
		httpTimeoutMs: env.HTTP_TIMEOUT_MS,
		processTimeoutMs: env.PROCESS_TIMEOUT_MS
	};
}

/** Décrit un sélecteur pour le journal de démarrage. */
function describeSelector(selector: CampaignSelector): string {
	const type = selector.formType ?? '(tous types)';
	const slug = selector.formSlug ?? '(toutes campagnes)';
	return `${type} / ${slug}`;
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
			acceptedStates: config.helloasso.acceptedStates
		},
		handlers: {
			membership:
				config.membership === undefined
					? 'désactivé'
					: {
							campagne: describeSelector(config.membership.selector),
							notionVersion: config.membership.notion.version,
							emailProperty: config.membership.notion.emailProperty,
							paidProperty: config.membership.notion.paidProperty,
							paidStatus: config.membership.notion.paidStatus,
							amountProperty: config.membership.notion.amountProperty,
							repliParIdentite:
								config.membership.notion.nameProperties === undefined
									? 'désactivé'
									: `${config.membership.notion.nameProperties.firstName} + ${config.membership.notion.nameProperties.lastName}`
						},
			wei:
				config.wei === undefined
					? 'désactivé'
					: {
							campagne: describeSelector(config.wei.campaign),
							capacite: config.wei.capacity ?? '(inconnue)'
						}
		},
		alerting: config.alertWebhookUrl === undefined ? 'désactivé' : 'activé',
		httpTimeoutMs: config.httpTimeoutMs,
		processTimeoutMs: config.processTimeoutMs
	};
}
