/**
 * Server-side TIP-1034 precompile session payment method for request/response flows.
 *
 * Handles the full TIP20EscrowChannel lifecycle (open, voucher, top-up, close)
 * and one-shot settlement. Each incoming request carries a session credential
 * with a cumulative voucher that the server validates and records.
 */
import { isAddress, type Address, type Hex } from 'viem'
import { tempo as tempo_chain } from 'viem/chains'

import * as Challenge from '../../../Challenge.js'
import * as Constants from '../../../Constants.js'
import * as Credential from '../../../Credential.js'
import * as Errors from '../../../Errors.js'
import * as Expires from '../../../Expires.js'
import type { MaybePromise } from '../../../internal/types.js'
import type { LooseOmit, NoExtraKeys } from '../../../internal/types.js'
import * as Method from '../../../Method.js'
import * as Store from '../../../Store.js'
import * as Client from '../../../viem/Client.js'
import * as Account from '../../internal/account.js'
import * as defaults from '../../internal/defaults.js'
import * as FeePayer from '../../internal/fee-payer.js'
import type * as types from '../../internal/types.js'
import * as Methods from '../../Methods.js'
import * as ChargeServer from '../../server/Charge.js'
import * as Transport from '../../server/internal/transport.js'
import { tip20ChannelEscrow } from '../precompile/Protocol.js'
import {
  deserializeSnapshot as deserializeSessionSnapshot,
  serializeSnapshot as serializeSessionSnapshot,
} from '../Snapshot.js'
import * as ChannelStore from './ChannelStore.js'
import { broadcastCredentialPayload, validateCredentialPayload } from './CredentialVerification.js'
import { requireSessionCredentialPayload } from './CredentialVerification.js'
import {
  type ResolveSessionChannelId,
  resolveCredentialVerificationContext,
  resolveSessionChannelId,
  resolveSessionSnapshot,
  resolveSessionPaymentRequest,
  type SessionPaymentRequestInput,
} from './RequestState.js'
import { respondToSessionCredential } from './RequestState.js'
import {
  applyVerifiedHttpAccounting,
  chargeSessionChannel,
  type SettleChargedSessionChannel,
} from './Settlement.js'
import { isSettlementDue, maybeSettleScheduled } from './Settlement.js'
import {
  resolveSettlementSchedule,
  type OnSessionSettlement,
  type SettlementSchedule,
} from './Settlement.js'
import * as Ws from './Ws.js'

/** Server-side automatic settlement schedule. */
export type { SettlementSchedule } from './Settlement.js'
/** Server-side settlement event hook types. */
export type { OnSessionSettlement, SessionSettlementContext } from './Settlement.js'
/** Server-side hook types for request-identity channel bootstrap. */
export type {
  ResolveSessionChannelId,
  ResolveSessionChannelIdParameters,
  SessionChannelIdRequest,
} from './RequestState.js'
export { settle, settleBatch } from './Settlement.js'

type SessionDefaultValues = {
  amount: session.Parameters['amount']
  currency: session.Parameters['currency']
  decimals: number
  operator: session.Parameters['operator']
  recipient: Address | undefined
  suggestedDeposit: session.Parameters['suggestedDeposit']
  unitType: session.Parameters['unitType']
}

function deriveServerDefaults<const parameters extends session.Parameters>(
  values: SessionDefaultValues,
): session.DeriveDefaults<parameters> {
  // `Method.toServer()` models defaults from request input fields. Tempo session
  // defaults are assembled after account/currency resolution, so keep the
  // unavoidable generic bridge in one place instead of the control-flow body.
  return values as unknown as session.DeriveDefaults<parameters>
}

function deriveTransport<const parameters extends session.Parameters>(
  transport: Transport.Sse | undefined,
): parameters['sse'] extends false | undefined ? undefined : Transport.Sse {
  return transport as parameters['sse'] extends false | undefined ? undefined : Transport.Sse
}

type BootstrapCharge = ReturnType<typeof ChargeServer.charge>

type BootstrapPreflightParameters = {
  capturedRequest?: Method.CapturedRequest | undefined
  charge: BootstrapCharge
  credential: Credential.Credential | null
  decimals: number
  defaultRecipient?: Address | undefined
  expires?: string | undefined
  getClient(parameters: {
    chainId?: number | undefined
  }): MaybePromise<{ chain?: { id?: number | undefined } | undefined }>
  input: Request
  parameterChainId?: number | undefined
  parameterEscrowContract?: Address | undefined
  paymentRequest: SessionPaymentRequestInput
  realm: string
  resolveChannelId?: ResolveSessionChannelId | undefined
  secretKey: string
  store: ChannelStore.ChannelStore
}

type BootstrapChargeRequest = {
  amount: '0'
  chainId?: number | undefined
  currency: string
  decimals: number
  recipient?: string | undefined
}

async function resolveBootstrapChargeRequest(
  parameters: Pick<
    BootstrapPreflightParameters,
    'decimals' | 'defaultRecipient' | 'getClient' | 'parameterChainId' | 'paymentRequest'
  >,
): Promise<BootstrapChargeRequest> {
  const { decimals, defaultRecipient, getClient, parameterChainId, paymentRequest } = parameters
  const chainId = paymentRequest.chainId ?? parameterChainId ?? (await getClient({})).chain?.id
  return {
    amount: '0',
    ...(chainId !== undefined ? { chainId } : {}),
    currency: paymentRequest.currency,
    decimals,
    recipient: paymentRequest.recipient ?? defaultRecipient,
  }
}

function isBootstrapChargeCredential(credential: Credential.Credential | null) {
  return (
    credential?.challenge.method === Constants.Methods.tempo &&
    credential.challenge.intent === Constants.Intents.charge
  )
}

function createBootstrapChallenge(parameters: {
  expires?: string | undefined
  realm: string
  request: BootstrapChargeRequest
  secretKey: string
}) {
  return Challenge.fromMethod(Methods.charge, {
    expires: parameters.expires,
    realm: parameters.realm,
    request: parameters.request,
    secretKey: parameters.secretKey,
  })
}

function respondBootstrapChallenge(challenge: Challenge.Challenge, error?: Errors.PaymentError) {
  const headers = new Headers({
    [Constants.Headers.wwwAuthenticate]: Challenge.serialize(challenge),
    'Cache-Control': 'no-store',
  })
  if (!error) return new Response(null, { status: 402, headers })
  headers.set('Content-Type', 'application/problem+json')
  return new Response(JSON.stringify(error.toProblemDetails(challenge.id)), {
    status: error.status,
    headers,
  })
}

function assertBootstrapChallengeMatches(
  expected: Challenge.Challenge,
  actual: Challenge.Challenge,
) {
  if (actual.method !== Constants.Methods.tempo || actual.intent !== Constants.Intents.charge)
    throw new Errors.InvalidChallengeError({ id: actual.id, reason: 'not a bootstrap challenge' })
  if (!sameRequestValue(expected.request.amount, actual.request.amount))
    throw new Errors.InvalidChallengeError({ id: actual.id, reason: 'bootstrap amount mismatch' })
  if (!sameRequestValue(expected.request.currency, actual.request.currency))
    throw new Errors.InvalidChallengeError({ id: actual.id, reason: 'bootstrap currency mismatch' })
  if (!sameRequestValue(expected.request.recipient, actual.request.recipient))
    throw new Errors.InvalidChallengeError({
      id: actual.id,
      reason: 'bootstrap recipient mismatch',
    })
  const expectedChainId = readMethodDetail(expected.request, 'chainId')
  const actualChainId = readMethodDetail(actual.request, 'chainId')
  if (!sameRequestValue(expectedChainId, actualChainId))
    throw new Errors.InvalidChallengeError({ id: actual.id, reason: 'bootstrap chain mismatch' })
}

function readMethodDetail(request: unknown, key: string) {
  if (!request || typeof request !== 'object') return undefined
  const methodDetails = (request as { methodDetails?: unknown }).methodDetails
  if (!methodDetails || typeof methodDetails !== 'object') return undefined
  return (methodDetails as Record<string, unknown>)[key]
}

function sameRequestValue(a: unknown, b: unknown) {
  return a === b || (a === undefined && b === undefined)
}

function readBootstrapAddress(value: unknown, label: string): Address {
  if (typeof value === 'string' && isAddress(value, { strict: false })) return value
  throw new Errors.VerificationFailedError({ reason: `missing bootstrap ${label}` })
}

function resolveBootstrapEscrowContract(
  paymentRequest: SessionPaymentRequestInput,
  parameterEscrowContract?: Address | undefined,
): Address {
  const requestEscrow = (paymentRequest as { escrowContract?: unknown }).escrowContract
  if (requestEscrow === undefined) return parameterEscrowContract ?? tip20ChannelEscrow
  return readBootstrapAddress(requestEscrow, 'escrowContract')
}

function readBootstrapChainId(value: unknown): number {
  if (typeof value === 'number') return value
  throw new Errors.VerificationFailedError({ reason: 'missing bootstrap chainId' })
}

async function verifyBootstrapCredential(parameters: {
  challenge: Challenge.Challenge
  charge: BootstrapCharge
  credential: Credential.Credential
  rawRequest: BootstrapChargeRequest
  secretKey: string
}) {
  const { challenge, charge, credential, rawRequest, secretKey } = parameters
  if (!Challenge.verify(credential.challenge, { secretKey }))
    throw new Errors.InvalidChallengeError({
      id: credential.challenge.id,
      reason: 'challenge was not issued by this server',
    })
  Expires.assert(credential.challenge.expires, credential.challenge.id)
  assertBootstrapChallengeMatches(challenge, credential.challenge)
  const payload = Methods.charge.schema.credential.payload.safeParse(credential.payload)
  if (!payload.success) throw new Errors.InvalidPayloadError()
  return charge.verify({
    credential: {
      ...credential,
      payload: payload.data,
    } as never,
    request: rawRequest,
  })
}

async function handleBootstrapPreflight(
  parameters: BootstrapPreflightParameters,
): Promise<Response | undefined> {
  const request = await resolveBootstrapChargeRequest(parameters)
  const challenge = createBootstrapChallenge({
    expires: parameters.expires,
    realm: parameters.realm,
    request,
    secretKey: parameters.secretKey,
  })

  if (!parameters.credential) return respondBootstrapChallenge(challenge)
  if (!isBootstrapChargeCredential(parameters.credential)) return undefined

  try {
    await verifyBootstrapCredential({
      challenge,
      charge: parameters.charge,
      credential: parameters.credential,
      rawRequest: request,
      secretKey: parameters.secretKey,
    })
  } catch (error) {
    return respondBootstrapChallenge(
      challenge,
      error instanceof Errors.PaymentError ? error : new Errors.InternalPaymentError(),
    )
  }

  const channelId = await resolveSessionChannelId({
    capturedRequest: parameters.capturedRequest,
    credential: parameters.credential,
    request: parameters.paymentRequest,
    resolveChannelId: parameters.resolveChannelId,
    source: parameters.credential.source,
    store: parameters.store,
  })
  const snapshot = await resolveSessionSnapshot({
    amount: 0n,
    channelId,
    expected: {
      chainId: readBootstrapChainId(request.chainId),
      currency: readBootstrapAddress(request.currency, 'currency'),
      escrowContract: resolveBootstrapEscrowContract(
        parameters.paymentRequest,
        parameters.parameterEscrowContract,
      ),
      recipient: readBootstrapAddress(request.recipient, 'recipient'),
    },
    store: parameters.store,
  })
  const headers = new Headers({ 'Cache-Control': 'no-store' })
  if (snapshot) {
    headers.set(Constants.Headers.paymentSession, snapshot.channelId)
    headers.set(Constants.Headers.paymentSessionSnapshot, serializeSessionSnapshot(snapshot))
  }
  return new Response(null, { status: 204, headers })
}

/** Creates a server-side TIP20EscrowChannel precompile session payment method. */
export function session<const parameters extends session.Parameters>(
  p?: NoExtraKeys<parameters, session.Parameters>,
) {
  const parameters = p as parameters
  const {
    amount,
    channelStateTtl = 5_000,
    currency = defaults.resolveCurrency(parameters),
    decimals = defaults.decimals,
    operator,
    store: rawStore = Store.memory(),
    suggestedDeposit,
    unitType,
  } = parameters
  const settlementSchedule = resolveSettlementSchedule(parameters.settlementSchedule, decimals)
  const onSessionSettlement = parameters.onSessionSettlement

  const store = ChannelStore.fromStore(rawStore)
  const lastOnChainVerified = new Map<Hex, number>()
  const { account, feePayer, remoteFeePayer, recipient } = Account.resolve(parameters)
  const configuredFeePayer =
    feePayer ?? (remoteFeePayer || parameters.feePayer === true ? true : undefined)
  const getClient = Client.getResolver({
    chain: tempo_chain,
    remoteFeePayer,
    getClient: parameters.getClient,
    rpcUrl: defaults.rpcUrl,
  })
  const settleScheduled: SettleChargedSessionChannel = async (channel) => {
    if (!isSettlementDue(channel, settlementSchedule)) return undefined
    return maybeSettleScheduled({
      account,
      channel,
      client: await getClient({ chainId: channel.chainId }),
      ...(configuredFeePayer ? { feePayer: configuredFeePayer } : {}),
      feePayerPolicy: parameters.feePayerPolicy,
      feeToken: parameters.feeToken,
      onSessionSettlement,
      schedule: settlementSchedule,
      store,
    })
  }
  const serveWebSocket: session.Extensions['serveWebSocket'] = (options) =>
    Ws.serve({
      ...options,
      onChargeCommitted: settleScheduled,
      store,
    })
  const bootstrapCharge = ChargeServer.charge({
    account,
    chainId: parameters.chainId,
    currency,
    decimals,
    feePayer: parameters.feePayer,
    getClient: parameters.getClient,
    recipient,
    store: rawStore,
  })

  type SessionTransport = parameters['sse'] extends false | undefined ? undefined : Transport.Sse
  const transport = parameters.sse
    ? Transport.sse({
        settleCharged: settleScheduled,
        store,
        ...(typeof parameters.sse === 'object' ? parameters.sse : undefined),
      })
    : undefined

  const validateCredential: Method.ValidateFn<typeof Methods.session> = async ({
    credential,
    request,
  }) => {
    const payload = requireSessionCredentialPayload(credential.payload)
    const context = await resolveCredentialVerificationContext({
      decimals,
      feePayer: configuredFeePayer,
      getClient,
      minVoucherDelta: parameters.minVoucherDelta,
      request,
    })

    const details = await validateCredentialPayload({
      account,
      challenge: credential.challenge,
      channelStateTtl,
      chainId: context.chainId,
      client: context.client,
      credentialSource: credential.source,
      escrow: context.escrow,
      expectedOperator: context.methodDetails.operator,
      feePayer: context.feePayer,
      feePayerPolicy: parameters.feePayerPolicy,
      feeToken: context.methodDetails.feeToken,
      lastOnChainVerified,
      minVoucherDelta: context.minVoucherDelta,
      payload,
      store,
    })

    return {
      challenge: credential.challenge,
      credential: { ...credential, payload },
      details,
      intent: 'session' as const,
      method: 'tempo' as const,
      request: context.request,
      source: credential.source,
    }
  }

  const broadcastCredential: Method.BroadcastFn<typeof Methods.session> = async ({
    credential,
    envelope,
    request,
  }) => {
    const { challenge } = credential
    const payload = requireSessionCredentialPayload(credential.payload)
    const context = await resolveCredentialVerificationContext({
      decimals,
      feePayer: configuredFeePayer,
      getClient,
      minVoucherDelta: parameters.minVoucherDelta,
      request,
    })

    const sessionReceipt = await broadcastCredentialPayload({
      account,
      challenge,
      channelStateTtl,
      chainId: context.chainId,
      client: context.client,
      credentialSource: credential.source,
      escrow: context.escrow,
      expectedOperator: context.methodDetails.operator,
      feePayer: context.feePayer,
      feePayerPolicy: parameters.feePayerPolicy,
      feeToken: context.methodDetails.feeToken,
      lastOnChainVerified,
      minVoucherDelta: context.minVoucherDelta,
      onSessionSettlement,
      payload,
      store,
    })

    return applyVerifiedHttpAccounting({
      capturedRequest: envelope?.capturedRequest,
      payloadAction: payload.action,
      receipt: sessionReceipt,
      getRequestAmount: () => BigInt(context.request.amount ?? challenge.request.amount),
      sseEnabled: Boolean(parameters.sse),
      markPrepaidReceipt: Transport.markPrepaidSessionTick,
      store,
      settleCharged: (channel) =>
        maybeSettleScheduled({
          account,
          client: context.client,
          ...(context.feePayer ? { feePayer: context.feePayer } : {}),
          feePayerPolicy: parameters.feePayerPolicy,
          feeToken: parameters.feeToken,
          onSessionSettlement,
          schedule: settlementSchedule,
          store,
          channel,
        }),
    })
  }

  type Defaults = session.DeriveDefaults<parameters>
  const method = Method.toServer<
    typeof Methods.session,
    Defaults,
    SessionTransport,
    session.Extensions
  >(Methods.session, {
    canOffer: parameters.canOffer,
    onPaymentSuccess: parameters.onPaymentSuccess,
    defaults: deriveServerDefaults<parameters>({
      amount,
      currency,
      decimals,
      operator,
      recipient,
      suggestedDeposit,
      unitType,
    }),

    extensions: { serveWebSocket, settleScheduled },

    transport: deriveTransport<parameters>(transport),

    preflight: parameters.bootstrap
      ? async ({ capturedRequest, credential, expires, input, options, realm, secretKey }) => {
          if (input.method !== 'HEAD') return undefined
          return handleBootstrapPreflight({
            capturedRequest,
            credential,
            input,
            charge: bootstrapCharge,
            decimals,
            defaultRecipient: recipient,
            expires,
            getClient,
            parameterChainId: parameters.chainId,
            parameterEscrowContract: parameters.escrowContract,
            paymentRequest: options,
            realm,
            resolveChannelId: parameters.resolveChannelId,
            secretKey,
            store,
          })
        }
      : undefined,

    async request({ capturedRequest, credential, request }) {
      const resolvedRequest = await resolveSessionPaymentRequest({
        capturedRequest,
        credential,
        decimals,
        defaultFeePayer: feePayer,
        getClient,
        parameterChainId: parameters.chainId,
        parameterEscrowContract: parameters.escrowContract,
        parameterFeePayer: configuredFeePayer,
        request,
        resolveChannelId: parameters.resolveChannelId,
        store,
      })
      return {
        ...resolvedRequest,
        feeToken: parameters.feeToken,
        sessionProtocol: Constants.SessionProtocols.v2,
      }
    },

    validate: validateCredential,
    broadcast: broadcastCredential,

    // This hook acts as a gate: when it returns a Response, `withReceipt()`
    // in Mppx.ts short-circuits and returns that response directly without
    // invoking the user's route handler. When it returns undefined, the
    // user's handler runs normally and serves content.
    //
    // close and topUp are always gated (204) — they are pure management.
    //
    // open and voucher share the same captured-request classifier used
    // during verification. Non-billable requests are treated as management
    // updates; billable requests fall through to the application handler.
    respond({ credential, envelope, input }) {
      return respondToSessionCredential({
        capturedRequest: envelope?.capturedRequest,
        input,
        payload: credential.payload,
      })
    },
  })
  return method
}

export namespace session {
  export const serializeSnapshot = serializeSessionSnapshot
  export const deserializeSnapshot = deserializeSessionSnapshot

  /** Extensions attached to the Tempo session method handler. */
  export type Extensions = {
    /** Applies the configured automatic settlement policy to a committed channel charge. */
    settleScheduled: SettleChargedSessionChannel
    /** Serves a WebSocket route from this handler using its configured store and settlement policy. */
    serveWebSocket: (options: ServeWebSocketOptions) => Promise<void>
  }

  /** WebSocket server options supplied after the session binds shared dependencies. */
  export type ServeWebSocketOptions = Omit<
    Ws.serve.Options,
    'onChargeCommitted' | 'settleScheduled' | 'store'
  >

  /** Request defaults inferred from the Tempo session method schema. */
  export type Defaults = LooseOmit<
    Method.RequestDefaults<typeof Methods.session>,
    'escrowContract' | 'feePayer' | 'recipient'
  >

  /** Partial fee-sponsor policy used for server-submitted session transactions. */
  export type FeePayerPolicy = Partial<FeePayer.Policy>

  /** Parameters accepted by the TIP-1034 server session payment method. */
  export type Parameters = {
    /** TTL in milliseconds for cached on-chain channel state. After this duration, the server re-queries on-chain state during voucher handling to detect forced close requests. @default 5_000 */
    channelStateTtl?: number | undefined
    /** Override the fee-sponsor policy used for sponsored open/topUp transactions and server-driven close transactions. */
    feePayerPolicy?: FeePayerPolicy | undefined
    /** Minimum voucher delta to accept (numeric string, default: "0"). */
    minVoucherDelta?: string | undefined
    /**
     * Maps authenticated application identity and payment scope to an existing channel ID.
     * Called only when the request does not already supply a channel ID. MPPx then loads that
     * ID from `store` and validates the channel before including its snapshot in a challenge or
     * bootstrap response. The store is not searched automatically and does not need to implement
     * a secondary-index format.
     */
    resolveChannelId?: ResolveSessionChannelId | undefined
    /**
     * Enables same-route `HEAD` recovery before a paid request. The server issues a zero-amount
     * identity challenge, verifies the returned proof, passes its authenticated `source` to
     * `resolveChannelId`, validates the loaded channel's payment scope, and returns a snapshot
     * containing the signed highest voucher for client rehydration.
     */
    bootstrap?: boolean | undefined
    /**
     * Atomic store backend for channel state.
     *
     * Session mutations must be linearizable across instances so spent,
     * highest-voucher, top-up, and close/finalization updates cannot race.
     * Use `Store.memory()` for tests or local single-process usage.
     */
    store?: Store.AtomicStore | undefined
    /** Enable SSE streaming. Pass `true` for defaults or an options object to configure SSE. */
    sse?: boolean | Transport.sse.Options | undefined
    /** Tempo chain ID used for TIP-1034 channel escrow challenges. Defaults to the resolved client chain ID. */
    chainId?: number | undefined
    /** Escrow contract advertised to clients. Defaults to the canonical TIP20EscrowChannel address. */
    escrowContract?: Address | undefined
    /** Callback invoked after any on-chain settlement or close transaction is confirmed. */
    onSessionSettlement?: OnSessionSettlement | undefined
    /** Server-owned automatic settlement cadence. Clients do not receive or control this schedule. */
    settlementSchedule?: SettlementSchedule | undefined

    /** Optional fee token for management and server-driven settle/close transactions. */
    feeToken?: Address | undefined
  } & Account.resolve.Parameters &
    Client.getResolver.Parameters &
    Defaults &
    Method.ComposableHooks<typeof Methods.session>

  /** Defaults derived from `session()` parameters for handler type inference. */
  export type DeriveDefaults<parameters extends Parameters> = types.DeriveDefaults<
    parameters,
    Defaults,
    {
      currency: string
      decimals: number
    }
  >
}

/**
 * Charge against a precompile-backed channel's balance.
 *
 * Exported so consumers can deduct from a channel outside the `session()`
 * handler.
 *
 * Delegates to the shared `deductFromChannel` atomic helper and translates
 * failure modes into typed errors (`InsufficientBalanceError`, `ChannelClosedError`).
 */
export async function charge(
  store: ChannelStore.ChannelStore,
  channelId: Hex,
  amount: bigint,
): Promise<ChannelStore.State> {
  return chargeSessionChannel({ store, channelId, amount })
}
