import { z } from 'zod';
import type { HelloAssoConfig } from '../core/config.js';
import { DataError, TransientError, isTransientHttpStatus } from '../core/errors.js';
import { forLog, type Logger } from '../core/logger.js';
import type { Campaign, Order, Payment } from '../core/payment.js';

/**
 * Adaptateur HelloAsso : OAuth2 `client_credentials` avec cache de jeton, puis
 * lecture REST v5.
 *
 * C'est ici, et nulle part ailleurs, que le format de HelloAsso existe. Le port
 * rend des objets du domaine : le reste du service ignore que les montants sont
 * en centimes, que les identifiants changent de type d'un point d'entrée à
 * l'autre, et que l'identité des inscrits vit dans la commande et non dans le
 * paiement.
 *
 * `fetch` natif, pas de SDK — l'API se résume à trois lectures et un SDK
 * ajouterait une dépendance à maintenir pour rien.
 */

/** Port consommé par le pipeline. Permet de le tester sans réseau. */
export interface HelloAssoPort {
	/**
	 * Relit le paiement. C'est cette réponse — et elle seule — qui fait autorité
	 * pour décider d'agir.
	 *
	 * @throws {DataError} paiement inexistant côté HelloAsso.
	 * @throws {TransientError} panne réseau, timeout, 5xx, quota, jeton refusé.
	 */
	getPayment(paymentId: string, options: { signal: AbortSignal }): Promise<Payment>;

	/**
	 * Relit la commande. Elle seule porte l'identité des inscrits : la réponse
	 * d'un paiement ne connaît que le payeur.
	 *
	 * @throws {DataError} commande inexistante côté HelloAsso.
	 * @throws {TransientError} panne réseau, timeout, 5xx, quota, jeton refusé.
	 */
	getOrder(orderId: string, options: { signal: AbortSignal }): Promise<Order>;

	/**
	 * Parcourt les articles vendus par un formulaire. Sert l'amorçage du registre
	 * du WEI, jamais le traitement d'une notification.
	 *
	 * @throws {DataError} formulaire inexistant côté HelloAsso.
	 * @throws {TransientError} panne réseau, timeout, 5xx, quota, jeton refusé.
	 */
	listFormItems(
		campaign: { formType: string; formSlug: string },
		options: { signal: AbortSignal }
	): Promise<readonly FormItem[]>;
}

/** Article vendu par un formulaire, tel que l'amorçage le lit. */
export interface FormItem {
	readonly id: string;
	readonly orderId: string | undefined;
	readonly firstName: string | undefined;
	readonly lastName: string | undefined;
	readonly state: string | undefined;
}

/* -------------------------------------------------------------- Le format ---
 *
 * Validation *au plus juste* : on ne décrit que les champs réellement lus. Sur-
 * spécifier ne renforcerait rien — la sécurité vient de l'authentification
 * OAuth, pas de la forme du JSON — et casserait le service au premier champ
 * ajouté par HelloAsso.
 */

/** L'API HelloAsso renvoie les identifiants tantôt en nombre, tantôt en chaîne. */
const identifier = z.union([z.number().int(), z.string().min(1)]);

const payerSchema = z.object({
	email: z.string().optional(),
	firstName: z.string().optional(),
	lastName: z.string().optional()
});

/** Personne portée par une ligne de commande : ni email, ni compte. */
const userSchema = z.object({
	firstName: z.string().optional(),
	lastName: z.string().optional()
});

const campaignSchema = z.object({
	formSlug: z.string().optional(),
	formType: z.string().optional(),
	organizationSlug: z.string().optional()
});

/**
 * Ligne de commande vue depuis le paiement. `shareAmount` est la part de cette
 * ligne couverte par le paiement, du point de vue de l'association ; `id` sert à
 * retrouver la même ligne dans la commande.
 */
const paymentItemSchema = z.object({
	id: identifier.optional(),
	shareAmount: z.number().optional()
});

/** Ligne de commande vue depuis la commande : elle, porte la personne inscrite. */
const orderItemSchema = z.object({
	id: identifier.optional(),
	user: userSchema.optional()
});

const paymentSchema = z.object({
	id: identifier,
	state: z.string().optional(),
	amount: z.number().optional(),
	date: z.string().optional(),
	payer: payerSchema.optional(),
	order: campaignSchema.extend({ id: identifier.optional() }).optional(),
	items: z.array(paymentItemSchema).optional()
});

const orderSchema = campaignSchema.extend({
	id: identifier.optional(),
	items: z.array(orderItemSchema).optional()
});

/** Article vendu, tel que `/forms/{type}/{slug}/items` le rend. */
const formItemSchema = z.object({
	id: identifier,
	order: z.object({ id: identifier.optional() }).optional(),
	user: userSchema.optional(),
	state: z.string().optional()
});

const formItemsPageSchema = z.object({
	data: z.array(formItemSchema).optional(),
	pagination: z
		.object({
			continuationToken: z.string().optional(),
			totalPages: z.number().optional(),
			pageIndex: z.number().optional()
		})
		.optional()
});

type WirePayment = z.infer<typeof paymentSchema>;
type WireOrder = z.infer<typeof orderSchema>;

/* ------------------------------------------------------- Wire → domaine --- */

function toIdentifier(id: number | string): string {
	return String(id);
}

function toCampaign(source: z.infer<typeof campaignSchema> | undefined): Campaign {
	return {
		organizationSlug: source?.organizationSlug,
		formSlug: source?.formSlug,
		formType: source?.formType
	};
}

/**
 * Montant revenant à l'association, en euros.
 *
 * HelloAsso compte en centimes et distingue ce que le payeur débourse
 * (`amount`, contribution volontaire au site comprise) de ce qui revient à
 * l'association (la somme des `items[].shareAmount`). C'est la seconde qui a un
 * sens comptable. Repli sur `amount` quand le détail manque — mieux vaut un
 * montant approché qu'une colonne vide —, `undefined` si le paiement ne porte
 * aucun montant exploitable. Fonction pure.
 */
export function organizationAmountEuros(payment: WirePayment): number | undefined {
	const shares = (payment.items ?? [])
		.map((item) => item.shareAmount)
		.filter((share): share is number => typeof share === 'number');
	const cents =
		shares.length > 0 ? shares.reduce((total, share) => total + share, 0) : payment.amount;

	if (cents === undefined || !Number.isFinite(cents)) {
		return undefined;
	}
	return Math.round(cents) / 100;
}

/** Projette un paiement v5 dans le domaine. Fonction pure. */
export function toPayment(wire: WirePayment): Payment {
	return {
		id: toIdentifier(wire.id),
		state: wire.state,
		campaign: toCampaign(wire.order),
		orderId: wire.order?.id === undefined ? undefined : toIdentifier(wire.order.id),
		amountEuros: organizationAmountEuros(wire),
		payer: wire.payer,
		paidItemIds: (wire.items ?? [])
			.map((item) => item.id)
			.filter((id): id is number | string => id !== undefined)
			.map(toIdentifier)
	};
}

/** Projette une commande v5 dans le domaine. Fonction pure. */
export function toOrder(wire: WireOrder, fallbackId: string): Order {
	return {
		id: wire.id === undefined ? fallbackId : toIdentifier(wire.id),
		campaign: toCampaign(wire),
		items: (wire.items ?? []).map((item) => ({
			id: item.id === undefined ? undefined : toIdentifier(item.id),
			person: item.user
		}))
	};
}

/* ------------------------------------------------------------- Le client --- */

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

/** Au-delà, l'amorçage refuse de continuer : le formulaire visé n'est pas le bon. */
const MAX_ITEM_PAGES = 50;
const ITEMS_PAGE_SIZE = 100;

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
	readonly idField: 'paymentId' | 'orderId' | 'formSlug';
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

const FORM_ITEMS_LABELS: ResourceLabels = {
	noun: 'formulaire',
	genitive: 'des articles du formulaire',
	of: "d'articles",
	idField: 'formSlug'
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
	 * Les trois lectures du service n'en diffèrent que par l'URL et le schéma.
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
		async getPayment(paymentId, options): Promise<Payment> {
			const wire = await read(
				`/payments/${encodeURIComponent(paymentId)}`,
				paymentId,
				PAYMENT_LABELS,
				paymentSchema,
				options
			);
			return toPayment(wire);
		},

		async getOrder(orderId, options): Promise<Order> {
			const wire = await read(
				`/orders/${encodeURIComponent(orderId)}`,
				orderId,
				ORDER_LABELS,
				orderSchema,
				options
			);
			return toOrder(wire, orderId);
		},

		async listFormItems(campaign, options): Promise<readonly FormItem[]> {
			const base =
				`/organizations/${encodeURIComponent(config.orgSlug)}` +
				`/forms/${encodeURIComponent(campaign.formType)}` +
				`/${encodeURIComponent(campaign.formSlug)}/items`;

			const items: FormItem[] = [];
			let continuationToken: string | undefined;
			let pages = 0;

			do {
				options.signal.throwIfAborted();
				pages += 1;

				const query = new URLSearchParams({ pageSize: String(ITEMS_PAGE_SIZE) });
				if (continuationToken !== undefined) {
					query.set('continuationToken', continuationToken);
				}

				const page = await read(
					`${base}?${query.toString()}`,
					campaign.formSlug,
					FORM_ITEMS_LABELS,
					formItemsPageSchema,
					options
				);

				for (const item of page.data ?? []) {
					items.push({
						id: toIdentifier(item.id),
						orderId: item.order?.id === undefined ? undefined : toIdentifier(item.order.id),
						firstName: item.user?.firstName,
						lastName: item.user?.lastName,
						state: item.state
					});
				}

				continuationToken = page.pagination?.continuationToken;

				if (continuationToken !== undefined && pages >= MAX_ITEM_PAGES) {
					throw new DataError(
						`HelloAsso : plus de ${String(MAX_ITEM_PAGES)} pages d'articles pour ${campaign.formSlug}, formulaire probablement erroné`
					);
				}
			} while (continuationToken !== undefined);

			return items;
		}
	};
}
