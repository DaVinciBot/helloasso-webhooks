import { describe, expect, it } from 'vitest';
import { describeConfig, loadConfig } from '../src/config.js';
import { ConfigError } from '../src/errors.js';

function validEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
	return {
		WEBHOOK_SECRET: 'secret-de-test-suffisamment-long',
		HELLOASSO_CLIENT_ID: 'client-id',
		HELLOASSO_CLIENT_SECRET: 'client-secret',
		HELLOASSO_ORG_SLUG: 'davincibot',
		NOTION_TOKEN: 'ntn_xxx',
		NOTION_DATA_SOURCE_ID: 'abcdef',
		NOTION_EMAIL_PROPERTY: 'Email',
		NOTION_PAID_PROPERTY: 'Cotisation',
		NOTION_PAID_STATUS: 'Payé',
		NOTION_AMOUNT_PROPERTY: 'Montant',
		SUPABASE_URL: 'https://project.supabase.co',
		SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
		...overrides
	};
}

describe('loadConfig', () => {
	it('applique les valeurs par défaut documentées', () => {
		const config = loadConfig(validEnv());

		expect(config.port).toBe(3000);
		expect(config.logLevel).toBe('info');
		expect(config.notion.version).toBe('2025-09-03');
		expect(config.notion.emailPropertyType).toBe('email');
		expect(config.helloasso.apiBase).toBe('https://api.helloasso.com/v5');
		expect(config.helloasso.tokenUrl).toBe('https://api.helloasso.com/oauth2/token');
		expect(config.helloasso.acceptedStates).toEqual(['Authorized', 'Processed']);
		expect(config.alertWebhookUrl).toBeUndefined();
	});

	it("liste toutes les variables manquantes d'un coup", () => {
		let message = '';
		try {
			loadConfig({});
		} catch (error) {
			expect(error).toBeInstanceOf(ConfigError);
			message = (error as ConfigError).message;
		}

		expect(message).toContain('WEBHOOK_SECRET');
		expect(message).toContain('NOTION_TOKEN');
		expect(message).toContain('SUPABASE_URL');
	});

	it('refuse un secret de webhook trop court', () => {
		expect(() => loadConfig(validEnv({ WEBHOOK_SECRET: 'trop-court' }))).toThrow(ConfigError);
	});

	it("refuse une URL Supabase qui n'en est pas une", () => {
		expect(() => loadConfig(validEnv({ SUPABASE_URL: 'project.supabase.co' }))).toThrow(
			ConfigError
		);
	});

	it('traite une variable vide comme absente et non comme une valeur', () => {
		// `PORT=` dans un .env arrive en chaîne vide : sans nettoyage, la valeur
		// par défaut serait écrasée par un port invalide.
		const config = loadConfig(validEnv({ PORT: '', HELLOASSO_FORM_SLUG: '  ' }));

		expect(config.port).toBe(3000);
		expect(config.helloasso.formSlug).toBeUndefined();
	});

	it('découpe et nettoie la liste des statuts acceptés', () => {
		const config = loadConfig(validEnv({ HELLOASSO_ACCEPTED_STATES: 'Authorized, Registered ,' }));

		expect(config.helloasso.acceptedStates).toEqual(['Authorized', 'Registered']);
	});

	it("retire la barre oblique finale de l'URL d'API", () => {
		const config = loadConfig(
			validEnv({ HELLOASSO_API_BASE: 'https://api.helloasso-sandbox.com/v5/' })
		);

		expect(config.helloasso.apiBase).toBe('https://api.helloasso-sandbox.com/v5');
	});

	it('refuse un type de propriété email non pris en charge', () => {
		expect(() => loadConfig(validEnv({ NOTION_EMAIL_PROPERTY_TYPE: 'checkbox' }))).toThrow(
			ConfigError
		);
	});

	it('accepte les types de propriété email pris en charge', () => {
		const config = loadConfig(validEnv({ NOTION_EMAIL_PROPERTY_TYPE: 'rich_text' }));
		expect(config.notion.emailPropertyType).toBe('rich_text');
	});

	it("laisse le repli par identité désactivé quand aucune colonne n'est déclarée", () => {
		expect(loadConfig(validEnv()).notion.nameProperties).toBeUndefined();
	});

	it("accepte les deux colonnes d'identité", () => {
		const config = loadConfig(
			validEnv({
				NOTION_FIRST_NAME_PROPERTY: 'Prénom',
				NOTION_LAST_NAME_PROPERTY: 'Nom'
			})
		);

		expect(config.notion.nameProperties).toEqual({ firstName: 'Prénom', lastName: 'Nom' });
	});

	it("refuse une seule des deux colonnes d'identité", () => {
		// Apparier sur un demi-critère marquerait la mauvaise ligne ; le désactiver
		// en silence donnerait un service qui ne fait pas ce qu'on croit.
		expect(() => loadConfig(validEnv({ NOTION_FIRST_NAME_PROPERTY: 'Prénom' }))).toThrow(
			ConfigError
		);
		expect(() => loadConfig(validEnv({ NOTION_LAST_NAME_PROPERTY: 'Nom' }))).toThrow(ConfigError);
	});

	it("refuse une version d'API antérieure aux sources de données", () => {
		// 2022-06-28 ne connaît que `databases.query` : chaque recherche
		// échouerait au premier paiement plutôt qu'au démarrage.
		expect(() => loadConfig(validEnv({ NOTION_VERSION: '2022-06-28' }))).toThrow(ConfigError);
	});

	it("accepte une version d'API postérieure", () => {
		const config = loadConfig(validEnv({ NOTION_VERSION: '2026-03-11' }));
		expect(config.notion.version).toBe('2026-03-11');
	});
});

describe('describeConfig', () => {
	it('ne divulgue aucun secret', () => {
		const config = loadConfig(validEnv());
		const serialized = JSON.stringify(describeConfig(config));

		expect(serialized).not.toContain('client-secret');
		expect(serialized).not.toContain('service-role-key');
		expect(serialized).not.toContain('ntn_xxx');
		expect(serialized).not.toContain('secret-de-test-suffisamment-long');
		// …tout en restant utile au diagnostic.
		expect(serialized).toContain('davincibot');
		expect(serialized).toContain('Cotisation');
		expect(serialized).toContain('Payé');
	});
});
