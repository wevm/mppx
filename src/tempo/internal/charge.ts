import type { Address } from 'viem'

export type Split = {
  amount: string
  memo?: string | undefined
  recipient: Address
}

export type Transfer = {
  amount: string
  memo?: string | undefined
  recipient: Address
}

export function getTransfers(request: {
  amount: string
  methodDetails?: { memo?: string | undefined; splits?: readonly Split[] | undefined }
  recipient: Address
}): Transfer[] {
  const totalAmount = BigInt(request.amount)
  const splits = request.methodDetails?.splits ?? []

  const splitTotal = splits.reduce((sum, split) => sum + BigInt(split.amount), 0n)
  if (splitTotal >= totalAmount)
    throw new Error('Invalid charge request: split total must be less than total amount.')

  const primaryAmount = totalAmount - splitTotal
  if (primaryAmount <= 0n)
    throw new Error('Invalid charge request: primary transfer amount must be positive.')

  return [
    {
      amount: primaryAmount.toString(),
      memo: request.methodDetails?.memo,
      recipient: request.recipient,
    },
    ...splits.map((split) => ({
      amount: split.amount,
      memo: split.memo,
      recipient: split.recipient,
    })),
  ]
}
