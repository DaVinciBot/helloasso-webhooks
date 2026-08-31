import { describe, expect, it } from 'vitest';
import { describeConfig, loadConfig } from '../../src/core/config.js';
import { ConfigError } from '../../src/core/errors.js';

/** Socle minimal : ni Notion, ni WEI. */
const base: NodeJS.ProcessEnv = {
	NODE_ENV: 'test',
	WEBHOOK_SECRET: 'un-secret-de-plus-de-24-caracteres',
	HELLOASSO_CLIENT_ID: 'client',
	HELLOASSO_CLIENT_SECRET: 'secret',
	HELLOASSO_ORG_SLUG: 'davincibot',
	SUPABASE_URL: 'https://project.supabase.co',
	SUPABASE_SERVICE_ROLE_KEY: 'service-role'
};

const notionBlock: NodeJS.ProcessEnv = {
	NOTION_TOKEN: 'jeton',
	NOTION_DATA_SOURCE_ID: 'source',
	NOTION_EMAIL_PROPERTY: 'Email',
	NOTION_PAID_PROPERTY: 'Cotisation',
	NOTION_PAID_STATUS: 'Payé',
	NOTION_AMOUNT_PROPERTY: 'Montant'
};

const weiBlock: NodeJS.ProcessEnv = {
	WEI_DISCORD_WEBHOOK_URL: 'https://discord.test/webhook',
	WEI_FORM_SLUG: 'wei-2026'
};

function load(env: NodeJS.ProcessEnv) {
	return loadConfig({ ...base, ...env });
}

function failure(env: NodeJS.ProcessEnv): string {
	try {
		loadConfig({ ...base, ...env });
	} catch (error) {
		return error instanceof ConfigError ? error.message : String(error);
	}
	throw new Error('la configuration aurait dû être refusée');
}

describe('loadConfig', () => {
	it('accepte un socle avec le seul handler cotisation', () => {
		const config = load(notionBlock);
		expect(config.membership?.notion.paidStatus).toBe('Payé');
		expect(config.wei).toBeUndefined();
	});

	it('accepte un socle avec le seul handler WEI', () => {
		const config = load(weiBlock);
		expect(config.wei?.campaign).toEqual({ formType: 'Event', formSlug: 'wei-2026' });
		expect(config.membership).toBeUndefined();
	});

	it('accepte les deux handlers ensemble', () => {
		const config = load({ ...notionBlock, ...weiBlock });
		expect(config.membership).toBeDefined();
		expect(config.wei).toBeDefined();
	});

	it("refuse un service sans aucun handler : il n'aurait rien à faire", () => {
		expect(failure({})).toContain('au moins un handler');
	});

	it('traite une variable vide comme absente', () => {
		// Dans un .env, `FOO=` arrive en chaîne vide et écraserait le défaut.
		const config = load({ ...notionBlock, MEMBERSHIP_FORM_SLUG: '   ' });
		expect(config.membership?.selector.formSlug).toBeUndefined();
	});

	it('liste toutes les variables fautives en une fois', () => {
		// Éviter le cycle « corriger, redémarrer, découvrir la suivante ».
		const message = failure({ NOTION_TOKEN: 'jeton', WEI_DISCORD_WEBHOOK_URL: 'https://d.test/w' });
		expect(message).toContain('NOTION_DATA_SOURCE_ID');
		expect(message).toContain('NOTION_PAID_PROPERTY');
		expect(message).toContain('WEI_FORM_SLUG');
	});

	it('exige les deux colonnes de repli ou aucune', () => {
		expect(failure({ ...notionBlock, NOTION_FIRST_NAME_PROPERTY: 'Prénom' })).toContain(
			'les deux ou aucune'
		);
	});

	it('accepte les deux colonnes de repli ensemble', () => {
		const config = load({
			...notionBlock,
			NOTION_FIRST_NAME_PROPERTY: 'Prénom',
			NOTION_LAST_NAME_PROPERTY: 'Nom'
		});
		expect(config.membership?.notion.nameProperties).toEqual({
			firstName: 'Prénom',
			lastName: 'Nom'
		});
	});

	it('exige le slug du WEI dès que son webhook est défini', () => {
		// Sans slug, le sélecteur attraperait toutes les billetteries.
		expect(failure({ WEI_DISCORD_WEBHOOK_URL: 'https://discord.test/webhook' })).toContain(
			'WEI_FORM_SLUG'
		);
	});

	it('refuse un secret de webhook trop court', () => {
		expect(failure({ ...notionBlock, WEBHOOK_SECRET: 'court' })).toContain('24 caractères');
	});

	it('refuse une version de Notion antérieure aux sources de données', () => {
		expect(failure({ ...notionBlock, NOTION_VERSION: '2022-06-28' })).toContain('2025-09-03');
	});

	it('refuse une URL Supabase qui n’en est pas une', () => {
		expect(failure({ ...notionBlock, SUPABASE_URL: 'pas-une-url' })).toContain('SUPABASE_URL');
	});

	it('retire la barre finale de la base d’API', () => {
		const config = load({ ...notionBlock, HELLOASSO_API_BASE: 'https://api.helloasso.com/v5/' });
		expect(config.helloasso.apiBase).toBe('https://api.helloasso.com/v5');
	});

	it('découpe les statuts acceptés', () => {
		const config = load({ ...notionBlock, HELLOASSO_ACCEPTED_STATES: ' Authorized , Processed ' });
		expect(config.helloasso.acceptedStates).toEqual(['Authorized', 'Processed']);
	});

	it('lit la capacité du WEI quand elle est fournie', () => {
		expect(load({ ...weiBlock, WEI_CAPACITY: '60' }).wei?.capacity).toBe(60);
	});
});

describe('describeConfig', () => {
	it('résume les handlers sans divulguer de secret', () => {
		const described = JSON.stringify(describeConfig(load({ ...notionBlock, ...weiBlock })));

		expect(described).not.toContain('jeton');
		expect(described).not.toContain('service-role');
		expect(described).not.toContain('discord.test');
		expect(described).toContain('wei-2026');
	});

	it('signale les handlers désactivés', () => {
		const described = describeConfig(load(notionBlock));
		expect((described.handlers as Record<string, unknown>).wei).toBe('désactivé');
	});
});
