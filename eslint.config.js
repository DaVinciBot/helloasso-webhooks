import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig(
	{
		ignores: ['dist/', 'coverage/', 'node_modules/']
	},
	js.configs.recommended,
	...tseslint.configs.strictTypeChecked,
	...tseslint.configs.stylisticTypeChecked,
	prettier,
	{
		languageOptions: {
			parserOptions: {
				projectService: true,
				tsconfigRootDir: import.meta.dirname
			},
			globals: {
				...globals.node
			}
		},
		rules: {
			'@typescript-eslint/no-explicit-any': 'error',

			eqeqeq: ['error', 'always'],
			curly: ['error', 'all'],
			'no-console': 'error',
			'no-debugger': 'error',
			'no-var': 'error',
			'object-shorthand': 'warn',
			'no-else-return': 'warn',

			'@typescript-eslint/consistent-type-imports': 'error',
			'@typescript-eslint/no-non-null-assertion': 'error',
			'@typescript-eslint/no-empty-object-type': 'error',
			'@typescript-eslint/no-inferrable-types': 'warn',

			'@typescript-eslint/no-unused-vars': [
				'error',
				{ argsIgnorePattern: '^_', varsIgnorePattern: '^_' }
			],

			'@typescript-eslint/ban-ts-comment': [
				'error',
				{
					'ts-ignore': true,
					'ts-nocheck': true,
					'ts-expect-error': 'allow-with-description',
					minimumDescriptionLength: 10
				}
			]
		}
	},
	{
		// Les tests manipulent des fixtures partiellement typées et des doubles
		// de test ; ces deux règles y produisent du bruit sans valeur.
		files: ['tests/**/*.ts'],
		rules: {
			'@typescript-eslint/unbound-method': 'off',
			'@typescript-eslint/no-unsafe-assignment': 'off'
		}
	},
	{
		files: ['eslint.config.js'],
		extends: [tseslint.configs.disableTypeChecked]
	}
);
