import { tempo as serverTempo } from 'mppx/server'
import { expectTypeOf, test } from 'vp/test'

import type {
  PaymentResponse as ClientPaymentResponse,
  SessionManager as ClientSessionManager,
  SessionManagerSseOptions as ClientSessionManagerSseOptions,
  SessionManagerWebSocketOptions as ClientSessionManagerWebSocketOptions,
} from './client/index.js'
import * as Tempo from './index.js'
import type { charge as ServerCharge } from './server/Charge.js'
import type { SettlementSchedule as ServerSettlementSchedule } from './server/index.js'
import type {
  ActiveSessionState,
  ClosedSessionState,
  PaymentResponse as SessionPaymentResponse,
  SessionManager,
  SessionManagerSseOptions,
  SessionManagerWebSocketOptions,
  SessionTransition,
  VoucherNeededSessionState,
} from './session/client/index.js'
import type { SessionTransition as MachineSessionTransition } from './session/client/index.js'
import type { ChannelTransactionOptions } from './session/precompile/Chain.js'
import type { RawAmountString } from './session/precompile/index.js'
import type { SettlementSchedule as SessionSettlementSchedule } from './session/server/index.js'
import type { SessionController } from './session/server/Sse.js'

test('tempo session public barrels expose manager and schedule interfaces', () => {
  expectTypeOf(Tempo.mach).toBeFunction()
  expectTypeOf(Tempo.mach(42431).address).toMatchTypeOf<`0x${string}`>()
  expectTypeOf(Tempo.Session).toBeObject()
  expectTypeOf(Tempo.Session.Client).toBeObject()
  expectTypeOf(Tempo.Session.Precompile).toBeObject()
  expectTypeOf(Tempo.Session.Server).toBeObject()
  expectTypeOf<typeof Tempo>().not.toHaveProperty('Precompile')
  expectTypeOf<serverTempo.RelayOptions>().toEqualTypeOf<ServerCharge.RelayOptions>()
  expectTypeOf<serverTempo.RelayErrorCode>().toEqualTypeOf<
    | 'already_used'
    | 'broadcast_failed'
    | 'expired'
    | 'invalid_payment'
    | 'insufficient_funds'
    | 'policy_denied'
    | 'screen_rejected'
    | 'simulation_failed'
    | 'temporarily_unavailable'
    | 'unsupported'
    | 'unknown'
  >()
  expectTypeOf<serverTempo.RelayErrorDetails>().toEqualTypeOf<
    | { code: 'already_used' | 'broadcast_failed' | 'insufficient_funds' | 'invalid_payment' }
    | { code: 'simulation_failed' | 'unsupported' }
    | { code: 'temporarily_unavailable'; retry: 'same_credential' }
  >()

  expectTypeOf<ClientPaymentResponse>().toEqualTypeOf<SessionPaymentResponse>()
  expectTypeOf<ClientSessionManager>().toEqualTypeOf<SessionManager>()
  expectTypeOf<ClientSessionManagerSseOptions>().toEqualTypeOf<SessionManagerSseOptions>()
  expectTypeOf<ClientSessionManagerWebSocketOptions>().toEqualTypeOf<SessionManagerWebSocketOptions>()

  expectTypeOf<ServerSettlementSchedule>().toEqualTypeOf<SessionSettlementSchedule>()
  expectTypeOf<MachineSessionTransition>().toEqualTypeOf<SessionTransition>()
  expectTypeOf<ServerSettlementSchedule>().toEqualTypeOf<{
    amount?: string | bigint | undefined
    intervalMs?: number | undefined
    units?: number | undefined
  }>()
  expectTypeOf<RawAmountString>().toEqualTypeOf<string>()
  expectTypeOf<serverTempo.Sse.SessionController>().toEqualTypeOf<SessionController>()
  expectTypeOf<Tempo.Session.Server.Sse.SessionController>().toEqualTypeOf<SessionController>()
  expectTypeOf<ActiveSessionState['status']>().toEqualTypeOf<'active'>()
  expectTypeOf<VoucherNeededSessionState['status']>().toEqualTypeOf<'voucherNeeded'>()
  expectTypeOf<ClosedSessionState['status']>().toEqualTypeOf<'closed'>()
})

test('tempo session chain exports canonical transaction options', () => {
  expectTypeOf<ChannelTransactionOptions>().toEqualTypeOf<{
    account?: import('viem').Account | undefined
    candidateFeeTokens?: readonly import('viem').Address[] | undefined
    feePayer?: import('viem').Account | true | undefined
    feePayerPolicy?: Partial<import('./internal/fee-payer.js').Policy> | undefined
    feeToken?: import('viem').Address | undefined
  }>()
})

test('tempo session public barrel hides internal session drivers', () => {
  type SessionNamespacePublic = typeof import('./session/index.js')
  type SessionPublic = typeof import('./session/precompile/index.js')
  type SessionClientPublic = typeof import('./session/client/index.js')
  type SessionServerPublic = typeof import('./session/server/index.js')

  expectTypeOf<SessionNamespacePublic>().toHaveProperty('Precompile')
  expectTypeOf<SessionNamespacePublic>().toHaveProperty('Client')
  expectTypeOf<SessionNamespacePublic>().toHaveProperty('Server')
  expectTypeOf<SessionNamespacePublic>().not.toHaveProperty('ChannelStore')
  expectTypeOf<SessionNamespacePublic>().not.toHaveProperty('Receipt')
  expectTypeOf<SessionNamespacePublic>().not.toHaveProperty('Sse')
  expectTypeOf<SessionNamespacePublic>().not.toHaveProperty('Types')
  expectTypeOf<SessionNamespacePublic>().not.toHaveProperty('Ws')
  expectTypeOf<SessionNamespacePublic>().not.toHaveProperty('session')
  expectTypeOf<SessionNamespacePublic>().not.toHaveProperty('sessionManager')
  expectTypeOf<SessionPublic>().not.toHaveProperty('openSseSession')
  expectTypeOf<SessionPublic>().not.toHaveProperty('openWebSocketSession')
  expectTypeOf<SessionPublic>().not.toHaveProperty('Client')
  expectTypeOf<SessionPublic>().not.toHaveProperty('Server')
  expectTypeOf<SessionPublic>().not.toHaveProperty('session')
  expectTypeOf<SessionPublic>().not.toHaveProperty('sessionManager')
  expectTypeOf<SessionPublic>().not.toHaveProperty('settle')
  expectTypeOf<SessionClientPublic>().not.toHaveProperty('ChannelOps')
  expectTypeOf<SessionClientPublic>().not.toHaveProperty('Chain')
  expectTypeOf<SessionClientPublic>().not.toHaveProperty('driveSseResponse')
  expectTypeOf<SessionServerPublic>().not.toHaveProperty('ChannelOps')
  expectTypeOf<SessionServerPublic>().not.toHaveProperty('Chain')
})

test('tempo legacy namespace retains client and channel primitives only', () => {
  type LegacySessionPublic = typeof import('./legacy/session/index.js')
  type LegacyNamespacePublic = typeof import('./legacy/index.js')

  expectTypeOf(Tempo.SessionLegacy.Client.session).toBeFunction()
  expectTypeOf(Tempo.SessionLegacy.Client.sessionManager).toBeFunction()
  expectTypeOf(Tempo.SessionLegacy.Session.Chain).toBeObject()
  expectTypeOf(Tempo.SessionLegacy.Session.Channel).toBeObject()
  expectTypeOf(Tempo.SessionLegacy.Session.Voucher).toBeObject()

  expectTypeOf<LegacyNamespacePublic>().not.toHaveProperty('Server')
  expectTypeOf<LegacySessionPublic>().not.toHaveProperty('ChannelStore')
  expectTypeOf<LegacySessionPublic>().not.toHaveProperty('Receipt')
  expectTypeOf<LegacySessionPublic>().not.toHaveProperty('Sse')
  expectTypeOf<LegacySessionPublic>().not.toHaveProperty('Ws')
})
