import { APIErrorCode, Client, ClientErrorCode, isNotionClientError } from '@notionhq/client';
import type { EmailPropertyType, NotionConfig } from './config.js';
import { DataError, TransientError } from './errors.js';
import type { Logger } from './logger.js';

/**
 * Accès Notion : recherche des lignes par email, puis coche la case « cotisation
 * payée ».
 *
 * Le SDK officiel n'expose pas d'`AbortSignal`. Le budget de temps est donc tenu
 * par deux moyens : `timeoutMs` passé au client (borne chaque appel HTTP) et un
 * `throwIfAborted()` avant chaque appel (borne la boucle globale). Voir
 * `docs/architecture.md` § budget de temps.
 */

export interface NotionPort {
	/** Ids des pages dont la propriété email vaut `email`. Peut être vide. */
	findPagesByEmail(email: string, options: { signal: AbortSignal }): Promise<string[]>;
	/** Coche la propriété booléenne de cotisation sur la page. Idempotent. */
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
 * Surface Notion réellement utilisée par ce service — deux appels.
 *
 * L'exposer comme interface étroite plutôt que de dépendre du type `Client`
 * complet rend les tests lisibles et confine le SDK à un seul adaptateur.
 */
export interface NotionApi {
	dataSources: {
		query(args: {
			data_source_id: string;
			filter: EmailFilter;
			page_size: number;
			start_cursor?: string;
		}): Promise<{ results: { id: string }[]; next_cursor: string | null }>;
	};
	pages: {
		update(args: {
			page_id: string;
			properties: Record<string, { checkbox: boolean }>;
		}): Promise<unknown>;
	};
}

/** Adaptateur du SDK officiel vers la surface étroite ci-dessus. */
export function toNotionApi(client: Client): NotionApi {
	return {
		dataSources: {
			query: async (args) => {
				const response = await client.dataSources.query(args);
				return { results: response.results, next_cursor: response.next_cursor };
			}
		},
		pages: {
			update: (args) => client.pages.update(args)
		}
	};
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
 * Un email ne devrait matcher qu'une poignée de lignes. Au-delà, on refuse de
 * parcourir la base entière : c'est le signe que la propriété configurée n'est
 * pas la bonne, et 500 lignes cochées par erreur sont pénibles à défaire.
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

	return {
		async findPagesByEmail(email, options): Promise<string[]> {
			const filter = buildEmailFilter(config.emailProperty, config.emailPropertyType, email);
			const pageIds: string[] = [];
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
						filter
					});
				} catch (error) {
					throw mapNotionError(error, 'recherche par email');
				}

				for (const result of response.results) {
					pageIds.push(result.id);
				}

				cursor = response.next_cursor ?? undefined;

				if (cursor !== undefined && visitedPages >= MAX_QUERY_PAGES) {
					logger.warn(
						{ email, found: pageIds.length, visitedPages },
						'trop de résultats pour un seul email, pagination interrompue'
					);
					break;
				}
			} while (cursor !== undefined);

			return pageIds;
		},

		async markPaid(pageId, options): Promise<void> {
			options.signal.throwIfAborted();
			try {
				await client.pages.update({
					page_id: pageId,
					properties: {
						[config.paidProperty]: { checkbox: true }
					}
				});
			} catch (error) {
				throw mapNotionError(error, `mise à jour de la page ${pageId}`);
			}
		}
	};
}
