import { pino } from 'pino';
import { vi } from 'vitest';
import type { Alert, AlertPort } from '../src/alerts.js';
import type { Config } from '../src/config.js';
import type { DedupPort } from '../src/dedup.js';
import type { HelloAssoPort } from '../src/helloasso.js';
import type { Logger } from '../src/logger.js';
import type { NotionMatch, NotionPort } from '../src/notion.js';
import type { HelloAssoPayment } from '../src/schema.js';

/** Logger muet : les tests vérifient des comportements, pas des sorties de log. */
export const silentLogger: Logger = pino({ level: 'silent' });

export const TEST_SECRET = 'secret-de-test-suffisamment-long';

export function makeConfig(overrides: Partial<Config> = {}): Config {
	return {
		nodeEnv: 'test',
		port: 3000,
		logLevel: 'silent',
		webhookSecret: TEST_SECRET,
		helloasso: {
			clientId: 'client-id',
			clientSecret: 'client-secret',
			orgSlug: 'davincibot',
			apiBase: 'https://api.helloasso-sandbox.com/v5',
			tokenUrl: 'https://api.helloasso-sandbox.com/oauth2/token',
			acceptedStates: ['Authorized', 'Processed'],
			formSlug: undefined,
			formType: undefined
		},
		notion: {
			token: 'notion-token',
			dataSourceId: 'data-source-id',
			version: '2025-09-03',
			emailProperty: 'Email',
			emailPropertyType: 'email',
			paidProperty: 'Cotisation',
			paidStatus: 'Payé',
			nameProperties: { firstName: 'Prénom', lastName: 'Nom' }
		},
		supabase: {
			url: 'https://project.supabase.co',
			serviceRoleKey: 'service-role-key'
		},
		alertWebhookUrl: undefined,
		httpTimeoutMs: 8000,
		processTimeoutMs: 12_000,
		...overrides
	};
}

/** Paiement tel que le renverrait la réconciliation HelloAsso. */
export function makePayment(overrides: Partial<HelloAssoPayment> = {}): HelloAssoPayment {
	return {
		id: 12345,
		state: 'Authorized',
		amount: 2000,
		date: '2026-08-17T10:12:05.000Z',
		payer: { email: 'Membre.Test@Example.Org', firstName: 'Membre', lastName: 'Test' },
		order: {
			id: 98765,
			formSlug: 'adhesion-2026-2027',
			formType: 'Membership',
			organizationSlug: 'davincibot'
		},
		...overrides
	};
}

export interface FakePorts {
	helloasso: HelloAssoPort;
	notion: NotionPort;
	dedup: DedupPort;
	alerts: AlertPort;
}

export interface FakePortOptions {
	payment?: HelloAssoPayment;
	processedIds?: Set<string>;
	/** Lignes rendues par la recherche Notion ; vide = aucun appariement. */
	notionPages?: string[];
	matchedBy?: NotionMatch['matchedBy'];
}

/**
 * Doubles de test contrôlables. `vi.fn()` partout : les assertions portent
 * autant sur ce qui est appelé que sur ce qui ne l'est pas (ne pas écrire dans
 * Notion est un comportement à vérifier).
 */
export function makePorts(options: FakePortOptions = {}) {
	const processed = options.processedIds ?? new Set<string>();
	const pages = options.notionPages ?? ['page-1'];

	const getPayment = vi.fn((): Promise<HelloAssoPayment> =>
		Promise.resolve(options.payment ?? makePayment())
	);
	const findPages = vi.fn((): Promise<NotionMatch | undefined> =>
		Promise.resolve(
			pages.length === 0
				? undefined
				: { pageIds: [...pages], matchedBy: options.matchedBy ?? 'email' }
		)
	);
	const markPaid = vi.fn((): Promise<void> => Promise.resolve());
	const isProcessed = vi.fn((id: string): Promise<boolean> => Promise.resolve(processed.has(id)));
	const markProcessed = vi.fn((id: string): Promise<void> => {
		processed.add(id);
		return Promise.resolve();
	});
	const notify = vi.fn((_alert: Alert): Promise<void> => Promise.resolve());

	const ports: FakePorts = {
		helloasso: { getPayment },
		notion: { findPages, markPaid },
		dedup: { isProcessed, markProcessed },
		alerts: { notify }
	};

	return { ports, getPayment, findPages, markPaid, isProcessed, markProcessed, notify };
}
