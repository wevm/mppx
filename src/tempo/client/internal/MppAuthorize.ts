import { type Address, type Client, type Hex, numberToHex } from 'viem'

import * as Challenge from '../../../Challenge.js'
import * as Credential from '../../../Credential.js'

export type Session =
  | {
      action: 'close' | 'voucher'
      authorizedSigner: Address
      channelId: Hex
      cumulativeAmount: string
    }
  | {
      action: 'topUp'
      additionalDeposit: string
      authorizedSigner: Address
      channelId: Hex
    }

export type Response = {
  authorization: string
}

/**
 * Requests a wallet-native MPP authorization credential from a JSON-RPC client.
 *
 * Returns `undefined` when the wallet does not support `mpp_authorize`, allowing
 * callers to fall back to the existing lower-level signing path.
 */
export async function authorize(
  client: Client,
  parameters: {
    account: Address
    challenge: Challenge.Challenge
    chainId?: number | undefined
    session?: Session | undefined
  },
): Promise<string | undefined> {
  const chainId = parameters.chainId ? numberToHex(parameters.chainId) : undefined

  try {
    const capabilities = (await client.request({
      method: 'wallet_getCapabilities',
      params: chainId ? [parameters.account, [chainId]] : [parameters.account],
    } as never)) as Record<string, { mpp?: { status?: string | undefined } | undefined }>
    if (!capabilities || typeof capabilities !== 'object') return undefined

    const supported = chainId
      ? Object.entries(capabilities).find(([id]) => id.toLowerCase() === chainId.toLowerCase())?.[1]
          ?.mpp?.status === 'supported'
      : Object.values(capabilities).some((entry) => entry.mpp?.status === 'supported')
    if (!supported) return undefined
  } catch (error) {
    if (isUnsupported(error)) return undefined
    throw error
  }

  try {
    const result = (await client.request({
      method: 'mpp_authorize',
      params: [
        {
          challenges: [Challenge.serialize(parameters.challenge)],
          ...(parameters.session ? { session: parameters.session } : {}),
        },
      ],
    } as never)) as Response

    if (!result || typeof result.authorization !== 'string') {
      throw new Error('Invalid mpp_authorize response.')
    }

    const credential = Credential.deserialize(result.authorization)
    if (Challenge.serialize(credential.challenge) !== Challenge.serialize(parameters.challenge)) {
      throw new Error('mpp_authorize returned a credential for a different challenge.')
    }

    return result.authorization
  } catch (error) {
    if (isUnsupported(error)) return undefined
    throw error
  }
}

function isUnsupported(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const code = (error as { code?: unknown }).code
  return code === 4200 || code === -32601
}
