import { z } from 'zod';
import type { HelloAssoConfig } from './config.js';
import { DataError, TransientError, isTransientHttpStatus } from './errors.js';
import type { Logger } from './logger.js';
import { helloAssoPaymentSchema, type HelloAssoPayment } from './schema.js';

/**
 * Client HelloAsso : OAuth2 `client_credentials` avec cache de jeton, puis
 * lecture REST v5 du paiement pour réconciliation.
 *
 * `fetch` natif, pas de SDK — l'API se résume à deux appels et un SDK
 * ajouterait une dépendance à maintenir pour rien.
 */

/** Port consommé par l'orchestrateur. Permet de le tester sans réseau. */
export interface HelloAssoPort {
	/**
	 * Relit le paiement auprès de HelloAsso. C'est cette réponse — et elle
	 * seule — qui fait autorité pour décider d'écrire dans Notion.
	 *
	 * @throws {DataError} paiement inexistant côté HelloAsso.
	 * @throws {TransientError} panne réseau, timeout, 5xx, quota, jeton refusé.
	 */
	getPayment(paymentId: string, options: { signal: AbortSignal }): Promise<HelloAssoPayment>;
}

export type FetchLike = typeof globalThis.fetch;

export interface HelloAssoClientDeps {
	readonly logger: Logger;
	readonly timeoutMs: number;
	/** Injectable pour les tests ; par défaut le `fetch` global de Node. */
	readonly fetch?: FetchLike;
	/** Injectable pour les tests de cache de jeton. */
	readonly now?: () => number;
}

const tokenResponseSchema = z.object({
	access_token: z.string().min(1),
	token_type: z.string().optional(),
	expires_in: z.number().int().positive().optional()
});

/**
 * Marge de sécurité avant expiration : on renouvelle le jeton un peu en avance
 * pour ne pas se faire refuser un appel parti juste avant la bascule.
 */
const TOKEN_EXPIRY_MARGIN_MS = 60_000;

/** Repli si HelloAsso omet `expires_in` (documenté à 30 min). */
const TOKEN_DEFAULT_TTL_MS = 30 * 60_000;

interface CachedToken {
	readonly accessToken: string;
	readonly expiresAt: number;
}

export function createHelloAssoClient(
	config: HelloAssoConfig,
	deps: HelloAssoClientDeps
): HelloAssoPort {
	const doFetch: FetchLike = deps.fetch ?? globalThis.fetch;
	const now = deps.now ?? Date.now;
	const logger = deps.logger.child({ component: 'helloasso' });

	let cached: CachedToken | undefined;
	/** Évite N appels au endpoint de jeton si N requêtes arrivent en rafale. */
	let inFlight: Promise<CachedToken> | undefined;

	function timedSignal(signal: AbortSignal): AbortSignal {
		return AbortSignal.any([signal, AbortSignal.timeout(deps.timeoutMs)]);
	}

	async function requestToken(signal: AbortSignal): Promise<CachedToken> {
		const body = new URLSearchParams({
			grant_type: 'client_credentials',
			client_id: config.clientId,
			client_secret: config.clientSecret
		});

		let response: Response;
		try {
			response = await doFetch(config.tokenUrl, {
				method: 'POST',
				headers: { 'content-type': 'application/x-www-form-urlencoded' },
				body,
				signal: timedSignal(signal)
			});
		} catch (cause) {
			throw new TransientError('HelloAsso : échec réseau sur la demande de jeton', { cause });
		}

		if (!response.ok) {
			// Même un 401 est traité comme passager : si les identifiants sont
			// mauvais, mieux vaut que HelloAsso rejoue pendant qu'on les corrige
			// plutôt que de perdre définitivement la notification.
			throw new TransientError(
				`HelloAsso : demande de jeton refusée (HTTP ${String(response.status)})`
			);
		}

		const payload: unknown = await response.json().catch((cause: unknown) => {
			throw new TransientError('HelloAsso : réponse de jeton illisible', { cause });
		});

		const parsed = tokenResponseSchema.safeParse(payload);
		if (!parsed.success) {
			throw new TransientError('HelloAsso : réponse de jeton inattendue');
		}

		const ttlMs =
			parsed.data.expires_in === undefined ? TOKEN_DEFAULT_TTL_MS : parsed.data.expires_in * 1000;

		logger.debug({ ttlMs }, 'jeton HelloAsso obtenu');

		return {
			accessToken: parsed.data.access_token,
			expiresAt: now() + Math.max(ttlMs - TOKEN_EXPIRY_MARGIN_MS, 0)
		};
	}

	async function getToken(signal: AbortSignal, forceRefresh = false): Promise<string> {
		if (!forceRefresh && cached !== undefined && cached.expiresAt > now()) {
			return cached.accessToken;
		}

		if (forceRefresh) {
			cached = undefined;
			inFlight = undefined;
		}

		inFlight ??= requestToken(signal)
			.then((token) => {
				cached = token;
				return token;
			})
			.finally(() => {
				inFlight = undefined;
			});

		const token = await inFlight;
		return token.accessToken;
	}

	async function getPaymentOnce(
		paymentId: string,
		accessToken: string,
		signal: AbortSignal
	): Promise<Response> {
		const url = `${config.apiBase}/payments/${encodeURIComponent(paymentId)}`;
		try {
			return await doFetch(url, {
				method: 'GET',
				headers: {
					authorization: `Bearer ${accessToken}`,
					accept: 'application/json'
				},
				signal: timedSignal(signal)
			});
		} catch (cause) {
			throw new TransientError('HelloAsso : échec réseau sur la lecture du paiement', {
				cause
			});
		}
	}

	return {
		async getPayment(paymentId, options): Promise<HelloAssoPayment> {
			let token = await getToken(options.signal);
			let response = await getPaymentOnce(paymentId, token, options.signal);

			// Un jeton peut être révoqué avant son expiration annoncée : on
			// retente une fois avec un jeton neuf avant de conclure à une panne.
			if (response.status === 401) {
				logger.warn({ paymentId }, 'jeton HelloAsso refusé, renouvellement');
				token = await getToken(options.signal, true);
				response = await getPaymentOnce(paymentId, token, options.signal);
			}

			if (response.status === 404) {
				throw new DataError(`HelloAsso : paiement ${paymentId} introuvable`);
			}

			if (!response.ok) {
				if (isTransientHttpStatus(response.status) || response.status === 401) {
					throw new TransientError(
						`HelloAsso : lecture du paiement en échec (HTTP ${String(response.status)})`
					);
				}
				throw new DataError(
					`HelloAsso : lecture du paiement refusée (HTTP ${String(response.status)})`
				);
			}

			const payload: unknown = await response.json().catch((cause: unknown) => {
				throw new TransientError('HelloAsso : réponse de paiement illisible', { cause });
			});

			const parsed = helloAssoPaymentSchema.safeParse(payload);
			if (!parsed.success) {
				throw new DataError(
					`HelloAsso : paiement ${paymentId} au format inattendu (${parsed.error.issues
						.map((issue) => issue.path.join('.'))
						.join(', ')})`
				);
			}

			return parsed.data;
		}
	};
}
