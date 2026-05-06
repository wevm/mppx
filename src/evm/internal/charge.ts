import { encodePacked, keccak256, parseUnits, type Address, type Hex } from 'viem'

import { credentialTypes, permit2Address } from './constants.js'

export type CredentialType = (typeof credentialTypes)[number]

export type Split = {
  amount: string
  memo?: string | undefined
  recipient: Address
}

export type Transfer = {
  amount: string
  recipient: Address
}

export type MethodDetails = {
  chainId?: number | undefined
  credentialTypes?: readonly CredentialType[] | undefined
  decimals?: number | undefined
  permit2Address?: Address | undefined
  spender?: Address | undefined
  splits?: readonly Split[] | undefined
}

export const witnessTypeString =
  'PaymentWitness witness)PaymentWitness(bytes32 challengeHash)TokenPermissions(address token,uint256 amount)'

export const permit2WitnessTypes = {
  TokenPermissions: [
    { name: 'token', type: 'address' },
    { name: 'amount', type: 'uint256' },
  ],
  PaymentWitness: [{ name: 'challengeHash', type: 'bytes32' }],
} as const

export const eip3009Types = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const

export function amountToBaseUnits(amount: string, decimals: number | undefined): string {
  if (decimals === undefined) {
    if (!/^\d+$/.test(amount))
      throw new Error('Amount must be an integer when decimals is omitted.')
    return amount
  }
  return parseUnits(amount, decimals).toString()
}

export function getTransfers(request: {
  amount: string
  methodDetails?: { splits?: readonly Split[] | undefined } | undefined
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
    { amount: primaryAmount.toString(), recipient: request.recipient },
    ...splits.map((split) => ({ amount: split.amount, recipient: split.recipient })),
  ]
}

export function challengeHash(challenge: { id: string; realm: string }): Hex {
  return keccak256(encodePacked(['string', 'string'], [challenge.id, challenge.realm]))
}

export function defaultCredentialTypes(parameters: {
  authorization?: boolean | undefined
  serverPaysGas?: boolean | undefined
}): CredentialType[] {
  return [
    ...(parameters.serverPaysGas ? (['permit2'] as const) : []),
    ...(parameters.authorization ? (['authorization'] as const) : []),
    'transaction',
    'hash',
  ]
}

export function resolvePermit2Address(address: string | undefined): Address {
  return (address ?? permit2Address) as Address
}
