import { tempo as tempoMainnet, tempoModerato } from 'viem/chains'
import { afterEach, describe, expect, test } from 'vp/test'

import { resolveChain, resolveRpcUrl } from './utils.js'

describe('resolveRpcUrl', () => {
  afterEach(() => {
    delete process.env.MPPX_RPC_URL
    delete process.env.RPC_URL
  })

  test('returns explicit value when provided', () => {
    process.env.MPPX_RPC_URL = 'https://env.example.com'
    expect(resolveRpcUrl('https://explicit.example.com')).toBe('https://explicit.example.com')
  })

  test('falls back to MPPX_RPC_URL env var', () => {
    process.env.MPPX_RPC_URL = 'https://mppx.example.com'
    process.env.RPC_URL = 'https://rpc.example.com'
    expect(resolveRpcUrl()).toBe('https://mppx.example.com')
  })

  test('falls back to RPC_URL env var when MPPX_RPC_URL is not set', () => {
    process.env.RPC_URL = 'https://rpc.example.com'
    expect(resolveRpcUrl()).toBe('https://rpc.example.com')
  })

  test('returns undefined when nothing is set', () => {
    expect(resolveRpcUrl()).toBeUndefined()
  })

  test('trims whitespace from env vars', () => {
    process.env.MPPX_RPC_URL = '  https://mppx.example.com  '
    expect(resolveRpcUrl()).toBe('https://mppx.example.com')
  })

  test('skips empty MPPX_RPC_URL and falls back to RPC_URL', () => {
    process.env.MPPX_RPC_URL = '  '
    process.env.RPC_URL = 'https://rpc.example.com'
    expect(resolveRpcUrl()).toBe('https://rpc.example.com')
  })
})

describe('resolveChain', () => {
  afterEach(() => {
    delete process.env.MPPX_RPC_URL
    delete process.env.RPC_URL
  })

  test('defaults to tempo mainnet when no rpcUrl is provided', async () => {
    const chain = await resolveChain()
    expect(chain.id).toBe(tempoMainnet.id)
  })

  test('defaults to tempo mainnet when rpcUrl is undefined', async () => {
    const chain = await resolveChain({ rpcUrl: undefined })
    expect(chain.id).toBe(tempoMainnet.id)
  })

  test('does not default to testnet', async () => {
    const chain = await resolveChain()
    expect(chain.id).not.toBe(tempoModerato.id)
  })
})
