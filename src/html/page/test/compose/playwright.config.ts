import * as path from 'node:path'

import { defineConfig } from '@playwright/test'

const root = path.resolve(import.meta.dirname, '../..')

export default defineConfig({
  globalSetup: '../../../test/tempo.setup.global.ts',
  testDir: '.',
  testMatch: 'compose.test.ts',
  timeout: 60_000,
  use: {
    baseURL: 'http://127.0.0.1:34074',
    headless: true,
  },
  webServer: {
    command:
      'MPPX_TEMPO_ACCOUNTS_PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 TEMPO_CHAIN_ID=1337 pnpm exec vp dev --config test/compose/vite.config.ts --host 127.0.0.1 --port 34074 --strictPort',
    cwd: root,
    reuseExistingServer: !process.env.CI,
    url: 'http://127.0.0.1:34074/?__mppx=serviceWorker',
  },
})
