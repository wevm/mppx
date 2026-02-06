import type { Account, Address, Client, Hex, WalletClient } from 'viem'
import * as Credential from '../../../Credential.js'
import type { OneOf } from '../../../internal/types.js'
import * as Method from '../../../Method.js'
import * as z from '../../../zod.js'
import * as defaults from '../../internal/defaults.js'
import * as Methods from '../../Method.js'
import type { StreamCredentialPayload } from '../Types.js'
import { signVoucher } from '../Voucher.js'

export const streamContextSchema = z.object({
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
  const escrowContractMap = new Map<string, Address>()

  return Method.toClient(Methods.tempo, {
    context: streamContextSchema,

    async createCredential({ challenge, context }) {
      const account = parameters.account
      if (!account) throw new Error('No `account` provided. Pass `account` to parameters.')

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

      const chainId =
        (challenge.request.methodDetails as { chainId?: number })?.chainId ??
        parameters.chainId ??
        defaults.testnetChainId

      const walletClient = parameters.walletClient ?? parameters.client
      if (!walletClient) throw new Error('No `client` or `walletClient` provided.')

      const signature = await signVoucher(
        walletClient as WalletClient,
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
    /** Chain ID override. Derived from challenge or defaults if not provided. */
    chainId?: number | undefined
  } & OneOf<
    | {
        /** Client for signing. */
        client?: Client | undefined
      }
    | {
        /** Wallet client for signing. */
        walletClient?: WalletClient | undefined
      }
  >
}
