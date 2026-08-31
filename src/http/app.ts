import { Hono } from 'hono';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { AlertPort } from '../adapters/discord.js';
import type { HelloAssoPort } from '../adapters/helloasso.js';
import type { ProcessedPaymentsPort } from '../adapters/supabase/processedPayments.js';
import type { Config } from '../core/config.js';
import { describeError, isTransientError } from '../core/errors.js';
import { forLog, type Logger } from '../core/logger.js';
import { processNotification, type Outcome } from '../core/pipeline.js';
import type { PaymentHandler } from '../handlers/types.js';

/**
 * Application Hono : une route de webhook, une sonde de santé publique.
 *
 * Le handler HTTP ne contient aucune logique métier. Il authentifie, borne le
 * temps, délègue au pipeline, puis traduit le résultat en code HTTP. Cette
 * traduction porte toute la sémantique de rejeu vue par HelloAsso :
 *
 * - **200** — traité, déjà traité, hors périmètre, non résolu, ou donnée
 *   fautive : ne rejoue pas.
 * - **401** — secret d'URL invalide.
 * - **400** — corps illisible.
 * - **413** — corps aberrant.
 * - **503** — panne passagère : rejoue, l'idempotence rend le rejeu sûr.
 */

export interface AppDeps {
	readonly config: Config;
	readonly helloasso: HelloAssoPort;
	readonly processedPayments: ProcessedPaymentsPort;
	readonly alerts: AlertPort;
	readonly handlers: readonly PaymentHandler[];
	readonly logger: Logger;
}

/** Taille au-delà de laquelle un corps de notification est aberrant. */
const MAX_BODY_BYTES = 256 * 1024;

/**
 * Comparaison à temps constant. On compare les empreintes plutôt que les
 * chaînes : `timingSafeEqual` exige des longueurs égales, et les comparer
 * d'abord divulguerait la longueur du secret.
 */
export function secretMatches(candidate: string, expected: string): boolean {
	const a = createHash('sha256').update(candidate).digest();
	const b = createHash('sha256').update(expected).digest();
	return timingSafeEqual(a, b);
}

/** Le résultat métier ne change pas le code HTTP : tout succès logique est un 200. */
export function outcomeBody(outcome: Outcome): Record<string, unknown> {
	switch (outcome.status) {
		case 'ignored':
			return { status: 'ignored', reason: outcome.reason };
		case 'already_handled':
			return {
				status: 'already_handled',
				paymentId: outcome.paymentId,
				handler: outcome.handler
			};
		case 'data_error':
			return { status: 'data_error', reason: outcome.reason };
		case 'unresolved':
			return {
				status: 'unresolved',
				paymentId: outcome.paymentId,
				handler: outcome.handler,
				reason: outcome.reason
			};
		case 'handled':
			return { status: 'handled', paymentId: outcome.paymentId, handler: outcome.handler };
	}
}

export function createApp(deps: AppDeps): Hono {
	const app = new Hono();

	// `/health` et non `/healthz` : c'est la convention des autres services
	// DaVinciBot, et `shared-workflows/deploy.yml` sonde cette URL publiquement
	// après chaque déploiement pour valider la mise en ligne.
	app.get('/health', (c) => c.json({ status: 'ok' }));

	app.post('/webhook/:secret', async (c) => {
		const requestId = randomUUID();
		const logger = deps.logger.child({ requestId });

		if (!secretMatches(c.req.param('secret'), deps.config.webhookSecret)) {
			logger.warn('secret de webhook invalide');
			return c.json({ status: 'unauthorized' }, 401);
		}

		const contentLength = Number(c.req.header('content-length') ?? '0');
		if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
			logger.warn({ contentLength }, 'corps de notification trop volumineux');
			return c.json({ status: 'payload_too_large' }, 413);
		}

		let raw: string;
		try {
			raw = await c.req.text();
		} catch (error) {
			logger.warn({ err: describeError(error) }, 'corps de notification illisible');
			return c.json({ status: 'invalid_json' }, 400);
		}

		logger.debug(
			{
				method: c.req.method,
				headers: c.req.header(),
				contentLength,
				body: forLog(raw)
			},
			'appel HelloAsso reçu (brut)'
		);

		let body: unknown;
		try {
			body = JSON.parse(raw);
		} catch (error) {
			logger.warn({ err: describeError(error) }, 'corps de notification illisible');
			return c.json({ status: 'invalid_json' }, 400);
		}

		// Budget global du traitement : garantit une réponse bien avant le
		// timeout de HelloAsso, quel que soit le nombre d'appels sortants.
		const signal = AbortSignal.timeout(deps.config.processTimeoutMs);

		try {
			const outcome = await processNotification(body, {
				helloasso: deps.helloasso,
				processedPayments: deps.processedPayments,
				alerts: deps.alerts,
				handlers: deps.handlers,
				orgSlug: deps.config.helloasso.orgSlug,
				acceptedStates: deps.config.helloasso.acceptedStates,
				logger,
				signal
			});

			return c.json(outcomeBody(outcome), 200);
		} catch (error) {
			const described = describeError(error);

			if (isTransientError(error)) {
				logger.error({ err: described }, 'panne passagère, rejeu attendu');
			} else {
				// Y compris l'abandon sur dépassement du budget de temps.
				logger.error({ err: described }, 'erreur inattendue, rejeu attendu');
			}

			return c.json({ status: 'retry_later' }, 503);
		}
	});

	app.notFound((c) => c.json({ status: 'not_found' }, 404));

	app.onError((error, c) => {
		deps.logger.error({ err: describeError(error) }, 'erreur non rattrapée');
		return c.json({ status: 'internal_error' }, 500);
	});

	return app;
}
