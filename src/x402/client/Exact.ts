import type { Account } from 'viem'
import { getAddress, parseUnits } from 'viem'

import type * as Challenge from '../../Challenge.js'
import * as Assets from '../Assets.js'
import * as Header from '../Header.js'
import * as RouteBinding from '../internal/RouteBinding.js'
import * as Types from '../Types.js'

/**
 * Creates an x402 exact `PAYMENT-SIGNATURE` credential.
 */
export async function createCredential(parameters: createCredential.Parameters): Promise<string> {
  const account = (parameters.context?.account ?? parameters.config.account) as Signer
  if (!account.signTypedData) throw new Error('x402 exact requires a typed-data signer.')

  const request = parameters.challenge.request as Types.ExactRequest
  const accepted = Types.toPaymentRequirements(request)
  assertPolicy(parameters.config, accepted)
  if (!request.resource || !request.extensions?.mppx)
    throw new Error('x402 exact EIP-3009 requires route binding.')
  const extensions = withNonceSalt(request.extensions)
  const transferMethod = accepted.extra?.assetTransferMethod ?? 'eip3009'
  if (transferMethod !== 'eip3009')
    throw new Error(`x402 exact ${String(transferMethod)} signing is not implemented yet.`)

  const name = accepted.extra?.name
  const version = accepted.extra?.version
  if (typeof name !== 'string' || typeof version !== 'string')
    throw new Error('x402 exact EIP-3009 requires token name and version.')

  const now = Math.floor(Date.now() / 1000)
  const authorization: Types.ExactEip3009Payload['authorization'] = {
    from: getAddress(account.address),
    nonce: RouteBinding.nonce({
      accepted,
      extensions,
      resource: request.resource,
    }),
    to: getAddress(accepted.payTo),
    validAfter: (now - 600).toString(),
    validBefore: (now + accepted.maxTimeoutSeconds).toString(),
    value: accepted.amount,
  }
  const signature = await account.signTypedData({
    domain: {
      chainId: chainIdOf(accepted.network),
      name,
      verifyingContract: getAddress(accepted.asset),
      version,
    },
    message: {
      ...authorization,
      value: BigInt(authorization.value),
      validAfter: BigInt(authorization.validAfter),
      validBefore: BigInt(authorization.validBefore),
    },
    primaryType: 'TransferWithAuthorization',
    types: authorizationTypes,
  })

  return Header.encodePaymentSignature({
    accepted,
    extensions,
    payload: {
      authorization,
      signature,
    },
    ...(request.resource ? { resource: request.resource } : {}),
    x402Version: 2,
  })
}

export declare namespace createCredential {
  type Parameters = {
    challenge: Challenge.Challenge<Types.ExactRequest>
    config: Config
    context?: Context | undefined
  }
}

export type Context = {
  account?: Account | undefined
}

export type Signer = Account & {
  signTypedData?: (parameters: any) => Promise<`0x${string}`>
}

export type Config = {
  /** Account used to sign exact EVM payment payloads. */
  account: Account
  /** Optional token decimals used to parse `maxAmount` when currency metadata is not provided. */
  decimals?: number | undefined
  /** Optional maximum display-unit amount the client is willing to pay. */
  maxAmount?: string | undefined
  /** Optional maximum atomic amount the client is willing to pay. */
  maxAtomicAmount?: string | undefined
  /** Optional allowlist of supported EVM chain IDs. */
  networks?: readonly number[] | undefined
  /** Optional allowlist of supported currencies. */
  currencies?: readonly Assets.Currency[] | undefined
  /** Legacy alias for `currencies`. */
  assets?: readonly Assets.Currency[] | undefined
}

const authorizationTypes = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const

function chainIdOf(network: Types.EvmNetwork): number {
  return Number(network.slice(Types.evmNetworkPrefix.length))
}

function assertPolicy(parameters: Config, accepted: Types.PaymentRequirements) {
  const chainId = chainIdOf(accepted.network)
  if (parameters.networks && !parameters.networks.includes(chainId))
    throw new Error(`x402 exact chain ID is not allowed: ${chainId}.`)

  const currencies = parameters.currencies ?? parameters.assets
  if (currencies?.some((currency) => Assets.isRawAddress(currency)) && !parameters.networks?.length)
    throw new Error('x402 exact raw currency allowlists require networks.')
  if (currencies) {
    const acceptedCurrency = getAddress(accepted.asset as `0x${string}`)
    const allowed = currencies.some((currency) =>
      Assets.matches(currency, acceptedCurrency, accepted.network),
    )
    if (!allowed) throw new Error(`x402 exact currency is not allowed: ${acceptedCurrency}.`)
  }

  if (
    parameters.maxAtomicAmount !== undefined &&
    BigInt(accepted.amount) > BigInt(parameters.maxAtomicAmount)
  )
    throw new Error('x402 exact amount exceeds maxAtomicAmount.')

  if (parameters.maxAmount !== undefined) {
    const decimals = decimalsOfAcceptedCurrency(parameters, accepted)
    if (decimals === undefined) throw new Error('x402 exact maxAmount requires currency decimals.')
    if (BigInt(accepted.amount) > parseUnits(parameters.maxAmount, decimals))
      throw new Error('x402 exact amount exceeds maxAmount.')
  }
}

function decimalsOfAcceptedCurrency(
  parameters: Config,
  accepted: Types.PaymentRequirements,
): number | undefined {
  const currencies = parameters.currencies ?? parameters.assets
  const acceptedCurrency = getAddress(accepted.asset as `0x${string}`)
  const currency = currencies?.find((currency) =>
    Assets.matches(currency, acceptedCurrency, accepted.network),
  )
  const resolved = currency ? Assets.resolve(currency, accepted.network) : undefined
  if (resolved?.decimals !== undefined) return resolved.decimals
  return parameters.decimals
}

function withNonceSalt(extensions: Types.Extensions): Types.Extensions {
  const mppx = extensions.mppx
  if (!mppx) return extensions
  return {
    ...extensions,
    mppx: {
      ...mppx,
      info: {
        ...mppx.info,
        nonce: randomNonceSalt(),
      },
    },
  }
}

function randomNonceSalt(): string {
  const crypto = globalThis.crypto
  if (!crypto?.getRandomValues) throw new Error('x402 exact requires crypto randomness.')
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}
