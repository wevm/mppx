import type { Frame, Page } from '@playwright/test'
import { expect, test } from '@playwright/test'

test('charge via stripe html payment page', async ({ page }) => {
  test.slow()

  await page.goto('/stripe/charge', {
    waitUntil: 'domcontentloaded',
  })

  // Verify 402 payment page rendered
  await expect(page.locator('h1')).toHaveText('Payment Required')
  await expect(page.getByRole('button', { name: 'Pay' })).toBeVisible({ timeout: 10_000 })

  // Stripe renders several private frames. Find the one that actually contains
  // the payment controls instead of assuming the first frame is the card UI.
  const stripeFrame = await getStripePaymentFrame(page)
  const numberInput = stripeFrame.locator('[name="number"]')

  // Open card form
  const cardButton = stripeFrame.locator('[data-value="card"]')
  await cardButton.isVisible({ timeout: 90_000 })
  await cardButton.click()
  await page.waitForTimeout(1_000)

  // Wait for card inputs to appear and fill test card details
  await expect(numberInput).toBeVisible({ timeout: 90_000 })
  await numberInput.fill('4242424242424242')
  await stripeFrame.locator('[name="expiry"]').fill('12/34')
  await stripeFrame.locator('[name="cvc"]').fill('123')

  // Fill postal code if visible
  const postalCode = stripeFrame.locator('[name="postalCode"]')
  await postalCode.isVisible({ timeout: 2_000 })
  await postalCode.fill('10001')

  // Wait for Stripe Elements to settle
  await page.waitForTimeout(500)

  // Submit payment
  await page.getByRole('button', { name: 'Pay' }).click()

  // Wait for service worker to submit credential and page to reload with paid response
  await expect(page.locator('body')).toContainText('"fortune":', { timeout: 30_000 })
})

test('service worker endpoint returns javascript', async ({ page }) => {
  const response = await page.goto('/stripe/charge?__mppx_worker')
  expect(response?.headers()['content-type']).toContain('application/javascript')
  expect(response?.status()).toBe(200)
})

async function getStripePaymentFrame(page: Page, timeout = 30_000): Promise<Frame> {
  const deadline = Date.now() + timeout

  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      if (!frame.name().startsWith('__privateStripeFrame')) continue

      const hasCardButton =
        (await frame
          .locator('[data-value="card"]')
          .count()
          .catch(() => 0)) > 0
      if (hasCardButton) return frame
    }

    await page.waitForTimeout(250)
  }

  throw new Error('Timed out waiting for Stripe payment frame')
}
