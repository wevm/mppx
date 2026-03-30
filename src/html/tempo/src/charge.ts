import { local, Provider } from 'accounts'
import {
  createClient,
  createPublicClient,
  custom,
  defineChain,
  encodeFunctionData,
  getAddress,
  http,
  parseAbi,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { readContract } from 'viem/actions'
import { sendTransactionSync } from 'viem/actions'
import { tempo as tempoMainnet, tempoLocalnet, tempoModerato } from 'viem/chains'

import type { Methods } from '../../../tempo/index.js'
import type { charge } from '../../../tempo/server/Charge.js'
import { mount } from '../../index.js'

mount<typeof Methods.charge, charge.HtmlConfig>((c) => {
  const request = c.challenge.request
  const tempoLogo =
    '<svg width="184" height="41" viewBox="0 0 184 41" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M13.6424 40.3635H2.80251L12.8492 9.60026H0L2.80251 0.58344H38.6006L35.7981 9.60026H23.6362L13.6424 40.3635Z" fill="currentColor"/><path d="M53.9809 40.3635H28.2824L41.1846 0.58344H66.7773L64.3449 8.16818H49.4863L46.7896 16.7076H61.1723L58.7399 24.1863H44.3043L41.6076 32.7788H56.3604L53.9809 40.3635Z" fill="currentColor"/><path d="M65.6123 40.3635H56.9933L69.9483 0.58344H84.331L83.8551 22.0647L97.8676 0.58344H113.625L100.723 40.3635H89.936L98.5021 13.6313H98.3435L80.7353 40.3635H74.3371L74.6015 13.3131H74.4957L65.6123 40.3635Z" fill="currentColor"/><path d="M125.758 7.95602L121.581 20.7917H122.744C125.388 20.7917 127.592 20.1729 129.354 18.9353C131.117 17.6624 132.262 15.859 132.791 13.5252C133.249 11.5097 133.003 10.0776 132.051 9.22898C131.099 8.38034 129.513 7.95602 127.292 7.95602H125.758ZM115.289 40.3635H104.449L117.351 0.58344H130.517C133.549 0.58344 136.158 1.07848 138.343 2.06856C140.564 3.02328 142.186 4.40233 143.208 6.20569C144.266 7.97369 144.618 10.0423 144.266 12.4114C143.807 15.5231 142.609 18.2635 140.67 20.6326C138.731 23.0017 136.211 24.8405 133.108 26.1488C130.042 27.4217 126.604 28.0582 122.797 28.0582H119.255L115.289 40.3635Z" fill="currentColor"/><path d="M170.103 37.8176C166.507 39.9392 162.682 41 158.628 41H158.523C154.927 41 151.895 40.2044 149.428 38.6132C146.995 36.9866 145.25 34.7943 144.193 32.0362C143.171 29.2781 142.924 26.2549 143.453 22.9664C144.122 18.8292 145.656 15.0103 148.053 11.5097C150.45 8.00906 153.446 5.21561 157.042 3.12937C160.638 1.04312 164.48 0 168.569 0H168.675C172.412 0 175.496 0.795602 177.929 2.38681C180.396 3.97801 182.106 6.15265 183.058 8.91074C184.045 11.6335 184.256 14.6921 183.692 18.0867C183.023 22.0824 181.489 25.8482 179.092 29.3842C176.695 32.8849 173.699 35.696 170.103 37.8176ZM155.138 30.9754C156.09 32.7788 157.747 33.6805 160.109 33.6805H160.215C162.154 33.6805 163.951 32.9556 165.608 31.5058C167.3 30.0207 168.728 28.0405 169.891 25.5653C171.09 23.0901 171.971 20.332 172.535 17.2911C173.064 14.3208 172.852 11.934 171.901 10.1307C170.949 8.29194 169.31 7.37257 166.983 7.37257H166.877C165.079 7.37257 163.335 8.11514 161.642 9.60026C159.986 11.0854 158.54 13.0832 157.306 15.5938C156.073 18.1044 155.174 20.8271 154.61 23.762C154.046 26.7322 154.222 29.1367 155.138 30.9754Z" fill="currentColor"/></svg>'

  const walletsElement = document.createElement('div')
  walletsElement.id = 'wallets'
  walletsElement.className = c.classNames.wallets
  c.root.appendChild(walletsElement)

  const connectButton = document.createElement('button')
  connectButton.className = c.classNames.button
  connectButton.type = 'button'
  connectButton.ariaLabel = 'Continue with Tempo'
  connectButton.style.alignItems = 'center'
  connectButton.style.display = 'inline-flex'
  connectButton.style.gap = '0.375rem'
  connectButton.style.justifyContent = 'center'

  const connectLabel = document.createElement('span')
  connectLabel.textContent = 'Continue with'
  connectButton.appendChild(connectLabel)

  const connectLogo = document.createElement('span')
  connectLogo.ariaHidden = 'true'
  connectLogo.innerHTML = tempoLogo
  connectLogo.style.display = 'block'
  const connectLogoSvg = connectLogo.firstElementChild as SVGSVGElement | null
  if (connectLogoSvg) {
    connectLogoSvg.style.display = 'block'
    connectLogoSvg.style.height = '14px'
    connectLogoSvg.style.width = 'auto'
  }
  connectButton.appendChild(connectLogo)

  walletsElement.appendChild(connectButton)

  const connectedElement = document.createElement('div')
  connectedElement.id = 'connected'
  connectedElement.hidden = true
  c.root.appendChild(connectedElement)

  const payButton = document.createElement('button')
  payButton.id = 'pay-button'
  payButton.className = c.classNames.button
  payButton.type = 'button'
  connectedElement.appendChild(payButton)

  const statusElement = document.createElement('output')
  statusElement.id = 'status'
  statusElement.className = c.classNames.status
  connectedElement.appendChild(statusElement)

  const disconnectParagraph = document.createElement('p')
  disconnectParagraph.className = c.classNames.disconnect
  connectedElement.appendChild(disconnectParagraph)

  const disconnectButton = document.createElement('button')
  disconnectButton.id = 'disconnect-button'
  disconnectButton.className = c.classNames.buttonTertiary
  disconnectButton.type = 'button'
  disconnectButton.textContent = 'Disconnect'
  disconnectParagraph.appendChild(disconnectButton)

  const tempoMain = getConfiguredChain(tempoMainnet)
  const tempoTestnet = getConfiguredChain(tempoModerato)
  const tempoLocal = getConfiguredChain(tempoLocalnet)
  function getConfiguredChain<
    chain extends typeof tempoMainnet | typeof tempoModerato | typeof tempoLocalnet,
  >(chain: chain) {
    const rpcUrl = c.config.rpcUrls?.[chain.id]
    if (typeof rpcUrl !== 'string') return chain
    return defineChain({
      ...chain,
      rpcUrls: { default: { http: [rpcUrl] } },
    })
  }

  const localStoreAccount = (() => {
    if (!c.config.accountsPrivateKey) return undefined
    const localAccount = privateKeyToAccount(c.config.accountsPrivateKey)
    return {
      address: localAccount.address,
      keyType: 'secp256k1' as const,
      privateKey: c.config.accountsPrivateKey,
    }
  })()

  const provider = Provider.create({
    chains: [tempoMain, tempoTestnet, tempoLocal],
    ...(localStoreAccount
      ? {
          adapter: local({
            async loadAccounts() {
              return {
                accounts: [localStoreAccount],
              }
            },
          }),
        }
      : {}),
  })

  let activeAccount: string | null = null

  function getChain(chainId: number | undefined) {
    if (chainId === tempoMain.id) return tempoMain
    if (chainId === tempoTestnet.id) return tempoTestnet
    if (chainId === tempoLocal.id) return tempoLocal
    throw new Error(`Unsupported chain: ${chainId}`)
  }

  function showConnected(account: string) {
    activeAccount = account
    statusElement.textContent = ''
    walletsElement.hidden = true
    connectedElement.hidden = false
  }

  function showWallets() {
    activeAccount = null
    statusElement.textContent = ''
    disconnectParagraph.hidden = false
    walletsElement.hidden = false
    connectedElement.hidden = true
  }

  disconnectButton.onclick = () => {
    void disconnect().catch(() => {})
  }
  connectButton.onclick = () => {
    void connect().catch(() => {})
  }
  payButton.onclick = () => pay()

  payButton.textContent = 'Pay'

  async function tryReconnect() {
    if (activeAccount) return
    try {
      const accounts = await provider.request({ method: 'eth_accounts' })
      const account = accounts[0]
      if (!account) return
      showConnected(account)
    } catch {}
  }
  void tryReconnect()

  // Register formatted amount and fetch token symbol
  const decimals = (request.decimals as number | undefined) ?? 0
  const displayAmount = (Number(request.amount) / 10 ** decimals).toLocaleString(
    navigator.language,
    {
      minimumFractionDigits: 2,
      maximumFractionDigits: decimals,
    },
  )
  c.set('amount', displayAmount)

  // Fetch token symbol and update
  ;(async () => {
    try {
      const chain = getChain(request.methodDetails?.chainId)
      const publicClient = createPublicClient({ chain, transport: http() })
      const symbol = await readContract(publicClient, {
        address: getAddress(request.currency),
        abi: parseAbi(['function symbol() view returns (string)']),
        functionName: 'symbol',
      })
      if (symbol) c.set('amount', `${displayAmount} ${symbol}`)
    } catch {}
  })()

  async function connect() {
    connectButton.disabled = true
    statusElement.textContent = ''
    try {
      const result = await provider.request({ method: 'wallet_connect' })
      const account = result.accounts[0]?.address
      if (!account) throw new Error('No account selected')
      showConnected(account)
    } finally {
      connectButton.disabled = false
    }
  }

  async function disconnect() {
    await provider.request({ method: 'wallet_disconnect' })
    showWallets()
  }

  async function pay() {
    if (!activeAccount) return
    payButton.disabled = true
    statusElement.textContent = ''

    try {
      const chain = getChain(request.methodDetails?.chainId)
      const hexChainId = `0x${chain.id.toString(16)}` as `0x${string}`

      const currentChain = await provider.request({ method: 'eth_chainId' })
      if (parseInt(currentChain, 16) !== chain.id)
        await provider.request({
          method: 'wallet_switchEthereumChain',
          params: [{ chainId: hexChainId }],
        })

      const client = createClient({
        account: getAddress(activeAccount),
        chain,
        transport: custom(provider),
      })

      const receipt = await sendTransactionSync(client, {
        to: getAddress(request.currency),
        data: encodeFunctionData({
          abi: parseAbi(['function transfer(address to, uint256 amount)']),
          args: [getAddress(request.recipient ?? ''), BigInt(request.amount)],
        }),
      })

      disconnectParagraph.hidden = true
      c.dispatch(
        { hash: receipt.transactionHash, type: 'hash' },
        `did:pkh:eip155:${chain.id}:${activeAccount}`,
      )
    } catch (error) {
      statusElement.textContent = error instanceof Error ? error.message : 'Payment failed'
      payButton.disabled = false
    }
  }
})
