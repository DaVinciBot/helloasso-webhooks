/**
 * Point d'entrée du process : charge l'environnement, valide la configuration,
 * câble les clients réels, écoute, et s'arrête proprement.
 *
 * Tous les imports applicatifs sont dynamiques et volontairement placés *après*
 * le chargement du `.env` : `logger.ts` et `config.ts` lisent `process.env` dès
 * leur évaluation. Un import statique serait hissé avant ce chargement — et
 * `prettier-plugin-organize-imports` réordonnerait de toute façon un import
 * d'effet de bord, rendant l'ordre non fiable.
 */

// En conteneur, les variables viennent de l'environnement : l'absence de
// fichier `.env` est le cas nominal, pas une erreur.
if (process.env.NODE_ENV !== 'production') {
	try {
		process.loadEnvFile('.env');
	} catch {
		// Pas de fichier .env : on continue avec l'environnement du process.
	}
}

const { serve } = await import('@hono/node-server');
const { createAlerter } = await import('./adapters/discord.js');
const { createHelloAssoClient } = await import('./adapters/helloasso.js');
const { createProcessedPayments } = await import('./adapters/supabase/processedPayments.js');
const { describeConfig, loadConfig } = await import('./core/config.js');
const { describeError } = await import('./core/errors.js');
const { logger } = await import('./core/logger.js');
const { createApp } = await import('./http/app.js');
const { buildHandlers } = await import('./wiring.js');

const config = (() => {
	try {
		return loadConfig();
	} catch (error) {
		logger.fatal({ err: describeError(error) }, 'démarrage impossible');
		process.exit(1);
	}
})();

const alerts = createAlerter(config.alertWebhookUrl, {
	logger,
	timeoutMs: config.httpTimeoutMs
});

const handlers = buildHandlers(config, { logger, alerts });

const app = createApp({
	config,
	logger,
	alerts,
	handlers,
	helloasso: createHelloAssoClient(config.helloasso, {
		logger,
		timeoutMs: config.httpTimeoutMs
	}),
	processedPayments: createProcessedPayments(config.supabase, { logger })
});

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
	logger.info(
		{
			...describeConfig(config),
			handlers: handlers.map((handler) => handler.name),
			address: info.address
		},
		'service démarré'
	);
});

/** Délai laissé aux requêtes en cours avant arrêt forcé. */
const SHUTDOWN_GRACE_MS = 15_000;

function shutdown(signal: NodeJS.Signals): void {
	logger.info({ signal }, 'arrêt demandé');

	const forced = setTimeout(() => {
		logger.warn('arrêt forcé après expiration du délai de grâce');
		process.exit(1);
	}, SHUTDOWN_GRACE_MS);
	forced.unref();

	server.close((error) => {
		if (error) {
			logger.error({ err: describeError(error) }, 'arrêt en échec');
			process.exit(1);
		}
		logger.info('arrêt terminé');
		process.exit(0);
	});
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

process.on('unhandledRejection', (reason) => {
	logger.fatal({ err: describeError(reason) }, 'rejet de promesse non géré');
	process.exit(1);
});
