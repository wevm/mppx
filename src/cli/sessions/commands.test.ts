import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

import type { Address, Hex } from 'viem'
import { afterEach, beforeEach, describe, expect, test } from 'vp/test'

import type * as Challenge from '../../Challenge.js'
import type { ChannelEntry } from '../../tempo/session/client/ChannelOps.js'
import sessions from './commands.js'
import { createSessionRegistry, type SessionRegistry } from './store.js'

const payer = '0x1111111111111111111111111111111111111111' as Address
const payee = '0x2222222222222222222222222222222222222222' as Address
const token = '0x3333333333333333333333333333333333333333' as Address
const escrow = '0x4444444444444444444444444444444444444444' as Address
const operator = '0x0000000000000000000000000000000000000000' as Address
const testnetChannelId = `0x${'aa'.repeat(32)}` as Hex
const mainnetChannelId = `0x${'bb'.repeat(32)}` as Hex

let temporaryDirectory: string
let registry: SessionRegistry
let previousPrivateKey: string | undefined
let previousStateHome: string | undefined

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'mppx-session-commands-'))
  previousPrivateKey = process.env.MPPX_PRIVATE_KEY
  previousStateHome = process.env.XDG_STATE_HOME
  process.env.XDG_STATE_HOME = temporaryDirectory
  const timestamps = [new Date('2026-07-16T00:00:00.000Z'), new Date('2026-07-16T00:01:00.000Z')]
  registry = createSessionRegistry({
    stateRoot: path.join(temporaryDirectory, 'mppx', 'sessions', 'v1'),
    now: () => timestamps.shift() ?? new Date('2026-07-16T00:02:00.000Z'),
  })
})

afterEach(async () => {
  if (previousPrivateKey === undefined) delete process.env.MPPX_PRIVATE_KEY
  else process.env.MPPX_PRIVATE_KEY = previousPrivateKey
  if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME
  else process.env.XDG_STATE_HOME = previousStateHome
  await fs.rm(temporaryDirectory, { force: true, recursive: true })
})

async function serve(argv: string[]) {
  let output = ''
  let exitCode: number | undefined
  await sessions.serve(argv, {
    stdout(value: string) {
      output += value
    },
    exit(code: number) {
      exitCode = code
    },
  })
  return { exitCode, output }
}

function channel(parameters: {
  channelId: Hex
  chainId: number
  cumulativeAmount: bigint
  deposit: bigint
  saltByte: string
}): ChannelEntry {
  return {
    channelId: parameters.channelId,
    cumulativeAmount: parameters.cumulativeAmount,
    deposit: parameters.deposit,
    descriptor: {
      payer,
      payee,
      operator,
      token,
      salt: `0x${parameters.saltByte.repeat(32)}` as Hex,
      authorizedSigner: payer,
      expiringNonceHash: `0x${'66'.repeat(32)}`,
    },
    escrow,
    chainId: parameters.chainId,
    opened: true,
  }
}

function challenge(chainId: number, id: string): Challenge.Challenge {
  return {
    id,
    realm: 'api.example.test',
    method: 'tempo',
    intent: 'session',
    request: {
      amount: '1',
      currency: token,
      recipient: payee,
      methodDetails: { chainId, escrowContract: escrow },
    },
  }
}

async function seedSessions() {
  await registry.upsert({
    status: 'open',
    channel: channel({
      channelId: testnetChannelId,
      chainId: 42431,
      cumulativeAmount: 9_007_199_254_740_993_123_456_789n,
      deposit: 9_999_999_999_999_999_999_999_999n,
      saltByte: '55',
    }),
    account: { name: 'testnet-payer', address: payer },
    endpoint: 'https://api.example.test/query?chainId=testnet&sql=select%201',
    challenge: challenge(42431, 'testnet-challenge'),
    spent: 1_234_567_890_123_456_789n,
    units: 7,
  })
  await registry.upsert({
    status: 'closing',
    channel: channel({
      channelId: mainnetChannelId,
      chainId: 4217,
      cumulativeAmount: 20n,
      deposit: 100n,
      saltByte: '77',
    }),
    account: { name: 'mainnet-payer', address: payer },
    endpoint: 'https://api.example.test/query?chainId=mainnet',
    challenge: challenge(4217, 'mainnet-challenge'),
    spent: 5n,
    units: 2,
  })
}

describe('session commands', () => {
  test('list returns stable JSON-safe decimal-string projections', async () => {
    await seedSessions()

    const result = await serve(['list', '--json'])

    expect(result.exitCode).toBeUndefined()
    expect(JSON.parse(result.output)).toEqual({
      sessions: [
        {
          status: 'open',
          channelId: testnetChannelId,
          account: 'testnet-payer',
          payer,
          payee,
          authorizedSigner: payer,
          token,
          escrow,
          chainId: 42431,
          cumulativeAmount: '9007199254740993123456789',
          confirmedSpend: '1234567890123456789',
          deposit: '9999999999999999999999999',
          units: 7,
          resourceUrl: 'https://api.example.test/query?chainId=testnet&sql=select%201',
          createdAt: '2026-07-16T00:00:00.000Z',
          updatedAt: '2026-07-16T00:00:00.000Z',
        },
        {
          status: 'closing',
          channelId: mainnetChannelId,
          account: 'mainnet-payer',
          payer,
          payee,
          authorizedSigner: payer,
          token,
          escrow,
          chainId: 4217,
          cumulativeAmount: '20',
          confirmedSpend: '5',
          deposit: '100',
          units: 2,
          resourceUrl: 'https://api.example.test/query?chainId=mainnet',
          createdAt: '2026-07-16T00:01:00.000Z',
          updatedAt: '2026-07-16T00:01:00.000Z',
        },
      ],
    })
  })

  test('list filters by account and network', async () => {
    await seedSessions()

    const byAccount = await serve(['list', '--account', 'testnet-payer', '--json'])
    const byNetwork = await serve(['list', '--network', 'mainnet', '--json'])
    const mismatch = await serve([
      'list',
      '--account',
      'testnet-payer',
      '--network',
      'mainnet',
      '--json',
    ])

    expect(JSON.parse(byAccount.output).sessions).toMatchObject([{ channelId: testnetChannelId }])
    expect(JSON.parse(byNetwork.output).sessions).toMatchObject([{ channelId: mainnetChannelId }])
    expect(JSON.parse(mismatch.output)).toEqual({ sessions: [] })
  })

  test('view returns the same stable projection as list', async () => {
    await seedSessions()
    const listed = await serve(['list', '--network', 'testnet', '--json'])
    const viewed = await serve(['view', testnetChannelId, '--json'])

    expect(JSON.parse(viewed.output)).toEqual(JSON.parse(listed.output).sessions[0])
  })

  test('view rejects a missing full channel ID', async () => {
    const missingChannelId = `0x${'cc'.repeat(32)}`
    const result = await serve(['view', missingChannelId, '--json'])

    expect(result.exitCode).toBe(2)
    expect(result.output).toContain('SESSION_NOT_FOUND')
    expect(result.output).toContain(`Session ${missingChannelId} was not found.`)
  })

  test('close all reports failures in session order', async () => {
    await seedSessions()
    process.env.MPPX_PRIVATE_KEY = `0x${'11'.repeat(32)}`
    const originalStderrWrite = process.stderr.write
    let stderr = ''
    process.stderr.write = ((chunk: unknown) => {
      stderr += typeof chunk === 'string' ? chunk : String(chunk)
      return true
    }) as typeof process.stderr.write

    let result!: Awaited<ReturnType<typeof serve>>
    try {
      result = await serve(['close', '--all', '--yes', '--json'])
    } finally {
      process.stderr.write = originalStderrWrite
    }
    const output = JSON.parse(result.output)

    expect(output.closed).toEqual([])
    expect(output.failed.map((failure: { channelId: string }) => failure.channelId)).toEqual([
      testnetChannelId,
      mainnetChannelId,
    ])
    expect(output.failed[0].message).toContain('cannot sign for session')
    expect(output.failed[1].message).toContain('cannot sign for session')
    expect(stderr).toContain(testnetChannelId)
    expect(stderr).toContain(mainnetChannelId)
  })
})
