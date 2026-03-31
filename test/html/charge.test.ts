import { expect, test } from '@playwright/test'

import { setup } from './setup.js'

test.beforeAll(async () => {
  await setup()
})

test('charge via html payment page', async ({ page }) => {
  // Navigate to the payment endpoint as a browser
  await page.goto('/api/photo', {
    waitUntil: 'domcontentloaded',
  })

  // Verify 402 payment page rendered
  await expect(page.locator('h1')).toHaveText('Payment Required')
  await expect(page.getByText('Continue with Tempo')).toBeVisible()

  // Click the pay button — local adapter signs without dialog
  await page.getByText('Continue with Tempo').click()

  // Wait for service worker to submit credential and page to reload with paid response
  await expect(page.locator('body')).toContainText('"url":', { timeout: 30_000 })
})

test('service worker endpoint returns javascript', async ({ page }) => {
  const response = await page.goto('/api/photo?__mppx_worker')
  expect(response?.headers()['content-type']).toContain('application/javascript')
  expect(response?.status()).toBe(200)
})
