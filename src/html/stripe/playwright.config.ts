import { defineConfig } from '@playwright/test'

const stripeMockEnv = process.env.MPPX_MOCK_STRIPE === '0' ? '' : 'MPPX_MOCK_STRIPE=1 '

export default defineConfig({
  testDir: './src',
  testMatch: '*.test.ts',
  timeout: 30_000,
  use: {
    baseURL: 'http://127.0.0.1:34071',
    headless: true,
  },
  webServer: {
    command: `${stripeMockEnv}pnpm exec vp dev --host 127.0.0.1 --port 34071 --strictPort`,
    cwd: import.meta.dirname,
    reuseExistingServer: !process.env.CI,
    url: 'http://127.0.0.1:34071/?__mppx=serviceWorker',
  },
})
