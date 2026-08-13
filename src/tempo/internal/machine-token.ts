import type * as Hex from 'ox/Hex'
import {
  decodeFunctionData,
  encodeFunctionData,
  isAddressEqual,
  type Address,
  type Client,
} from 'viem'
import { call, readContract } from 'viem/actions'
import { Abis, Actions } from 'viem/tempo'

import * as defaults from './defaults.js'

const swapAbi = [
  {
    inputs: [
      { name: 'inputToken', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'targetToken', type: 'address' },
      { name: 'recipient', type: 'address' },
      { name: 'memo', type: 'bytes32' },
    ],
    name: 'swapTo',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
] as const

export type Call = {
  data?: Hex.Hex | undefined
  to?: Address | undefined
  value?: bigint | undefined
}

type RouteCall = {
  data: Hex.Hex
  to: Address
}

type Route = {
  calls: readonly [RouteCall, RouteCall]
  token: Address
  transfer: { amount: bigint; memo: Hex.Hex; recipient: Address }
}

export type Transfer = {
  amount: bigint | string
  memo?: string | undefined
  recipient: Address
}

/** Shared first-party machine-token configuration for Tempo methods. */
export type Options = {
  /** Enables first-party machine-token settlement for supported Tempo methods. */
  machineTokenEnabled?: boolean | undefined
}

function getDeployment(chainId: number | undefined) {
  if (chainId === undefined) return undefined
  return defaults.machineToken[chainId as keyof typeof defaults.machineToken]
}

/** Returns whether a first-party machine-token route is deployed on a chain. */
export function isSupported(chainId: number | undefined): boolean {
  return !!getDeployment(chainId)
}

/** Resolves the canonical first-party machine-token settlement route. */
export function getRoute(parameters: {
  chainId: number | undefined
  currency: Address
  transfers: readonly Transfer[]
}): Route | undefined {
  const deployment = getDeployment(parameters.chainId)
  const transfer = parameters.transfers.length === 1 ? parameters.transfers[0] : undefined
  if (!deployment || !transfer?.memo) return undefined
  const amount = BigInt(transfer.amount)
  const memo = transfer.memo as Hex.Hex

  return {
    calls: [
      {
        data: encodeFunctionData({
          abi: Abis.tip20,
          functionName: 'approve',
          args: [deployment.swap, amount],
        }),
        to: deployment.token,
      },
      {
        data: encodeFunctionData({
          abi: swapAbi,
          functionName: 'swapTo',
          args: [deployment.token, amount, parameters.currency, transfer.recipient, memo],
        }),
        to: deployment.swap,
      },
    ],
    token: deployment.token,
    transfer: { amount, memo, recipient: transfer.recipient },
  }
}

/** Builds and simulates the first-party machine-token settlement calls. */
export async function findCalls(
  client: Client,
  parameters: {
    account: Address
    chainId: number
    currency: Address
    transfers: readonly Transfer[]
  },
): Promise<readonly Call[] | undefined> {
  const route = getRoute(parameters)
  if (!route) return undefined

  try {
    const balance = await readContract(
      client,
      Actions.token.getBalance.call(client, {
        account: parameters.account,
        token: route.token,
      }) as never,
    )
    if ((balance as bigint) < route.transfer.amount) return undefined

    await call(client, { account: parameters.account, calls: route.calls } as never)
    return route.calls
  } catch {
    return undefined
  }
}

/** Validates the exact first-party machine-token settlement route. */
export function validateCalls(parameters: {
  calls: readonly Call[]
  chainId: number | undefined
  currency: Address
  transfers: readonly Transfer[]
}): readonly Transfer[] | false {
  const transfer = parameters.transfers.length === 1 ? parameters.transfers[0] : undefined
  const swap = parameters.calls[1]
  if (!transfer || parameters.calls.length !== 2 || !swap?.data) return false

  try {
    const decoded = decodeFunctionData({ abi: swapAbi, data: swap.data })
    const route = getRoute({
      ...parameters,
      transfers: [{ ...transfer, memo: transfer.memo ?? decoded.args[4] }],
    })
    if (!route) return false
    if (
      parameters.calls.some((call, index) => {
        const expected = route.calls[index]
        return (
          !call.data ||
          !call.to ||
          !expected ||
          (call.value ?? 0n) !== 0n ||
          !isAddressEqual(call.to, expected.to) ||
          call.data.toLowerCase() !== expected.data.toLowerCase()
        )
      })
    )
      return false

    return [route.transfer]
  } catch {
    return false
  }
}

/** Returns whether an address is the first-party machine-token swap. */
export function isSwap(parameters: { address: Address; chainId: number | undefined }): boolean {
  const deployment = getDeployment(parameters.chainId)
  return !!deployment && isAddressEqual(parameters.address, deployment.swap)
}
