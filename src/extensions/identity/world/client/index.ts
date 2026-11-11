import { Base64, Hash, Hex } from 'ox'
import type { Address } from 'viem'
import { createSiweMessage } from 'viem/siwe'

import type * as Identity from '../../../../identity/Types.js'
import { Constants } from '../Constants.js'
import type * as Types from '../Types.js'

/**
 * Creates a World AgentKit identity prover.
 *
 * The prover signs a CAIP-122 (SIWE) message for each in-scope attempt with the agent's
 * wallet and sends it in the `agentkit` header, the same payload x402's AgentKit extension
 * uses. Servers resolve the wallet to an anonymous human in World's AgentBook, so the wallet
 * must be registered once with `npx @worldcoin/agentkit-cli register <address>`.
 *
 * @example
 * ```ts
 * Mppx.create({ identity: [World.Client.prover({ account, scope: ['https://api.example'] })], methods })
 * ```
 */
export function prover(config: prover.Config): Identity.Prover {
  const chainId = config.chainId ?? Constants.worldChainId
  return {
    scope: config.scope,
    headers: [Constants.header],
    async prove(request, context) {
      const url = new URL(request.url)
      const issuedAt = new Date(context.created * 1000)
      const fields = {
        domain: url.hostname,
        address: config.account.address,
        statement: config.statement ?? Constants.statement,
        uri: url.href,
        version: '1',
        chainId: `eip155:${chainId}`,
        type: config.type ?? 'eip191',
        // SIWE nonces are alphanumeric and at least 8 characters: hash the attempt's nonce.
        nonce: Hash.sha256(Hex.fromString(context.nonce)).slice(2, 34),
        issuedAt: issuedAt.toISOString(),
        ...(context.challenge && { requestId: context.challenge.id }),
      } as const
      let text: string
      try {
        text = message(fields)
      } catch {
        // SIWE allows fewer hosts and URI characters than WHATWG URLs (such as IPv6 or
        // underscore hosts): send the request unsigned rather than failing it.
        return request
      }
      const signature = await config.account.signMessage({ message: text })
      const payload: Types.Payload = { ...fields, signature }
      const headers = new Headers(request.headers)
      headers.set(Constants.header, Base64.fromString(JSON.stringify(payload)))
      return new Request(request, { headers })
    },
  }
}

export declare namespace prover {
  type Config = {
    /** The agent's wallet, registered in AgentBook. */
    account: {
      readonly address: Address
      readonly signMessage: (parameters: { message: string }) => Promise<`0x${string}`>
    }
    /** Origins that receive AgentKit signatures, or `'*'` for any origin. */
    scope: Identity.Prover['scope']
    /** Chain the account signs for: a smart account's chain, where servers verify its signature. @default 480 (World Chain) */
    chainId?: number | undefined
    /** Signature type: `eip1271` for a smart account, such as a Coinbase Smart Wallet or Safe. @default 'eip191' */
    type?: 'eip191' | 'eip1271' | undefined
    /** SIWE statement. @default 'Verify your agent is backed by a real human' */
    statement?: string | undefined
  }
}

/** Builds the SIWE message for a payload's fields, exactly as `@worldcoin/agentkit` does. @internal */
export function message(payload: Omit<Types.Payload, 'signature'>): string {
  return createSiweMessage({
    domain: payload.domain,
    address: payload.address as Address,
    statement: payload.statement,
    uri: payload.uri,
    version: '1',
    chainId: Number(payload.chainId.slice('eip155:'.length)),
    nonce: payload.nonce,
    issuedAt: new Date(payload.issuedAt),
    expirationTime: payload.expirationTime ? new Date(payload.expirationTime) : undefined,
    notBefore: payload.notBefore ? new Date(payload.notBefore) : undefined,
    requestId: payload.requestId,
    resources: payload.resources ? [...payload.resources] : undefined,
  })
}
