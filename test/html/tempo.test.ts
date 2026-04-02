import { expect, test } from '@playwright/test'

test('charge via tempo html payment page', async ({ page }) => {
  // Navigate to the payment endpoint as a browser
  await page.goto('/tempo/charge', {
    waitUntil: 'domcontentloaded',
  })

  // Verify 402 payment page rendered
  await expect(page.getByText('Payment Required')).toBeVisible()
  await expect(page.getByRole('button', { name: /continue with tempo/i })).toBeVisible()

  // Click the pay button (local adapter signs without dialog)
  await page.getByRole('button', { name: /continue with tempo/i }).click()

  // Wait for service worker to submit credential and page to reload with paid response
  await expect(page.locator('body')).toContainText('"url":', { timeout: 30_000 })
})

test('service worker endpoint returns javascript', async ({ page }) => {
  const response = await page.goto('/tempo/charge?__mppx_worker')
  expect(response?.headers()['content-type']).toContain('application/javascript')
  expect(response?.status()).toBe(200)
})
