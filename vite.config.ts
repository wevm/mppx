import path from 'node:path'

import { defineConfig } from 'vp'
import { playwright } from 'vp/test/browser-playwright'

// Shared aliases used by both projects
const alias = {
  'mppx/client': path.resolve(import.meta.dirname, 'src/client'),
  'mppx/discovery': path.resolve(import.meta.dirname, 'src/discovery'),
  'mppx/mcp-sdk/client': path.resolve(import.meta.dirname, 'src/mcp-sdk/client'),
  'mppx/mcp-sdk/server': path.resolve(import.meta.dirname, 'src/mcp-sdk/server'),
  'mppx/proxy': path.resolve(import.meta.dirname, 'src/proxy'),
  'mppx/server': path.resolve(import.meta.dirname, 'src/server'),
  'mppx/tempo': path.resolve(import.meta.dirname, 'src/tempo'),
  'mppx/hono': path.resolve(import.meta.dirname, 'src/middlewares/hono'),
  'mppx/express': path.resolve(import.meta.dirname, 'src/middlewares/express'),
  'mppx/nextjs': path.resolve(import.meta.dirname, 'src/middlewares/nextjs'),
  'mppx/elysia': path.resolve(import.meta.dirname, 'src/middlewares/elysia'),
  'mppx/stripe': path.resolve(import.meta.dirname, 'src/stripe'),
  'mppx/stripe/client': path.resolve(import.meta.dirname, 'src/stripe/client'),
  'mppx/stripe/server': path.resolve(import.meta.dirname, 'src/stripe/server'),
  mppx: path.resolve(import.meta.dirname, 'src'),
  '~test': path.resolve(import.meta.dirname, 'test'),
}

export default defineConfig({
  test: {
    coverage: {
      include: ['src/**'],
      exclude: ['test/**', 'src/cli/**', 'src/bin.ts', '**/*.test-d.ts'],
      thresholds: {
        statements: 70,
        branches: 70,
        functions: 70,
      },
    },
    globalSetup: ['./test/setup.global.ts'],
    projects: [
      {
        test: {
          name: 'node',
          alias,
          include: ['src/**/*.test.ts'],
          exclude: ['**/node_modules/**', 'src/**/*.browser.test.ts', 'src/cli/**/*.test.ts'],
          typecheck: {
            include: ['src/**/*.test-d.ts'],
          },
          globals: true,
          retry: 3,
          setupFiles: ['./test/setup.ts'],
          testTimeout: 10_000,
          hookTimeout: 60_000,
        },
      },
      {
        test: {
          name: 'cli',
          alias,
          include: ['src/cli/**/*.test.ts'],
          globals: true,
          retry: 3,
          setupFiles: ['./test/setup.ts'],
          testTimeout: 10_000,
          hookTimeout: 60_000,
        },
      },
      {
        resolve: {
          alias: {
            // constantTimeEqual uses node:crypto which is unavailable in browser.
            // The browser tests don't exercise challenge verification, so a shim is fine.
            './internal/constantTimeEqual.js': path.resolve(
              import.meta.dirname,
              'test/browser/constantTimeEqual.shim.ts',
            ),
          },
        },
        test: {
          name: 'browser',
          alias,
          include: ['src/**/*.browser.test.ts'],
          globals: true,
          retry: 1,
          testTimeout: 10_000,
          browser: {
            enabled: true,
            headless: true,
            provider: playwright(),
            instances: [{ browser: 'chromium' }],
          },
        },
      },
    ],
  },
  lint: {
    categories: {
      correctness: 'error',
      suspicious: 'warn',
    },
    plugins: ['typescript', 'oxc'],
    env: {
      builtin: true,
    },
    rules: {
      'typescript/no-non-null-assertion': 'off',
      'typescript/no-explicit-any': 'off',
      'no-shadow-restricted-names': 'off',
      'no-shadow': 'off',
      'no-control-regex': 'off',
    },
    settings: {
      polyfills: ['PaymentRequest', 'URLPattern', 'crypto', 'navigator'],
    },
    overrides: [
      {
        files: ['src/**/*.ts'],
        rules: {
          'compat/compat': 'error',
        },
        jsPlugins: ['eslint-plugin-compat'],
      },
    ],
  },
  fmt: {
    singleQuote: true,
    semi: false,
    sortImports: {},
    sortPackageJson: false,
  },
  staged: {
    '*': 'vp fmt --write --no-error-on-unmatched-pattern',
    '*.{js,jsx,ts,tsx,mjs,cjs}': 'vp lint --fix',
    '*.{ts,tsx}': "bash -c 'vp check'",
  },
})
