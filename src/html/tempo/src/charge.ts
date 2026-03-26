import { createStore } from 'mipd'
import type { EIP1193Provider } from 'mipd'
import {
  createClient,
  createPublicClient,
  custom,
  encodeFunctionData,
  getAddress,
  http,
  parseAbi,
  RpcError,
} from 'viem'
import { readContract } from 'viem/actions'
import { sendTransactionSync } from 'viem/actions'
import { tempo as tempoMainnet, tempoLocalnet, tempoModerato } from 'viem/chains'

import * as Html from '../../../server/Html.js'

const root = document.getElementById(window.__mppx_root ?? Html.elements.method)
if (!root) throw new Error('Missing root element')

const walletsElement = document.createElement('div')
walletsElement.id = 'wallets'
walletsElement.className = Html.classNames.wallets
root.appendChild(walletsElement)

const connectedElement = document.createElement('div')
connectedElement.id = 'connected'
connectedElement.hidden = true
root.appendChild(connectedElement)

const payButton = document.createElement('button')
payButton.id = 'pay-button'
payButton.className = Html.classNames.button
payButton.type = 'button'
connectedElement.appendChild(payButton)

const statusElement = document.createElement('output')
statusElement.id = 'status'
statusElement.className = Html.classNames.status
connectedElement.appendChild(statusElement)

const disconnectParagraph = document.createElement('p')
disconnectParagraph.className = Html.classNames.disconnect
connectedElement.appendChild(disconnectParagraph)

const disconnectButton = document.createElement('button')
disconnectButton.id = 'disconnect-button'
disconnectButton.className = Html.classNames.buttonTertiary
disconnectButton.type = 'button'
disconnectButton.textContent = 'Disconnect'
disconnectParagraph.appendChild(disconnectButton)

const store = createStore()
let activeProvider: EIP1193Provider | null = null
let activeAccount: string | null = null

function renderWallets() {
  if (activeAccount) return
  const providers = store.getProviders()
  if (!providers.length) {
    walletsElement.innerHTML = '<p>No wallets detected.</p>'
    return
  }
  walletsElement.innerHTML = ''
  for (const p of providers) {
    const button = document.createElement('button')
    button.className =
      providers.length === 1 ? Html.classNames.button : Html.classNames.buttonSecondary
    button.textContent = providers.length === 1 ? 'Connect Wallet' : `Connect ${p.info.name}`
    button.onclick = () => connect(p.provider, p.info.rdns)
    walletsElement.appendChild(button)
  }
}

function showConnected(account: string) {
  activeAccount = account
  walletsElement.hidden = true
  connectedElement.hidden = false
}

const STORAGE_KEY = 'mppx:wallet'

function disconnect() {
  activeProvider = null
  activeAccount = null
  sessionStorage.removeItem(STORAGE_KEY)
  walletsElement.hidden = false
  connectedElement.hidden = true
  renderWallets()
}

disconnectButton.onclick = disconnect
payButton.onclick = () => pay()

const request = mppx.challenge.request
payButton.textContent = 'Pay'

// Reconnect previously connected wallet silently
async function tryReconnect() {
  if (activeAccount) return
  const savedRdns = sessionStorage.getItem(STORAGE_KEY)
  if (!savedRdns) return
  const match = store.getProviders().find((p) => p.info.rdns === savedRdns)
  if (!match) return
  try {
    const accounts = (await match.provider.request({ method: 'eth_accounts' })) as string[]
    const account = accounts[0]
    if (!account) return
    activeProvider = match.provider
    showConnected(account)
  } catch {}
}

store.subscribe(() => {
  renderWallets()
  tryReconnect()
})
renderWallets()
tryReconnect()

// Register formatted amount and fetch token symbol
const methodKey = window.__mppx_active ?? 'tempo/charge'
const decimals = (request.decimals as number | undefined) ?? 0
const displayAmount = (Number(request.amount) / 10 ** decimals).toLocaleString(navigator.language, {
  minimumFractionDigits: 2,
  maximumFractionDigits: decimals,
})
dispatchEvent(new CustomEvent('mppx:amount', { detail: { key: methodKey, amount: displayAmount } }))

// Fetch token symbol and update
;(async () => {
  try {
    const chainId = request.methodDetails?.chainId
    const chain = (() => {
      if (chainId === tempoMainnet.id) return tempoMainnet
      if (chainId === tempoModerato.id) return tempoModerato
      if (chainId === tempoLocalnet.id) return tempoLocalnet
      return undefined
    })()
    if (!chain) return
    const publicClient = createPublicClient({ chain, transport: http() })
    const symbol = await readContract(publicClient, {
      address: getAddress(request.currency),
      abi: parseAbi(['function symbol() view returns (string)']),
      functionName: 'symbol',
    })
    if (symbol)
      dispatchEvent(
        new CustomEvent('mppx:amount', {
          detail: { key: methodKey, amount: `${displayAmount} ${symbol}` },
        }),
      )
  } catch {}
})()

async function connect(provider: EIP1193Provider, rdns?: string) {
  const accounts = (await provider.request({ method: 'eth_requestAccounts' })) as string[]
  const account = accounts[0]
  if (!account) throw new Error('No account selected')
  activeProvider = provider
  if (rdns) sessionStorage.setItem(STORAGE_KEY, rdns)
  showConnected(account)
}

async function pay() {
  if (!activeProvider || !activeAccount) return
  payButton.disabled = true

  try {
    const chainId = request.methodDetails?.chainId
    const chain = (() => {
      if (chainId === tempoMainnet.id) return tempoMainnet
      if (chainId === tempoModerato.id) return tempoModerato
      if (chainId === tempoLocalnet.id) return tempoLocalnet
      throw new Error(`Unsupported chain: ${chainId}`)
    })()
    const hexChainId = `0x${chainId.toString(16)}`

    const currentChain = await activeProvider.request({ method: 'eth_chainId' })
    if (parseInt(currentChain, 16) !== chainId) {
      try {
        await activeProvider.request({
          method: 'wallet_switchEthereumChain',
          params: [{ chainId: hexChainId }],
        })
      } catch (error) {
        if ((error as RpcError).code === 4902) {
          await activeProvider.request({
            method: 'wallet_addEthereumChain',
            params: [
              {
                chainId: hexChainId,
                chainName: chain.name,
                nativeCurrency: { ...chain.nativeCurrency, decimals: 18 },
                rpcUrls: [chain.rpcUrls.default.http[0]],
              },
            ],
          })
        } else throw error
      }
    }

    const client = createClient({
      account: getAddress(activeAccount),
      chain,
      transport: custom(activeProvider),
    })

    const receipt = await sendTransactionSync(client, {
      to: getAddress(request.currency),
      data: encodeFunctionData({
        abi: parseAbi(['function transfer(address to, uint256 amount)']),
        args: [getAddress(request.recipient ?? ''), BigInt(request.amount)],
      }),
    })

    mppx.dispatch(
      { hash: receipt.transactionHash, type: 'hash' },
      `did:pkh:eip155:${chainId}:${activeAccount}`,
    )
  } catch {
    payButton.disabled = false
  }
}
