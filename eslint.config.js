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
    // The edge handler runs in CloudFront's JavaScript runtime 2.0: ES5.1 plus
    // a few later features. The parser accepts newer syntax regardless of
    // ecmaVersion, so the syntax that runtime lacks is banned explicitly.
    files: ['packages/edge/src/handler.js', 'packages/edge/src/response.js'],
    languageOptions: { ecmaVersion: 2017, sourceType: 'script', globals: {} },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { varsIgnorePattern: '^(handle|robots)$', caughtErrors: 'none' }],
      'no-restricted-syntax': [
        'error',
        { selector: 'ClassDeclaration, ClassExpression', message: 'Classes are not supported at the edge.' },
        { selector: 'ObjectPattern, ArrayPattern', message: 'Destructuring is not supported at the edge.' },
        { selector: 'SpreadElement, RestElement[parent.type!=/Function/]', message: 'Spread is not supported at the edge.' },
        { selector: 'ChainExpression', message: 'Optional chaining is not supported at the edge.' },
        { selector: "LogicalExpression[operator='??'], AssignmentExpression[operator=/^(\\?\\?|\\|\\||&&)=$/]", message: 'Nullish and logical assignment operators are not supported at the edge.' },
        { selector: 'CatchClause[param=null]', message: 'catch needs a binding at the edge.' },
        { selector: 'AssignmentPattern', message: 'Default parameters are not supported at the edge.' },
        { selector: 'Property[computed=true]', message: 'Computed keys are not supported at the edge.' },
        { selector: 'ArrowFunctionExpression[async=true], FunctionExpression[async=true]', message: 'Async closures are not supported at the edge.' },
        { selector: 'ForOfStatement', message: 'for...of is not supported at the edge.' },
        { selector: 'TaggedTemplateExpression', message: 'Tagged templates are not supported at the edge.' },
        { selector: 'CallExpression > AwaitExpression.arguments, NewExpression > AwaitExpression.arguments', message: 'await in arguments is not supported at the edge: assign it first.' },
        { selector: 'ImportDeclaration, ExportNamedDeclaration, ExportDefaultDeclaration', message: 'build.ts adds the imports.' },
      ],
    },
  },
  {
    files: ['scripts/**'],
    rules: { 'no-console': 'off' },
  },
);
