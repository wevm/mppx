import { Hex } from 'ox'
import type { Account } from 'viem'
import { getAddress } from 'viem'

import * as Method from '../../Method.js'
import * as z from '../../zod.js'
import * as Header from '../Header.js'
import * as Methods from '../Methods.js'
import * as Types from '../Types.js'

/**
 * Creates an x402 exact client method.
 *
 * This is the public interface scaffold for exact EVM payments. The signing
 * implementation will use the configured account to create x402
 * `PAYMENT-SIGNATURE` payloads.
 */
export function exact(parameters: exact.Parameters) {
  return Method.toClient(Methods.exact, {
    context: z.object({
      account: z.optional(z.custom<Account>()),
    }),
    async createCredential({ challenge, context }) {
      const account = (context?.account ?? parameters.account) as exact.Signer
      if (!account.signTypedData) throw new Error('x402 exact requires a typed-data signer.')

      const request = challenge.request as Types.ExactRequest
      const accepted = Types.toPaymentRequirements(request)
      assertPolicy(parameters, accepted)
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
        nonce: Hex.random(32),
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
        payload: {
          authorization,
          signature,
        },
        ...(request.resource ? { resource: request.resource } : {}),
        x402Version: 2,
      })
    },
  })
}

export declare namespace exact {
  type Signer = Account & {
    signTypedData?: (parameters: any) => Promise<`0x${string}`>
  }

  type Parameters = {
    /** Account used to sign exact EVM payment payloads. */
    account: Account
    /** Optional maximum atomic amount the client is willing to pay. */
    maxAmount?: string | undefined
    /** Optional allowlist of supported x402 EVM networks. */
    networks?: readonly Types.EvmNetwork[] | undefined
    /** Optional allowlist of supported asset contract addresses. */
    assets?: readonly `0x${string}`[] | undefined
  }
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

function assertPolicy(parameters: exact.Parameters, accepted: Types.PaymentRequirements) {
  if (parameters.maxAmount !== undefined && BigInt(accepted.amount) > BigInt(parameters.maxAmount))
    throw new Error('x402 exact amount exceeds maxAmount.')

  if (parameters.networks && !parameters.networks.includes(accepted.network))
    throw new Error(`x402 exact network is not allowed: ${accepted.network}.`)

  if (parameters.assets) {
    const acceptedAsset = getAddress(accepted.asset as `0x${string}`)
    const allowed = parameters.assets.some((asset) => getAddress(asset) === acceptedAsset)
    if (!allowed) throw new Error(`x402 exact asset is not allowed: ${acceptedAsset}.`)
  }
}
