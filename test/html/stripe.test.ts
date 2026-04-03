import { expect, test } from '@playwright/test'

import { getStripePaymentFrame } from './utils.js'

test('charge via stripe html payment page', async ({ page }, testInfo) => {
  test.slow()

  await page.goto('/stripe/charge', {
    waitUntil: 'domcontentloaded',
  })

  // Verify 402 payment page rendered
  await expect(page.getByText('Payment Required')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Pay' })).toBeVisible({ timeout: 10_000 })

  if (!testInfo.project.use.headless) {
    const stripeFrame = await getStripePaymentFrame(page)
    const numberInput = stripeFrame.locator('[name="number"]')
    const cardButton = stripeFrame.locator('[data-value="card"]')

    await cardButton.isVisible({ timeout: 90_000 })
    await cardButton.click()
    await page.waitForTimeout(1_000)

    await expect(numberInput).toBeVisible({ timeout: 90_000 })
    await numberInput.fill('4242424242424242')
    await stripeFrame.locator('[name="expiry"]').fill('12/34')
    await stripeFrame.locator('[name="cvc"]').fill('123')

    const postalCode = stripeFrame.locator('[name="postalCode"]')
    await postalCode.isVisible({ timeout: 2_000 })
    await postalCode.fill('10001')

    await page.waitForTimeout(500)
  }

  // Submit payment (force needed — Stripe Link overlay can intercept click)
  await page.getByRole('button', { name: 'Pay' }).click({ force: true })

  // Wait for service worker to submit credential and page to reload with paid response
  await expect(page.locator('body')).toContainText('"fortune":', { timeout: 30_000 })
})

test('service worker endpoint returns javascript', async ({ page }) => {
  const response = await page.goto('/stripe/charge?__mppx_worker')
  expect(response?.headers()['content-type']).toContain('application/javascript')
  expect(response?.status()).toBe(200)
})
