import * as core from 'mppx/client/core'
import { expect, test } from 'vp/test'

test('exports client primitives without payment methods', () => {
  expect(core.Mppx.create).toBeTypeOf('function')
  expect(core.Fetch.from).toBeTypeOf('function')
  expect(core).not.toHaveProperty('evm')
  expect(core).not.toHaveProperty('stripe')
  expect(core).not.toHaveProperty('tempo')
  expect(core).not.toHaveProperty('session')
})
