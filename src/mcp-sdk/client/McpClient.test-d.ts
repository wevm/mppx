import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { tempo } from 'mpay/client'
import type { Account } from 'viem'
import { describe, expectTypeOf, test } from 'vitest'
import * as McpClient from './McpClient.js'

describe('McpClient.wrap', () => {
  test('returns wrapped client with callTool', () => {
    const client = {} as Client
    const wrapped = McpClient.wrap(client, {
      methods: [
        tempo({
          account: {} as Account,
        }),
      ],
    })

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

  test('callTool accepts context when method has context', () => {
    const client = {} as Client
    const wrapped = McpClient.wrap(client, {
      methods: [tempo({})],
    })

    expectTypeOf(wrapped.callTool).toBeCallableWith(
      { name: 'tool' },
      { context: { account: {} as Account } },
    )
  })

  test('callTool context is optional when account provided at creation', () => {
    const client = {} as Client
    const wrapped = McpClient.wrap(client, {
      methods: [
        tempo({
          account: {} as Account,
        }),
      ],
    })

    expectTypeOf(wrapped.callTool).toBeCallableWith({ name: 'tool' })
    expectTypeOf(wrapped.callTool).toBeCallableWith({ name: 'tool' }, {})
    expectTypeOf(wrapped.callTool).toBeCallableWith({ name: 'tool' }, { timeout: 5000 })
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
})

describe('McpClient.wrap.McpClient', () => {
  test('has callTool with correct signature', () => {
    type WrappedClient = McpClient.wrap.McpClient

    expectTypeOf<WrappedClient>().toHaveProperty('callTool')
  })
})

describe('McpClient.wrap.CallToolOptions', () => {
  test('has context and timeout properties', () => {
    type Options = McpClient.wrap.CallToolOptions

    expectTypeOf<Options>().toHaveProperty('context')
    expectTypeOf<Options>().toHaveProperty('timeout')
  })
})
