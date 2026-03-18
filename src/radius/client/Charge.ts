import type { Address, Hex } from 'viem'
import {
  readContract,
  sendTransaction,
  signTypedData,
  waitForTransactionReceipt,
} from 'viem/actions'
import { encodeFunctionData } from 'viem'
import * as Credential from '../../Credential.js'
import * as Method from '../../Method.js'
import * as Account from '../../viem/Account.js'
import * as Client from '../../viem/Client.js'
import * as z from '../../zod.js'
import * as Abi from '../internal/abi.js'
import { radiusMainnet, radiusTestnet } from '../internal/chain.js'
import * as defaults from '../internal/defaults.js'
import * as Methods from '../Methods.js'

/** Minimal ABI fragment for reading the EIP-2612 nonce. */
const noncesAbi = [
  {
    type: 'function',
    name: 'nonces',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
] as const

/**
 * Creates a Radius charge method intent for usage on the client.
 *
 * @example
 * ```ts
 * import { radius } from 'mppx/client'
 * import { privateKeyToAccount } from 'viem/accounts'
 *
 * const charge = radius.charge({
 *   account: privateKeyToAccount('0x...'),
 * })
 * ```
 */
export function charge(parameters: charge.Parameters = {}) {
  const getClient = Client.getResolver({
    chain: parameters.testnet ? radiusTestnet : radiusMainnet,
    getClient: parameters.getClient,
    rpcUrl: defaults.rpcUrl,
  })
  const getAccount = Account.getResolver({ account: parameters.account })

  return Method.toClient(Methods.charge, {
    context: z.object({
      account: z.optional(z.custom<Account.getResolver.Parameters['account']>()),
      mode: z.optional(z.enum(['push', 'permit'])),
    }),

    async createCredential({ challenge, context }) {
      const chainId = challenge.request.methodDetails?.chainId
      const client = await getClient({ chainId })
      const account = getAccount(client, context)

      const mode = context?.mode ?? parameters.mode ?? 'push'

      const { request } = challenge
      const { amount } = request
      const currency = request.currency as Address
      const recipient = request.recipient as Address

      if (mode === 'push') {
        const hash = await sendTransaction(client, {
          account,
          to: currency,
          data: encodeFunctionData({
            abi: Abi.erc20,
            functionName: 'transfer',
            args: [recipient, BigInt(amount)],
          }),
        } as never)
        await waitForTransactionReceipt(client, { hash })

        return Credential.serialize({
          challenge,
          payload: { hash, type: 'hash' },
          source: `did:pkh:eip155:${client.chain?.id}:${account.address}`,
        })
      }

      // Permit mode: sign EIP-2612 permit off-chain, let server execute on-chain.
      const deadline = BigInt(
        Math.floor(Date.now() / 1000) + 3600, // 1 hour from now
      )

      const nonce = await readContract(client, {
        address: currency,
        abi: noncesAbi,
        functionName: 'nonces',
        args: [account.address],
      })

      // EIP-2612 permit domain — must match the token contract's DOMAIN_SEPARATOR.
      // SBC mainnet uses { name: "SBC", version: "1" }.
      const domain = {
        name: parameters.permitName ?? 'SBC',
        version: parameters.permitVersion ?? '1',
        chainId: client.chain?.id,
        verifyingContract: currency,
      }

      const signature = await signTypedData(client, {
        account,
        domain,
        types: {
          Permit: [
            { name: 'owner', type: 'address' },
            { name: 'spender', type: 'address' },
            { name: 'value', type: 'uint256' },
            { name: 'nonce', type: 'uint256' },
            { name: 'deadline', type: 'uint256' },
          ],
        },
        primaryType: 'Permit',
        message: {
          owner: account.address,
          spender: recipient,
          value: BigInt(amount),
          nonce,
          deadline,
        },
      })

      return Credential.serialize({
        challenge,
        payload: {
          type: 'permit',
          owner: account.address,
          deadline: deadline.toString(),
          signature,
        },
        source: `did:pkh:eip155:${client.chain?.id}:${account.address}`,
      })
    },
  })
}

export declare namespace charge {
  type Parameters = {
    /**
     * Controls how the charge is submitted.
     *
     * - `'push'`:   Client broadcasts a standard `transfer()` and sends the tx hash.
     * - `'permit'`: Client signs an EIP-2612 permit; the server executes settlement.
     *
     * @default 'push'
     */
    mode?: 'push' | 'permit' | undefined
    /** Testnet mode. */
    testnet?: boolean | undefined
    /**
     * EIP-2612 permit domain `name`.  Must match the token contract's
     * DOMAIN_SEPARATOR.
     *
     * @default 'SBC'
     */
    permitName?: string | undefined
    /**
     * EIP-2612 permit domain `version`.  Must match the token contract's
     * DOMAIN_SEPARATOR.
     *
     * @default '1'
     */
    permitVersion?: string | undefined
  } & Account.getResolver.Parameters &
    Client.getResolver.Parameters
}
