import { expect } from '@playwright/test'

import { test } from '../../test/playwright-utils.js'

test('renders the payment page with challenge info', async ({ page }) => {
  const response = await page.goto('/')
  expect(response!.status()).toBe(402)

  await expect(page.locator('h1')).toHaveText('Payment Required')
  await expect(page.locator('main')).toContainText('Expires')
})

test('displays "No wallets detected" when no provider is injected', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('#wallets')).toContainText('No wallets detected')
})

test('displays pay button', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('#pay-button')).toHaveText('Pay')
})

test('shows wallet and connects', async ({ wallet: _wallet, page }) => {
  await expect(page.locator('#wallets button')).toHaveText('Connect Wallet')
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
