import * as client from 'mppx/client'
import * as server from 'mppx/server'
import * as tempoClient from 'mppx/tempo/client'
import * as tempoServer from 'mppx/tempo/server'
import { expect, test } from 'vp/test'

test('mppx/tempo/client exports the same Tempo client methods as mppx/client', () => {
  expect(tempoClient.tempo).toBe(client.tempo)
  expect(tempoClient.session).toBe(client.session)
  expect(tempoClient.sessionMethod).toBe(client.sessionMethod)
  expect(tempoClient.sessionManager).toBe(client.sessionManager)
  expect(tempoClient.createChannelStore).toBe(client.createChannelStore)
  expect(tempoClient.createJsonChannelStore).toBe(client.createJsonChannelStore)
  expect(tempoClient.entryKey).toBe(client.entryKey)
  expect(tempoClient).not.toHaveProperty('stripe')
  expect(tempoClient).not.toHaveProperty('evm')
})

test('mppx/tempo/server exports the same Tempo server method as mppx/server', () => {
  expect(tempoServer.tempo).toBe(server.tempo)
  expect(tempoServer.charge).toBeTypeOf('function')
  expect(tempoServer.session).toBeTypeOf('function')
  expect(tempoServer).not.toHaveProperty('stripe')
  expect(tempoServer).not.toHaveProperty('evm')
})
