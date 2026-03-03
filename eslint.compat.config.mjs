import tsParser from '@typescript-eslint/parser'
import compat from 'eslint-plugin-compat'

export default [
  {
    files: ['src/**/*.ts'],
    ignores: ['**/*.test.ts', '**/*.test-d.ts'],
    plugins: {
      compat: compat,
    },
    languageOptions: {
      parser: tsParser,
    },
    settings: {
      polyfills: [
        // Core to this library — browser support is intentionally gated
        'PaymentRequest',
        // Used only in server-side proxy code (Node 18+ has URLPattern)
        'URLPattern',
        // globalThis.crypto available from Node 18.4+; gated on modern runtimes
        'crypto',
      ],
    },
    rules: {
      'compat/compat': 'error',
    },
  },
]
