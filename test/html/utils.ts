import type { Frame, Page } from '@playwright/test'

export async function getStripePaymentFrame(page: Page, timeout = 30_000): Promise<Frame> {
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
