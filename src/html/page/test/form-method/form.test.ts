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

test('theme presets can pin light and dark mode independent of system', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.goto('/')

  const toolbar = page.locator('#mppx-debug-toolbar')
  const logo = page.locator('.mppx-header .mppx-logo')

  await toolbar.getByLabel('Theme').selectOption('Stripe')
  await expect
    .poll(() =>
      page.evaluate(() => ({
        background: getComputedStyle(document.documentElement)
          .getPropertyValue('--mppx-background')
          .trim(),
        foreground: getComputedStyle(document.documentElement)
          .getPropertyValue('--mppx-foreground')
          .trim(),
      })),
    )
    .toEqual({ background: '#ffffff', foreground: '#0a2540' })
  await expect(logo).toHaveAttribute('src', /635BFF/)

  await toolbar.getByLabel('Theme').selectOption('Vercel')
  await expect
    .poll(() =>
      page.evaluate(() => ({
        background: getComputedStyle(document.documentElement)
          .getPropertyValue('--mppx-background')
          .trim(),
        foreground: getComputedStyle(document.documentElement)
          .getPropertyValue('--mppx-foreground')
          .trim(),
      })),
    )
    .toEqual({ background: '#000000', foreground: '#ededed' })
  await expect(logo).toHaveAttribute('src', /ffffff/)
})

test('debug toolbar can switch theme and force page states', async ({ page }) => {
  await page.goto('/')

  const toolbar = page.locator('#mppx-debug-toolbar')
  const method = page.locator('#mppx-method')
  const overlay = page.locator('#mppx-method .mppx-state-pane--overlay')
  await expect(toolbar).toBeVisible()

  await toolbar.getByLabel('Theme').selectOption('Stripe')
  await expect
    .poll(() =>
      page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--mppx-accent').trim(),
      ),
    )
    .toBe('#635bff')

  await toolbar.getByRole('button', { name: 'Verifying' }).click()
  await expect(page.locator('h1')).toHaveText('Payment Required')
  await expect(overlay).toHaveText('Verifying payment')
  await expect(page.locator('#payment-form')).toBeHidden()

  await toolbar.getByRole('button', { name: 'Success' }).click()
  await expect(page.locator('h1')).toHaveText('Payment Required')
  await expect(method).toHaveText('Verified payment')
  await expect(page.locator('#payment-form')).toHaveCount(0)

  await toolbar.getByRole('button', { name: 'Failed' }).click()
  await expect(page.locator('h1')).toHaveText('Payment Required')
  await expect(page.locator('.mppx-state-pane--error')).toHaveText('Verification failed')
  await expect(page.locator('#payment-form')).toBeVisible()

  await toolbar.getByRole('button', { name: 'Default' }).click()
  await expect(page.locator('h1')).toHaveText('Payment Required')
  await expect(page.locator('#payment-form')).toBeVisible()
  await expect(page.locator('#status')).toHaveText('')
  await expect(page.locator('#status')).toHaveClass('mppx-status')
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

test('shows success state when verification triggers a download without navigation', async ({
  page,
}) => {
  await page.goto('/?download=1')

  await page.fill('input[name="code"]', 'test-payment-code-123')
  await page.fill('input[name="serverToken"]', 'server-ok-123')

  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 15_000 }),
    page.click('#payment-form button[type="submit"]'),
  ])

  await expect(page.locator('h1')).toHaveText('Payment Required')
  await expect(page.locator('#mppx-method')).toHaveText('Verified payment')
  await expect(page.locator('#payment-form')).toHaveCount(0)
  expect(download.suggestedFilename()).toBe('protected.txt')
})

test('submitting form with an invalid server token stays unauthorized', async ({ page }) => {
  await page.goto('/')

  await page.fill('input[name="code"]', 'test-payment-code-123')
  await page.fill('input[name="serverToken"]', 'invalid-token')
  await page.click('#payment-form button[type="submit"]')

  await expect(page.locator('h1')).toHaveText('Payment Required', { timeout: 15_000 })
  await expect(page.locator('#payment-form')).toBeVisible()
})
