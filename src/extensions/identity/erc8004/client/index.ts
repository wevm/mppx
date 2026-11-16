import type { Address, Hex } from 'viem'

import type * as Identity from '../../../../identity/Types.js'
import { Constants } from '../Constants.js'
import * as Agent from '../internal/Agent.js'

/**
 * Creates a prover that signs each request as an ERC-8004 agent, with the agent's wallet.
 *
 * @example
 * ```ts
 * const mppx = Mppx.create({
 *   identity: [Erc8004.Client.prover({ account, agentId: 42n, scope: ['https://api.example'] })],
 *   methods: [tempo({ account })],
 * })
 * ```
 */
export function prover(config: prover.Config): Identity.Prover {
  const id = Agent.format({
    agentId: BigInt(config.agentId),
    chainId: config.chainId ?? Constants.chainId,
    registry: config.registry ?? Constants.identityRegistry,
  })
  return {
    scope: config.scope,
    async prove(request, { created, nonce }) {
      const signature = await config.account.signMessage({
        message: Agent.message({ created, id, nonce, request }),
      })
      const headers = new Headers(request.headers)
      headers.set(Constants.idHeader, id)
      headers.set(Constants.signatureHeader, `${created}.${nonce}.${signature}`)
      return new Request(request, { headers })
    },
  }
}

export declare namespace prover {
  type Config = {
    /** The agent's wallet, such as a viem `privateKeyToAccount` account. It also pays. */
    readonly account: { readonly signMessage: (parameters: { message: string }) => Promise<Hex> }
    /** The agent's token ID in the Identity Registry. */
    readonly agentId: bigint | number
    /** Origins that receive the agent's signature, or `'*'` for any origin. */
    readonly scope: Identity.Prover['scope']
    /** The registry's chain. @default 4217 (Tempo mainnet) */
    readonly chainId?: number | undefined
    /** The Identity Registry. @default '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432' */
    readonly registry?: Address | undefined
  }
}
