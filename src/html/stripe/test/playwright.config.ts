import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: '../src',
  testMatch: '*.test.ts',
  timeout: 30_000,
  use: {
    headless: true,
  },
})
