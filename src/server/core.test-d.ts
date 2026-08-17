import { Mppx, Transport } from 'mppx/server/core'
import { test } from 'vp/test'

test('exports typed server primitives', () => {
  Mppx.create({ methods: [], secretKey: 'test' })
  Transport.http()
})
