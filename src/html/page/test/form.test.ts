import { expect, test } from '@playwright/test'

test('renders form with input and submit button', async ({ page }) => {
  const response = await page.goto('/')
  expect(response!.status()).toBe(402)

  await expect(page.locator('h1')).toHaveText('Payment Required')
  await expect(page.locator('#payment-form')).toBeVisible()
  await expect(page.locator('input[name="code"]')).toBeVisible()
  await expect(page.locator('#payment-form button[type="submit"]')).toBeVisible()
})

test('displays amount via setAmount', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.mppx-summary-amount')).toHaveText('$10.00')
})

test('submitting form dispatches credential', async ({ page }) => {
  await page.goto('/')

  await page.fill('input[name="code"]', 'test-payment-code-123')
  await page.click('#payment-form button[type="submit"]')

  // After dispatch, the page registers a service worker and reloads.
  // The dev server verifies the credential and returns the success page.
  await expect(page.locator('h1')).toHaveText('Payment verified!', { timeout: 15_000 })
})
