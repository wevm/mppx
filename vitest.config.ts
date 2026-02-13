import path from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    alias: {
      'mppx/client': path.resolve(import.meta.dirname, 'src/client'),
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
    },
    coverage: {
      exclude: ['test/**'],
    },
    include: ['src/**/*.test.ts'],
    typecheck: {
      include: ['src/**/*.test-d.ts'],
    },
    globals: true,
    retry: 3,
    globalSetup: ['./test/setup.global.ts'],
    setupFiles: ['./test/setup.ts'],
    hookTimeout: 60_000,
    maxWorkers: 3,
  },
})
