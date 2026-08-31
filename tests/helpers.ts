import { pino, type Logger } from 'pino';
import { vi } from 'vitest';
import type { Alert, AlertPort, Announcement, AnnouncePort } from '../src/adapters/discord.js';
import type { FormItem, HelloAssoPort } from '../src/adapters/helloasso.js';
import type { NotionMatch, NotionPort } from '../src/adapters/notion.js';
import type { ProcessedPaymentsPort } from '../src/adapters/supabase/processedPayments.js';
import type {
	NewRegistration,
	Registration,
	WeiRegistryPort
} from '../src/adapters/supabase/weiRegistry.js';
import type { Config, NotionConfig, WeiConfig } from '../src/core/config.js';
import type { Order, Payment } from '../src/core/payment.js';

/** Logger muet : les tests vérifient des comportements, pas des sorties de log. */
export const silentLogger: Logger = pino({ level: 'silent' });

export const TEST_SECRET = 'secret-de-test-suffisamment-long';

export const MEMBERSHIP_SLUG = 'adhesion-2026-2027';
export const WEI_SLUG = 'wei-2026';

/**
 * Les deux blocs de handler de la configuration de test, sans le `| undefined`
 * que porte `Config` — un test d'adaptateur veut la config, pas la question de
 * savoir si le handler est câblé.
 */
export function makeNotionConfig(): NotionConfig {
	const membership = makeConfig().membership;
	if (membership === undefined) {
		throw new Error('la configuration de test doit câbler le handler cotisation');
	}
	return membership.notion;
}

export function makeWeiConfig(): WeiConfig {
	const wei = makeConfig().wei;
	if (wei === undefined) {
		throw new Error('la configuration de test doit câbler le handler WEI');
	}
	return wei;
}

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
			acceptedStates: ['Authorized', 'Processed']
		},
		supabase: {
			url: 'https://project.supabase.co',
			serviceRoleKey: 'service-role-key'
		},
		alertWebhookUrl: undefined,
		membership: {
			selector: { formType: 'Membership', formSlug: undefined },
			notion: {
				token: 'notion-token',
				dataSourceId: 'data-source-id',
				version: '2025-09-03',
				emailProperty: 'Email',
				emailPropertyType: 'email',
				paidProperty: 'Cotisation',
				paidStatus: 'Payé',
				amountProperty: 'Montant',
				nameProperties: { firstName: 'Prénom', lastName: 'Nom' }
			}
		},
		wei: {
			campaign: { formType: 'Event', formSlug: WEI_SLUG },
			discordWebhookUrl: 'https://discord.test/webhook',
			capacity: undefined
		},
		httpTimeoutMs: 8000,
		processTimeoutMs: 12_000,
		...overrides
	};
}

/** Paiement du domaine, tel que l'adaptateur HelloAsso le rendrait. */
export function makePayment(overrides: Partial<Payment> = {}): Payment {
	return {
		id: '12345',
		state: 'Authorized',
		campaign: {
			organizationSlug: 'davincibot',
			formSlug: MEMBERSHIP_SLUG,
			formType: 'Membership'
		},
		orderId: '98765',
		amountEuros: 20,
		payer: { email: 'Membre.Test@Example.Org', firstName: 'Membre', lastName: 'Test' },
		paidItemIds: ['55501'],
		...overrides
	};
}

/** Commande du domaine : elle seule porte l'identité des inscrits. */
export function makeOrder(overrides: Partial<Order> = {}): Order {
	return {
		id: '98765',
		campaign: {
			organizationSlug: 'davincibot',
			formSlug: MEMBERSHIP_SLUG,
			formType: 'Membership'
		},
		items: [{ id: '55501', person: { firstName: 'Membre', lastName: 'Test' } }],
		...overrides
	};
}

/** Paiement WEI : trois places dans une même commande. */
export function makeWeiPayment(overrides: Partial<Payment> = {}): Payment {
	return makePayment({
		id: '70001',
		campaign: { organizationSlug: 'davincibot', formSlug: WEI_SLUG, formType: 'Event' },
		orderId: '80001',
		paidItemIds: ['901', '902'],
		payer: { email: 'lucie@example.org', firstName: 'Lucie', lastName: 'Martin' },
		...overrides
	});
}

export function makeWeiOrder(overrides: Partial<Order> = {}): Order {
	return makeOrder({
		id: '80001',
		campaign: { organizationSlug: 'davincibot', formSlug: WEI_SLUG, formType: 'Event' },
		items: [
			{ id: '901', person: { firstName: 'Lucie', lastName: 'Martin' } },
			{ id: '902', person: { firstName: 'Tom', lastName: 'Durand' } }
		],
		...overrides
	});
}

export function makeRegistration(overrides: Partial<Registration> = {}): Registration {
	return {
		itemId: '901',
		firstName: 'Lucie',
		lastName: 'Martin',
		registeredAt: '2026-08-26T10:00:00.000Z',
		...overrides
	};
}

export function makeFormItem(overrides: Partial<FormItem> = {}): FormItem {
	return {
		id: '901',
		orderId: '80001',
		firstName: 'Lucie',
		lastName: 'Martin',
		state: 'Processed',
		...overrides
	};
}

/* ------------------------------------------------------------- Les doubles --- */

export interface FakeHelloAssoOptions {
	payment?: Payment;
	order?: Order;
	formItems?: readonly FormItem[];
}

/**
 * Doubles contrôlables. `vi.fn()` partout : les assertions portent autant sur ce
 * qui est appelé que sur ce qui ne l'est pas — ne pas écrire dans Notion, ne pas
 * annoncer sur Discord sont des comportements à vérifier.
 */
export function makeHelloAsso(options: FakeHelloAssoOptions = {}) {
	const getPayment = vi.fn((): Promise<Payment> =>
		Promise.resolve(options.payment ?? makePayment())
	);
	const getOrder = vi.fn((): Promise<Order> => Promise.resolve(options.order ?? makeOrder()));
	const listFormItems = vi.fn((): Promise<readonly FormItem[]> =>
		Promise.resolve(options.formItems ?? [])
	);

	const port: HelloAssoPort = { getPayment, getOrder, listFormItems };
	return { port, getPayment, getOrder, listFormItems };
}

export function makeProcessedPayments(seeded = new Map<string, string>()) {
	const find = vi.fn((paymentId: string) => {
		const handler = seeded.get(paymentId);
		return Promise.resolve(
			handler === undefined ? undefined : { handler, processedAt: '2026-08-26T10:00:00.000Z' }
		);
	});
	const markProcessed = vi.fn((entry: { paymentId: string; handler: string }) => {
		seeded.set(entry.paymentId, entry.handler);
		return Promise.resolve();
	});

	const port: ProcessedPaymentsPort = { find, markProcessed };
	return { port, find, markProcessed, seeded };
}

export function makeNotion(
	options: { pages?: string[]; matchedBy?: NotionMatch['matchedBy'] } = {}
) {
	const pages = options.pages ?? ['page-1'];

	const findPages = vi.fn((): Promise<NotionMatch | undefined> =>
		Promise.resolve(
			pages.length === 0
				? undefined
				: { pageIds: [...pages], matchedBy: options.matchedBy ?? 'email' }
		)
	);
	const markPaid = vi.fn((): Promise<void> => Promise.resolve());

	const port: NotionPort = { findPages, markPaid };
	return { port, findPages, markPaid };
}

export function makeAlerts() {
	const notify = vi.fn((_alert: Alert): Promise<void> => Promise.resolve());
	const port: AlertPort = { notify };
	return { port, notify };
}

export function makeAnnouncer() {
	const announce = vi.fn((_announcement: Announcement): Promise<void> => Promise.resolve());
	const port: AnnouncePort = { announce };
	return { port, announce };
}

/**
 * Registre en mémoire, fidèle au comportement de la table : la clé est
 * `item_id`, une place déjà inscrite est ignorée en silence, et l'ordre de
 * lecture est celui de l'inscription.
 */
export function makeRegistry(initial: readonly Registration[] = []) {
	const rows = new Map<string, Registration & { paymentId: string | undefined }>();
	for (const [index, registration] of initial.entries()) {
		rows.set(registration.itemId, {
			...registration,
			registeredAt:
				registration.registeredAt || `2026-08-01T00:00:${String(index).padStart(2, '0')}.000Z`,
			paymentId: undefined
		});
	}

	let clock = 0;

	const register = vi.fn((registrations: readonly NewRegistration[]): Promise<void> => {
		clock += 1;
		for (const registration of registrations) {
			if (rows.has(registration.itemId)) {
				continue;
			}
			rows.set(registration.itemId, {
				itemId: registration.itemId,
				firstName: registration.firstName,
				lastName: registration.lastName,
				registeredAt: `2026-08-26T10:00:${String(clock).padStart(2, '0')}.000Z`,
				paymentId: registration.paymentId
			});
		}
		return Promise.resolve();
	});

	const findByPayment = vi.fn((paymentId: string): Promise<readonly Registration[]> =>
		Promise.resolve(
			[...rows.values()]
				.filter((row) => row.paymentId === paymentId)
				.map(({ paymentId: _ignored, ...registration }) => registration)
		)
	);

	const listAll = vi.fn((): Promise<readonly Registration[]> =>
		Promise.resolve(
			[...rows.values()]
				.toSorted((left, right) =>
					left.registeredAt === right.registeredAt
						? left.itemId.localeCompare(right.itemId)
						: left.registeredAt.localeCompare(right.registeredAt)
				)
				.map(({ paymentId: _ignored, ...registration }) => registration)
		)
	);

	const port: WeiRegistryPort = { register, findByPayment, listAll };
	return { port, register, findByPayment, listAll, rows };
}
