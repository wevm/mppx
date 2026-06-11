import { numberToHex, type Address, type Client, type Hex } from 'viem'

import * as Challenge from '../../Challenge.js'
import * as Credential from '../../Credential.js'

/** `wallet_getCapabilities` result, keyed by hex chain ID. */
type Capabilities = Record<
  string,
  { mpp?: { status?: string | undefined } | undefined } | undefined
>

/**
 * Asks the wallet behind a JSON-RPC account to satisfy an MPP challenge via
 * the `wallet_authorizeChallenge` RPC method, gated on a `wallet_getCapabilities` probe.
 *
 * Returns `undefined` when the capability probe fails for any reason, when
 * the wallet does not advertise MPP support, or when the wallet rejects
 * `wallet_authorizeChallenge` as unsupported (EIP-1193 `4200` or JSON-RPC `-32601`),
 * allowing callers to fall back to the local signing path.
 *
 * Wallet-managed sessions do not populate local `SessionManager` state — the
 * channel ID and cumulative getters, the `Payment-Session` header hint, and
 * persistence are no-ops, and the server identifies the channel from the
 * credential. Wallets may also apply their own approval policy and
 * auto-approve without prompting — apps that want app-level consent should
 * use the MCP wrapper's `onPaymentRequired` hook or equivalent.
 */
export async function authorize(
  client: Client,
  parameters: authorize.Parameters,
): Promise<authorize.ReturnType> {
  const { account, challenge, probeCache } = parameters
  const chainId = numberToHex(parameters.chainId)
  const serializedChallenge = Challenge.serialize(challenge)

  const probeKey = `${account.toLowerCase()}:${chainId}`
  if (!probeCache?.has(probeKey)) {
    // The capability probe is opportunistic — unauthorized, invalid-params,
    // or transport errors keep the legacy local-signing path.
    try {
      const capabilities = (await client.request({
        method: 'wallet_getCapabilities',
        params: [account, [chainId]],
      } as never)) as Capabilities | null | undefined
      if (!supportsMpp(capabilities, chainId)) return undefined
    } catch {
      return undefined
    }
    probeCache?.set(probeKey, true)
  }

  let response: { authorization?: string | undefined } | null | undefined
  try {
    response = (await client.request({
      method: 'wallet_authorizeChallenge',
      params: [{ challenges: [serializedChallenge] }],
    } as never)) as typeof response
  } catch (error) {
    // By now the wallet claimed support, so only an unsupported-method
    // rejection falls back; anything else (e.g. user rejection) propagates.
    if (isUnsupported(error)) return undefined
    throw error
  }

  if (!response || typeof response.authorization !== 'string')
    throw new Error('Invalid `wallet_authorizeChallenge` response.')

  const credential = Credential.deserialize(response.authorization)
  if (Challenge.serialize(credential.challenge) !== serializedChallenge)
    throw new Error('wallet_authorizeChallenge returned a credential for a different challenge.')

  return response.authorization
}

export declare namespace authorize {
  type Parameters = {
    /** Account address the wallet should authorize the payment for. */
    account: Address
    /** Chain ID to probe for MPP capability. */
    chainId: number
    /** Challenge from the 402 response. */
    challenge: Challenge.Challenge
    /** Positive-only memo of `account:chainId` keys that already passed the capability probe. */
    probeCache?: Map<string, true> | undefined
  }

  /** `undefined` when the wallet does not support `wallet_authorizeChallenge`. */
  type ReturnType = string | undefined
}

/** Whether the capabilities advertise MPP support for the chain. */
function supportsMpp(capabilities: Capabilities | null | undefined, chainId: Hex) {
  if (!capabilities) return false
  return Object.entries(capabilities).some(
    ([id, capability]) =>
      id.toLowerCase() === chainId.toLowerCase() && capability?.mpp?.status === 'supported',
  )
}

/** Whether an error signals the wallet does not implement the requested method. */
function isUnsupported(error: unknown) {
  if (!error || typeof error !== 'object') return false
  const { code } = error as { code?: unknown }
  return code === 4200 || code === -32601
}
