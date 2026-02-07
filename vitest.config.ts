import path from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    alias: {
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
