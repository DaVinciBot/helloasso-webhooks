/**
 * Erreurs typées du service.
 *
 * La distinction porte une décision opérationnelle, pas seulement un libellé :
 * elle détermine le code HTTP renvoyé à HelloAsso, donc si HelloAsso rejoue ou
 * non la notification.
 *
 * - {@link TransientError} → 503 : panne passagère, le rejeu a une chance
 *   d'aboutir. L'idempotence rend ce rejeu sûr.
 * - {@link DataError} → 200 : la donnée est incohérente (email inconnu de
 *   Notion, propriété absente). Rejouer ne changera rien ; il faut une action
 *   humaine, donc on accuse réception et on alerte.
 * - {@link ConfigError} → jeté au démarrage uniquement, le process refuse de
 *   se lancer.
 */

/**
 * Panne passagère : réseau, timeout, 5xx amont, quota. HelloAsso doit rejouer.
 *
 * Le constructeur d'`Error` accepte déjà `{ cause }` : aucune des trois classes
 * n'en redéfinit un.
 */
export class TransientError extends Error {
	public override readonly name = 'TransientError';
}

/** Incohérence de données : le rejeu est inutile, une correction humaine est requise. */
export class DataError extends Error {
	public override readonly name = 'DataError';
}

/** Configuration invalide, détectée au boot. Le process s'arrête. */
export class ConfigError extends Error {
	public override readonly name = 'ConfigError';
}

export function isTransientError(error: unknown): error is TransientError {
	return error instanceof TransientError;
}

export function isDataError(error: unknown): error is DataError {
	return error instanceof DataError;
}

/**
 * Représentation loggable d'une erreur inconnue, sans jamais faire confiance à
 * son type (une valeur jetée n'est pas forcément une `Error`).
 */
export function describeError(error: unknown): { name: string; message: string } {
	if (error instanceof Error) {
		return { name: error.name, message: error.message };
	}
	return { name: 'UnknownError', message: String(error) };
}

/**
 * Statuts HTTP amont considérés comme passagers. Tout le reste est définitif :
 * un 400 ou un 404 ne se répare pas en rejouant.
 */
export function isTransientHttpStatus(status: number): boolean {
	return status === 408 || status === 425 || status === 429 || status >= 500;
}
