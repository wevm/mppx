import type { Account } from 'viem'
import { describe, expectTypeOf, test } from 'vp/test'

import * as Challenge from '../../Challenge.js'
import { charge } from '../../tempo/client/Charge.js'
import * as Fetch from './Fetch.js'

describe('Fetch.from', () => {
  test('default', () => {
    const fetch = Fetch.from({
      methods: [charge()],
    })

    expectTypeOf(fetch).toBeFunction()
    expectTypeOf(fetch).returns.toMatchTypeOf<Promise<Response>>()
  })

  test('behavior: accepts context in RequestInit when method has context', () => {
    const fetch = Fetch.from({
      methods: [charge()],
    })

    expectTypeOf(fetch).toBeCallableWith('https://example.com', {
      context: { account: {} as Account },
    })
  })

  test('behavior: context is optional in RequestInit', () => {
    const fetch = Fetch.from({
      methods: [charge()],
    })

    expectTypeOf(fetch).toBeCallableWith('https://example.com')
    expectTypeOf(fetch).toBeCallableWith('https://example.com', {})
  })

  test('behavior: RequestInit extends standard RequestInit', () => {
    const fetch = Fetch.from({
      methods: [charge()],
    })

    expectTypeOf(fetch).toBeCallableWith('https://example.com', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ foo: 'bar' }),
    })
  })

  test('behavior: events infer payload types from methods', () => {
    const method = charge()
    const dispatcher = Fetch.createEventDispatcher<[typeof method]>()
    dispatcher.on('*', (event) => {
      if (event.name === 'challenge.received')
        expectTypeOf(event.payload.challenge).toEqualTypeOf<Challenge.Challenge>()
    })
    dispatcher.on('challenge.received', (payload) => {
      expectTypeOf(payload.method.intent).toEqualTypeOf<'charge'>()
      return payload.createCredential({ account: {} as Account })
    })
    dispatcher.on('credential.created', (payload) => {
      expectTypeOf(payload.method.intent).toEqualTypeOf<'charge'>()
      expectTypeOf(payload.credential).toEqualTypeOf<string>()
    })
    dispatcher.on('payment.failed', (payload) => {
      expectTypeOf(payload.error).toEqualTypeOf<unknown>()
    })
    dispatcher.on('payment.response', (payload) => {
      expectTypeOf(payload.response).toEqualTypeOf<Response>()
    })

    const fetch = Fetch.from({
      eventDispatcher: dispatcher,
      methods: [method],
    })

    expectTypeOf(fetch).toBeFunction()
  })
})

describe('Fetch.from.RequestInit', () => {
  test('behavior: has context property typed to method context', () => {
    const _method = charge()

    type Methods = [typeof _method]
    type Init = Fetch.from.RequestInit<Methods>

    expectTypeOf<Init>().toHaveProperty('context')
  })
})
