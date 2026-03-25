import { expect } from '@playwright/test'

import { test } from '../test/playwright-utils.js'

test('renders the payment page with challenge info', async ({ baseUrl, page }) => {
  const response = await page.goto(baseUrl)
  expect(response!.status()).toBe(402)

  await expect(page.locator('h1')).toHaveText('Payment Required')
  await expect(page.locator('#mppx-challenge')).toContainText('"method": "tempo"')
  await expect(page.locator('#mppx-challenge')).toContainText('"intent": "charge"')
})

test('displays "No wallets detected" when no provider is injected', async ({ baseUrl, page }) => {
  await page.goto(baseUrl)
  await expect(page.locator('#wallets')).toContainText('No wallets detected')
})

test('displays pay button', async ({ baseUrl, page }) => {
  await page.goto(baseUrl)
  await expect(page.locator('#pay-btn')).toHaveText('Pay with wallet')
})

test('shows wallet and connects', async ({ wallet: _wallet, page }) => {
  await expect(page.locator('#wallets button')).toHaveText('Connect Test Wallet')
  await page.locator('#wallets button').click()

  await expect(page.locator('#connected')).toBeVisible()
  await expect(page.locator('#wallets')).toBeHidden()
})

test('completes payment against local Tempo chain', async ({ wallet: _wallet, page }) => {
  await page.locator('#wallets button').click()
  await expect(page.locator('#connected')).toBeVisible()

  await page.locator('#pay-btn').click()

  await expect(page.locator('h1')).toHaveText('Payment verified!')
})

test('disconnect resets to wallet selection', async ({ wallet: _wallet, page }) => {
  await page.locator('#wallets button').click()
  await expect(page.locator('#connected')).toBeVisible()

  await page.locator('#disconnect-btn').click()
  await expect(page.locator('#wallets')).toBeVisible()
  await expect(page.locator('#connected')).toBeHidden()
})
