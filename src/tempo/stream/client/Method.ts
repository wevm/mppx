import { type Account, type Address, type Client, createClient, type Hex, http } from 'viem'
import { tempo as tempo_chain } from 'viem/chains'
import * as Credential from '../../../Credential.js'
import type { OneOf } from '../../../internal/types.js'
import * as MethodIntent from '../../../MethodIntent.js'
import * as z from '../../../zod.js'
import * as Intents from '../../Intents.js'
import * as defaults from '../../internal/defaults.js'
import type { StreamCredentialPayload } from '../Types.js'
import { signVoucher } from '../Voucher.js'

export const streamContextSchema = z.object({
  account: z.optional(z.custom<Account>()),
  action: z.enum(['open', 'topUp', 'voucher', 'close']),
  channelId: z.string(),
  cumulativeAmount: z.bigint(),
  hash: z.optional(z.string()),
  topUpTxHash: z.optional(z.string()),
  authorizedSigner: z.optional(z.string()),
})

export type StreamContext = z.infer<typeof streamContextSchema>

/**
 * Creates a stream payment client using the mpay Method.toClient() pattern.
 *
 * @example
 * ```ts
 * import { Fetch, tempo } from 'mpay/client'
 *
 * const paidFetch = Fetch.from({
 *   methods: [
 *     tempo.stream({
 *       account: privateKeyToAccount('0x...'),
 *     }),
 *   ],
 * })
 * ```
 */
export function stream(parameters: stream.Parameters = {}) {
  const rpcUrl = parameters.rpcUrl ?? defaults.rpcUrl

  function getClient(chainId: number): Client {
    if (parameters.client) return parameters.client(chainId)

    const url = rpcUrl[chainId as keyof typeof rpcUrl]
    if (!url) throw new Error(`No \`rpcUrl\` configured for \`chainId\` (${chainId}).`)

    return createClient({
      chain: { ...tempo_chain, id: chainId },
      transport: http(url),
    })
  }

  const escrowContractMap = new Map<string, Address>()

  return MethodIntent.toClient(Intents.stream, {
    context: streamContextSchema,

    async createCredential({ challenge, context }) {
      const account = context?.account ?? parameters.account
      if (!account)
        throw new Error('No `account` provided. Pass `account` to parameters or context.')

      const chainId = (challenge.request.methodDetails?.chainId ?? Number(Object.keys(rpcUrl)[0]))!
      const client = getClient(chainId)

      const {
        action,
        channelId: channelIdRaw,
        cumulativeAmount,
        hash: openTxHash,
        topUpTxHash,
        authorizedSigner,
      } = context

      const channelId = channelIdRaw as Hex

      const challengeEscrow = (challenge.request.methodDetails as { escrowContract?: string })
        ?.escrowContract as Address | undefined
      const escrowContract =
        escrowContractMap.get(channelId) ?? challengeEscrow ?? parameters.escrowContract
      if (!escrowContract)
        throw new Error(
          'No `escrowContract` available. Provide it in parameters or ensure the server challenge includes it.',
        )
      escrowContractMap.set(channelId, escrowContract)

      const signature = await signVoucher(
        client,
        account,
        { channelId, cumulativeAmount },
        escrowContract,
        chainId,
      )

      let payload: StreamCredentialPayload

      switch (action) {
        case 'open':
          payload = {
            action: 'open',
            type: openTxHash ? 'hash' : 'transaction',
            channelId,
            ...(openTxHash !== undefined && { hash: openTxHash as Hex }),
            authorizedSigner: (authorizedSigner as Address) ?? account.address,
            cumulativeAmount: cumulativeAmount.toString(),
            voucherSignature: signature,
          }
          break

        case 'topUp':
          if (!topUpTxHash) {
            throw new Error('topUpTxHash required for topUp action')
          }
          payload = {
            action: 'topUp',
            channelId,
            topUpTxHash: topUpTxHash as Hex,
            cumulativeAmount: cumulativeAmount.toString(),
            voucherSignature: signature,
          }
          break

        case 'voucher':
          payload = {
            action: 'voucher',
            channelId,
            cumulativeAmount: cumulativeAmount.toString(),
            signature,
          }
          break

        case 'close':
          payload = {
            action: 'close',
            channelId,
            cumulativeAmount: cumulativeAmount.toString(),
            voucherSignature: signature,
          }
          break
      }

      return Credential.serialize({
        challenge,
        payload,
        source: `did:pkh:eip155:${chainId}:${account.address}`,
      })
    },
  })
}

export declare namespace stream {
  type Parameters = {
    /** Account to sign vouchers with. */
    account?: Account | undefined
    /** Escrow contract address override. Derived from challenge if not provided. */
    escrowContract?: Address | undefined
  } & OneOf<
    | {
        /** Function that returns a client for the given chain ID. */
        client?: ((chainId: number) => Client) | undefined
      }
    | {
        /** RPC URLs keyed by chain ID. */
        rpcUrl?: ({ [chainId: number]: string } & object) | undefined
      }
  >
}
