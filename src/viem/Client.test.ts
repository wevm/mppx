import { describe, expect, test } from 'vitest'
import * as Client from './Client.js'

const rpcUrl = { 42: 'https://rpc.example.com', 99: 'https://rpc2.example.com' } as const

describe('getResolver', () => {
  test('behavior: creates client from rpcUrl for given chainId', async () => {
    const getClient = Client.getResolver({
      rpcUrl,
    })

    const client = await getClient({ chainId: 42 })

    expect(client).toBeDefined()
    expect(client.chain?.id).toBe(42)
  })

  test('behavior: falls back to first rpcUrl key when chainId is 0', async () => {
    const getClient = Client.getResolver({
      rpcUrl,
    })

    const client = await getClient({})

    expect(client.chain?.id).toBe(42)
  })

  test('behavior: spreads chain into created client', async () => {
    const chain = { id: 1, name: 'test' }
    const getClient = Client.getResolver({
      chain: chain as never,
      rpcUrl,
    })

    const client = await getClient({ chainId: 99 })

    expect(client.chain?.id).toBe(99)
    expect(client.chain?.name).toBe('test')
  })

  test('error: throws when no rpcUrl provided', () => {
    const getClient = Client.getResolver({})

    expect(() => getClient({ chainId: 1 })).toThrowErrorMatchingInlineSnapshot(
      `[Error: No \`rpcUrl\` provided.]`,
    )
  })

  test('error: throws when chainId not found in rpcUrl', () => {
    const getClient = Client.getResolver({
      rpcUrl: { 42: 'https://example.com' },
    })

    expect(() => getClient({ chainId: 99 })).toThrowErrorMatchingInlineSnapshot(
      `[Error: No \`rpcUrl\` configured for \`chainId\` (99).]`,
    )
  })
})
