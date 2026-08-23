import { Hono } from 'hono';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { AlertPort } from './alerts.js';
import type { Config } from './config.js';
import type { DedupPort } from './dedup.js';
import { describeError, isTransientError } from './errors.js';
import type { HelloAssoPort } from './helloasso.js';
import { forLog, type Logger } from './logger.js';
import type { NotionPort } from './notion.js';
import { processWebhook, type ProcessOutcome } from './processPayment.js';

/**
 * Application Hono : une route de webhook, une sonde de santé publique.
 *
 * Le handler ne contient aucune logique métier. Il authentifie, borne le temps,
 * délègue à `processWebhook`, puis traduit le résultat en code HTTP. Cette
 * traduction porte toute la sémantique de rejeu vue par HelloAsso :
 *
 * - **200** — traité, déjà traité, hors périmètre, ou donnée fautive : ne rejoue pas.
 * - **401** — secret d'URL invalide.
 * - **400** — corps illisible.
 * - **503** — panne passagère : rejoue, l'idempotence rend le rejeu sûr.
 */

export interface AppDeps {
	readonly config: Config;
	readonly helloasso: HelloAssoPort;
	readonly notion: NotionPort;
	readonly dedup: DedupPort;
	readonly alerts: AlertPort;
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
function outcomeBody(outcome: ProcessOutcome): Record<string, unknown> {
	switch (outcome.status) {
		case 'ignored':
			return { status: 'ignored', reason: outcome.reason };
		case 'already_handled':
			return { status: 'already_handled', paymentId: outcome.paymentId };
		case 'unmatched':
			return { status: 'unmatched', paymentId: outcome.paymentId };
		case 'data_error':
			return { status: 'data_error', reason: outcome.reason };
		case 'updated':
			return { status: 'updated', paymentId: outcome.paymentId, pages: outcome.pageIds.length };
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
			const outcome = await processWebhook(body, {
				helloasso: deps.helloasso,
				notion: deps.notion,
				dedup: deps.dedup,
				alerts: deps.alerts,
				logger,
				campaign: {
					orgSlug: deps.config.helloasso.orgSlug,
					formSlug: deps.config.helloasso.formSlug,
					formType: deps.config.helloasso.formType
				},
				acceptedStates: deps.config.helloasso.acceptedStates,
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
