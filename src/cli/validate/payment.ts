import * as Challenge from '../../Challenge.js'
import * as Constants from '../../Constants.js'
import * as Mppx from '../../client/Mppx.js'
import * as Receipt from '../../Receipt.js'
import { loadConfig, selectChallenge } from '../internal.js'
import { confirm, pc } from '../utils.js'
import type { CheckResult, EndpointSpec } from './helpers.js'
import { buildUrl, check, fail, fetchWithTimeout, formatBytes, MAINNET_CHAIN_ID, skip, warn } from './helpers.js'

async function provisionAndPayTestnet(
  challenge: Challenge.Challenge,
  verbose: boolean,
): Promise<{ methods: import('../../Method.js').AnyClient[] } | undefined> {
  try {
    console.log(pc.dim('    Provisioning testnet wallet and funding via faucet...'))
    const { privateKeyToAccount, generatePrivateKey } = await import('viem/accounts')
    const key = generatePrivateKey()
    const account = privateKeyToAccount(key)

    const { createClient, http } = await import('viem')
    const { tempoModerato } = await import('viem/tempo/chains')
    const client = createClient({ chain: tempoModerato, transport: http() })
    const { Actions } = await import('viem/tempo')
    const hashes = await Actions.faucet.fund(client, { account })
    const { waitForTransactionReceipt } = await import('viem/actions')
    await Promise.all(hashes.map((hash) => waitForTransactionReceipt(client, { hash })))
    console.log(pc.dim(`    Using wallet: ${account.address}`))

    const { tempo } = await import('../../tempo/client/index.js')
    const methods = [...tempo({ account })]
    return { methods }
  } catch (error) {
    if (verbose) console.log(pc.dim(`    Provisioning failed: ${(error as Error).message}`))
    return undefined
  }
}

// Resolves the wallet address using the same priority as the Tempo plugin:
// MPPX_PRIVATE_KEY env > Tempo CLI keystore > OS keychain.
async function resolveWalletAddress(): Promise<string | undefined> {
  const { resolveAccountName, createKeychain } = await import('../account.js')
  const { isTempoAccount } = await import('../utils.js')
  const { resolveTempoAccount } = await import('../plugins/tempo.js')
  const { privateKeyToAccount } = await import('viem/accounts')

  const accountName = resolveAccountName()
  const envKey = process.env.MPPX_PRIVATE_KEY?.trim()
  if (envKey) return privateKeyToAccount(envKey as `0x${string}`).address
  if (isTempoAccount(accountName)) {
    const entry = resolveTempoAccount(accountName)
    if (entry) return entry.wallet_address
  }
  const key = await createKeychain(accountName).get()
  if (key) return privateKeyToAccount(key as `0x${string}`).address
  return undefined
}

export async function validatePaymentFlow(
  baseUrl: string,
  endpoint: EndpointSpec,
  verbose: boolean,
  options?: { body?: string | undefined; query?: string[] | undefined; yes?: boolean | undefined },
): Promise<CheckResult[]> {
  const results: CheckResult[] = []
  const url = buildUrl(baseUrl, endpoint, options?.query)
  const fetchHeaders: Record<string, string> = {}
  let fetchBody: string | undefined
  if (options?.body) {
    fetchBody = options.body
    fetchHeaders['content-type'] = 'application/json'
  }

  // Get a fresh challenge
  let challengeResponse: Response
  try {
    challengeResponse = await fetchWithTimeout(url, {
      method: endpoint.method,
      headers: fetchHeaders,
      body: fetchBody ?? null,
    })
  } catch (error) {
    results.push(fail('Payment: fetch challenge', (error as Error).message))
    return results
  }

  if (challengeResponse.status !== 402) {
    results.push(skip('Payment: skipped', `Endpoint returned ${challengeResponse.status}`))
    return results
  }

  // Parse challenge
  let challenge: Challenge.Challenge
  try {
    challenge = Challenge.fromResponse(challengeResponse)
  } catch (error) {
    results.push(fail('Payment: parse challenge', (error as Error).message))
    return results
  }

  // Detect network
  const request = challenge.request as Record<string, unknown>
  const methodDetails = request.methodDetails as Record<string, unknown> | undefined
  const isTestnet = typeof methodDetails?.chainId === 'number' && methodDetails.chainId !== MAINNET_CHAIN_ID

  // Testnet Tempo: always use ephemeral wallet (zero-setup, free money)
  if (isTestnet && challenge.method === Constants.Methods.tempo) {
    const provisioned = await provisionAndPayTestnet(challenge, verbose)
    if (provisioned) {
      const fakeResp = new Response(null, {
        status: 402,
        headers: { [Constants.Headers.wwwAuthenticate]: Challenge.serialize(challenge) },
      })
      try {
        const mppx = Mppx.create({ methods: provisioned.methods, polyfill: false })
        const cred = await mppx.createCredential(fakeResp)
        results.push(check('Payment: credential created', 'ephemeral testnet wallet'))
        return await sendAndValidateResponse(results, url, endpoint, cred, fetchHeaders, fetchBody, verbose, true)
      } catch (error) {
        results.push(fail('Payment: create credential', (error as Error).message))
        return results
      }
    } else {
      results.push(fail('Payment: auto-provision wallet', 'Failed to create and fund testnet wallet'))
      return results
    }
  }

  // Mainnet: use configured wallet
  const loaded = await loadConfig().catch(() => undefined)
  const selected = selectChallenge([challenge], loaded?.config)

  if (!selected) {
    results.push(skip('Payment: no configured method', `Need ${challenge.method}/${challenge.intent}`, 'Run "mppx account create" to create a local wallet for payment testing. The wallet is stored on your machine and only used by mppx.'))
    return results
  }

  const { plugin, method: directMethod } = selected

  if (!plugin && !directMethod) {
    results.push(skip('Payment: no plugin available', `${challenge.method}/${challenge.intent}`))
    return results
  }

  const requiredAmount = request.amount ? BigInt(request.amount as string) : undefined
  const decimals = (request.decimals as number | undefined) ?? 6
  const currency = request.currency as string | undefined

  // Pre-flight balance check
  let walletAddress: string | undefined
  if (challenge.method === Constants.Methods.tempo && requiredAmount && currency) {
    try {
      walletAddress = await resolveWalletAddress()
      if (walletAddress) {
        const { fetchTokenInfo } = await import('../utils.js')
        const { createClient, http } = await import('viem')
        const { tempo: tempoMainnetChain } = await import('viem/tempo/chains')
        const client = createClient({ chain: tempoMainnetChain, transport: http() })
        const tokenInfo = await fetchTokenInfo(client, currency as `0x${string}`, walletAddress as `0x${string}`)
        const requiredDisplay = `$${(Number(requiredAmount) / 10 ** decimals).toFixed(2)}`
        const balanceDisplay = `$${(Number(tokenInfo.balance) / 10 ** tokenInfo.decimals).toFixed(2)}`

        if (tokenInfo.balance < requiredAmount) {
          console.log(pc.dim(`    Wallet: ${walletAddress}`))
          console.log(pc.dim(`    Balance: ${balanceDisplay} ${tokenInfo.symbol}`))
          const hint = `Wallet ${walletAddress} has ${balanceDisplay} but endpoint requires ${requiredDisplay}. Fund this wallet to run payment tests, or use a testnet server.`
          results.push(skip('Payment: insufficient balance', `Have ${balanceDisplay}, need ${requiredDisplay}`, hint))
          return results
        }
      }
    } catch (e) {
      if (verbose) console.log(pc.dim(`    Balance check skipped: ${(e as Error).message}`))
    }
  }

  // Prompt before paying on mainnet (unless --yes)
  const amountDisplay = requiredAmount ? `$${(Number(requiredAmount) / 10 ** decimals).toFixed(2)}` : 'unknown amount'
  if (walletAddress) console.log(pc.dim(`    Using wallet: ${walletAddress}`))
  if (!options?.yes) {
    console.log('')
    const ok = await confirm(
      `  ${pc.yellow('Mainnet payment:')} Will transfer ${amountDisplay} to ${String(request.recipient).slice(0, 10)}... Continue?`,
      false,
    )
    if (!ok) {
      results.push(skip('Payment: skipped by user', 'mainnet payment declined'))
      return results
    }
  } else {
    console.log(pc.dim(`    Auto-approved: ${amountDisplay} to ${String(request.recipient).slice(0, 10)}...`))
  }

  // Setup plugin or use direct method
  let methods: import('../../Method.js').AnyClient[]
  let createCredentialFn: ((response: Response) => Promise<string>) | undefined

  if (plugin) {
    try {
      const pluginResult = await plugin.setup({
        challenge,
        options: { network: 'mainnet' },
        methodOpts: {},
      })
      methods = pluginResult.methods
      createCredentialFn = pluginResult.createCredential
    } catch (error) {
      const msg = (error as Error).message
      if (msg.includes('No account found') || msg.includes('not found')) {
        results.push(skip('Payment: no wallet configured', msg))
      } else {
        results.push(fail('Payment: wallet setup', msg))
      }
      return results
    }
  } else {
    methods = [directMethod!]
  }

  // Create credential
  let credential: string
  const fakeResponse = new Response(null, {
    status: 402,
    headers: { [Constants.Headers.wwwAuthenticate]: Challenge.serialize(challenge) },
  })
  try {
    if (createCredentialFn) {
      credential = await createCredentialFn(fakeResponse)
    } else {
      const mppx = Mppx.create({ methods, polyfill: false })
      credential = await mppx.createCredential(fakeResponse)
    }
  } catch (error) {
    const msg = (error as Error).message
    const isInsufficientBalance = msg.toLowerCase().includes('insufficientbalance') || msg.toLowerCase().includes('insufficient')
    if (isInsufficientBalance) {
      const match = msg.match(/available:\s*(\d+),\s*required:\s*(\d+)/)
      const available = match ? BigInt(match[1]!) : undefined
      const required = match ? BigInt(match[2]!) : requiredAmount
      const fromMatch = msg.match(/from:\s*(0x[0-9a-fA-F]{40})/)
      const fromAddr = fromMatch?.[1]
      const requiredDisplay = required ? `$${(Number(required) / 10 ** decimals).toFixed(2)}` : 'unknown'
      const availableDisplay = available !== undefined ? `$${(Number(available) / 10 ** decimals).toFixed(2)}` : undefined
      const detail = availableDisplay ? `Have ${availableDisplay}, need ${requiredDisplay}` : `Endpoint requires ${requiredDisplay}`
      const hint = fromAddr
        ? `Wallet ${fromAddr} needs at least ${requiredDisplay}. This is a local wallet created by "mppx account create". Fund it to run payment tests, or point at a testnet server for free validation.`
        : `Fund your mppx wallet with at least ${requiredDisplay} to run payment tests, or use a testnet server.`
      results.push(skip('Payment: insufficient balance', detail, hint))
      return results
    }
    results.push(fail('Payment: create credential', msg))
    return results
  }

  results.push(check('Payment: credential created'))

  // Prepare and send
  plugin?.prepareCredentialRequest?.({ challenge, credential, headers: fetchHeaders })
  return await sendAndValidateResponse(results, url, endpoint, credential, fetchHeaders, fetchBody, verbose, isTestnet)
}

async function sendAndValidateResponse(
  results: CheckResult[],
  url: string,
  endpoint: EndpointSpec,
  credential: string,
  baseHeaders: Record<string, string>,
  fetchBody: string | undefined,
  verbose: boolean,
  isTestnet?: boolean,
): Promise<CheckResult[]> {
  let paymentResponse: Response
  try {
    paymentResponse = await fetchWithTimeout(url, {
      method: endpoint.method,
      headers: { ...baseHeaders, [Constants.Headers.authorization]: credential },
      body: fetchBody ?? null,
    }, 30_000)
  } catch (error) {
    results.push(fail('Payment: send credential', (error as Error).message))
    return results
  }

  if (paymentResponse.status === 402) {
    const body = await paymentResponse.text().catch(() => '')
    let detail = 'Payment rejected'
    try {
      const problem = JSON.parse(body) as Record<string, unknown>
      detail = (problem.detail as string) ?? (problem.title as string) ?? detail
    } catch {}
    results.push(fail('Payment: accepted', detail, 'The server rejected a valid credential. Check that your payment verification logic accepts the credential format and that the payment was processed on-chain.'))
    return results
  }

  if (paymentResponse.status >= 400 && paymentResponse.status < 500) {
    results.push(warn('Payment: post-payment response', `Got ${paymentResponse.status}`, 'Payment succeeded but the endpoint returned a client error. The endpoint likely requires request body parameters. Use --body to provide them.'))
  } else if (paymentResponse.status >= 500) {
    results.push(fail('Payment: server response', `Got ${paymentResponse.status}`, 'Payment was accepted but the server errored while generating the response. Check server logs for the underlying error.'))
    return results
  } else {
    results.push(check('Payment: successful', `HTTP ${paymentResponse.status}`))
  }

  // Validate receipt
  const receiptHeader = paymentResponse.headers.get(Constants.Headers.paymentReceipt)
  if (!receiptHeader) {
    results.push(fail('Payment-Receipt header present', undefined, 'After accepting payment, include a Payment-Receipt header with a base64url-encoded JSON object containing: method, reference, status ("success"), and timestamp (ISO 8601).'))
  } else {
    results.push(check('Payment-Receipt header present'))
    try {
      const receipt = Receipt.deserialize(receiptHeader)
      results.push(check('Receipt parseable'))

      if (receipt.status === 'success') {
        results.push(check('Receipt status is "success"'))
      } else {
        results.push(fail('Receipt status is "success"', `Got: ${receipt.status}`))
      }

      if (receipt.reference) {
        const validTxHash = /^0x[0-9a-fA-F]{64}$/.test(receipt.reference)
        const validStripeRef = receipt.reference.startsWith('pi_')
        if (validTxHash || validStripeRef) {
          results.push(check('Receipt reference valid', receipt.reference.slice(0, 20) + '...'))
        } else {
          results.push(warn('Receipt reference format', receipt.reference.slice(0, 40)))
        }
      } else {
        results.push(warn('Receipt has reference', 'No reference field'))
      }

      if (receipt.timestamp) {
        const ts = new Date(receipt.timestamp)
        const age = Date.now() - ts.getTime()
        if (age < 60_000) {
          results.push(check('Receipt timestamp recent', `${Math.round(age / 1000)}s ago`))
        } else {
          results.push(warn('Receipt timestamp recent', `${Math.round(age / 60000)}m ago`))
        }
      }

      if (verbose) {
        console.log(pc.dim(`    Receipt: ${JSON.stringify(receipt, null, 2)}`))
      }
    } catch (error) {
      results.push(fail('Receipt parseable', (error as Error).message))
    }
  }

  // Validate response body
  const contentType = paymentResponse.headers.get('content-type') ?? ''
  const body = await paymentResponse.text().catch(() => '')

  if (body.length > 0) {
    results.push(check('Response body non-empty', `${contentType.split(';')[0]}, ${formatBytes(body.length)}`))
  } else {
    const suspiciousHeaders = [...paymentResponse.headers.entries()].filter(
      ([key]) =>
        !key.startsWith('x-') &&
        !['content-type', 'content-length', 'date', 'server', 'connection', 'keep-alive',
          'cache-control', 'vary', 'access-control-allow-origin', 'payment-receipt',
          'payment-session', 'payment-session-snapshot'].includes(key.toLowerCase()),
    )
    if (suspiciousHeaders.length > 0) {
      results.push(warn('Response body empty -- data may be in headers only', suspiciousHeaders.map(([k]) => k).join(', ')))
    } else {
      results.push(warn('Response body empty'))
    }
  }

  if (!contentType) {
    results.push(warn('Content-Type header set'))
  } else {
    results.push(check('Content-Type header set', contentType.split(';')[0]))
  }

  // Explorer link for on-chain payments
  if (receiptHeader) {
    try {
      const receipt = Receipt.deserialize(receiptHeader)
      if (receipt.reference && /^0x[0-9a-fA-F]{64}$/.test(receipt.reference)) {
        const { tempoModerato, tempo: tempoMainnetChain } = await import('viem/tempo/chains')
        const chain = isTestnet ? tempoModerato : tempoMainnetChain
        const explorerUrl = chain.blockExplorers?.default?.url
        if (explorerUrl) {
          results.push(check('On-chain transaction', `${explorerUrl}/receipt/${receipt.reference}`))
        }
      }
    } catch {}
  }

  return results
}
