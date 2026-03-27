import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './src',
  testMatch: '*.test.ts',
  globalSetup: '../test/tempo.setup.global.ts',
  timeout: 60_000,
  use: {
    baseURL: 'http://127.0.0.1:34072',
    headless: true,
  },
  webServer: {
    command: 'TEMPO_CHAIN_ID=1337 pnpm exec vp dev --host 127.0.0.1 --port 34072 --strictPort',
    cwd: import.meta.dirname,
    reuseExistingServer: !process.env.CI,
    url: 'http://127.0.0.1:34072/?__mppx=serviceWorker',
  },
})
