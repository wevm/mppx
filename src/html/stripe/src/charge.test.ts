import { expect } from '@playwright/test'

import { test } from './playwright-utils.js'

test('renders the payment page with challenge info', async ({ baseUrl, page }) => {
  const response = await page.goto(baseUrl)
  expect(response!.status()).toBe(402)

  await expect(page.locator('h1')).toHaveText('Payment Required')
  await expect(page.locator('#mppx-challenge')).toContainText('"method": "stripe"')
  await expect(page.locator('#mppx-challenge')).toContainText('"intent": "charge"')
})

test('mounts stripe payment element', async ({ baseUrl, page }) => {
  await page.goto(baseUrl)
  await expect(page.locator('#mppx-method button')).toHaveText('Pay with card')
  // Stripe Payment Element renders inside an iframe
  const stripeFrame = page.frameLocator('iframe[name^="__privateStripeFrame"]').nth(0)
  await expect(stripeFrame.locator('[name="number"]')).toBeVisible({ timeout: 15_000 })
})

test('completes payment with test card', async ({ baseUrl, page }) => {
  await page.goto(baseUrl)

  // Wait for Stripe Payment Element iframe to load
  const stripeFrame = page.frameLocator('iframe[name^="__privateStripeFrame"]').nth(0)
  const cardInput = stripeFrame.locator('[name="number"]')
  await expect(cardInput).toBeVisible({ timeout: 15_000 })

  // Fill test card details
  await cardInput.fill('4242424242424242')
  await stripeFrame.locator('[name="expiry"]').fill('12/34')
  await stripeFrame.locator('[name="cvc"]').fill('123')

  // Fill postal code if visible
  const postalCode = stripeFrame.locator('[name="postalCode"]')
  if (await postalCode.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await postalCode.fill('10001')
  }

  // Submit payment
  await page.locator('#mppx-method button').click()

  // Should complete and reload with verified content
  await expect(page.locator('h1')).toHaveText('Payment verified!', { timeout: 30_000 })
})
