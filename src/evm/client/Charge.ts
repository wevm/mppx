import type { Account } from 'viem'
import { getAddress, parseUnits } from 'viem'

import * as Credential from '../../Credential.js'
import * as Method from '../../Method.js'
import * as x402_Exact from '../../x402/client/Exact.js'
import * as z from '../../zod.js'
import * as Assets from '../Assets.js'
import * as Methods from '../Methods.js'
import * as Types from '../Types.js'

/**
 * Creates an EVM charge client method.
 *
 * Signs native Payment-auth `authorization` credentials for EVM charges. It
 * also keeps x402 exact signing for x402 compatibility challenges.
 */
export function charge(parameters: charge.Parameters) {
  return Method.toClient(Methods.charge, {
    context: z.object({
      account: z.optional(z.custom<Account>()),
    }),
    async createCredential({ challenge, context }) {
      if (isX402Challenge(challenge))
        return x402_Exact.createCredential({
          challenge: challenge as never,
          config: parameters as x402_Exact.Config,
          context,
        })

      const account = (context?.account ?? parameters.account) as charge.Signer
      if (!account.signTypedData) throw new Error('EVM authorization requires a typed-data signer.')

      const request = challenge.request as Types.ChargeRequest
      assertPolicy(parameters, request)
      if (!request.methodDetails.credentialTypes?.includes('authorization')) {
        throw new Error('EVM authorization is not accepted by this challenge.')
      }
      if (request.methodDetails.splits?.length) {
        throw new Error('EVM authorization does not support payment splits.')
      }

      const authorization = resolveAuthorization(parameters, request)
      const validBefore = challenge.expires
        ? Math.floor(new Date(challenge.expires).getTime() / 1000).toString()
        : (Math.floor(Date.now() / 1000) + 300).toString()

      const payload: Types.AuthorizationPayload = {
        from: getAddress(account.address),
        nonce: Types.challengeHash(challenge),
        signature: await account.signTypedData({
          domain: Types.authorizationDomain({
            authorization,
            chainId: request.methodDetails.chainId,
            currency: request.currency as `0x${string}`,
          }),
          message: {
            from: getAddress(account.address),
            nonce: Types.challengeHash(challenge),
            to: getAddress(request.recipient),
            validAfter: 0n,
            validBefore: BigInt(validBefore),
            value: BigInt(request.amount),
          },
          primaryType: 'TransferWithAuthorization',
          types: Types.authorizationTypes,
        }),
        to: getAddress(request.recipient),
        type: 'authorization',
        validAfter: '0',
        validBefore,
        value: request.amount,
      }

      return Credential.serialize(
        Credential.from({
          challenge,
          payload,
          source: Types.toSource({
            address: getAddress(account.address),
            chainId: request.methodDetails.chainId,
          }),
        }),
      )
    },
  })
}

export declare namespace charge {
  type Signer = Account & {
    signTypedData?: (parameters: any) => Promise<`0x${string}`>
  }

  type Parameters = {
    /** Account used to sign EVM charge credentials. */
    account: Account
    /** EIP-3009 token domain metadata for custom currencies. */
    authorization?: Types.AuthorizationConfig | undefined
    /** Optional token decimals used to parse `maxAmount` when currency metadata is not provided. */
    decimals?: number | undefined
    /** Optional maximum display-unit amount the client is willing to pay. */
    maxAmount?: string | undefined
    /** Optional maximum atomic amount the client is willing to pay. */
    maxAtomicAmount?: string | undefined
    /** Optional allowlist of supported CAIP-2 EVM networks. */
    networks?: readonly Types.EvmNetwork[] | undefined
    /** Optional allowlist of supported currencies. */
    currencies?: readonly (`0x${string}` | Assets.KnownAsset)[] | undefined
    /** Legacy alias for `currencies`. */
    assets?: readonly (`0x${string}` | Assets.KnownAsset)[] | undefined
  }
}

function isX402Challenge(challenge: { request: Record<string, unknown> }) {
  return challenge.request.scheme === 'exact' && typeof challenge.request.network === 'string'
}

function assertPolicy(parameters: charge.Parameters, request: Types.ChargeRequest) {
  const network = Types.networkOf(request.methodDetails.chainId)
  if (parameters.networks && !parameters.networks.includes(network))
    throw new Error(`EVM network is not allowed: ${network}.`)

  const currencies = parameters.currencies ?? parameters.assets
  if (currencies) {
    const acceptedCurrency = getAddress(request.currency as `0x${string}`)
    const allowed = currencies.some(
      (currency) => getAddress(addressOf(currency)) === acceptedCurrency,
    )
    if (!allowed) throw new Error(`EVM currency is not allowed: ${acceptedCurrency}.`)
  }

  if (
    parameters.maxAtomicAmount !== undefined &&
    BigInt(request.amount) > BigInt(parameters.maxAtomicAmount)
  )
    throw new Error('EVM charge amount exceeds maxAtomicAmount.')

  if (parameters.maxAmount !== undefined) {
    const decimals = decimalsOfAcceptedCurrency(parameters, request)
    if (decimals === undefined) throw new Error('EVM charge maxAmount requires currency decimals.')
    if (BigInt(request.amount) > parseUnits(parameters.maxAmount, decimals))
      throw new Error('EVM charge amount exceeds maxAmount.')
  }
}

function resolveAuthorization(
  parameters: charge.Parameters,
  request: Types.ChargeRequest,
): Types.AuthorizationConfig {
  const currencies = parameters.currencies ?? parameters.assets
  const acceptedCurrency = getAddress(request.currency as `0x${string}`)
  const currency = currencies?.find(
    (currency) => getAddress(addressOf(currency)) === acceptedCurrency,
  )
  if (currency && Assets.isAsset(currency) && currency.transfer.type === Types.eip3009)
    return {
      name: currency.transfer.name,
      version: currency.transfer.version,
    }
  if (parameters.authorization) return parameters.authorization
  throw new Error('EVM authorization requires token name and version.')
}

function addressOf(currency: `0x${string}` | Assets.KnownAsset): `0x${string}` {
  return Assets.isAsset(currency) ? currency.address : currency
}

function decimalsOfAcceptedCurrency(
  parameters: charge.Parameters,
  request: Types.ChargeRequest,
): number | undefined {
  const currencies = parameters.currencies ?? parameters.assets
  const acceptedCurrency = getAddress(request.currency as `0x${string}`)
  const currency = currencies?.find(
    (currency) => getAddress(addressOf(currency)) === acceptedCurrency,
  )
  if (currency && Assets.isAsset(currency)) return currency.decimals
  return parameters.decimals ?? request.methodDetails.decimals
}
