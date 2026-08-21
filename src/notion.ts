import {
	APIErrorCode,
	Client,
	ClientErrorCode,
	isNotionClientError,
	type QueryDataSourceResponse
} from '@notionhq/client';
import type { EmailPropertyType, NotionConfig } from './config.js';
import { DataError, TransientError } from './errors.js';
import type { Logger } from './logger.js';
import { normalizeEmail, normalizeName } from './schema.js';

/**
 * Accès Notion : recherche de la ligne du membre, puis pose l'état
 * « cotisation payée ».
 *
 * Le SDK officiel n'expose pas d'`AbortSignal`. Le budget de temps est donc tenu
 * par deux moyens : `timeoutMs` passé au client (borne chaque appel HTTP) et un
 * `throwIfAborted()` avant chaque appel (borne la boucle globale). Voir
 * `docs/architecture.md` § budget de temps.
 */

/** Ce qu'on sait du payeur, par ordre de priorité d'appariement. */
export interface MemberQuery {
	/** Déjà normalisé par {@link normalizeEmail}. */
	readonly email: string | undefined;
	readonly firstName: string | undefined;
	readonly lastName: string | undefined;
}

/** Lignes appariées, et sur quel critère — l'information intéresse les logs. */
export interface NotionMatch {
	readonly pageIds: string[];
	readonly matchedBy: 'email' | 'identité';
}

export interface NotionPort {
	/**
	 * Lignes du membre : l'email d'abord, l'identité en repli. `undefined` si
	 * aucun critère n'apparie.
	 */
	findPages(query: MemberQuery, options: { signal: AbortSignal }): Promise<NotionMatch | undefined>;
	/** Pose l'état de cotisation configuré sur la page. Idempotent. */
	markPaid(pageId: string, options: { signal: AbortSignal }): Promise<void>;
}

/**
 * Filtre `dataSources.query`. Sa forme dépend du type de la propriété : une
 * colonne « Email » et une colonne texte ne se filtrent pas de la même façon,
 * et se tromper donne un `validation_error` opaque côté Notion.
 */
export type EmailFilter =
	| { property: string; email: { equals: string } }
	| { property: string; rich_text: { equals: string } }
	| { property: string; title: { equals: string } };

/** Fonction pure, testable sans réseau. */
export function buildEmailFilter(
	property: string,
	propertyType: EmailPropertyType,
	email: string
): EmailFilter {
	switch (propertyType) {
		case 'email':
			return { property, email: { equals: email } };
		case 'rich_text':
			return { property, rich_text: { equals: email } };
		case 'title':
			return { property, title: { equals: email } };
	}
}

/**
 * Ligne telle que le SDK la rend. Annoter le paramètre plutôt que de laisser
 * l'inférence le déduire : selon la façon dont l'éditeur résout les types du
 * SDK, le callback part sinon en `any` implicite.
 */
type SdkRow = QueryDataSourceResponse['results'][number];

/** Ligne de la source de données, réduite à ce que le service lit. */
export interface NotionRow {
	readonly id: string;
	/** Absent des réponses partielles du SDK. */
	readonly properties?: Record<string, unknown> | undefined;
}

/**
 * Surface Notion réellement utilisée par ce service — deux appels.
 *
 * L'exposer comme interface étroite plutôt que de dépendre du type `Client`
 * complet rend les tests lisibles et confine le SDK à un seul adaptateur.
 */
export interface NotionApi {
	dataSources: {
		query(args: {
			data_source_id: string;
			filter?: EmailFilter;
			page_size: number;
			start_cursor?: string;
		}): Promise<{ results: NotionRow[]; next_cursor: string | null }>;
	};
	pages: {
		update(args: {
			page_id: string;
			properties: Record<string, { status: { name: string } }>;
		}): Promise<unknown>;
	};
}

/** Adaptateur du SDK officiel vers la surface étroite ci-dessus. */
export function toNotionApi(client: Client): NotionApi {
	return {
		dataSources: {
			query: async (args) => {
				const response = await client.dataSources.query(args);
				return {
					results: response.results.map((result: SdkRow) => ({
						id: result.id,
						properties:
							'properties' in result
								? (result.properties as unknown as Record<string, unknown>)
								: undefined
					})),
					next_cursor: response.next_cursor
				};
			}
		},
		pages: {
			update: (args) => client.pages.update(args)
		}
	};
}

/**
 * Texte d'une valeur de propriété Notion, quel que soit son type.
 *
 * Le repli lit les colonnes plutôt que de les filtrer : il doit donc savoir
 * extraire un `title`, un `rich_text` et un `email` sans que la configuration
 * ait à déclarer lequel c'est. Toute autre forme rend une chaîne vide, qui
 * n'apparie rien. Fonction pure.
 */
export function plainText(property: unknown): string {
	if (property === null || typeof property !== 'object') {
		return '';
	}
	const value = property as {
		email?: unknown;
		title?: unknown;
		rich_text?: unknown;
	};

	if (typeof value.email === 'string') {
		return value.email;
	}

	const richText = value.title ?? value.rich_text;
	if (!Array.isArray(richText)) {
		return '';
	}
	return richText
		.map((piece: unknown) =>
			piece !== null &&
			typeof piece === 'object' &&
			typeof (piece as { plain_text?: unknown }).plain_text === 'string'
				? (piece as { plain_text: string }).plain_text
				: ''
		)
		.join('');
}

/**
 * Traduit une erreur du SDK Notion en erreur métier.
 *
 * `unauthorized` et `restricted_resource` sont classés *passagers* à dessein :
 * ce sont des incidents de configuration (jeton révoqué, intégration retirée de
 * la base). Répondre 5xx fait rejouer HelloAsso, ce qui laisse le temps de
 * corriger sans perdre le paiement — alors qu'un 200 le perdrait
 * définitivement.
 */
export function mapNotionError(error: unknown, context: string): Error {
	if (!isNotionClientError(error)) {
		return new TransientError(`Notion : ${context} — erreur inattendue`, { cause: error });
	}

	switch (error.code) {
		case APIErrorCode.RateLimited:
		case APIErrorCode.InternalServerError:
		case APIErrorCode.ServiceUnavailable:
		case APIErrorCode.ConflictError:
		case APIErrorCode.Unauthorized:
		case APIErrorCode.RestrictedResource:
		case ClientErrorCode.RequestTimeout:
		case ClientErrorCode.ResponseError:
			return new TransientError(`Notion : ${context} (${error.code})`, { cause: error });

		default:
			// object_not_found, validation_error, invalid_request… : la requête ou
			// la source de données est mal configurée, rejouer n'y changera rien.
			return new DataError(`Notion : ${context} (${error.code}) — ${error.message}`, {
				cause: error
			});
	}
}

export interface NotionClientDeps {
	readonly logger: Logger;
	readonly timeoutMs: number;
	/** Injectable pour les tests. */
	readonly client?: NotionApi;
}

/**
 * Un membre ne devrait matcher qu'une poignée de lignes. Au-delà, on refuse de
 * parcourir la base entière : c'est le signe que la propriété configurée n'est
 * pas la bonne, et 500 lignes marquées par erreur sont pénibles à défaire.
 */
const MAX_QUERY_PAGES = 5;
const PAGE_SIZE = 100;

export function createNotionClient(config: NotionConfig, deps: NotionClientDeps): NotionPort {
	const logger = deps.logger.child({ component: 'notion' });
	const client =
		deps.client ??
		toNotionApi(
			new Client({
				auth: config.token,
				notionVersion: config.version,
				timeoutMs: deps.timeoutMs
			})
		);

	/** Parcours paginé, borné, d'une recherche — filtrée ou non. */
	async function collect(
		filter: EmailFilter | undefined,
		context: string,
		options: { signal: AbortSignal },
		details: Record<string, unknown>
	): Promise<NotionRow[]> {
		const rows: NotionRow[] = [];
		let cursor: string | undefined;
		let visitedPages = 0;

		do {
			options.signal.throwIfAborted();
			visitedPages += 1;

			let response;
			try {
				response = await client.dataSources.query({
					data_source_id: config.dataSourceId,
					page_size: PAGE_SIZE,
					...(cursor === undefined ? {} : { start_cursor: cursor }),
					...(filter === undefined ? {} : { filter })
				});
			} catch (error) {
				throw mapNotionError(error, context);
			}

			rows.push(...response.results);
			cursor = response.next_cursor ?? undefined;

			if (cursor !== undefined && visitedPages >= MAX_QUERY_PAGES) {
				logger.warn(
					{ ...details, found: rows.length, visitedPages },
					`${context} : pagination interrompue`
				);
				break;
			}
		} while (cursor !== undefined);

		return rows;
	}

	/**
	 * Repli : un seul parcours de la source, comparaison côté service.
	 *
	 * Notion ne documente pas si ses filtres texte tiennent compte de la casse ;
	 * bâtir l'appariement dessus laisserait passer un « Dupont » écrit
	 * « DUPONT ». On lit donc les colonnes et on compare des formes normalisées.
	 * Le même balayage sert les deux critères : l'email d'abord — il reste le
	 * plus sûr — l'identité seulement pour les lignes qu'il n'a pas prises.
	 */
	async function scan(
		query: MemberQuery,
		options: { signal: AbortSignal }
	): Promise<NotionMatch | undefined> {
		const firstName = normalizeName(query.firstName);
		const lastName = normalizeName(query.lastName);
		const names = config.nameProperties;
		const byIdentity =
			names !== undefined && firstName !== undefined && lastName !== undefined ? names : undefined;

		if (query.email === undefined && byIdentity === undefined) {
			return undefined;
		}

		const rows = await collect(undefined, 'recherche par identité', options, {
			email: query.email,
			lastName
		});

		const emailMatches: string[] = [];
		const identityMatches: string[] = [];

		for (const row of rows) {
			const properties = row.properties ?? {};

			if (
				query.email !== undefined &&
				normalizeEmail(plainText(properties[config.emailProperty])) === query.email
			) {
				emailMatches.push(row.id);
				continue;
			}

			if (
				byIdentity !== undefined &&
				normalizeName(plainText(properties[byIdentity.firstName])) === firstName &&
				normalizeName(plainText(properties[byIdentity.lastName])) === lastName
			) {
				identityMatches.push(row.id);
			}
		}

		if (emailMatches.length > 0) {
			return { pageIds: emailMatches, matchedBy: 'email' };
		}
		return identityMatches.length > 0
			? { pageIds: identityMatches, matchedBy: 'identité' }
			: undefined;
	}

	return {
		async findPages(query, options): Promise<NotionMatch | undefined> {
			// Chemin rapide : un filtre côté Notion, une requête, aucun parcours.
			// Il couvre le cas nominal — l'email est saisi à l'identique des deux
			// côtés — et laisse le balayage aux seuls paiements qu'il ne trouve pas.
			if (query.email !== undefined) {
				const filter = buildEmailFilter(
					config.emailProperty,
					config.emailPropertyType,
					query.email
				);
				const rows = await collect(filter, 'recherche par email', options, {
					email: query.email
				});
				if (rows.length > 0) {
					return { pageIds: rows.map((row) => row.id), matchedBy: 'email' };
				}
			}

			return await scan(query, options);
		},

		async markPaid(pageId, options): Promise<void> {
			options.signal.throwIfAborted();
			try {
				await client.pages.update({
					page_id: pageId,
					properties: {
						[config.paidProperty]: { status: { name: config.paidStatus } }
					}
				});
			} catch (error) {
				throw mapNotionError(error, `mise à jour de la page ${pageId}`);
			}
		}
	};
}
