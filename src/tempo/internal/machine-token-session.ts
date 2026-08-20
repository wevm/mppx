import type * as Hex from 'ox/Hex'
import { SignatureEnvelope } from 'ox/tempo'
import {
  hashTypedData,
  isAddressEqual,
  parseAbi,
  zeroAddress,
  type Account,
  type Address,
  type Client,
} from 'viem'
import { readContract, signTypedData } from 'viem/actions'
import { Actions } from 'viem/tempo'

import { isAccessKeyAccount } from './account.js'
import * as defaults from './defaults.js'
import { parseCanonicalEnvelope, serializeCanonicalEnvelope } from './signature-envelope.js'

const sessionRouteAbi = parseAbi([
  'function sessionRouteFor(address merchant,address targetToken) view returns (address routeAddress)',
  'function sessionRoutes(address routeAddress) view returns (address merchant,address targetToken)',
])

const authorizationTypes = {
  SessionAuthorization: [
    { name: 'channelId', type: 'bytes32' },
    { name: 'cumulativeAmount', type: 'uint96' },
  ],
} as const

type Deployment = (typeof defaults.machineToken)[keyof typeof defaults.machineToken]

/** Verified machine-token session route. */
export type Route = {
  operator: Address
  payee: Address
  token: Address
}

type Authorization = {
  channelId: Hex.Hex
  cumulativeAmount: bigint
}

function getDeployment(chainId: number | undefined): Deployment | undefined {
  if (chainId === undefined) return undefined
  return defaults.machineToken[chainId as keyof typeof defaults.machineToken]
}

/** Returns whether a unified machine-token router is configured on a chain. */
export function isSupported(chainId: number | undefined): boolean {
  return !!getDeployment(chainId)
}

/** Matches a session descriptor to the configured router and machine token. */
export function matchDeployment(parameters: {
  chainId: number | undefined
  descriptor: { operator: Address; token: Address }
}): Deployment | undefined {
  const deployment = getDeployment(parameters.chainId)
  return deployment &&
    isAddressEqual(parameters.descriptor.operator, deployment.swap) &&
    isAddressEqual(parameters.descriptor.token, deployment.token)
    ? deployment
    : undefined
}

/** Returns whether an authenticated session challenge permits the machine-token rail. */
export function isEnabledChallenge(challenge: { request: { methodDetails?: unknown } }): boolean {
  return (
    (challenge.request.methodDetails as { machineTokenEnabled?: unknown } | null | undefined)
      ?.machineTokenEnabled === true
  )
}

/** Resolves the fee token from the payment token and an optional explicit override. */
export function resolveFeeToken(parameters: {
  chainId: number | undefined
  override?: Address | undefined
  paymentToken: Address
}): Address {
  if (parameters.override) return parameters.override
  const deployment = getDeployment(parameters.chainId)
  if (deployment && isAddressEqual(parameters.paymentToken, deployment.token))
    return defaults.tokens.pathUsd
  return parameters.paymentToken
}

/**
 * Resolves the fee tokens accepted for direct-rail sponsored transactions.
 * Clients released before the fee-token advertisement always pay sponsored
 * fees in the payment token, so it stays accepted alongside a configured
 * override. Machine-rail routes post-date the advertisement and pin a single
 * token via {@link resolveFeeToken}.
 */
export function allowedSponsoredFeeTokens(parameters: {
  chainId: number | undefined
  override?: Address | undefined
  paymentToken: Address
}): readonly Address[] {
  const feeToken = resolveFeeToken(parameters)
  if (isAddressEqual(feeToken, parameters.paymentToken)) return [feeToken]
  return [feeToken, parameters.paymentToken]
}

/** Returns whether an account has enough of a TIP-20 token for an operation. */
export async function hasSufficientBalance(
  client: Client,
  parameters: { account: Address; amount: bigint; token: Address },
): Promise<boolean> {
  try {
    const balance = await readContract(
      client,
      Actions.token.getBalance.call(client, {
        account: parameters.account,
        token: parameters.token,
      }) as never,
    )
    return (balance as bigint) >= parameters.amount
  } catch {
    return false
  }
}

function authorizationDomain(router: Address, chainId: number) {
  return {
    name: 'MachineUSD Session Router',
    version: '1',
    chainId,
    verifyingContract: router,
  } as const
}

function hashAuthorization(parameters: {
  authorization: Authorization
  chainId: number
  router: Address
}): Hex.Hex {
  return hashTypedData({
    domain: authorizationDomain(parameters.router, parameters.chainId),
    types: authorizationTypes,
    primaryType: 'SessionAuthorization',
    message: parameters.authorization,
  })
}

/** Signs a cumulative amount in the router-specific authorization domain. */
export async function signAuthorization(
  client: Client,
  account: Account,
  parameters: { authorization: Authorization; chainId: number; router: Address },
): Promise<Hex.Hex> {
  const signature = isAccessKeyAccount(account)
    ? await account.sign({
        hash: hashAuthorization(parameters),
        raw: true,
      })
    : await signTypedData(client, {
        account,
        domain: authorizationDomain(parameters.router, parameters.chainId),
        types: authorizationTypes,
        primaryType: 'SessionAuthorization',
        message: parameters.authorization,
      })
  return serializeCanonicalEnvelope(signature, 'Machine-token session authorizations')
}

/** Verifies a cumulative authorization in the router-specific domain. */
export function verifyAuthorization(parameters: {
  authorization: Authorization
  chainId: number
  expectedSigner: Address
  router: Address
  signature: Hex.Hex
}): boolean {
  try {
    const envelope = parseCanonicalEnvelope(parameters.signature)
    if (!envelope) return false
    const payload = hashAuthorization(parameters)
    return SignatureEnvelope.verify(envelope, { address: parameters.expectedSigner, payload })
  } catch {
    return false
  }
}

async function readRoute(
  client: Client,
  deployment: Deployment,
  parameters: {
    active: boolean
    merchant: Address
    payee?: Address | undefined
    targetToken: Address
  },
): Promise<Route | undefined> {
  const payee =
    parameters.payee ??
    (await readContract(client, {
      address: deployment.swap,
      abi: sessionRouteAbi,
      functionName: 'sessionRouteFor',
      args: [parameters.merchant, parameters.targetToken],
    }))
  if (isAddressEqual(payee, zeroAddress)) return undefined

  const [binding, activePayee] = await Promise.all([
    readContract(client, {
      address: deployment.swap,
      abi: sessionRouteAbi,
      functionName: 'sessionRoutes',
      args: [payee],
    }),
    parameters.active && parameters.payee
      ? readContract(client, {
          address: deployment.swap,
          abi: sessionRouteAbi,
          functionName: 'sessionRouteFor',
          args: [parameters.merchant, parameters.targetToken],
        })
      : payee,
  ])
  if (
    isAddressEqual(binding[0], zeroAddress) ||
    isAddressEqual(binding[1], zeroAddress) ||
    !isAddressEqual(binding[0], parameters.merchant) ||
    !isAddressEqual(binding[1], parameters.targetToken) ||
    !isAddressEqual(activePayee, payee)
  )
    return undefined
  return { operator: deployment.swap, payee, token: deployment.token }
}

/** Resolves the active virtual payee and verifies its immutable reverse binding. */
export async function resolveRoute(
  client: Client,
  parameters: { chainId: number; merchant: Address; targetToken: Address },
): Promise<Route | undefined> {
  const deployment = getDeployment(parameters.chainId)
  if (!deployment) return undefined
  return readRoute(client, deployment, { ...parameters, active: true })
}

/** Verifies a descriptor against the trusted router and merchant payout binding. */
export async function matchRoute(
  client: Client,
  parameters: {
    active?: boolean | undefined
    chainId: number
    descriptor: { operator: Address; payee: Address; token: Address }
    merchant: Address
    targetToken: Address
  },
): Promise<Route | undefined> {
  const deployment = matchDeployment(parameters)
  if (!deployment) return undefined
  return readRoute(client, deployment, {
    ...parameters,
    active: parameters.active !== false,
    payee: parameters.descriptor.payee,
  })
}
