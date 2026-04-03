import { expect, test } from '@playwright/test'

import { getStripePaymentFrame } from './utils.js'

test('compose renders tabs for multiple methods', async ({ page }) => {
  await page.goto('/compose', { waitUntil: 'domcontentloaded' })

  // Verify 402 payment page rendered
  await expect(page.getByText('Payment Required')).toBeVisible()

  // Both tabs visible
  const tempoTab = page.getByRole('tab', { name: 'Tempo' })
  const stripeTab = page.getByRole('tab', { name: 'Stripe' })
  await expect(tempoTab).toBeVisible()
  await expect(stripeTab).toBeVisible()

  // Tempo tab is active by default
  await expect(tempoTab).toHaveAttribute('aria-selected', 'true')
  await expect(stripeTab).toHaveAttribute('aria-selected', 'false')

  // Tempo panel visible, Stripe panel hidden
  const tempoPanel = page.locator('#mppx-panel-0')
  const stripePanel = page.locator('#mppx-panel-1')
  await expect(tempoPanel).toBeVisible()
  await expect(stripePanel).toBeHidden()

  // Tempo content rendered
  await expect(page.getByRole('button', { name: /continue with tempo/i })).toBeVisible()
})

test('compose tab switching', async ({ page }) => {
  await page.goto('/compose', { waitUntil: 'domcontentloaded' })

  const tempoTab = page.getByRole('tab', { name: 'Tempo' })
  const stripeTab = page.getByRole('tab', { name: 'Stripe' })

  // Click Stripe tab
  await stripeTab.click()
  await expect(stripeTab).toHaveAttribute('aria-selected', 'true')
  await expect(tempoTab).toHaveAttribute('aria-selected', 'false')

  // Stripe panel visible, Tempo panel hidden
  await expect(page.locator('#mppx-panel-1')).toBeVisible()
  await expect(page.locator('#mppx-panel-0')).toBeHidden()

  // Click back to Tempo
  await tempoTab.click()
  await expect(tempoTab).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('#mppx-panel-0')).toBeVisible()
})

test('compose arrow key navigation', async ({ page }) => {
  await page.goto('/compose', { waitUntil: 'domcontentloaded' })

  const tempoTab = page.getByRole('tab', { name: 'Tempo' })
  const stripeTab = page.getByRole('tab', { name: 'Stripe' })

  // Focus Tempo tab and press ArrowRight
  await tempoTab.focus()
  await page.keyboard.press('ArrowRight')
  await expect(stripeTab).toHaveAttribute('aria-selected', 'true')
  await expect(stripeTab).toBeFocused()

  // ArrowRight wraps to first tab
  await page.keyboard.press('ArrowRight')
  await expect(tempoTab).toHaveAttribute('aria-selected', 'true')
  await expect(tempoTab).toBeFocused()

  // ArrowLeft wraps to last tab
  await page.keyboard.press('ArrowLeft')
  await expect(stripeTab).toHaveAttribute('aria-selected', 'true')
  await expect(stripeTab).toBeFocused()
})

test('compose service worker endpoint', async ({ page }) => {
  const response = await page.goto('/compose?__mppx_worker')
  expect(response?.headers()['content-type']).toContain('application/javascript')
  expect(response?.status()).toBe(200)
})

test('compose tab switching updates URL query param', async ({ page }) => {
  await page.goto('/compose', { waitUntil: 'domcontentloaded' })

  const stripeTab = page.getByRole('tab', { name: 'Stripe' })

  // Click Stripe tab — URL should update
  await stripeTab.click()
  expect(new URL(page.url()).searchParams.get('__mppx_tab')).toBe('stripe')

  // Click Tempo tab — URL should update
  await page.getByRole('tab', { name: 'Tempo' }).click()
  expect(new URL(page.url()).searchParams.get('__mppx_tab')).toBe('tempo')
})

test('compose restores tab from URL query param', async ({ page }) => {
  await page.goto('/compose?__mppx_tab=stripe', { waitUntil: 'domcontentloaded' })

  // Stripe tab should be active
  await expect(page.getByRole('tab', { name: 'Stripe' })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('tab', { name: 'Tempo' })).toHaveAttribute('aria-selected', 'false')

  // Stripe panel visible, Tempo panel hidden
  await expect(page.locator('#mppx-panel-1')).toBeVisible()
  await expect(page.locator('#mppx-panel-0')).toBeHidden()
})

test('compose duplicate method names get unique slugs', async ({ page }) => {
  await page.goto('/compose-duplicates', { waitUntil: 'domcontentloaded' })

  const tabs = page.getByRole('tab')
  await expect(tabs).toHaveCount(3)

  // Click second Stripe tab — should get stripe-2 slug
  await tabs.nth(2).click()
  expect(new URL(page.url()).searchParams.get('__mppx_tab')).toBe('stripe-2')

  // Click first Stripe tab — should get stripe slug
  await tabs.nth(1).click()
  expect(new URL(page.url()).searchParams.get('__mppx_tab')).toBe('stripe')
})

test('compose restores duplicate method tab from URL', async ({ page }) => {
  await page.goto('/compose-duplicates?__mppx_tab=stripe-2', { waitUntil: 'domcontentloaded' })

  const tabs = page.getByRole('tab')

  // Third tab (second Stripe) should be active
  await expect(tabs.nth(2)).toHaveAttribute('aria-selected', 'true')
  await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'false')
  await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'false')

  // Third panel visible
  await expect(page.locator('#mppx-panel-2')).toBeVisible()
  await expect(page.locator('#mppx-panel-0')).toBeHidden()
  await expect(page.locator('#mppx-panel-1')).toBeHidden()
})

test('compose pay via stripe tab', async ({ page }, testInfo) => {
  test.slow()

  await page.goto('/compose', { waitUntil: 'domcontentloaded' })

  // Switch to Stripe tab
  await page.getByRole('tab', { name: 'Stripe' }).click()
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
  await expect(page.locator('body')).toContainText('"ok":', { timeout: 30_000 })
})

test('compose pay via tempo tab', async ({ page }) => {
  await page.goto('/compose', { waitUntil: 'domcontentloaded' })

  // Tempo tab is active by default, click pay
  await page.getByRole('button', { name: /continue with tempo/i }).click()

  // Wait for service worker to submit credential and page to reload with paid response
  await expect(page.locator('body')).toContainText('"ok":', { timeout: 30_000 })
})
