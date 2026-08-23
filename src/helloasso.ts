import { z } from 'zod';
import type { HelloAssoConfig } from './config.js';
import { DataError, TransientError, isTransientHttpStatus } from './errors.js';
import { forLog, type Logger } from './logger.js';
import {
	helloAssoOrderSchema,
	helloAssoPaymentSchema,
	type HelloAssoOrder,
	type HelloAssoPayment
} from './schema.js';

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

	/**
	 * Relit la commande. Elle seule porte l'identité des adhérents
	 * (`items[].user`) : la réponse d'un paiement ne connaît que le payeur.
	 *
	 * @throws {DataError} commande inexistante côté HelloAsso.
	 * @throws {TransientError} panne réseau, timeout, 5xx, quota, jeton refusé.
	 */
	getOrder(orderId: string, options: { signal: AbortSignal }): Promise<HelloAssoOrder>;
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

/**
 * Ce qui distingue la lecture d'une ressource de celle d'une autre : les mots
 * employés dans les messages — journal et erreurs — et la clé sous laquelle
 * l'identifiant est journalisé. Le reste de la lecture est commun.
 */
interface ResourceLabels {
	/** « paiement », « commande » */
	readonly noun: string;
	/** « du paiement », « de la commande » */
	readonly genitive: string;
	/** « de paiement », « de commande » */
	readonly of: string;
	readonly idField: 'paymentId' | 'orderId';
}

const PAYMENT_LABELS: ResourceLabels = {
	noun: 'paiement',
	genitive: 'du paiement',
	of: 'de paiement',
	idField: 'paymentId'
};

const ORDER_LABELS: ResourceLabels = {
	noun: 'commande',
	genitive: 'de la commande',
	of: 'de commande',
	idField: 'orderId'
};

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

	/** Réponse brute d'une lecture : corps lu une seule fois, ici. */
	interface RawResponse {
		readonly response: Response;
		readonly body: string;
	}

	async function readOnce(
		path: string,
		id: string,
		labels: ResourceLabels,
		accessToken: string,
		signal: AbortSignal
	): Promise<RawResponse> {
		const url = `${config.apiBase}${path}`;

		logger.debug(
			{ [labels.idField]: id, url, method: 'GET' },
			`lecture ${labels.genitive} demandée à HelloAsso`
		);

		let response: Response;
		try {
			response = await doFetch(url, {
				method: 'GET',
				headers: {
					authorization: `Bearer ${accessToken}`,
					accept: 'application/json'
				},
				signal: timedSignal(signal)
			});
		} catch (cause) {
			throw new TransientError(`HelloAsso : échec réseau sur la lecture ${labels.genitive}`, {
				cause
			});
		}

		let body: string;
		try {
			body = await response.text();
		} catch (cause) {
			throw new TransientError(`HelloAsso : réponse ${labels.of} illisible`, { cause });
		}

		logger.debug(
			{
				[labels.idField]: id,
				url,
				status: response.status,
				headers: Object.fromEntries(response.headers),
				body: forLog(body)
			},
			`réponse ${labels.of} HelloAsso (brut)`
		);

		return { response, body };
	}

	/**
	 * Lecture d'une ressource v5 : jeton, appel, classement de l'échec, parsing.
	 * Les deux lectures du service n'en diffèrent que par l'URL et le schéma.
	 */
	async function read<S extends z.ZodType>(
		path: string,
		id: string,
		labels: ResourceLabels,
		schema: S,
		options: { signal: AbortSignal }
	): Promise<z.infer<S>> {
		let token = await getToken(options.signal);
		let attempt = await readOnce(path, id, labels, token, options.signal);

		// Un jeton peut être révoqué avant son expiration annoncée : on
		// retente une fois avec un jeton neuf avant de conclure à une panne.
		if (attempt.response.status === 401) {
			logger.warn({ [labels.idField]: id }, 'jeton HelloAsso refusé, renouvellement');
			token = await getToken(options.signal, true);
			attempt = await readOnce(path, id, labels, token, options.signal);
		}

		const { response, body: raw } = attempt;

		if (response.status === 404) {
			throw new DataError(`HelloAsso : ${labels.noun} ${id} introuvable`);
		}

		if (!response.ok) {
			if (isTransientHttpStatus(response.status) || response.status === 401) {
				throw new TransientError(
					`HelloAsso : lecture ${labels.genitive} en échec (HTTP ${String(response.status)})`
				);
			}
			throw new DataError(
				`HelloAsso : lecture ${labels.genitive} refusée (HTTP ${String(response.status)})`
			);
		}

		let payload: unknown;
		try {
			payload = JSON.parse(raw);
		} catch (cause) {
			throw new TransientError(`HelloAsso : réponse ${labels.of} illisible`, { cause });
		}

		const parsed = schema.safeParse(payload);
		if (!parsed.success) {
			throw new DataError(
				`HelloAsso : ${labels.noun} ${id} au format inattendu (${parsed.error.issues
					.map((issue) => issue.path.join('.'))
					.join(', ')})`
			);
		}

		return parsed.data;
	}

	return {
		getPayment(paymentId, options): Promise<HelloAssoPayment> {
			return read(
				`/payments/${encodeURIComponent(paymentId)}`,
				paymentId,
				PAYMENT_LABELS,
				helloAssoPaymentSchema,
				options
			);
		},

		getOrder(orderId, options): Promise<HelloAssoOrder> {
			return read(
				`/orders/${encodeURIComponent(orderId)}`,
				orderId,
				ORDER_LABELS,
				helloAssoOrderSchema,
				options
			);
		}
	};
}
