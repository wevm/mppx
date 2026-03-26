import * as path from 'node:path'

import { defineConfig } from '@playwright/test'

const root = path.resolve(import.meta.dirname, '..')

export default defineConfig({
  globalSetup: '../../test/tempo.setup.global.ts',
  timeout: 60_000,
  webServer: [
    {
      command:
        'pnpm exec vp dev test/form-method --config test/form-method/vite.config.ts --host 127.0.0.1 --port 34073 --strictPort',
      cwd: root,
      reuseExistingServer: !process.env.CI,
      url: 'http://127.0.0.1:34073/__mppx_serviceWorker.js',
    },
    {
      command:
        'TEMPO_CHAIN_ID=1337 pnpm exec vp dev --config vite.compose.ts --host 127.0.0.1 --port 34074 --strictPort',
      cwd: root,
      reuseExistingServer: !process.env.CI,
      url: 'http://127.0.0.1:34074/__mppx_serviceWorker.js',
    },
  ],
  projects: [
    {
      name: 'form',
      testDir: '.',
      testMatch: 'form.test.ts',
      use: {
        baseURL: 'http://127.0.0.1:34073',
        headless: true,
      },
    },
    {
      name: 'compose',
      testDir: '.',
      testMatch: 'compose.test.ts',
      use: {
        baseURL: 'http://127.0.0.1:34074',
        headless: true,
      },
    },
  ],
})
