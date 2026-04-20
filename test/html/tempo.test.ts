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

test('charge via tempo html payment page respects custom pay text', async ({ page }) => {
  await page.goto('/tempo/charge-custom-text', {
    waitUntil: 'domcontentloaded',
  })

  await expect(page.getByRole('button', { name: /buy now tempo/i })).toBeVisible()
})

test('subscription via tempo html payment page', async ({ page }) => {
  await page.goto('/tempo/subscription', {
    waitUntil: 'domcontentloaded',
  })

  await expect(page.getByText('Payment Required')).toBeVisible()
  await expect(page.getByRole('button', { name: /authorize with tempo/i })).toBeVisible()

  const paidResponsePromise = page.waitForResponse(
    (response) => response.url().includes('/tempo/subscription') && response.status() === 200,
  )

  await page.getByRole('button', { name: /authorize with tempo/i }).click()

  const paidResponse = await paidResponsePromise
  expect(paidResponse.headers()['payment-receipt']).toBeTruthy()
  await expect(page.locator('body')).toContainText('"plan":"pro"', { timeout: 30_000 })
})

test('service worker endpoint returns javascript', async ({ page }) => {
  const response = await page.goto('/tempo/charge?__mppx_worker')
  expect(response?.headers()['content-type']).toContain('application/javascript')
  expect(response?.status()).toBe(200)
})
