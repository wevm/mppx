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
  settlementSender: Address
  transfers: readonly [{ amount: bigint; memo: Hex.Hex; recipient: Address }]
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

/** Resolves the canonical first-party settlement route for a compatible charge. */
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
    settlementSender: deployment.swap,
    transfers: [{ amount, memo, recipient: transfer.recipient }],
  }
}

/** Builds and simulates the first-party settlement route. */
export async function findRoute(
  client: Client,
  parameters: {
    account: Address
    chainId: number
    currency: Address
    transfers: readonly Transfer[]
  },
): Promise<Route | undefined> {
  const route = getRoute(parameters)
  if (!route) return undefined

  try {
    const balance = await readContract(
      client,
      Actions.token.getBalance.call(client, {
        account: parameters.account,
        token: route.calls[0].to,
      }) as never,
    )
    if ((balance as bigint) < route.transfers[0].amount) return undefined

    await call(client, { account: parameters.account, calls: route.calls } as never)
    return route
  } catch {
    return undefined
  }
}

/** Matches an exact first-party settlement route. */
export function matchRoute(parameters: {
  calls: readonly Call[]
  chainId: number | undefined
  currency: Address
  transfers: readonly Transfer[]
}): Route | undefined {
  const transfer = parameters.transfers.length === 1 ? parameters.transfers[0] : undefined
  const swap = parameters.calls[1]
  if (!transfer || parameters.calls.length !== 2 || !swap?.data) return undefined

  try {
    const decoded = decodeFunctionData({ abi: swapAbi, data: swap.data })
    const route = getRoute({
      ...parameters,
      transfers: [{ ...transfer, memo: transfer.memo ?? decoded.args[4] }],
    })
    if (!route) return undefined
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
      return undefined

    return route
  } catch {
    return undefined
  }
}

/** Returns the trusted sender that settles the configured route on a chain. */
export function getSettlementSender(chainId: number | undefined): Address | undefined {
  return getDeployment(chainId)?.swap
}
