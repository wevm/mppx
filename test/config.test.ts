import { tempoDevnet, tempoLocalnet } from 'viem/chains'
import { describe, expect, test } from 'vp/test'

import { resolveTempoNetworkConfig, tempoLocalnetRpcUrl } from './config.js'

describe('resolveTempoNetworkConfig', () => {
  test('defaults to Docker localnet', () => {
    expect(resolveTempoNetworkConfig({})).toMatchObject({
      chain: tempoLocalnet,
      enabled: true,
      isDevnet: false,
      isLocalnet: true,
      network: 'localnet',
      rpcUrl: tempoLocalnetRpcUrl,
    })
  })

  test('selects Moderato with its default RPC URL', () => {
    expect(resolveTempoNetworkConfig({ network: 'moderato' })).toMatchObject({
      chain: tempoDevnet,
      enabled: true,
      isDevnet: true,
      isLocalnet: false,
      network: 'moderato',
      rpcUrl: tempoDevnet.rpcUrls.default.http[0],
    })
  })

  test('keeps devnet as a Moderato alias', () => {
    expect(resolveTempoNetworkConfig({ network: 'devnet' })).toMatchObject({
      chain: tempoDevnet,
      enabled: true,
      isDevnet: true,
      isLocalnet: false,
      network: 'moderato',
      rpcUrl: tempoDevnet.rpcUrls.default.http[0],
    })
  })

  test('keeps explicit RPC URL overrides', () => {
    expect(
      resolveTempoNetworkConfig({
        network: 'moderato',
        rpcUrl: 'http://localhost:18545',
      }).rpcUrl,
    ).toBe('http://localhost:18545')
  })

  test('disables network setup for pure tests', () => {
    expect(resolveTempoNetworkConfig({ network: 'none' })).toMatchObject({
      enabled: false,
      network: 'none',
    })
  })

  test('rejects unsupported test network names', () => {
    expect(() => resolveTempoNetworkConfig({ network: 'testnet' })).toThrow(
      'Unsupported Tempo test network "testnet". Use "localnet", "moderato", or "none".',
    )
  })
})
