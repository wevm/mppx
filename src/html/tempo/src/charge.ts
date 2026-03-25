import { createStore } from 'mipd'
import type { EIP1193Provider } from 'mipd'
import { createClient, custom, encodeFunctionData, getAddress, parseAbi, RpcError } from 'viem'
import { sendTransactionSync } from 'viem/actions'
import { tempo as tempoMainnet, tempoLocalnet, tempoModerato } from 'viem/chains'

import { methodElementId } from '../../../server/Html.js'

const root = document.getElementById(methodElementId)
if (!root) throw new Error('Missing root element')

const walletsElement = document.createElement('div')
walletsElement.id = 'wallets'
root.appendChild(walletsElement)

const connectedElement = document.createElement('div')
connectedElement.id = 'connected'
connectedElement.hidden = true
root.appendChild(connectedElement)

const payButton = document.createElement('button')
payButton.id = 'pay-btn'
payButton.type = 'button'
connectedElement.appendChild(payButton)

const statusElement = document.createElement('output')
connectedElement.appendChild(statusElement)

const disconnectParagraph = document.createElement('p')
connectedElement.appendChild(disconnectParagraph)

const disconnectButton = document.createElement('button')
disconnectButton.id = 'disconnect-btn'
disconnectButton.type = 'button'
disconnectButton.textContent = 'Disconnect'
disconnectParagraph.appendChild(disconnectButton)

disconnectParagraph.append(' ')

const accountDisplay = document.createElement('code')
accountDisplay.id = 'account-display'
disconnectParagraph.appendChild(accountDisplay)

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
    button.textContent = `Connect ${p.info.name}`
    button.onclick = () => connect(p.provider)
    walletsElement.appendChild(button)
  }
}

function showConnected(account: string) {
  activeAccount = account
  accountDisplay.textContent = `${account.slice(0, 6)}...${account.slice(-4)}`
  walletsElement.hidden = true
  connectedElement.hidden = false
}

function disconnect() {
  activeProvider = null
  activeAccount = null
  walletsElement.hidden = false
  connectedElement.hidden = true
  renderWallets()
}

disconnectButton.onclick = disconnect
payButton.onclick = () => pay()

const request = mppx.challenge.request
payButton.textContent = 'Pay with wallet'

store.subscribe(renderWallets)
renderWallets()

async function connect(provider: EIP1193Provider) {
  const accounts = (await provider.request({ method: 'eth_requestAccounts' })) as string[]
  const account = accounts[0]
  if (!account) throw new Error('No account selected')
  activeProvider = provider
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
