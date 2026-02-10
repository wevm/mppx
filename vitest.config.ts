import path from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    alias: {
      'mpay/client': path.resolve(import.meta.dirname, 'src/client'),
      'mpay/mcp-sdk/client': path.resolve(import.meta.dirname, 'src/mcp-sdk/client'),
      'mpay/mcp-sdk/server': path.resolve(import.meta.dirname, 'src/mcp-sdk/server'),
      'mpay/server': path.resolve(import.meta.dirname, 'src/server'),
      'mpay/tempo': path.resolve(import.meta.dirname, 'src/tempo'),
      'mpay/hono': path.resolve(import.meta.dirname, 'src/middlewares/hono'),
      'mpay/express': path.resolve(import.meta.dirname, 'src/middlewares/express'),
      'mpay/nextjs': path.resolve(import.meta.dirname, 'src/middlewares/nextjs'),
      'mpay/elysia': path.resolve(import.meta.dirname, 'src/middlewares/elysia'),
      mpay: path.resolve(import.meta.dirname, 'src'),
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
