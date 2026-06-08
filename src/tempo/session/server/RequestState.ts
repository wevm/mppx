import { isAddress, parseUnits, type Account as viem_Account, type Address, type Hex } from 'viem'

import * as Constants from '../../../Constants.js'
import type * as Credential from '../../../Credential.js'
import { VerificationFailedError } from '../../../Errors.js'
import type { Challenge } from '../../../index.js'
import type * as z from '../../../zod.js'
import * as Methods from '../../Methods.js'
import {
  captureRequestBodyProbe,
  isSessionContentRequest,
  type RequestBodyProbe,
} from '../../server/internal/request-body.js'
import type * as PrecompileChain from '../precompile/Chain.js'
import { tip20ChannelEscrow, type SessionCredentialPayload } from '../precompile/Protocol.js'
import type { SessionSnapshot } from '../Snapshot.js'
import * as ChannelStore from './ChannelStore.js'
import { requireSessionCredentialAction } from './CredentialVerification.js'
import {
  resolveCredentialFeePayer,
  resolveRequestFeePayer,
  type ParameterFeePayer,
} from './Settlement.js'

/** Inputs used to build server bootstrap hints for a reusable session channel. */
export type ResolveSessionSnapshotParameters = {
  /** Raw request amount that must be covered by the next voucher. */
  amount: bigint
  /** Channel ID from credential or challenge request, when available. */
  channelId: Hex | undefined
  /** Server channel store. */
  store: ChannelStore.ChannelStore
}

/** Request metadata available to `resolveChannelId` without exposing a mutable `Request`. */
export type SessionChannelIdRequest = {
  /** Request headers, useful for cookies or auth/session headers. */
  readonly headers: Headers
  /** Whether the original request had a body, when known. */
  readonly hasBody?: boolean | undefined
  /** HTTP method for the protected request. */
  readonly method: string
  /** Request URL, when the transport captured it. */
  readonly url?: URL | undefined
}

/** Inputs for resolving a reusable channel when the request did not include a channel ID. */
export type ResolveSessionChannelIdParameters = {
  /** Captured HTTP request metadata, when the transport provides it. */
  request?: SessionChannelIdRequest | undefined
  /** Credential submitted with the request, when present. */
  credential: Credential.Credential | null | undefined
  /** Cryptographic payer identity from a verified zero-amount bootstrap proof. */
  source?: string | undefined
  /** Session payment request being challenged. */
  paymentRequest: SessionPaymentRequestInput
  /** Channel store backing this session method. */
  store: ChannelStore.ChannelStore
}

/** Application hook for mapping request identity to an existing session channel. */
export type ResolveSessionChannelId = (
  parameters: ResolveSessionChannelIdParameters,
) => Promise<string | null | undefined> | string | null | undefined

/** Normalizes a session channel ID hint when one is present. */
export function normalizeSessionChannelId(value: unknown): Hex | undefined {
  if (typeof value !== 'string') return undefined
  try {
    return ChannelStore.normalizeChannelId(value)
  } catch {
    return undefined
  }
}

/** Extracts and normalizes a credential channel ID for server bootstrap hints. */
export function getCredentialChannelId(credential: Credential.Credential | null | undefined) {
  if (!isObject(credential?.payload)) return undefined
  return normalizeSessionChannelId(credential.payload.channelId)
}

function normalizeResolvedSessionChannelId(value: string | null | undefined): Hex | undefined {
  if (value === null || value === undefined) return undefined
  return ChannelStore.normalizeChannelId(value)
}

/** Resolves the channel ID used to build server-side session bootstrap hints. */
export async function resolveSessionChannelId(parameters: {
  capturedRequest?: RequestBodyProbe | undefined
  credential: Credential.Credential | null | undefined
  request: SessionPaymentRequestInput
  resolveChannelId?: ResolveSessionChannelId | undefined
  source?: string | undefined
  store: ChannelStore.ChannelStore
}): Promise<Hex | undefined> {
  const { capturedRequest, credential, request, resolveChannelId, source, store } = parameters
  const explicitChannelId =
    getCredentialChannelId(credential) ?? normalizeSessionChannelId(request.channelId)
  if (explicitChannelId) return explicitChannelId
  if (!resolveChannelId) return undefined
  return normalizeResolvedSessionChannelId(
    await resolveChannelId({
      request: capturedRequest,
      credential,
      source,
      paymentRequest: request,
      store,
    }),
  )
}

/** Builds server bootstrap hints for a reusable precompile session channel. */
export async function resolveSessionSnapshot(
  parameters: ResolveSessionSnapshotParameters,
): Promise<SessionSnapshot | undefined> {
  const { amount, channelId, store } = parameters
  if (!channelId) return undefined
  const channel = await store.getChannel(ChannelStore.normalizeChannelId(channelId))
  if (!channel || !ChannelStore.isPrecompileState(channel)) return undefined
  if (channel.finalized) return undefined
  const requiredCumulative = channel.spent + amount
  const acceptedCumulative =
    channel.highestVoucherAmount > requiredCumulative
      ? channel.highestVoucherAmount
      : requiredCumulative
  return {
    acceptedCumulative: acceptedCumulative.toString(),
    chainId: channel.chainId,
    channelId: channel.channelId,
    closeRequestedAt:
      channel.closeRequestedAt === 0n ? undefined : channel.closeRequestedAt.toString(),
    deposit: channel.deposit.toString(),
    descriptor: channel.descriptor,
    escrow: channel.escrowContract,
    requiredCumulative: requiredCumulative.toString(),
    settled: channel.settledOnChain.toString(),
    spent: channel.spent.toString(),
    units: channel.units,
  }
}

/** Inputs for deciding whether a verified session credential should serve content. */
export type SessionResponseGateParameters = {
  /** Captured request metadata from the verification envelope, when available. */
  capturedRequest?: Parameters<typeof isSessionContentRequest>[0] | undefined
  /** Raw HTTP request used as a fallback when no captured metadata exists. */
  input: Request
  /** Credential payload or minimal action-bearing payload. */
  payload: SessionCredentialPayload | { action?: unknown }
}

/**
 * Returns a management response for non-content session actions.
 *
 * `close` and `topUp` are always management-only. `open` and `voucher` serve
 * content only when the request classifier says the request is billable.
 */
export function respondToSessionCredential(
  parameters: SessionResponseGateParameters,
): Response | undefined {
  const action = requireSessionCredentialAction(parameters.payload)

  if (action === 'close') return new Response(null, { status: 204 })
  if (action === 'topUp') return new Response(null, { status: 204 })

  const request = parameters.capturedRequest ?? captureRequestBodyProbe(parameters.input)
  if (isSessionContentRequest(request)) return undefined
  return new Response(null, { status: 204 })
}

type ChainIdClient = {
  chain?: { id?: number | undefined } | undefined
}

/** Public request input accepted by the tempo session method before schema normalization. */
export type SessionPaymentRequestInput = z.input<typeof Methods.session.schema.request>

/** Canonical request shape embedded in signed `tempo/session` challenges. */
export type CanonicalSessionPaymentRequest = z.output<typeof Methods.session.schema.request>

/** Canonical challenge request after required TIP-1034 method details have been proven present. */
export type VerifiedSessionPaymentRequest = CanonicalSessionPaymentRequest & {
  /** Required TIP-1034 method details for credential verification. */
  methodDetails: SessionMethodDetails
}

/** Session request input after server-side chain, escrow, fee-payer, and snapshot defaults are added. */
export type ResolvedSessionPaymentRequest = SessionPaymentRequestInput & {
  chainId: number
  escrowContract: Address
  feePayer?: boolean | viem_Account | undefined
  operator?: Address | undefined
  sessionSnapshot?: SessionSnapshot | undefined
}

/** TIP-1034 session details embedded in a payment challenge request. */
export type SessionMethodDetails = {
  /** Tempo chain ID used for voucher domain and channel ID checks. */
  chainId: number
  /** TIP20EscrowChannel precompile address for this challenge. */
  escrowContract: Address
  /** Whether this challenge allows fee-sponsored management transactions. */
  feePayer?: boolean | undefined
  /** Minimum raw-unit increase required for voucher credentials. */
  minVoucherDelta?: string | undefined
  /** Channel operator address the client should encode in new open transactions. */
  operator?: Address | undefined
  /** Tempo session protocol version for this challenge. */
  sessionProtocol?: Constants.SessionProtocol | undefined
}

/** Inputs used to resolve the chain ID for a session challenge. */
export type ResolveRequestChainIdParameters = {
  getClient(parameters: { chainId?: number | undefined }): ChainIdClient | Promise<ChainIdClient>
  parameterChainId?: number | undefined
  requestChainId?: number | undefined
}

/** Inputs used to enrich a server session payment request before challenge creation. */
export type ResolveSessionPaymentRequestParameters = {
  capturedRequest?: RequestBodyProbe | undefined
  credential: Credential.Credential | null | undefined
  decimals: number
  defaultFeePayer?: viem_Account | undefined
  getClient: ResolveRequestChainIdParameters['getClient']
  parameterChainId?: number | undefined
  parameterEscrowContract?: Address | undefined
  parameterFeePayer?: ParameterFeePayer
  request: SessionPaymentRequestInput
  resolveChannelId?: ResolveSessionChannelId | undefined
  source?: string | undefined
  store: ChannelStore.ChannelStore
}

/** Inputs used to resolve shared context for credential verification. */
export type ResolveCredentialVerificationContextParameters = {
  /** Default configured fee-payer account, when enabled. */
  feePayer?: viem_Account | undefined
  /** Resolves a viem client for the challenge chain ID. */
  getClient(parameters: {
    chainId: number
  }): PrecompileChain.TransactionClient | Promise<PrecompileChain.TransactionClient>
  /** Default human-readable minimum voucher delta configured on `session()`. */
  minVoucherDelta?: string | undefined
  /** Token decimals used to parse default minimum voucher delta. */
  decimals: number
  /** Canonical or schema-input request being verified. */
  request: unknown
}

/** Shared context derived from the HMAC-bound challenge request for credential verification. */
export type CredentialVerificationContext = {
  /** Canonical session request shape. */
  request: VerifiedSessionPaymentRequest
  /** Required TIP-1034 method details embedded in the challenge request. */
  methodDetails: SessionMethodDetails
  /** Challenge chain ID. */
  chainId: number
  /** Challenge escrow precompile address. */
  escrow: Address
  /** Client for precompile reads and transaction broadcasts. */
  client: PrecompileChain.TransactionClient
  /** Fee payer authorized for this credential, when allowed. */
  feePayer?: viem_Account | undefined
  /** Minimum allowed voucher delta in raw token units. */
  minVoucherDelta: bigint
}

/** Payment fields extracted from the credential challenge request. */
export type ChallengePaymentFields = {
  /** Raw request amount in token units. */
  amount: bigint
  /** Token address expected by the server. */
  currency: Address
  /** Payee address expected by the server. */
  recipient: Address
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isCanonicalSessionMethodDetails(value: unknown): value is SessionMethodDetails {
  return (
    isObject(value) &&
    typeof value.chainId === 'number' &&
    typeof value.escrowContract === 'string' &&
    isAddress(value.escrowContract, { strict: false }) &&
    (value.feePayer === undefined || typeof value.feePayer === 'boolean') &&
    (value.minVoucherDelta === undefined || typeof value.minVoucherDelta === 'string') &&
    (value.operator === undefined ||
      (typeof value.operator === 'string' && isAddress(value.operator, { strict: false }))) &&
    (value.sessionProtocol === undefined || value.sessionProtocol === Constants.SessionProtocols.v2)
  )
}

function isVerifiedSessionPaymentRequest(
  request: unknown,
): request is VerifiedSessionPaymentRequest {
  return (
    isObject(request) &&
    typeof request.amount === 'string' &&
    typeof request.currency === 'string' &&
    typeof request.unitType === 'string' &&
    isCanonicalSessionMethodDetails(request.methodDetails)
  )
}

function readChallengeAddress(value: unknown, label: string): Address {
  if (typeof value === 'string' && isAddress(value, { strict: false })) return value
  throw new VerificationFailedError({ reason: `missing challenge ${label}` })
}

function readChallengeAmount(value: unknown): bigint {
  if (typeof value === 'string') return BigInt(value)
  throw new VerificationFailedError({ reason: 'missing challenge amount' })
}

/** Reads the destination, token, and raw amount from a session challenge request. */
export function getChallengePaymentFields(challenge: Challenge.Challenge): ChallengePaymentFields {
  return {
    amount: readChallengeAmount(challenge.request.amount),
    currency: readChallengeAddress(challenge.request.currency, 'currency'),
    recipient: readChallengeAddress(challenge.request.recipient, 'recipient'),
  }
}

/** Resolves the chain ID from request override, method parameters, or client config. */
export async function resolveRequestChainId(parameters: ResolveRequestChainIdParameters) {
  const { getClient, parameterChainId, requestChainId } = parameters
  if (requestChainId) return requestChainId
  if (parameterChainId) return parameterChainId
  return (await getClient({})).chain?.id
}

/** Resolves request-time TIP-1034 details and server bootstrap hints for a challenge. */
export async function resolveSessionPaymentRequest(
  parameters: ResolveSessionPaymentRequestParameters,
): Promise<ResolvedSessionPaymentRequest> {
  const {
    capturedRequest,
    credential,
    decimals,
    defaultFeePayer,
    getClient,
    parameterChainId,
    parameterEscrowContract,
    parameterFeePayer,
    request,
    resolveChannelId,
    source,
    store,
  } = parameters

  const chainId = await resolveRequestChainId({
    getClient,
    parameterChainId,
    requestChainId: request.chainId,
  })
  if (!chainId) throw new Error('No chainId configured for tempo.session().')

  const client = await getClient({ chainId })
  if (client.chain?.id !== chainId)
    throw new Error(`Client not configured with chainId ${chainId}.`)

  const escrowContract = resolveRequestEscrowContract(
    request.escrowContract,
    parameterEscrowContract,
  )
  const operator = resolveRequestOperator(request.operator)
  const requestAmount = parseUnits(request.amount, decimals)
  const channelId = await resolveSessionChannelId({
    capturedRequest,
    credential,
    request,
    resolveChannelId,
    source,
    store,
  })
  const sessionSnapshot = await resolveSessionSnapshot({
    amount: capturedRequest && !isSessionContentRequest(capturedRequest) ? 0n : requestAmount,
    channelId,
    store,
  })
  const { operator: _operator, ...requestWithoutOperator } = request

  return {
    ...requestWithoutOperator,
    chainId,
    escrowContract,
    feePayer: resolveRequestFeePayer({
      credential,
      defaultFeePayer,
      parameterFeePayer,
      requestFeePayer: request.feePayer,
    }),
    ...(operator ? { operator } : {}),
    ...(sessionSnapshot ? { sessionSnapshot } : {}),
  }
}

function resolveRequestEscrowContract(
  requestEscrowContract: unknown,
  parameterEscrowContract: Address | undefined,
): Address {
  if (typeof requestEscrowContract === 'string') {
    if (!isAddress(requestEscrowContract, { strict: false }))
      throw new Error('Invalid escrowContract configured for tempo.session().')
    return requestEscrowContract
  }
  return parameterEscrowContract ?? tip20ChannelEscrow
}

function resolveRequestOperator(requestOperator: unknown): Address | undefined {
  if (requestOperator === undefined) return undefined
  if (typeof requestOperator === 'string' && isAddress(requestOperator, { strict: false }))
    return requestOperator as Address
  throw new Error('Invalid operator configured for tempo.session().')
}

/** Parses the canonical session request shape used during credential verification. */
export function resolveVerificationRequest(request: unknown): VerifiedSessionPaymentRequest {
  const parsed = Methods.session.schema.request.safeParse(request)
  if (parsed.success && isVerifiedSessionPaymentRequest(parsed.data)) return parsed.data
  // verifyCredential() passes the HMAC-bound challenge request, which is
  // already in canonical output form and should not be transformed again.
  if (isVerifiedSessionPaymentRequest(request)) return request
  throw new VerificationFailedError({ reason: 'invalid session request' })
}

/** Returns required TIP-1034 method details from a canonical session request. */
export function requireMethodDetails(request: VerifiedSessionPaymentRequest): SessionMethodDetails {
  return request.methodDetails
}

/** Resolves all non-payload verification context from a session challenge request. */
export async function resolveCredentialVerificationContext(
  parameters: ResolveCredentialVerificationContextParameters,
): Promise<CredentialVerificationContext> {
  const { decimals, feePayer, getClient, minVoucherDelta, request } = parameters
  const resolvedRequest = resolveVerificationRequest(request)
  const methodDetails = requireMethodDetails(resolvedRequest)
  const chainId = methodDetails.chainId
  const client = await getClient({ chainId })
  return {
    request: resolvedRequest,
    methodDetails,
    chainId,
    escrow: methodDetails.escrowContract,
    client,
    feePayer: resolveCredentialFeePayer({
      feePayer,
      methodDetails,
      request: resolvedRequest,
    }),
    minVoucherDelta: methodDetails.minVoucherDelta
      ? BigInt(methodDetails.minVoucherDelta)
      : parseUnits(minVoucherDelta ?? '0', decimals),
  }
}
