import type { Account } from 'viem'
import { describe, expectTypeOf, test } from 'vitest'
import * as tempo from '../tempo/client/Intents.js'
import * as Fetch from './Fetch.js'

describe('Fetch.from', () => {
  test('default', () => {
    const fetch = Fetch.from({
      methods: [tempo.charge()],
    })

    expectTypeOf(fetch).toBeFunction()
    expectTypeOf(fetch).returns.toMatchTypeOf<Promise<Response>>()
  })

  test('behavior: accepts context in RequestInit when method has context', () => {
    const fetch = Fetch.from({
      methods: [tempo.charge()],
    })

    expectTypeOf(fetch).toBeCallableWith('https://example.com', {
      context: { account: {} as Account },
    })
  })

  test('behavior: context is optional in RequestInit', () => {
    const fetch = Fetch.from({
      methods: [tempo.charge()],
    })

    expectTypeOf(fetch).toBeCallableWith('https://example.com')
    expectTypeOf(fetch).toBeCallableWith('https://example.com', {})
  })

  test('behavior: RequestInit extends standard RequestInit', () => {
    const fetch = Fetch.from({
      methods: [tempo.charge()],
    })

    expectTypeOf(fetch).toBeCallableWith('https://example.com', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ foo: 'bar' }),
    })
  })
})

describe('Fetch.from.RequestInit', () => {
  test('behavior: has context property typed to method context', () => {
    const method = tempo.charge()

    type Methods = [typeof method]
    type Init = Fetch.from.RequestInit<Methods>

    expectTypeOf<Init>().toHaveProperty('context')
  })
})
