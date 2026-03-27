import { expect, test } from '@playwright/test'

test('renders form with input and submit button', async ({ page }) => {
  const response = await page.goto('/')
  expect(response!.status()).toBe(402)

  await expect(page.locator('h1')).toHaveText('Payment Required')
  await expect(page.locator('#payment-form')).toBeVisible()
  await expect(page.locator('input[name="code"]')).toBeVisible()
  await expect(page.locator('input[name="serverToken"]')).toBeVisible()
  await expect(page.locator('#payment-form button[type="submit"]')).toBeVisible()
})

test('displays amount via set("amount")', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.mppx-summary-amount')).toHaveText('$10.00')
})

test('submitting form with a valid server token dispatches credential', async ({ page }) => {
  await page.goto('/')

  await page.fill('input[name="code"]', 'test-payment-code-123')
  await page.fill('input[name="serverToken"]', 'server-ok-123')
  await page.click('#payment-form button[type="submit"]')

  // After dispatch, the page registers a service worker and reloads.
  // The dev server verifies the credential and returns the success page.
  await expect(page.locator('h1')).toHaveText('Payment verified!', { timeout: 15_000 })
})

test('submitting form with an invalid server token stays unauthorized', async ({ page }) => {
  await page.goto('/')

  await page.fill('input[name="code"]', 'test-payment-code-123')
  await page.fill('input[name="serverToken"]', 'invalid-token')
  await page.click('#payment-form button[type="submit"]')

  await expect(page.locator('h1')).toHaveText('Payment Required', { timeout: 15_000 })
  await expect(page.locator('#payment-form')).toBeVisible()
})
