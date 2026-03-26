import { expect } from '@playwright/test'

import { test } from '../../test/playwright-utils.js'

test('renders accessible tabs for both methods', async ({ page }) => {
  const response = await page.goto('/')
  expect(response!.status()).toBe(402)

  await expect(page.locator('h1')).toHaveText('Payment Required')

  // Tablist with label
  const tablist = page.locator('[role="tablist"]')
  await expect(tablist).toBeVisible()
  await expect(tablist).toHaveAttribute('aria-label', 'Payment method')

  // Tabs with ARIA attributes
  const tabs = page.locator('[role="tab"]')
  await expect(tabs).toHaveCount(2)
  await expect(tabs.nth(0)).toHaveText('stripe')
  await expect(tabs.nth(1)).toHaveText('tempo')

  // Panels with ARIA attributes
  const panels = page.locator('[role="tabpanel"]')
  await expect(panels).toHaveCount(2)
})

test('first tab is active by default with correct ARIA state', async ({ page }) => {
  await page.goto('/')

  const firstTab = page.locator('[role="tab"]').nth(0)
  const secondTab = page.locator('[role="tab"]').nth(1)

  await expect(firstTab).toHaveAttribute('aria-selected', 'true')
  await expect(firstTab).toHaveAttribute('tabindex', '0')
  await expect(secondTab).toHaveAttribute('aria-selected', 'false')
  await expect(secondTab).toHaveAttribute('tabindex', '-1')

  // aria-controls / aria-labelledby linkage
  const panelId = await firstTab.getAttribute('aria-controls')
  await expect(page.locator(`#${panelId}`)).toHaveAttribute('role', 'tabpanel')
  const tabId = await firstTab.getAttribute('id')
  await expect(page.locator(`#${panelId}`)).toHaveAttribute('aria-labelledby', tabId!)

  await expect(page.locator('.mppx-tab-panel[data-method="stripe/charge"]')).not.toHaveAttribute(
    'hidden',
    '',
  )
  await expect(page.locator('.mppx-tab-panel[data-method="tempo/charge"]')).toHaveAttribute(
    'hidden',
    '',
  )
})

test('switching tabs updates ARIA state and panels', async ({ page }) => {
  await page.goto('/')

  const firstTab = page.locator('[role="tab"]').nth(0)
  const secondTab = page.locator('[role="tab"]').nth(1)

  // Click tempo tab
  await secondTab.click()

  // ARIA state updated
  await expect(secondTab).toHaveAttribute('aria-selected', 'true')
  await expect(secondTab).toHaveAttribute('tabindex', '0')
  await expect(firstTab).toHaveAttribute('aria-selected', 'false')
  await expect(firstTab).toHaveAttribute('tabindex', '-1')

  // Panels toggled
  await expect(page.locator('.mppx-tab-panel[data-method="tempo/charge"]')).not.toHaveAttribute(
    'hidden',
    '',
  )
  await expect(page.locator('.mppx-tab-panel[data-method="stripe/charge"]')).toHaveAttribute(
    'hidden',
    '',
  )
})

test('keyboard navigation switches tabs', async ({ page }) => {
  await page.goto('/')

  const firstTab = page.locator('[role="tab"]').nth(0)
  const secondTab = page.locator('[role="tab"]').nth(1)

  // Focus first tab and press ArrowRight
  await firstTab.focus()
  await page.keyboard.press('ArrowRight')
  await expect(secondTab).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('.mppx-tab-panel[data-method="tempo/charge"]')).not.toHaveAttribute(
    'hidden',
    '',
  )

  // ArrowLeft wraps back
  await page.keyboard.press('ArrowLeft')
  await expect(firstTab).toHaveAttribute('aria-selected', 'true')

  // End key goes to last tab
  await page.keyboard.press('End')
  await expect(secondTab).toHaveAttribute('aria-selected', 'true')

  // Home key goes to first tab
  await page.keyboard.press('Home')
  await expect(firstTab).toHaveAttribute('aria-selected', 'true')
})

test('summary shows shared info without method row', async ({ page }) => {
  await page.goto('/')

  await expect(page.locator('.mppx-summary')).toContainText('$10.00')
  await expect(page.locator('.mppx-summary')).toContainText('Test payment')
  // Composed mode omits the "Method" row
  await expect(page.locator('.mppx-summary')).not.toContainText('Method')
})

test('each panel has its own scoped root', async ({ page }) => {
  await page.goto('/')

  const stripeRoot = await page.locator('#mppx-method-stripe-charge').count()
  const tempoRoot = await page.locator('#mppx-method-tempo-charge').count()
  expect(stripeRoot).toBe(1)
  expect(tempoRoot).toBe(1)
})

test('completes stripe payment via compose tab', async ({ page }) => {
  await page.goto('/')

  // Stripe tab is active by default — wait for Stripe Payment Element iframe
  const stripePanel = page.locator('.mppx-tab-panel[data-method="stripe/charge"]')
  const stripeFrame = stripePanel
    .locator('iframe[name^="__privateStripeFrame"]')
    .nth(0)
    .contentFrame()
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
  await stripePanel.locator('button.mppx-button').click()

  // Should complete and reload with verified content
  await expect(page.locator('h1')).toHaveText('Payment verified!', { timeout: 30_000 })
})

test('completes tempo payment via compose tab', async ({ wallet: _wallet, page }) => {
  // Switch to tempo tab
  await page.locator('[role="tab"]').nth(1).click()
  await expect(page.locator('.mppx-tab-panel[data-method="tempo/charge"]')).not.toHaveAttribute(
    'hidden',
    '',
  )

  const tempoPanel = page.locator('.mppx-tab-panel[data-method="tempo/charge"]')

  // Connect wallet
  await tempoPanel.locator('#wallets button').click()
  await expect(tempoPanel.locator('#connected')).toBeVisible()

  // Pay
  await tempoPanel.locator('#pay-button').click()

  // Should complete and reload with verified content
  await expect(page.locator('h1')).toHaveText('Payment verified!', { timeout: 30_000 })
})
