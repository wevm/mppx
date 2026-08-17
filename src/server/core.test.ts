import * as core from 'mppx/server/core'
import { expect, test } from 'vp/test'

test('exports server primitives without payment methods', () => {
  expect(core.Mppx.create).toBeTypeOf('function')
  expect(core).not.toHaveProperty('evm')
  expect(core).not.toHaveProperty('stripe')
  expect(core).not.toHaveProperty('tempo')
})
