import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		environment: 'node',
		include: ['tests/**/*.test.ts'],
		coverage: {
			provider: 'v8',
			reporter: ['text', 'lcov'],
			include: ['src/**/*.ts'],
			// `server.ts` n'est qu'un bootstrap (listen + signaux) : il n'a pas de
			// logique propre et son exécution ouvrirait un port pendant les tests.
			exclude: ['src/server.ts'],
			thresholds: {
				statements: 80,
				branches: 80,
				functions: 80,
				lines: 80
			}
		}
	}
});
