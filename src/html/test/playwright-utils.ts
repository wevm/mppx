import { test as base } from '@playwright/test'
import { createClient, decodeFunctionData, defineChain, http, numberToHex, parseAbi } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { tempoLocalnet } from 'viem/chains'
import { Actions, Addresses } from 'viem/tempo'
import { createServer } from 'vite'

type ServerOptions = { root: string; configFile: string }

// oxlint-disable-next-line no-empty-pattern
async function baseUrl({}: object, use: (url: string) => Promise<void>, options: ServerOptions) {
  const port = 24000 + Math.floor(Math.random() * 4000)
  const cacheDir = `node_modules/.vite-test-${port}`
  const server = await createServer({
    root: options.root,
    configFile: options.configFile,
    cacheDir,
    server: { port, strictPort: false },
  })
  await server.listen()
  process.on('exit', server.close)
  const address = server.httpServer?.address()
  const actualPort = typeof address === 'object' && address ? address.port : port
  const url = `http://localhost:${actualPort}`
  // Warmup: fetch the page to discover module scripts, then pre-transform them
  // to trigger dep optimization before tests navigate. Without this, lazy dep
  // discovery causes 504 (Outdated Optimize Dep) errors that prevent method
  // scripts from executing on first page load.
  const html = await fetch(url, { headers: { accept: 'text/html' } })
    .then((r) => r.text())
    .catch(() => '')
  const srcRe = /src="([^"]+)"/g
  const warmups: Promise<unknown>[] = []
  for (let m: RegExpExecArray | null; (m = srcRe.exec(html)); ) {
    if (m[1]!.startsWith('/@') || m[1]!.endsWith('.ts') || m[1]!.endsWith('.js'))
      warmups.push(server.transformRequest(m[1]!).catch(() => {}))
  }
  await Promise.all(warmups)
  // Wait for dep optimization to settle (discovered deps move to optimized)
  const optimizer = (server as any).environments?.client?.depsOptimizer
  if (optimizer) {
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      const { discovered } = optimizer.metadata
      if (Object.keys(discovered).length === 0) break
      await new Promise((r) => setTimeout(r, 200))
    }
  }
  await use(url)
  process.off('exit', server.close)
  await server.close()
  // Clean up per-worker cache dir
  const { rm } = await import('node:fs/promises')
  const { resolve } = await import('node:path')
  await rm(resolve(options.root, cacheDir), { recursive: true, force: true }).catch(() => {})
}

export function createBaseTest(options: ServerOptions) {
  return base.extend<object, { baseUrl: string }>({
    // oxlint-disable-next-line no-empty-pattern
    baseUrl: [async ({}, use) => baseUrl({}, use, options), { scope: 'worker' }],
  })
}

export function createTest(options: ServerOptions) {
  return base.extend<{ wallet: void }, { baseUrl: string }>({
    // oxlint-disable-next-line no-empty-pattern
    baseUrl: [async ({}, use) => baseUrl({}, use, options), { scope: 'worker' }],

    wallet: async ({ baseUrl, page }, use) => {
      const privateKey = generatePrivateKey()
      const account = privateKeyToAccount(privateKey)

      const chain = defineChain({
        ...tempoLocalnet,
        rpcUrls: { default: { http: [process.env.TEMPO_RPC_URL!] } },
      })

      {
        const funderAccount = privateKeyToAccount(
          '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
        )
        const funderClient = createClient({ account: funderAccount, chain, transport: http() })
        const alphaUsd = '0x20c0000000000000000000000000000000000001' as const
        // Fund AlphaUSD (payment token) and pathUSD (fee token)
        await Promise.all([
          Actions.token.transferSync(funderClient, {
            account: funderAccount,
            chain,
            token: alphaUsd,
            to: account.address,
            amount: 10_000_000n,
          }),
          Actions.token.transferSync(funderClient, {
            account: funderAccount,
            chain,
            token: Addresses.pathUsd,
            to: account.address,
            amount: 10_000_000n,
            nonceKey: 'expiring',
          }),
        ])
      }

      const client = createClient({ account, chain, transport: http() })

      await page.exposeFunction('__mockRequest', async (method: string, params?: unknown) => {
        if (method === 'eth_requestAccounts') return [account.address]
        if (method === 'eth_chainId') return numberToHex(chain.id)
        if (method === 'wallet_switchEthereumChain') return null
        if (method === 'wallet_addEthereumChain') return null

        if (method === 'eth_sendTransactionSync' || method === 'eth_sendTransaction') {
          const [tx] = params as [{ to: `0x${string}`; data: `0x${string}` }]
          const { args } = decodeFunctionData({
            abi: parseAbi(['function transfer(address to, uint256 amount)']),
            data: tx.data,
          })
          const result = await Actions.token.transferSync(client, {
            account,
            chain,
            token: tx.to,
            to: args[0],
            amount: args[1],
            feeToken: Addresses.pathUsd,
          })
          if (method === 'eth_sendTransactionSync') return result.receipt
          return result.receipt.transactionHash
        }

        return client.transport.request({ method, params } as any)
      })

      await page.goto(baseUrl)
      await page.evaluate(() => {
        window.dispatchEvent(
          new CustomEvent('eip6963:announceProvider', {
            detail: Object.freeze({
              info: {
                uuid: 'test-wallet-uuid',
                name: 'Test Wallet',
                icon: 'data:image/svg+xml,<svg/>',
                rdns: 'com.test.wallet',
              },
              provider: {
                request: async ({ method, params }: { method: string; params?: unknown }) =>
                  (window as any).__mockRequest(method, params),
                on() {},
                removeListener() {},
              },
            }),
          }),
        )
      })

      await use()
    },
  })
}
