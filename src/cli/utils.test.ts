import { tempo as tempoMainnet, tempoModerato } from 'viem/tempo/chains'
import { afterEach, describe, expect, test, vi } from 'vp/test'

import {
  fetchTokenInfo,
  isAgentEnvironment,
  networkRpcUrls,
  resolveChain,
  resolveFundingNetwork,
  resolveRpcUrl,
} from './utils.js'

describe('isAgentEnvironment', () => {
  test('detects Claude Code', () => {
    expect(isAgentEnvironment({ CLAUDECODE: '1' })).toBe(true)
  })

  test('detects Codex by exact env var', () => {
    expect(isAgentEnvironment({ CODEX: '1' })).toBe(true)
  })

  test('detects Codex wrapper env vars', () => {
    expect(isAgentEnvironment({ CODEX_CI: '1' })).toBe(true)
    expect(isAgentEnvironment({ CODEX_SANDBOX: 'seatbelt' })).toBe(true)
    expect(isAgentEnvironment({ CODEX_THREAD_ID: '019f6bc0-b80f-7061-ac1b-7af8ba1ea513' })).toBe(
      true,
    )
  })

  test('ignores empty and unrelated env vars', () => {
    expect(isAgentEnvironment({ CODEX_CI: '', CI: '1' })).toBe(false)
  })
})

describe('resolveRpcUrl', () => {
  afterEach(() => {
    delete process.env.MPPX_RPC_URL
    delete process.env.RPC_URL
  })

  test('returns explicit value when provided', () => {
    process.env.MPPX_RPC_URL = 'https://env.example.com'
    expect(resolveRpcUrl('https://explicit.example.com')).toBe('https://explicit.example.com')
  })

  test('uses network default before env vars', () => {
    process.env.MPPX_RPC_URL = 'https://env.example.com'
    expect(resolveRpcUrl(undefined, { network: 'testnet' })).toBe(networkRpcUrls.testnet)
  })

  test('prefers explicit rpc url over network default', () => {
    expect(resolveRpcUrl('https://explicit.example.com', { network: 'mainnet' })).toBe(
      'https://explicit.example.com',
    )
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

describe('resolveFundingNetwork', () => {
  afterEach(() => {
    delete process.env.MPPX_RPC_URL
    delete process.env.RPC_URL
  })

  test('defaults faucet funding to testnet', () => {
    expect(resolveFundingNetwork()).toBe('testnet')
  })

  test('keeps explicit network selection', () => {
    expect(resolveFundingNetwork({ network: 'mainnet' })).toBe('mainnet')
  })

  test('does not override explicit rpc url', () => {
    expect(resolveFundingNetwork({ rpcUrl: 'https://explicit.example.com' })).toBeUndefined()
  })

  test('does not override env rpc urls', () => {
    process.env.MPPX_RPC_URL = 'https://env.example.com'
    expect(resolveFundingNetwork()).toBeUndefined()
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

describe('fetchTokenInfo', () => {
  afterEach(() => {
    vi.doUnmock('viem/tempo')
  })

  test('uses 6 decimals when token metadata omits a numeric decimals value', async () => {
    const token = '0x1111111111111111111111111111111111111111'
    const account = '0x2222222222222222222222222222222222222222'
    vi.doMock('viem/tempo', () => ({
      Actions: {
        token: {
          getBalance: vi.fn(async () => ({ amount: 123n })),
          getMetadata: vi.fn(async () => ({ decimals: undefined, symbol: 'TEST' })),
        },
      },
    }))

    const info = await fetchTokenInfo({} as never, token, account)

    expect(info).toEqual({
      balance: 123n,
      decimals: 6,
      symbol: 'TEST',
      token,
    })
  })

  test('rejects missing decimals when trusted metadata is required', async () => {
    const token = '0x1111111111111111111111111111111111111111'
    const account = '0x2222222222222222222222222222222222222222'
    vi.doMock('viem/tempo', () => ({
      Actions: {
        token: {
          getBalance: vi.fn(async () => ({ amount: 123n })),
          getMetadata: vi.fn(async () => ({ decimals: undefined, symbol: 'TEST' })),
        },
      },
    }))

    await expect(
      fetchTokenInfo({} as never, token, account, { requireDecimals: true }),
    ).rejects.toThrow('Token decimals are unavailable.')
  })
})
