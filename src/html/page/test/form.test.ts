import * as path from 'node:path'

import { expect } from '@playwright/test'

import { createBaseTest } from '../../test/playwright-utils.js'

const test = createBaseTest({
  root: path.resolve(import.meta.dirname, 'form-method'),
  configFile: path.resolve(import.meta.dirname, 'form-method/vite.config.ts'),
})

test('renders form with input and submit button', async ({ baseUrl, page }) => {
  const response = await page.goto(baseUrl)
  expect(response!.status()).toBe(402)

  await expect(page.locator('h1')).toHaveText('Payment Required')
  await expect(page.locator('#payment-form')).toBeVisible()
  await expect(page.locator('input[name="code"]')).toBeVisible()
  await expect(page.locator('#payment-form button[type="submit"]')).toBeVisible()
})

test('displays amount via setAmount', async ({ baseUrl, page }) => {
  await page.goto(baseUrl)
  await expect(page.locator('.mppx-summary-amount')).toHaveText('$10.00')
})

test('submitting form dispatches credential', async ({ baseUrl, page }) => {
  await page.goto(baseUrl)

  await page.fill('input[name="code"]', 'test-payment-code-123')
  await page.click('#payment-form button[type="submit"]')

  // After dispatch, the page registers a service worker and reloads.
  // The dev server verifies the credential and returns the success page.
  await expect(page.locator('h1')).toHaveText('Payment verified!', { timeout: 15_000 })
})
