import { test as base } from '@playwright/test'

export const test = base.extend<{ wallet: void }>({
  wallet: async ({ page }, use) => {
    const tempoRpcUrl = process.env.TEMPO_RPC_URL
    if (tempoRpcUrl) {
      await page.addInitScript((rpcUrl) => {
        const nativeFetch = window.fetch.bind(window)
        window.fetch = (input, init) => {
          const url =
            typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url

          if (!url.startsWith('http://localhost:8545')) return nativeFetch(input, init)

          const nextUrl = `${rpcUrl}${url.slice('http://localhost:8545'.length)}`
          if (typeof input === 'string' || input instanceof URL) return nativeFetch(nextUrl, init)

          return nativeFetch(new Request(nextUrl, input), init)
        }
      }, tempoRpcUrl)
    }

    await page.goto('/')
    await use()
  },
})
