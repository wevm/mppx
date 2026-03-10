import type { Address, Client } from 'viem'
import { estimateGas } from 'viem/actions'

/**
 * Simulate a Tempo transaction via `eth_estimateGas` to catch reverts
 * (e.g. insufficient balance, invalid calls) before broadcasting.
 */
export async function simulateTransaction(
  client: Client,
  transaction: {
    from: Address
    chainId: number
    nonce?: number | bigint | undefined
    maxFeePerGas?: bigint | undefined
    maxPriorityFeePerGas?: bigint | undefined
    feeToken?: string | bigint | undefined
    nonceKey?: bigint | undefined
    validBefore?: number | undefined
    calls?: readonly {
      to?: string | undefined
      value?: bigint | undefined
      data?: string | undefined
    }[]
  },
): Promise<void> {
  await estimateGas(client, {
    account: transaction.from,
    calls: transaction.calls,
    nonce: transaction.nonce !== undefined ? Number(transaction.nonce) : undefined,
    maxFeePerGas: transaction.maxFeePerGas,
    maxPriorityFeePerGas: transaction.maxPriorityFeePerGas,
    feeToken: transaction.feeToken,
    nonceKey: transaction.nonceKey,
    ...(transaction.validBefore ? { validBefore: transaction.validBefore } : {}),
    prepare: false,
  } as never)
}
