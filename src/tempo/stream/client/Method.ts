import type { Account, Address, Hex, WalletClient } from 'viem'
import * as Credential from '../../../Credential.js'
import * as Method from '../../../Method.js'
import * as z from '../../../zod.js'
import * as Methods from '../../Method.js'
import type { StreamCredentialPayload } from '../Types.js'
import { signVoucher } from '../Voucher.js'

/**
 * Context schema for stream credential creation.
 * This is passed per-request to the createCredential function.
 */
export const streamContextSchema = z.object({
	/** Action to perform: open, topUp, voucher, or close */
	action: z.enum(['open', 'topUp', 'voucher', 'close']),
	/** On-chain channel ID (caller provides from channel open) */
	channelId: z.string(),
	/** Cumulative amount for the voucher */
	cumulativeAmount: z.bigint(),
	/** Transaction hash for open action (optional - can derive channelId) */
	hash: z.optional(z.string()),
	/** Transaction hash for topUp action */
	topUpTxHash: z.optional(z.string()),
	/** Override authorized signer (defaults to account address) */
	authorizedSigner: z.optional(z.string()),
})

export type StreamContext = z.infer<typeof streamContextSchema>

/**
 * Creates a stream payment client using the mpay Method.toClient() pattern.
 *
 * The client accepts a channelId from the caller, which should be the
 * real on-chain channel ID from opening a channel on the escrow contract.
 *
 * @example
 * ```ts
 * import { Fetch, tempo } from 'mpay/client'
 *
 * const paidFetch = Fetch.from({
 *   methods: [
 *     tempo.stream({
 *       account: privateKeyToAccount('0x...'),
 *       walletClient,
 *       escrowContract: '0x...',
 *       chainId: 42431,
 *     }),
 *   ],
 * })
 * ```
 */
export function stream(parameters: stream.Parameters) {
	const { account, walletClient, escrowContract, chainId } = parameters

	return Method.toClient(Methods.tempo, {
		context: streamContextSchema,

		async createCredential({ challenge, context }) {
			const {
				action,
				channelId: channelIdRaw,
				cumulativeAmount,
				hash: openTxHash,
				topUpTxHash,
				authorizedSigner,
			} = context

			const channelId = channelIdRaw as Hex

			// Sign voucher (no sessionHash — cumulative monotonicity prevents replay)
			const signature = await signVoucher(
				walletClient,
				account,
				{
					channelId,
					cumulativeAmount,
				},
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
		/** Account to sign vouchers with */
		account: Account
		/** Wallet client for signing */
		walletClient: WalletClient
		/** Escrow contract address */
		escrowContract: Address
		/** Chain ID */
		chainId: number
	}
}
