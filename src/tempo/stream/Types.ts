import type { Address, Hex } from 'viem'

/**
 * Voucher for cumulative payment.
 * Cumulative monotonicity prevents replay attacks.
 */
export interface Voucher {
	channelId: Hex
	cumulativeAmount: bigint
}

/**
 * Signed voucher with EIP-712 signature.
 */
export interface SignedVoucher extends Voucher {
	signature: Hex
}

/**
 * Stream credential payload (discriminated union).
 */
export type StreamCredentialPayload =
	| {
			action: 'open'
			type: 'hash' | 'transaction'
			channelId: Hex
			hash?: Hex | undefined
			signature?: Hex | undefined
			authorizedSigner?: Address | undefined
			cumulativeAmount: string
			voucherSignature: Hex
	  }
	| {
			action: 'topUp'
			channelId: Hex
			topUpTxHash: Hex
			cumulativeAmount: string
			voucherSignature: Hex
	  }
	| {
			action: 'voucher'
			channelId: Hex
			cumulativeAmount: string
			signature: Hex
	  }
	| {
			action: 'close'
			channelId: Hex
			cumulativeAmount: string
			voucherSignature: Hex
	  }

/**
 * Stream receipt returned in Payment-Receipt header.
 */
export interface StreamReceipt {
	method: 'tempo'
	intent: 'stream'
	status: 'success'
	timestamp: string
	/** Payment reference (channelId). Satisfies Receipt.Receipt contract. */
	reference: string
	challengeId: string
	channelId: Hex
	acceptedCumulative: string
	spent: string
	units?: number | undefined
	txHash?: Hex | undefined
}
