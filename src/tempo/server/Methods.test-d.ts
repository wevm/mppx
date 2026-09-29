import { tokens } from 'viem/tokens'
import { expectTypeOf, test } from 'vp/test'

import * as Mppx from '../../server/Mppx.js'
import { tokens as defaults } from '../internal/defaults.js'
import type { session } from '../session/server/Session.js'
import { tempo } from './Methods.js'

test('accepts maintained token sets and preserves configured handler defaults', () => {
  const methods = tempo.common({
    currencies: tokens.tempo,
    amount: '1',
    recipient: '0x1234567890123456789012345678901234567890',
  })
  const mppx = Mppx.create({ methods: [methods], secretKey: 'test-secret-key-test-secret-key-32' })
  expectTypeOf(mppx.charge({})).toBeFunction()
  expectTypeOf(mppx.session({ unitType: 'request' })).toBeFunction()
  expectTypeOf(methods[0].intent).toEqualTypeOf<'charge'>()
  expectTypeOf(methods[1].intent).toEqualTypeOf<'session'>()
  expectTypeOf(mppx.tempo.session.settleScheduled).toEqualTypeOf<
    session.Extensions['settleScheduled']
  >()
  expectTypeOf(mppx.tempo.session.serveWebSocket).toEqualTypeOf<
    session.Extensions['serveWebSocket']
  >()
})

test('accepts readonly addresses, requires missing handler parameters, rejects conflicts', () => {
  const mppx = Mppx.create({
    methods: [tempo.common({ currencies: [defaults.ousd, defaults.usdc] as const })],
    secretKey: 'test-secret-key-test-secret-key-32',
  })
  expectTypeOf(mppx.charge({ amount: '1' })).toBeFunction()
  // @ts-expect-error Amount has not been configured.
  mppx.charge({})
  // @ts-expect-error Single and multiple currency options are mutually exclusive.
  tempo.common({ currency: defaults.usdc, currencies: [defaults.ousd] })
  // @ts-expect-error Definitions require decimals.
  tempo.common({ currencies: [{ addresses: { 4217: defaults.ousd }, currency: 'USD' }] })
  // @ts-expect-error No separate preference setting.
  tempo.common({ currencies: [defaults.ousd], preferredCurrency: defaults.ousd })
})

test('individual factories preserve handler defaults and intent-specific helpers', () => {
  const charge = tempo.charge({ amount: '1', currencies: tokens.tempo })
  const sessionMethods = tempo.session({ amount: '1', currencies: tokens.tempo })
  const subscriptions = tempo.subscription({
    amount: '1',
    currencies: tokens.tempo,
    periodCount: 1,
    periodUnit: 'day',
    recipient: '0x1234567890123456789012345678901234567890',
    resolve: async () => null,
    subscriptionExpires: '2027-01-01T00:00:00Z',
  })
  const mppx = Mppx.create({ methods: [charge, sessionMethods, subscriptions] })
  expectTypeOf(charge[0].intent).toEqualTypeOf<'charge'>()
  expectTypeOf(sessionMethods[0].intent).toEqualTypeOf<'session'>()
  expectTypeOf(subscriptions[0].intent).toEqualTypeOf<'subscription'>()
  expectTypeOf(mppx.charge({})).toBeFunction()
  expectTypeOf(mppx.session({ unitType: 'request' })).toBeFunction()
  expectTypeOf(mppx.subscription({})).toBeFunction()
  expectTypeOf(mppx.tempo.session.settleScheduled).toEqualTypeOf<
    session.Extensions['settleScheduled']
  >()
  expectTypeOf(mppx.tempo.subscription.renew).toBeFunction()
  expectTypeOf(tempo.session.charge).toBeFunction()
  // @ts-expect-error Single and multiple currency options are mutually exclusive.
  tempo.charge({ currency: defaults.usdc, currencies: [defaults.ousd] })
})
