/**
 * Amorçage du registre du WEI depuis HelloAsso.
 *
 * À lancer une fois, avant la mise en service du flux, quand des places ont déjà
 * été vendues : le service n'a vu passer aucune de ces notifications, et sans
 * amorçage la première annonce afficherait une liste commençant au jour de la
 * mise en ligne.
 *
 *     pnpm backfill:wei            # écrit
 *     pnpm backfill:wei --dry-run  # montre ce qui serait écrit
 *
 * Rejouable sans précaution : les places déjà inscrites sont ignorées
 * (`ON CONFLICT DO NOTHING`). Le script **n'annonce rien** sur Discord — il
 * n'appelle aucun handler, et les lignes qu'il écrit portent un `payment_id`
 * nul, donc aucune annonce future ne les comptera parmi les arrivants.
 */

import { pathToFileURL } from 'node:url';
import type { FormItem } from '../adapters/helloasso.js';
import type { NewRegistration } from '../adapters/supabase/weiRegistry.js';

/**
 * États d'article valant place réellement prise. Une absence d'état est
 * acceptée : HelloAsso ne le renseigne pas systématiquement sur les articles, et
 * une place manquante se verrait tout de suite sur Discord alors qu'une place en
 * trop se retire d'un `DELETE`.
 */
const REGISTERED_STATES = new Set(['processed', 'registered']);

function isRegistered(item: FormItem): boolean {
	return item.state === undefined || REGISTERED_STATES.has(item.state.toLowerCase());
}

/** Ne retient que les articles exploitables comme place. Fonction pure. */
export function toRegistrations(
	items: readonly FormItem[],
	isUsableName: (name: string | undefined) => boolean
): {
	readonly registrations: readonly NewRegistration[];
	readonly skipped: readonly string[];
} {
	const registrations: NewRegistration[] = [];
	const skipped: string[] = [];

	for (const item of items) {
		if (!isRegistered(item)) {
			skipped.push(`${item.id} (état ${item.state ?? 'inconnu'})`);
			continue;
		}

		const { firstName, lastName, orderId } = item;
		if (
			orderId === undefined ||
			firstName === undefined ||
			lastName === undefined ||
			!isUsableName(firstName) ||
			!isUsableName(lastName)
		) {
			skipped.push(`${item.id} (identité ou commande incomplète)`);
			continue;
		}

		registrations.push({
			itemId: item.id,
			orderId,
			// Nul, et c'est tout l'intérêt : ces places précèdent le service, aucune
			// annonce ne doit les compter parmi les arrivants.
			paymentId: undefined,
			firstName,
			lastName
		});
	}

	return { registrations, skipped };
}

/**
 * Le corps du script n'est exécuté que lancé directement, jamais à l'import :
 * les tests peuvent ainsi éprouver {@link toRegistrations} sans démarrer quoi
 * que ce soit ni exiger un environnement complet.
 */
async function main(): Promise<never> {
	if (process.env.NODE_ENV !== 'production') {
		try {
			process.loadEnvFile('.env');
		} catch {
			// Pas de fichier .env : on continue avec l'environnement du process.
		}
	}

	const { createHelloAssoClient } = await import('../adapters/helloasso.js');
	const { createWeiRegistry } = await import('../adapters/supabase/weiRegistry.js');
	const { loadConfig } = await import('../core/config.js');
	const { describeError } = await import('../core/errors.js');
	const { normalizeName } = await import('../core/identity.js');
	const { logger } = await import('../core/logger.js');

	const dryRun = process.argv.includes('--dry-run');

	let config;
	try {
		config = loadConfig();
	} catch (error) {
		logger.fatal({ err: describeError(error) }, 'configuration invalide');
		return process.exit(1);
	}

	if (config.wei === undefined) {
		logger.fatal(
			'bloc WEI absent : WEI_DISCORD_WEBHOOK_URL et WEI_FORM_SLUG sont requis pour amorcer le registre'
		);
		return process.exit(1);
	}

	const { campaign } = config.wei;
	const helloasso = createHelloAssoClient(config.helloasso, {
		logger,
		timeoutMs: config.httpTimeoutMs
	});
	const registry = createWeiRegistry(config.supabase, { logger });

	try {
		// Large, et sans rapport avec PROCESS_TIMEOUT_MS : on n'est pas dans le
		// budget d'une notification, mais dans un script lancé à la main.
		const signal = AbortSignal.timeout(5 * 60_000);

		logger.info({ ...campaign, dryRun }, 'lecture des articles du formulaire');
		const items = await helloasso.listFormItems(campaign, { signal });

		const { registrations, skipped } = toRegistrations(
			items,
			(name) => normalizeName(name) !== undefined
		);

		logger.info(
			{ articles: items.length, places: registrations.length, ecartes: skipped.length },
			'articles lus'
		);
		if (skipped.length > 0) {
			logger.warn({ ecartes: skipped }, 'articles écartés');
		}

		if (dryRun) {
			logger.info(
				{ places: registrations.map((row) => `${row.firstName} ${row.lastName}`) },
				'--dry-run : aucune écriture'
			);
			return process.exit(0);
		}

		await registry.register(registrations);
		const total = await registry.listAll();
		logger.info({ inscrits: total.length }, 'registre amorcé');
		return process.exit(0);
	} catch (error) {
		logger.fatal({ err: describeError(error) }, 'amorçage en échec');
		return process.exit(1);
	}
}

/**
 * Vrai uniquement si ce fichier est le point d'entrée du process. Comparer les
 * URL plutôt que les chemins fonctionne aussi bien pour `node dist/…js` que pour
 * `tsx src/…ts`.
 */
const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) {
	await main();
}
