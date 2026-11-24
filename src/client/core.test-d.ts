import { Mppx, Transport } from 'mppx/client/core'
import { test } from 'vp/test'

test('exports typed client primitives', () => {
  Mppx.create({ methods: [], polyfill: false })
  Transport.http()
})
