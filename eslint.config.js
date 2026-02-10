const config = require('@rubensworks/eslint-config');

module.exports = config([
  {
    files: [ '**/*.ts' ],
    languageOptions: {
      parserOptions: {
        tsconfigRootDir: __dirname,
        project: [ './tsconfig.eslint.json' ],
      },
    },
  },
  {
    rules: {
      // Default
      'unicorn/consistent-destructuring': 'off',
      'unicorn/no-array-callback-reference': 'off',

      // TODO: check if these can be enabled
      'ts/naming-convention': 'off',
      'ts/no-unsafe-return': 'off',
      'ts/no-unsafe-argument': 'off',
      'ts/no-unsafe-assignment': 'off',

      'ts/no-require-imports': [ 'error', { allow: [
        'process/',
        'web-streams-ponyfill',
        'is-stream',
        'readable-stream-node-to-web',
        'stream-to-string',
      ]}],
      'ts/no-var-requires': [ 'error', { allow: [
        'process/',
        'web-streams-ponyfill',
        'is-stream',
        'readable-stream-node-to-web',
        'stream-to-string',
      ]}],
    },
  },
  {
    // Specific rules for NodeJS-specific files
    files: [
      '**/test/**/*.ts',
    ],
    rules: {
      'import/no-nodejs-modules': 'off',
      'unused-imports/no-unused-vars': 'off',
      'ts/no-require-imports': 'off',
      'ts/no-var-requires': 'off',
    },
  },
  {
    // The config packages use an empty index.ts
    files: [
      'engines/config-*/lib/index.ts',
    ],
    rules: {
      'import/unambiguous': 'off',
    },
  },
  {
    // Some test files import 'jest-rdf' which triggers this
    // The http actors import 'cross-fetch/polyfill' which also triggers this
    // Some jest tests import '../../lib' which triggers this
    files: [
      '**/test/*-test.ts',
      '**/test/*-util.ts',
    ],
    rules: {
      'import/no-unassigned-import': 'off',
    },
  },
  {
    // Files that do not require linting
    ignores: [
      'setup-jest.js',
      '**/engine-default.js',
      '**/engine-browser.js',
      '**/comunica-browser.js',
      '.github/**',
      '**/bintest/**',
      'lerna.json',
    ],
  },
  {
    files: [ '**/*.js' ],
    rules: {
      'ts/no-require-imports': 'off',
      'ts/no-var-requires': 'off',
      'import/no-nodejs-modules': 'off',
      'import/no-extraneous-dependencies': 'off',
      'import/extensions': 'off',
    },
  },
]);
