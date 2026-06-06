/**
 * Server-side TIP-1034 precompile session payment method for request/response flows.
 *
 * Handles the full TIP20EscrowChannel lifecycle (open, voucher, top-up, close)
 * and one-shot settlement. Each incoming request carries a session credential
 * with a cumulative voucher that the server validates and records.
 */
import { type Address, type Hex } from 'viem'
import { tempo as tempo_chain } from 'viem/chains'

import * as Constants from '../../../Constants.js'
import type { LooseOmit, NoExtraKeys } from '../../../internal/types.js'
import * as Method from '../../../Method.js'
import * as Store from '../../../Store.js'
import * as Client from '../../../viem/Client.js'
import * as Account from '../../internal/account.js'
import * as defaults from '../../internal/defaults.js'
import * as FeePayer from '../../internal/fee-payer.js'
import type * as types from '../../internal/types.js'
import * as Methods from '../../Methods.js'
import * as Transport from '../../server/internal/transport.js'
import * as ChannelStore from './ChannelStore.js'
import { verifyCredentialPayload } from './CredentialVerification.js'
import { requireSessionCredentialPayload } from './CredentialVerification.js'
import {
  type ResolveSessionChannelId,
  resolveCredentialVerificationContext,
  resolveSessionPaymentRequest,
} from './RequestState.js'
import { respondToSessionCredential } from './RequestState.js'
import { applyVerifiedHttpAccounting, chargeSessionChannel } from './Settlement.js'
import { maybeSettleScheduled } from './Settlement.js'
import { resolveSettlementSchedule, type SettlementSchedule } from './Settlement.js'

/** Server-side automatic settlement schedule. */
export type { SettlementSchedule } from './Settlement.js'
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

  const store = ChannelStore.fromStore(rawStore)
  const lastOnChainVerified = new Map<Hex, number>()
  const { account, feePayer, recipient } = Account.resolve(parameters)
  const getClient = Client.getResolver({
    chain: tempo_chain,
    getClient: parameters.getClient,
    rpcUrl: defaults.rpcUrl,
  })

  type Transport = parameters['sse'] extends false | undefined ? undefined : Transport.Sse
  const transport = parameters.sse
    ? Transport.sse({
        store,
        ...(typeof parameters.sse === 'object' ? parameters.sse : undefined),
      })
    : undefined

  type Defaults = session.DeriveDefaults<parameters>
  return Method.toServer<typeof Methods.session, Defaults, Transport>(Methods.session, {
    defaults: deriveServerDefaults<parameters>({
      amount,
      currency,
      decimals,
      operator,
      recipient,
      suggestedDeposit,
      unitType,
    }),

    transport: deriveTransport<parameters>(transport),

    async request({ capturedRequest, credential, request }) {
      const resolvedRequest = await resolveSessionPaymentRequest({
        capturedRequest,
        credential,
        decimals,
        defaultFeePayer: feePayer,
        getClient,
        parameterChainId: parameters.chainId,
        parameterEscrowContract: parameters.escrowContract,
        parameterFeePayer: parameters.feePayer,
        request,
        resolveChannelId: parameters.resolveChannelId,
        store,
      })
      return {
        ...resolvedRequest,
        sessionProtocol: Constants.SessionProtocols.tip1034,
      }
    },

    async verify({ credential, envelope, request }) {
      const { challenge } = credential
      const payload = requireSessionCredentialPayload(credential.payload)
      const context = await resolveCredentialVerificationContext({
        decimals,
        feePayer,
        getClient,
        minVoucherDelta: parameters.minVoucherDelta,
        request,
      })

      const sessionReceipt = await verifyCredentialPayload({
        account,
        challenge,
        channelStateTtl,
        chainId: context.chainId,
        client: context.client,
        escrow: context.escrow,
        feePayer: context.feePayer,
        feePayerPolicy: parameters.feePayerPolicy,
        feeToken: parameters.feeToken,
        lastOnChainVerified,
        minVoucherDelta: context.minVoucherDelta,
        payload,
        store,
      })

      return applyVerifiedHttpAccounting({
        capturedRequest: envelope?.capturedRequest,
        payloadAction: payload.action,
        receipt: sessionReceipt,
        getRequestAmount: () => BigInt(context.request.amount ?? challenge.request.amount),
        sseEnabled: Boolean(parameters.sse),
        charge: (channelId, requestAmount) =>
          chargeSessionChannel({ store, channelId, amount: requestAmount }),
        settleCharged: (channel) =>
          maybeSettleScheduled({
            account,
            client: context.client,
            feePayer: context.feePayer,
            feePayerPolicy: parameters.feePayerPolicy,
            feeToken: parameters.feeToken,
            schedule: settlementSchedule,
            store,
            channel,
          }),
      })
    },

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
}

export namespace session {
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
    /** Resolve a reusable channel ID from request identity when no credential/request channel ID is present. */
    resolveChannelId?: ResolveSessionChannelId | undefined
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
    /** Tempo chain ID used for TIP-1034 channel escrow challenges. Defaults to the resolved client chain ID. Pass the Tempo testnet chain ID here instead of using legacy session's `testnet` boolean. */
    chainId?: number | undefined
    /** TIP20EscrowChannel precompile address override. */
    escrowContract?: Address | undefined
    /** Server-owned automatic settlement cadence. Clients do not receive or control this schedule. */
    settlementSchedule?: SettlementSchedule | undefined

    /** Optional fee token used for server-driven close transactions. */
    feeToken?: Address | undefined
  } & Account.resolve.Parameters &
    Client.getResolver.Parameters &
    Defaults

  /** Defaults derived from `session()` parameters for handler type inference. */
  export type DeriveDefaults<parameters extends Parameters> = types.DeriveDefaults<
    parameters,
    Defaults
  > & {
    decimals: number
    escrowContract: Address
  }
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
