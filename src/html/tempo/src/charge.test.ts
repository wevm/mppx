import { expect } from '@playwright/test'

import { test } from '../../test/playwright-utils.js'

test('renders the payment page with challenge info', async ({ page }) => {
  const response = await page.goto('/')
  expect(response!.status()).toBe(402)

  await expect(page.locator('h1')).toHaveText('Payment Required')
  await expect(page.locator('main')).toContainText('Expires')
})

test('displays connect wallet button when disconnected', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('#wallets button')).toHaveAccessibleName('Continue with Tempo')
})

test('debug toolbar shows verifying state while disconnected', async ({ page }) => {
  await page.goto('/')

  await page.locator('#mppx-debug-toolbar').getByRole('button', { name: 'Verifying' }).click()

  await expect(page.locator('h1')).toHaveText('Payment Required')
  await expect(page.locator('#mppx-method .mppx-state-pane--overlay')).toHaveText(
    'Verifying payment',
  )
  await expect(page.locator('#wallets')).toBeHidden()
})

test('displays pay button', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('#pay-button')).toHaveText('Pay')
})

test('shows wallet and connects', async ({ wallet: _wallet, page }) => {
  await expect(page.locator('#wallets button')).toHaveAccessibleName('Continue with Tempo')
  await page.locator('#wallets button').click()

  await expect(page.locator('#connected')).toBeVisible()
  await expect(page.locator('#wallets')).toBeHidden()
})

test('completes payment against local Tempo chain', async ({ wallet: _wallet, page }) => {
  await page.locator('#wallets button').click()
  await expect(page.locator('#connected')).toBeVisible()

  await page.locator('#pay-button').click()
  await expect(page.locator('#disconnect-button')).toBeHidden()

  await expect(page.locator('h1')).toHaveText('Payment verified!', { timeout: 30_000 })
})

test('disconnect resets to wallet selection', async ({ wallet: _wallet, page }) => {
  await page.locator('#wallets button').click()
  await expect(page.locator('#connected')).toBeVisible()

  await page.locator('#disconnect-button').click()
  await expect(page.locator('#wallets')).toBeVisible()
  await expect(page.locator('#connected')).toBeHidden()
})
