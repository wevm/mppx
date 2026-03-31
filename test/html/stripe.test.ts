import { expect, test } from '@playwright/test'

import { setup } from './setup.js'

test.beforeAll(async () => {
  await setup()
})

test('charge via stripe html payment page', async ({ page, context }) => {
  const logs: string[] = []
  page.on('pageerror', (err) => logs.push(`[pageerror] ${err.message}`))
  page.on('console', (msg) => logs.push(`[console.${msg.type()}] ${msg.text()}`))
  page.on('requestfailed', (req) =>
    logs.push(`[requestfailed] ${req.url()} ${req.failure()?.errorText}`),
  )
  context.on('serviceworker', (sw) => logs.push(`[serviceworker] registered: ${sw.url()}`))

  await page.goto('/stripe/charge', {
    waitUntil: 'domcontentloaded',
  })

  // Verify 402 payment page rendered
  await expect(page.locator('h1')).toHaveText('Payment Required')
  await expect(page.getByRole('button', { name: 'Pay' })).toBeVisible()

  // Wait for Stripe Payment Element iframe to load
  const stripeFrame = page.frameLocator('iframe[name^="__privateStripeFrame"]').first()
  const cardButton = stripeFrame.locator('[data-value="card"]')
  await expect(cardButton)
    .toBeVisible({ timeout: 15_000 })
    .catch((e) => {
      console.error('Browser logs:\n' + logs.join('\n'))
      throw e
    })

  // Card option is collapsed by default — click to expand, wait for inputs to render
  await cardButton.click()
  await page.waitForTimeout(1_000)

  // Wait for card inputs to appear and fill test card details
  const numberInput = stripeFrame.locator('[name="number"]')
  await expect(numberInput).toBeVisible({ timeout: 15_000 })
  await numberInput.fill('4242424242424242')
  await stripeFrame.locator('[name="expiry"]').fill('12/34')
  await stripeFrame.locator('[name="cvc"]').fill('123')

  // Fill postal code if visible
  const postalCode = stripeFrame.locator('[name="postalCode"]')
  if (await postalCode.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await postalCode.fill('10001')
  }

  // Wait for Stripe Elements to settle
  await page.waitForTimeout(500)

  // Submit payment
  await page.getByRole('button', { name: 'Pay' }).click()

  // Wait for service worker to submit credential and page to reload with paid response
  await expect(page.locator('body')).toContainText('"fortune":')
})

test('service worker endpoint returns javascript', async ({ page }) => {
  const response = await page.goto('/stripe/charge?__mppx_worker')
  expect(response?.headers()['content-type']).toContain('application/javascript')
  expect(response?.status()).toBe(200)
})
