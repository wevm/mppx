import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { tempo } from 'mppx/client'
import type { Account } from 'viem'
import { describe, expectTypeOf, test } from 'vp/test'

import * as McpClient from './McpClient.js'

describe('McpClient.wrap', () => {
  test('returns the original client with payment-aware callTool', () => {
    const client = {} as Client
    const wrapped = McpClient.wrap(client, {
      methods: [
        tempo({
          account: {} as Account,
        }),
      ],
    })

    expectTypeOf(wrapped).toEqualTypeOf<
      McpClient.wrap.McpClient<Client, readonly [ReturnType<typeof tempo>]>
    >()
    expectTypeOf(wrapped.callTool).toBeFunction()
    expectTypeOf(wrapped.callTool).returns.toExtend<Promise<McpClient.CallToolResult>>()
  })

  test('preserves original client methods', () => {
    const client = {} as Client
    const wrapped = McpClient.wrap(client, {
      methods: [
        tempo({
          account: {} as Account,
        }),
      ],
    })

    expectTypeOf(wrapped).toHaveProperty('connect')
    expectTypeOf(wrapped).toHaveProperty('close')
    expectTypeOf(wrapped).toHaveProperty('listTools')
    expectTypeOf(wrapped).toHaveProperty('listResources')
    expectTypeOf(wrapped).toHaveProperty('listPrompts')
  })

  test('preserves custom properties on client', () => {
    const client = { callTool: {} as Client['callTool'], customProp: 'hello' }
    const wrapped = McpClient.wrap(client, {
      methods: [
        tempo({
          account: {} as Account,
        }),
      ],
    })

    expectTypeOf(wrapped.customProp).toEqualTypeOf<string>()
  })

  test('callTool keeps the MCP SDK result schema and options positions', () => {
    const client = {} as Client
    const wrapped = McpClient.wrap(client, {
      methods: [
        tempo({
          account: {} as Account,
        }),
      ],
    })

    expectTypeOf(wrapped.callTool).toBeCallableWith({ name: 'tool' })
    expectTypeOf(wrapped.callTool).toBeCallableWith({ name: 'tool' }, undefined, {})
    expectTypeOf(wrapped.callTool).toBeCallableWith({ name: 'tool' }, undefined, {
      timeout: 5000,
    })
  })

  test('callTool accepts context in the options position', () => {
    const client = {} as Client
    const wrapped = McpClient.wrap(client, {
      methods: [tempo({})],
    })

    expectTypeOf(wrapped.callTool).toBeCallableWith({ name: 'tool' }, undefined, {
      context: { account: {} as Account },
      timeout: 5000,
    })
  })

  test('callTool accepts a per-call approval hook in the options position', () => {
    const client = {} as Client
    const wrapped = McpClient.wrap(client, {
      methods: [
        tempo({
          account: {} as Account,
        }),
      ],
    })

    expectTypeOf(wrapped.callTool).toBeCallableWith({ name: 'tool' }, undefined, {
      onPaymentRequired: async (challenge) => challenge.intent === 'charge',
    })
    expectTypeOf(wrapped.callTool).toBeCallableWith({ name: 'tool' }, undefined, {
      onPaymentRequired: null,
    })
  })

  test('callTool result includes receipt', () => {
    const client = {} as Client
    const wrapped = McpClient.wrap(client, {
      methods: [
        tempo({
          account: {} as Account,
        }),
      ],
    })

    expectTypeOf(wrapped.callTool({} as never)).resolves.toHaveProperty('receipt')
    expectTypeOf(wrapped.callTool({} as never)).resolves.toHaveProperty('content')
  })

  test('can store an inferred client as the exported client type', () => {
    const client = {} as Client

    const wrapped = McpClient.wrap(client, {
      methods: [tempo({ account: {} as Account })],
    })

    expectTypeOf(wrapped).toMatchTypeOf<McpClient.wrap.McpClient>()
  })
})

describe('McpClient.wrap.McpClient', () => {
  test('has callTool with correct signature', () => {
    type WrappedClient = McpClient.wrap.McpClient

    expectTypeOf<WrappedClient>().toHaveProperty('callTool')
  })
})

describe('McpClient.wrap.CallToolOptions', () => {
  test('has context, approval hook, and timeout properties', () => {
    type Options = McpClient.wrap.CallToolOptions

    expectTypeOf<Options>().toHaveProperty('context')
    expectTypeOf<Options>().toHaveProperty('onPaymentRequired')
    expectTypeOf<Options>().toHaveProperty('timeout')
  })
})
