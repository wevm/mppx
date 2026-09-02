import * as childProcess from 'node:child_process'

import { type Address, type Chain, createClient, erc20Abi, http } from 'viem'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'
import { readContract, waitForTransactionReceipt } from 'viem/actions'
import * as viemChains from 'viem/chains'
import { Actions } from 'viem/tempo'
import { tempoModerato, tempo as tempoMainnetChain } from 'viem/tempo/chains'

import * as Challenge from '../../Challenge.js'
import * as Mppx from '../../client/Mppx.js'
import * as Constants from '../../Constants.js'
import type { AnyClient } from '../../Method.js'
import * as Receipt from '../../Receipt.js'
import { tempo as tempoMethods } from '../../tempo/client/index.js'
import { chainId as tempoChainIds } from '../../tempo/internal/defaults.js'
import { resolveAccount, resolveAccountName } from '../account.js'
import type { Config } from '../config.js'
import type * as Extension from '../Extension.js'
import { loadConfig, preparePayment, resolvePlugin } from '../internal.js'
import { fetchTokenInfo, confirm, pc } from '../utils.js'
import { buildUrl } from './discovery.js'
import type { CheckResult, EndpointSpec } from './helpers.js'
import {
  check,
  fail,
  fetchWithTimeout,
  formatBytes,
  isValidIntegerAmount,
  parseHeaders,
  skip,
  warn,
} from './helpers.js'

async function provisionAndPayTestnet(
  challenge: Challenge.Challenge,
  verbose: boolean,
  silent?: boolean,
): Promise<{ methods: AnyClient[] } | undefined> {
  try {
    if (!silent) console.log(pc.dim('    Provisioning testnet wallet and funding via faucet...'))
    const key = generatePrivateKey()
    const account = privateKeyToAccount(key)

    const client = createClient({ chain: tempoModerato, transport: http() })
    const hashes = await Actions.faucet.fund(client, { account })
    await Promise.all(hashes.map((hash) => waitForTransactionReceipt(client, { hash })))
    if (!silent) console.log(pc.dim(`    Using wallet: ${account.address}`))

    // The faucet tx receipt can land before the RPC's balance reads are
    // consistent with it, so poll briefly for the funded balance to appear
    // rather than racing straight into the charge.
    const currency = (challenge.request as Record<string, unknown>).currency
    if (typeof currency === 'string') {
      for (let attempt = 0; attempt < 10; attempt++) {
        const balance = await Actions.token
          .getBalance(client, { account: account.address, token: currency as Address })
          .catch(() => undefined)
        if (balance && balance.amount > 0n) break
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
    }

    const methods = [...tempoMethods({ account })]
    return { methods }
  } catch (error) {
    if (verbose) console.log(pc.dim(`    Provisioning failed: ${(error as Error).message}`))
    return undefined
  }
}

async function resolveWalletAddress(): Promise<string | undefined> {
  const accountName = resolveAccountName()
  const { isTempoAccount } = await import('../utils.js')
  const { resolveTempoAccount } = await import('../plugins/tempo.js')
  if (isTempoAccount(accountName)) {
    const entry = resolveTempoAccount(accountName)
    if (entry) return entry.wallet_address
  }
  try {
    const account = await resolveAccount()
    return account.address
  } catch {
    return undefined
  }
}

// Auto-detect Stripe test key from the Stripe CLI if installed and logged in.
function resolveStripeKey(verbose: boolean): string | undefined {
  try {
    const { execSync } = childProcess
    const output = execSync('stripe config --list', { encoding: 'utf8', timeout: 5000 })
    const match = output.match(/test_mode_api_key\s*=\s*'([^']+)'/)
    if (match?.[1]) {
      if (verbose) console.log(pc.dim('    Using Stripe test key from stripe CLI'))
      return match[1]
    }
  } catch {}
  return undefined
}

async function fetchEvmTokenInfo(
  chain: Chain,
  token: Address,
  account: Address,
): Promise<{ balance: bigint; symbol: string | undefined }> {
  const client = createClient({ chain, transport: http() })
  const [balance, symbol] = await Promise.all([
    readContract(client, {
      address: token,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [account],
    }),
    readContract(client, { address: token, abi: erc20Abi, functionName: 'symbol' }).catch(
      () => undefined,
    ),
  ])
  return { balance, symbol: symbol ?? undefined }
}

function resolveEvmChain(chainId: number): Chain | undefined {
  const all = Object.values(viemChains) as Chain[]
  return all.find((c) => c.id === chainId)
}

function formatAmount(amount: bigint, decimals: number): string {
  return `$${(Number(amount) / 10 ** decimals).toFixed(2)}`
}

function methodSetupHint(challenge: Challenge.Challenge): string {
  switch (challenge.method) {
    case Constants.Methods.evm:
      return 'no EVM payment plugin yet'
    case 'solana':
      return 'no Solana payment plugin yet'
    default:
      return `no plugin for ${challenge.method}/${challenge.intent}`
  }
}
export async function validatePaymentFlow(
  baseUrl: string,
  endpoint: EndpointSpec,
  verbose: boolean,
  options: {
    body?: string | undefined
    query?: string[] | undefined
    extraHeaders?: string[] | undefined
    yes?: boolean | undefined
    silent?: boolean | undefined
    interactive?: boolean | undefined
    onResults?: (results: CheckResult[]) => void
  },
): Promise<CheckResult[]> {
  const results: CheckResult[] = []
  const url = buildUrl(baseUrl, endpoint, options.query)
  const fetchHeaders: Record<string, string> = parseHeaders(options.extraHeaders)
  let fetchBody: string | undefined
  if (options.body) {
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

  // Parse all challenges
  let challenges: Challenge.Challenge[]
  try {
    challenges = Challenge.fromResponseList(challengeResponse)
  } catch (error) {
    results.push(fail('Payment: parse challenge', (error as Error).message))
    return results
  }
  if (challenges.length === 0) {
    results.push(fail('Payment: parse challenge', 'No Payment challenges in response'))
    return results
  }

  const loaded = await loadConfig().catch(() => undefined)

  // Testnet Tempo: always use ephemeral wallet (zero-setup, free money)
  const tempoTestnetChallenge = challenges.find((ch) => {
    if (ch.method !== Constants.Methods.tempo) return false
    const req = ch.request as Record<string, unknown>
    const md = req.methodDetails as Record<string, unknown> | undefined
    return typeof md?.chainId === 'number' && md.chainId !== tempoChainIds.mainnet
  })

  if (tempoTestnetChallenge) {
    const provisioned = await provisionAndPayTestnet(tempoTestnetChallenge, verbose, options.silent)
    if (provisioned) {
      const fakeResp = new Response(null, {
        status: 402,
        headers: {
          [Constants.Headers.wwwAuthenticate]: Challenge.serialize(tempoTestnetChallenge),
        },
      })
      try {
        const mppx = Mppx.create({ methods: provisioned.methods, polyfill: false })
        const credentialContext = await preparePayment(
          tempoTestnetChallenge,
          loaded?.config.extensions,
        )
        const cred = await mppx.createCredential(fakeResp, credentialContext as never)
        results.push(check('Payment: submitted', 'ephemeral testnet wallet'))
        await sendAndValidateResponse(
          results,
          url,
          endpoint,
          cred,
          fetchHeaders,
          fetchBody,
          verbose,
          tempoModerato,
        )
      } catch (error) {
        results.push(fail('Payment: create credential', (error as Error).message))
      }
    } else {
      results.push(
        fail('Payment: auto-provision wallet', 'Failed to create and fund testnet wallet'),
      )
    }
    options.onResults?.(results)
  }

  // Try each remaining challenge method (tempo testnet already handled above),
  // so validate exercises every payment method the server offers, same as mainnet.
  const isInteractive = options.interactive
  const stripeKey = process.env.MPPX_STRIPE_SECRET_KEY ?? resolveStripeKey(verbose)
  const isStripeTestKey = stripeKey?.startsWith('sk_test_') || stripeKey?.startsWith('rk_test_')
  const supportedPaymentMethods: Set<string> = new Set([
    Constants.Methods.tempo,
    Constants.Methods.evm,
    Constants.Methods.stripe,
  ])

  for (const challenge of challenges) {
    if (challenge === tempoTestnetChallenge) continue
    if (!supportedPaymentMethods.has(challenge.method)) continue
    if (!options.silent) console.log('')

    const flushStart = results.length
    const flush = () => {
      if (options.onResults && results.length > flushStart)
        options.onResults(results.slice(flushStart))
    }
    const tag = `Payment [${challenge.method}]`

    try {
      switch (challenge.method) {
        case Constants.Methods.tempo:
        case Constants.Methods.evm:
          await attemptCryptoPayment(challenge, tag, {
            results,
            url,
            endpoint,
            fetchHeaders,
            fetchBody,
            verbose,
            loaded,
            isInteractive,
            options,
          })
          break
        case Constants.Methods.stripe:
          await attemptStripePayment(challenge, tag, {
            results,
            url,
            endpoint,
            fetchHeaders,
            fetchBody,
            verbose,
            loaded,
            isInteractive,
            isStripeTestKey: isStripeTestKey ?? false,
            stripeKey,
            options,
          })
          break
      }
    } finally {
      flush()
    }
  }

  return results
}

type PaymentContext = {
  results: CheckResult[]
  url: string
  endpoint: EndpointSpec
  fetchHeaders: Record<string, string>
  fetchBody: string | undefined
  verbose: boolean
  loaded: { config: Config; path: string } | undefined
  isInteractive: boolean | undefined
  options: {
    body?: string | undefined
    query?: string[] | undefined
    extraHeaders?: string[] | undefined
    yes?: boolean | undefined
    silent?: boolean | undefined
    interactive?: boolean | undefined
    onResults?: ((results: CheckResult[]) => void) | undefined
  }
}

async function attemptCryptoPayment(
  challenge: Challenge.Challenge,
  tag: string,
  ctx: PaymentContext,
): Promise<void> {
  const { results, url, endpoint, fetchHeaders, fetchBody, verbose, loaded, options } = ctx
  const request = challenge.request as Record<string, unknown>
  const methodDetails = request.methodDetails as Record<string, unknown> | undefined
  const requiredAmount = isValidIntegerAmount(request.amount)
    ? BigInt(request.amount as string)
    : undefined
  const decimals =
    (methodDetails?.decimals as number | undefined) ?? (request.decimals as number | undefined) ?? 6
  const currency = request.currency as string | undefined

  // Resolve wallet
  let walletAddress: string | undefined
  try {
    walletAddress = await resolveWalletAddress()
  } catch {}
  if (!walletAddress) {
    results.push(skip(tag, 'no wallet configured. Run "mppx account create" to create one.'))
    return
  }

  // Pre-flight balance check and chain resolution
  let paymentChain: Chain | undefined
  if (challenge.method === Constants.Methods.tempo) paymentChain = tempoMainnetChain
  else if (challenge.method === Constants.Methods.evm) {
    const chainId = methodDetails?.chainId as number | undefined
    if (chainId) paymentChain = resolveEvmChain(chainId)
  }

  let tokenSymbol: string | undefined
  if (requiredAmount && currency && paymentChain) {
    try {
      let balance: bigint
      if (challenge.method === Constants.Methods.tempo) {
        const client = createClient({ chain: tempoMainnetChain, transport: http() })
        const info = await fetchTokenInfo(client, currency as Address, walletAddress as Address)
        balance = info.balance
        tokenSymbol = info.symbol
      } else {
        const info = await fetchEvmTokenInfo(
          paymentChain,
          currency as Address,
          walletAddress as Address,
        )
        balance = info.balance
        tokenSymbol = info.symbol
      }
      if (balance < requiredAmount) {
        const requiredDisplay = formatAmount(requiredAmount, decimals)
        const balanceDisplay = formatAmount(balance, decimals)
        const symbol = tokenSymbol ?? 'tokens'
        results.push(
          skip(
            tag,
            `insufficient balance (have ${balanceDisplay}, need ${requiredDisplay} ${symbol} on ${paymentChain.name})`,
            `Fund wallet ${walletAddress} with at least ${requiredDisplay} ${symbol} on ${paymentChain.name}.`,
          ),
        )
        return
      }
    } catch (e) {
      if (verbose) console.log(pc.dim(`    Balance check skipped: ${(e as Error).message}`))
    }
  }

  // Prompt
  const amountDisplay = requiredAmount ? formatAmount(requiredAmount, decimals) : 'unknown amount'
  const tokenDisplay = tokenSymbol ?? (currency?.length === 3 ? currency.toUpperCase() : '')
  const chainName = paymentChain?.name
  const paymentDesc = `${amountDisplay}${tokenDisplay ? ` ${tokenDisplay}` : ''}${chainName ? ` on ${chainName}` : ''}`

  if (!options.silent) console.log(pc.dim(`    Attempting payment with wallet ${walletAddress}`))

  if (paymentChain?.testnet) {
    if (!options.silent) console.log(pc.dim(`    Auto-approved: ${paymentDesc} (testnet)`))
  } else if (!options.yes && !ctx.isInteractive) {
    results.push(skip(tag, 'non-interactive mode, use --yes to approve'))
    return
  } else if (!options.yes) {
    const ok = await confirm(`  ${pc.yellow('Pay')} ${paymentDesc}. Continue?`, false)
    if (!ok) {
      results.push(skip(tag, 'declined'))
      return
    }
  } else {
    if (!options.silent) console.log(pc.dim(`    Auto-approved: ${paymentDesc}`))
  }

  // Resolve plugin and pay
  const resolved = resolvePlugin(challenge, loaded?.config)
  const plugin = resolved.plugin
  const directMethod = resolved.method
  if (!plugin && !directMethod) {
    results.push(skip(tag, methodSetupHint(challenge)))
    return
  }

  let methods: AnyClient[]
  let createCredentialFn:
    | ((response: Response, credentialContext?: unknown) => Promise<string>)
    | undefined
  let credentialContext: unknown
  if (plugin) {
    try {
      const pluginResult = await plugin.setup({
        challenge,
        options: { network: 'mainnet' },
        methodOpts: {},
      })
      methods = pluginResult.methods
      createCredentialFn = pluginResult.createCredential
      credentialContext = pluginResult.credentialContext
    } catch (error) {
      results.push(skip(tag, (error as Error).message))
      return
    }
  } else {
    methods = [directMethod!]
  }

  const credential = await createAndSend(
    challenge,
    methods,
    createCredentialFn,
    tag,
    results,
    loaded?.config.extensions,
    credentialContext,
  )
  if (!credential) return

  plugin?.prepareCredentialRequest?.({ challenge, credential, headers: fetchHeaders })
  await sendAndValidateResponse(
    results,
    url,
    endpoint,
    credential,
    fetchHeaders,
    fetchBody,
    verbose,
    paymentChain,
  )
}

async function attemptStripePayment(
  challenge: Challenge.Challenge,
  tag: string,
  ctx: PaymentContext & { isStripeTestKey: boolean; stripeKey?: string | undefined },
): Promise<void> {
  const {
    results,
    url,
    endpoint,
    fetchHeaders,
    fetchBody,
    verbose,
    loaded,
    options,
    isStripeTestKey,
    stripeKey,
  } = ctx
  const request = challenge.request as Record<string, unknown>
  const requiredAmount = isValidIntegerAmount(request.amount)
    ? BigInt(request.amount as string)
    : undefined
  const decimals = (request.decimals as number | undefined) ?? 2
  const currency = request.currency as string | undefined

  const amountDisplay = requiredAmount ? formatAmount(requiredAmount, decimals) : 'unknown amount'
  const tokenDisplay = currency?.length === 3 ? currency.toUpperCase() : ''
  const paymentDesc = `${amountDisplay}${tokenDisplay ? ` ${tokenDisplay}` : ''} via Stripe${isStripeTestKey ? ' (testmode)' : ''}`

  if (isStripeTestKey) {
    if (!options.silent) console.log(pc.dim(`    Attempting: ${paymentDesc}`))
  } else if (!options.yes && !ctx.isInteractive) {
    results.push(skip(tag, 'non-interactive mode, use --yes to approve'))
    return
  } else if (!options.yes) {
    const ok = await confirm(`  ${pc.yellow('Pay')} ${paymentDesc}. Continue?`, false)
    if (!ok) {
      results.push(skip(tag, 'declined'))
      return
    }
  } else {
    if (!options.silent) console.log(pc.dim(`    Auto-approved: ${paymentDesc}`))
  }

  // Resolve plugin
  const resolved = resolvePlugin(challenge, loaded?.config)
  const plugin = resolved.plugin
  if (!plugin) {
    results.push(skip(tag, 'no Stripe plugin available'))
    return
  }

  let methods: AnyClient[]
  let createCredentialFn:
    | ((response: Response, credentialContext?: unknown) => Promise<string>)
    | undefined
  let credentialContext: unknown
  try {
    const methodOpts: Record<string, string> = { paymentMethod: 'pm_card_visa' }
    if (stripeKey) methodOpts.secretKey = stripeKey
    const pluginResult = await plugin.setup({
      challenge,
      options: {},
      methodOpts,
    })
    methods = pluginResult.methods
    createCredentialFn = pluginResult.createCredential
    credentialContext = pluginResult.credentialContext
  } catch (error) {
    results.push(skip(tag, (error as Error).message))
    return
  }

  const credential = await createAndSend(
    challenge,
    methods,
    createCredentialFn,
    tag,
    results,
    loaded?.config.extensions,
    credentialContext,
  )
  if (!credential) return

  plugin.prepareCredentialRequest?.({ challenge, credential, headers: fetchHeaders })

  // Stripe testmode: detect livemode rejection gracefully
  if (isStripeTestKey) {
    const resp = await fetchWithTimeout(
      url,
      {
        method: endpoint.method,
        headers: { ...fetchHeaders, [Constants.Headers.authorization]: credential },
        body: fetchBody ?? null,
      },
      30_000,
    )
    if (resp.status >= 200 && resp.status < 300) {
      results.push(check(`${tag}: successful`, `HTTP ${resp.status}`))
    } else {
      results.push(
        skip(
          `${tag}: server is in livemode`,
          undefined,
          'Run your server with a Stripe test key to automatically validate Stripe payments in testmode.',
        ),
      )
    }
    return
  }

  await sendAndValidateResponse(
    results,
    url,
    endpoint,
    credential,
    fetchHeaders,
    fetchBody,
    verbose,
    undefined,
  )
}

async function createAndSend(
  challenge: Challenge.Challenge,
  methods: AnyClient[],
  createCredentialFn:
    | ((response: Response, credentialContext?: unknown) => Promise<string>)
    | undefined,
  tag: string,
  results: CheckResult[],
  extensions?: readonly Extension.Extension[] | undefined,
  initialCredentialContext?: unknown,
): Promise<string | undefined> {
  const fakeResponse = new Response(null, {
    status: 402,
    headers: { [Constants.Headers.wwwAuthenticate]: Challenge.serialize(challenge) },
  })
  try {
    const credentialContext = await preparePayment(challenge, extensions, initialCredentialContext)
    let credential: string
    if (createCredentialFn) {
      credential = await createCredentialFn(fakeResponse, credentialContext)
    } else {
      const mppx = Mppx.create({ methods, polyfill: false })
      credential = await mppx.createCredential(fakeResponse, credentialContext as never)
    }
    results.push(check(`${tag}: submitted`))
    return credential
  } catch (error) {
    const msg = (error as Error).message
    if (msg.toLowerCase().includes('insufficient')) {
      results.push(skip(tag, `insufficient balance: ${msg}`))
    } else {
      results.push(fail(tag, msg))
    }
    return undefined
  }
}

async function sendAndValidateResponse(
  results: CheckResult[],
  url: string,
  endpoint: EndpointSpec,
  credential: string,
  baseHeaders: Record<string, string>,
  fetchBody: string | undefined,
  verbose: boolean,
  explorerChain?: Chain | undefined,
): Promise<CheckResult[]> {
  let paymentResponse: Response
  try {
    paymentResponse = await fetchWithTimeout(
      url,
      {
        method: endpoint.method,
        headers: { ...baseHeaders, [Constants.Headers.authorization]: credential },
        body: fetchBody ?? null,
      },
      30_000,
    )
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
    results.push(
      fail(
        'Payment: accepted',
        detail,
        'The server rejected a valid credential. Check that your payment verification logic accepts the credential format and that the payment was processed on-chain.',
      ),
    )
    return results
  }

  if (paymentResponse.status >= 400 && paymentResponse.status < 500) {
    results.push(
      warn(
        'Payment: post-payment response',
        `Got ${paymentResponse.status}`,
        'Payment succeeded but the endpoint returned a client error. The endpoint likely requires request body parameters. Use --body to provide them.',
      ),
    )
  } else if (paymentResponse.status >= 500) {
    results.push(
      fail(
        'Payment: server response',
        `Got ${paymentResponse.status}`,
        'Payment was accepted but the server errored while generating the response. Check server logs for the underlying error.',
      ),
    )
    return results
  } else {
    results.push(check('Payment: successful', `HTTP ${paymentResponse.status}`))
  }

  // Validate receipt
  const receiptHeader = paymentResponse.headers.get(Constants.Headers.paymentReceipt)
  if (!receiptHeader) {
    results.push(
      fail(
        'Payment-Receipt header present',
        undefined,
        'After accepting payment, include a Payment-Receipt header with a base64url-encoded JSON object containing: method, reference, status ("success"), and timestamp (ISO 8601).',
      ),
    )
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
    results.push(
      check('Response body non-empty', `${contentType.split(';')[0]}, ${formatBytes(body.length)}`),
    )
  } else {
    const suspiciousHeaders = [...paymentResponse.headers.entries()].filter(
      ([key]) =>
        !key.startsWith('x-') &&
        ![
          'content-type',
          'content-length',
          'date',
          'server',
          'connection',
          'keep-alive',
          'cache-control',
          'vary',
          'access-control-allow-origin',
          'payment-receipt',
          'payment-session',
          'payment-session-snapshot',
        ].includes(key.toLowerCase()),
    )
    if (suspiciousHeaders.length > 0) {
      results.push(
        warn(
          'Response body empty -- data may be in headers only',
          suspiciousHeaders.map(([k]) => k).join(', '),
        ),
      )
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
        const explorerUrl = explorerChain?.blockExplorers?.default?.url
        if (explorerUrl) {
          const path = explorerUrl.includes('tempo') ? 'receipt' : 'tx'
          results.push(check('On-chain transaction', `${explorerUrl}/${path}/${receipt.reference}`))
        }
      }
    } catch {}
  }

  return results
}
