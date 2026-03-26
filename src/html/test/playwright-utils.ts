import { test as base } from '@playwright/test'
import { createClient, decodeFunctionData, defineChain, http, numberToHex, parseAbi } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { tempoLocalnet } from 'viem/chains'
import { Actions, Addresses } from 'viem/tempo'
export const test = base.extend<{ wallet: void }>({
  wallet: async ({ page }, use) => {
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
      await Actions.token.transferSync(funderClient, {
        account: funderAccount,
        chain,
        token: alphaUsd,
        to: account.address,
        amount: 10_000_000n,
      })
      await Actions.token.transferSync(funderClient, {
        account: funderAccount,
        chain,
        token: Addresses.pathUsd,
        to: account.address,
        amount: 10_000_000n,
      })
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

    await page.goto('/')
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
