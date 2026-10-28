import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/node_modules/', '**/dist/', '**/cdk.out/'] },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    languageOptions: { globals: globals.node },
    rules: {
      'no-console': 'error',
    },
  },
  {
    files: ['scripts/**'],
    rules: { 'no-console': 'off' },
  },
);
