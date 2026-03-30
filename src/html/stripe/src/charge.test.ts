import { expect, test } from '@playwright/test'

const hasStripeKeys = !!(process.env.VITE_STRIPE_PUBLIC_KEY && process.env.VITE_STRIPE_SECRET_KEY)

test('renders the payment page with challenge info', async ({ page }) => {
  const response = await page.goto('/')
  expect(response!.status()).toBe(402)

  await expect(page.locator('h1')).toHaveText('Payment Required')
  await expect(page.locator('main')).toContainText('Expires')
})

if (hasStripeKeys) {
  test('mounts stripe payment element', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('#mppx-method button')).toHaveText('Pay')
    // Stripe Payment Element renders inside an iframe
    const stripeFrame = page.locator('iframe[name^="__privateStripeFrame"]').nth(0).contentFrame()
    await expect(stripeFrame.locator('[name="number"]')).toBeVisible({ timeout: 15_000 })
  })

  test('debug toolbar visually hides stripe method for verifying and failed states', async ({
    page,
  }) => {
    await page.goto('/')
    await expect(page.locator('#mppx-method button')).toHaveText('Pay')
    const stripeFrame = page.locator('iframe[name^="__privateStripeFrame"]').nth(0)
    const stripeFrameHandle = await stripeFrame.elementHandle()
    const overlay = page.locator('#mppx-method .mppx-state-pane--overlay')
    expect(stripeFrameHandle).toBeTruthy()

    const toolbar = page.locator('#mppx-debug-toolbar')
    await toolbar.getByRole('button', { name: 'Verifying' }).click()

    await expect(page.locator('h1')).toHaveText('Payment Required')
    await expect(overlay).toHaveText('Verifying payment')
    await expect(page.locator('#mppx-method button')).toBeHidden()
    expect(await stripeFrameHandle!.evaluate((element) => element.isConnected)).toBe(true)

    await toolbar.getByRole('button', { name: 'Default' }).click()
    await expect(page.locator('#mppx-method button')).toHaveText('Pay')

    await toolbar.getByRole('button', { name: 'Failed' }).click()
    await expect(page.locator('h1')).toHaveText('Payment Required')
    await expect(page.locator('.mppx-state-pane--error')).toHaveText('Verification failed')
    await expect(page.locator('#mppx-method button')).toBeVisible()
    expect(await stripeFrameHandle!.evaluate((element) => element.isConnected)).toBe(true)
  })

  test('completes payment with test card', async ({ page }) => {
    await page.goto('/')

    // Wait for Stripe Payment Element iframe to load
    const stripeFrame = page.locator('iframe[name^="__privateStripeFrame"]').nth(0).contentFrame()
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
}
