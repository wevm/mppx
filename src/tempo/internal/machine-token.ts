import type * as Hex from 'ox/Hex'
import {
  decodeFunctionData,
  encodeFunctionData,
  isAddressEqual,
  zeroAddress,
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

const sessionRouteAbi = [
  {
    inputs: [
      { name: 'merchant', type: 'address' },
      { name: 'targetToken', type: 'address' },
    ],
    name: 'sessionRouteFor',
    outputs: [{ name: 'routeAddress', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ name: 'routeAddress', type: 'address' }],
    name: 'sessionRoutes',
    outputs: [
      { name: 'merchant', type: 'address' },
      { name: 'targetToken', type: 'address' },
    ],
    stateMutability: 'view',
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

export type SessionDescriptor = {
  authorizedSigner: Address
  expiringNonceHash: Hex.Hex
  operator: Address
  payee: Address
  payer: Address
  salt: Hex.Hex
  token: Address
}

export type SessionRoute = {
  merchant: Address
  operator: Address
  payee: Address
  targetToken: Address
  token: Address
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

function getSessionDeployment(chainId: number | undefined) {
  const deployment = getDeployment(chainId)
  if (!deployment || !('session' in deployment) || deployment.session !== true) return undefined
  return deployment
}

/** Returns whether a first-party machine-token route is deployed on a chain. */
export function isSupported(chainId: number | undefined): boolean {
  return !!getDeployment(chainId)
}

/** Returns whether the first-party machine token supports TIP-1034 sessions on a chain. */
export function isSessionSupported(chainId: number | undefined): boolean {
  return !!getSessionDeployment(chainId)
}

/** Returns the liquid fee token used for machine-session management transactions. */
export function getSessionFeeToken(chainId: number | undefined): Address | undefined {
  return getSessionDeployment(chainId)?.feeToken
}

/** Resolves the active virtual payee for a merchant's target-currency session route. */
export async function findSessionRoute(
  client: Client,
  parameters: { chainId: number; merchant: Address; targetToken: Address },
): Promise<SessionRoute | undefined> {
  const deployment = getSessionDeployment(parameters.chainId)
  if (!deployment) return undefined
  const payee = await readContract(client, {
    address: deployment.swap,
    abi: sessionRouteAbi,
    functionName: 'sessionRouteFor',
    args: [parameters.merchant, parameters.targetToken],
  })
  if (isAddressEqual(payee, zeroAddress)) return undefined
  return {
    merchant: parameters.merchant,
    operator: deployment.swap,
    payee,
    targetToken: parameters.targetToken,
    token: deployment.token,
  }
}

/** Resolves the immutable merchant payout bound to a virtual machine-session payee. */
export async function getSessionRoute(
  client: Client,
  parameters: { chainId: number; payee: Address },
): Promise<SessionRoute | undefined> {
  const deployment = getSessionDeployment(parameters.chainId)
  if (!deployment) return undefined
  const [merchant, targetToken] = await readContract(client, {
    address: deployment.swap,
    abi: sessionRouteAbi,
    functionName: 'sessionRoutes',
    args: [parameters.payee],
  })
  if (isAddressEqual(merchant, zeroAddress) || isAddressEqual(targetToken, zeroAddress))
    return undefined
  return {
    merchant,
    operator: deployment.swap,
    payee: parameters.payee,
    targetToken,
    token: deployment.token,
  }
}

/** Resolves an active route and verifies its immutable reverse merchant binding. */
export async function findVerifiedSessionRoute(
  client: Client,
  parameters: { chainId: number; merchant: Address; targetToken: Address },
): Promise<SessionRoute | undefined> {
  const active = await findSessionRoute(client, parameters)
  if (!active) return undefined
  const route = await getSessionRoute(client, { chainId: parameters.chainId, payee: active.payee })
  if (
    !route ||
    !isAddressEqual(route.merchant, parameters.merchant) ||
    !isAddressEqual(route.targetToken, parameters.targetToken)
  )
    return undefined
  return route
}

/** Resolves a virtual payee and, unless closing, proves its route is still active. */
export async function resolveSessionRoute(
  client: Client,
  parameters: { active?: boolean | undefined; chainId: number; payee: Address },
): Promise<SessionRoute | undefined> {
  const route = await getSessionRoute(client, parameters)
  if (!route || parameters.active === false) return route
  const active = await findSessionRoute(client, {
    chainId: parameters.chainId,
    merchant: route.merchant,
    targetToken: route.targetToken,
  })
  if (!active || !isAddressEqual(active.payee, parameters.payee)) return undefined
  return route
}

/** Matches the trusted router and token pair for a machine-token session descriptor. */
export function matchSessionDescriptor(parameters: {
  chainId: number | undefined
  descriptor: Pick<SessionDescriptor, 'operator' | 'token'>
}) {
  const deployment = getSessionDeployment(parameters.chainId)
  if (!deployment) return undefined
  if (
    !isAddressEqual(parameters.descriptor.operator, deployment.swap) ||
    !isAddressEqual(parameters.descriptor.token, deployment.token)
  )
    return undefined
  return deployment
}

/** Returns whether an authenticated session challenge permits the machine-token rail. */
export function isSessionEnabledChallenge(challenge: { request: { methodDetails?: unknown } }) {
  const methodDetails = challenge.request.methodDetails
  if (!methodDetails || typeof methodDetails !== 'object') return false
  return (methodDetails as { machineTokenEnabled?: unknown }).machineTokenEnabled === true
}

/** Verifies that a machine-session descriptor resolves to the challenged merchant payout. */
export async function matchSessionRoute(
  client: Client,
  parameters: {
    active?: boolean | undefined
    chainId: number
    descriptor: Pick<SessionDescriptor, 'operator' | 'payee' | 'token'>
    merchant: Address
    targetToken: Address
  },
): Promise<SessionRoute | undefined> {
  if (!matchSessionDescriptor(parameters)) return undefined
  const route = await resolveSessionRoute(client, {
    active: parameters.active,
    chainId: parameters.chainId,
    payee: parameters.descriptor.payee,
  })
  if (
    !route ||
    !isAddressEqual(route.merchant, parameters.merchant) ||
    !isAddressEqual(route.targetToken, parameters.targetToken)
  )
    return undefined
  return route
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
