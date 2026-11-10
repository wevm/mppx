import type * as Hex from 'ox/Hex'
import {
  decodeFunctionData,
  encodeFunctionData,
  formatUnits,
  getAddress,
  isAddress,
  isAddressEqual,
  parseAbi,
  type Account,
  type Address,
  type Client,
} from 'viem'
import { call, readContract } from 'viem/actions'
import { Abis, Actions } from 'viem/tempo'

import * as Errors from '../../Errors.js'
import * as defaults from './defaults.js'

/** ABI for the legacy machine-token settlement swapper, still verified for older clients. */
export const machineTokenSwapperAbi = parseAbi([
  'function swapTo(address inputToken,uint256 amount,address targetToken,address recipient,bytes32 memo)',
])

type Call = {
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

type Transfer = {
  amount: bigint | string
  memo?: string | undefined
  recipient: Address
}

function getDeployment(chainId: number | undefined) {
  if (chainId === undefined) return undefined
  return defaults.machineToken[chainId as keyof typeof defaults.machineToken]
}

/** Returns whether a first-party machine-token charge route is deployed on a chain. */
export function isSupported(chainId: number | undefined): boolean {
  return !!getDeployment(chainId)
}

/** Returns whether a currency is the machine token for a supported chain. */
export function isMachineToken(parameters: {
  chainId: number | undefined
  currency: Address
}): boolean {
  const deployment = getDeployment(parameters.chainId)
  return (
    !!deployment &&
    isAddress(parameters.currency, { strict: false }) &&
    isAddressEqual(parameters.currency, deployment.token)
  )
}

/** Resolves the legacy swapper route for a compatible charge, which servers still accept. */
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
          abi: machineTokenSwapperAbi,
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

/** Matches an exact legacy swapper route. */
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
    const decoded = decodeFunctionData({ abi: machineTokenSwapperAbi, data: swap.data })
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

/** Returns the canonical machine token on a chain, if one is deployed. */
export function getToken(chainId: number | undefined): Address | undefined {
  return getDeployment(chainId)?.token
}

/** Returns the trusted sender that settles the configured charge route on a chain. */
export function getSettlementSender(chainId: number | undefined): Address | undefined {
  return getDeployment(chainId)?.swap
}

/** MACH base units per cent: MACH has 6 decimals and trades 1:1 with USD. */
const unitsPerCent = 10n ** BigInt(defaults.decimals - 2)

/**
 * Builds the Tempo Wallet link that buys MACH.
 *
 * Returns `undefined` on chains other than Tempo mainnet (4217), where the wallet sells no MACH.
 * `amount` is in MACH base units (6 decimals) and is rounded up to whole cents.
 *
 * @example
 * ```ts
 * import { Tempo } from 'mppx'
 *
 * Tempo.machineTokenFundingUrl({ address: '0x…', amount: 1_250_000n })
 * // https://wallet.tempo.xyz/agent?action=fund&intent=mach&chainId=4217&address=0x…&amount=1.25
 * ```
 */
export function fundingUrl(
  parameters: {
    /** Payer to fund. The wallet asks the user to sign in with this address. */
    address?: Address | undefined
    /** MACH to buy, in base units. */
    amount?: bigint | undefined
    /** Chain of the payment. Defaults to Tempo mainnet. */
    chainId?: number | undefined
  } = {},
): string | undefined {
  const { address, amount, chainId = defaults.chainId.mainnet } = parameters
  if (chainId !== defaults.chainId.mainnet) return undefined
  const url = new URL(defaults.machineTokenFundingBaseUrl)
  if (address && isAddress(address, { strict: false }))
    url.searchParams.set('address', getAddress(address))
  if (amount !== undefined && amount > 0n) {
    const cents = (amount + unitsPerCent - 1n) / unitsPerCent
    const fraction = cents % 100n
    const whole = (cents / 100n).toString()
    url.searchParams.set(
      'amount',
      fraction === 0n
        ? whole
        : `${whole}.${fraction.toString().padStart(2, '0').replace(/0$/, '')}`,
    )
  }
  return url.toString()
}

/**
 * Returns `account`'s MACH balance, or `undefined` when the chain has no machine-token deployment or
 * the balance can't be read.
 */
export async function getBalance(
  client: Client,
  parameters: { account: Address; chainId: number | undefined },
): Promise<bigint | undefined> {
  const deployment = getDeployment(parameters.chainId)
  if (!deployment) return undefined
  const balance = await readContract(
    client,
    Actions.token.getBalance.call(client, {
      account: parameters.account,
      token: deployment.token,
    }) as never,
  ).catch(() => undefined)
  return typeof balance === 'bigint' ? balance : undefined
}

/**
 * Returns how far `account`'s MACH balance falls short of `amount`, with a reason and the MACH onramp
 * link (on Tempo mainnet) to report it.
 *
 * Returns `undefined` when the chain has no machine-token deployment, the account holds enough MACH,
 * or its balance can't be read.
 */
export async function getShortfall(
  client: Client,
  parameters: {
    account: Address
    amount: bigint
    chainId: number | undefined
  },
): Promise<{ fundingUrl: string | undefined; reason: string; shortfall: bigint } | undefined> {
  const { account, amount, chainId } = parameters
  const balance = await getBalance(client, { account, chainId })
  if (balance === undefined || balance >= amount) return undefined
  const format = (value: bigint) => `${formatUnits(value, defaults.decimals)} MACH`
  const shortfall = amount - balance
  return {
    fundingUrl: fundingUrl({ address: account, amount: shortfall, chainId }),
    reason: `requested ${format(amount)}, available ${format(balance)}`,
    shortfall,
  }
}

/**
 * Returns an `InsufficientBalanceError` that links to the MACH onramp when `account` holds less
 * MACH than `amount`. See `getShortfall`.
 */
export async function getInsufficientBalanceError(
  client: Client,
  parameters: Parameters<typeof getShortfall>[1],
): Promise<Errors.InsufficientBalanceError | undefined> {
  const shortfall = await getShortfall(client, parameters)
  if (!shortfall) return undefined
  return new Errors.InsufficientBalanceError({
    fundingUrl: shortfall.fundingUrl,
    reason: shortfall.reason,
  })
}

/**
 * Returns whether an account can spend `amount` of a token: its balance covers it and, for an access
 * key that limits spending, so does its remaining limit. Any failed read returns false.
 */
export async function canSpend(
  client: Client,
  parameters: { account: Account; amount: bigint; token: Address },
): Promise<boolean> {
  const { account, amount, token } = parameters
  try {
    const balance = (await readContract(
      client,
      Actions.token.getBalance.call(client, { account: account.address, token }) as never,
    )) as bigint
    if (balance < amount) return false
    const accessKey = (account as { accessKeyAddress?: unknown }).accessKeyAddress
    if (typeof accessKey !== 'string') return true
    const metadata = await Actions.accessKey.getMetadata(client, {
      account: account.address,
      accessKey: accessKey as Address,
    })
    if (metadata.spendPolicy !== 'limited') return true
    const { remaining } = await Actions.accessKey.getRemainingLimit(client, {
      account: account.address,
      accessKey: accessKey as Address,
      token,
    })
    return remaining >= amount
  } catch {
    return false
  }
}

/**
 * Returns whether an account can pay a charge directly in the machine token: it can spend the total
 * and a simulation of the transfer calls succeeds. Any failure returns false, so the caller pays in
 * the challenge currency instead.
 */
export async function canPayDirect(
  client: Client,
  parameters: {
    account: Account
    amount: bigint
    calls: readonly Call[]
    token: Address
  },
): Promise<boolean> {
  const { account, amount, calls, token } = parameters
  if (!(await canSpend(client, { account, amount, token }))) return false
  try {
    await call(client, { account: account.address, calls } as never)
    return true
  } catch {
    return false
  }
}
