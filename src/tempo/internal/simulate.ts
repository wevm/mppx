import type { Address, Client } from 'viem'

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
    calls?: readonly { to?: string | undefined; value?: bigint | undefined; data?: string | undefined }[]
  },
): Promise<void> {
  const simCalls = (transaction.calls ?? []).map((c) => ({
    to: c.to,
    value: c.value ? `0x${c.value.toString(16)}` : '0x0',
    input: c.data ?? '0x',
  }))
  await client.request({
    method: 'eth_estimateGas' as never,
    params: [
      {
        from: transaction.from,
        chainId: `0x${transaction.chainId.toString(16)}`,
        nonce: `0x${BigInt(transaction.nonce ?? 0).toString(16)}`,
        gas: '0x2dc6c0', // 3M cap
        maxFeePerGas: `0x${(transaction.maxFeePerGas ?? 0n).toString(16)}`,
        maxPriorityFeePerGas: `0x${(transaction.maxPriorityFeePerGas ?? 0n).toString(16)}`,
        feeToken: transaction.feeToken,
        nonceKey: `0x${(transaction.nonceKey ?? 0n).toString(16)}`,
        calls: simCalls,
        ...(transaction.validBefore
          ? { validBefore: `0x${transaction.validBefore.toString(16)}` }
          : {}),
      },
    ] as never,
  })
}
