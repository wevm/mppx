import * as path from 'node:path'

import { defineConfig } from '@playwright/test'

const root = path.resolve(import.meta.dirname, '../../..')

export default defineConfig({
  globalSetup: './tempo.setup.global.ts',
  testDir: '.',
  testMatch: 'form.test.ts',
  timeout: 60_000,
  use: {
    baseURL: 'http://127.0.0.1:34073',
    headless: true,
  },
  webServer: {
    command:
      'pnpm exec vp dev src/html/test/form-method --config src/html/test/form-method/vite.config.ts --host 127.0.0.1 --port 34073 --strictPort',
    cwd: root,
    reuseExistingServer: !process.env.CI,
    url: 'http://127.0.0.1:34073/?__mppx=sw',
  },
})
