import { type Address, createClient, custom } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { describe, expect, test } from 'vp/test'

import type { Challenge } from '../../../Challenge.js'
import * as Credential from '../../../Credential.js'
import * as Channel from '../Channel.js'
import { tip20ChannelEscrow } from '../Constants.js'
import * as Types from '../Types.js'
import * as Voucher from '../Voucher.js'
import { session } from './Session.js'

const account = privateKeyToAccount(
  '0xac0974bec39a17e36ba6a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
)
const client = createClient({
  account,
  transport: custom({
    async request() {
      throw new Error('unexpected rpc request')
    },
  }),
})
const chainId = 42431

const descriptor = {
  payer: account.address,
  payee: '0x0000000000000000000000000000000000000002' as Address,
  operator: '0x0000000000000000000000000000000000000000' as Address,
  token: '0x0000000000000000000000000000000000000003' as Address,
  salt: `0x${'11'.repeat(32)}` as `0x${string}`,
  authorizedSigner: account.address,
  expiringNonceHash: `0x${'22'.repeat(32)}` as `0x${string}`,
} satisfies Channel.ChannelDescriptor

function makeChallenge(): Challenge {
  return {
    id: 'test-id',
    realm: 'test.com',
    method: 'tempo',
    intent: 'session',
    request: {
      amount: '100',
      currency: descriptor.token,
      recipient: descriptor.payee,
      methodDetails: { chainId },
    },
  }
}

describe('precompile client session', () => {
  test('creates manual voucher credentials with descriptor payloads', async () => {
    const method = session({ account, getClient: () => client })
    const credential = await method.createCredential({
      challenge: makeChallenge() as never,
      context: {
        action: 'voucher',
        descriptor,
        cumulativeAmountRaw: '250',
      },
    })

    const decoded = Credential.deserialize(credential)
    const payload = decoded.payload as Types.SessionCredentialPayload
    const cumulativeAmount = Types.uint96(250n)
    const channelId = Channel.computeId(descriptor, { chainId, escrow: tip20ChannelEscrow })

    expect(payload.action).toBe('voucher')
    if (payload.action !== 'voucher') throw new Error('expected voucher payload')
    expect(payload.channelId).toBe(channelId)
    expect(payload.descriptor).toEqual(descriptor)
    expect(payload.cumulativeAmount).toBe('250')
    expect(decoded.source).toBe(`did:pkh:eip155:${chainId}:${account.address}`)
    expect(
      Voucher.verify(
        { channelId, cumulativeAmount, signature: payload.signature },
        descriptor.authorizedSigner,
        { chainId, verifyingContract: tip20ChannelEscrow },
      ),
    ).toBe(true)
  })

  test('creates manual top-up credentials from provided transactions', async () => {
    const method = session({ account, getClient: () => client })
    const credential = await method.createCredential({
      challenge: makeChallenge() as never,
      context: {
        action: 'topUp',
        descriptor,
        additionalDepositRaw: '500',
        transaction: '0x1234',
      },
    })

    const decoded = Credential.deserialize(credential)
    const payload = decoded.payload as Types.SessionCredentialPayload

    expect(payload.action).toBe('topUp')
    if (payload.action !== 'topUp') throw new Error('expected topUp payload')
    expect(payload.descriptor).toEqual(descriptor)
    expect(payload.additionalDeposit).toBe('500')
    expect(payload.transaction).toBe('0x1234')
  })
})
